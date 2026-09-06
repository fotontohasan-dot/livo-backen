// views/profile/chat.ejs-এর আচরণ। আগে এটা একটা ইনলাইন <script> ব্লক ছিল আর
// ১৫টা ইনলাইন onclick হ্যান্ডলার ছিল — যার ৫টা টেমপ্লেটে নয়, রানটাইমে
// innerHTML দিয়ে তৈরি হত (welcome কার্ডের কুইক-বাটনগুলো)। ওই ৫টাও সমান
// সমস্যা: script-src-attr 'none' ওদেরও ব্লক করত।
//
// সার্ভার-সাইড মান (user id, অনুবাদ, সাইটের নাম) এখন একটা
// <script type="application/json"> ব্লক থেকে আসে — ওটা executable নয়,
// তাই CSP-তে কোনো ছাড় লাগে না।
//
// docs/CSP.md, ধাপ ২।

(function () {
  'use strict';

  var config = {};
  var socket = null;
  var userId = null;

  var messagesDiv, messageInput, sendButton, fileInput, filePreview, previewImg, previewName;
  var selectedFile = null;
  var selectedFileType = null;
  var botMode = true;

  function readConfig() {
    var el = document.getElementById('chatConfig');
    if (!el) return {};
    try {
      return JSON.parse(el.textContent) || {};
    } catch (e) {
      return {};
    }
  }

  function t(key, fallback) {
    var value = config.t && config.t[key];
    return value == null || value === '' ? (fallback || '') : value;
  }

  function setMode(isBot) {
    botMode = isBot;
    var bot = document.getElementById('mode-bot');
    var agent = document.getElementById('mode-agent');
    if (bot) {
      bot.style.background = isBot ? 'var(--grad-gold)' : 'rgba(255,255,255,0.08)';
      bot.style.color = isBot ? '#000' : '#fff';
    }
    if (agent) {
      agent.style.background = !isBot ? 'var(--grad-gold)' : 'rgba(255,255,255,0.08)';
      agent.style.color = !isBot ? '#000' : '#fff';
    }
  }

  function sendQuickMessage(text) {
    messageInput.value = text;
    return sendMessage();
  }

  // welcome কার্ড। কাঠামোটা innerHTML দিয়েই বসে (এতে কোনো হ্যান্ডলার নেই),
  // কিন্তু কুইক-বাটনগুলো DOM API দিয়ে বানিয়ে addEventListener যুক্ত হয় —
  // আগে ওগুলো click-হ্যান্ডলার অ্যাট্রিবিউটসহ স্ট্রিং হিসেবে বসত।
  function showWelcome() {
    var welcomeDiv = document.createElement('div');
    var card = document.createElement('div');
    card.style.cssText = 'background:#fff;color:#000;border-radius:16px;overflow:hidden;border:1px solid #e5e7eb;margin-bottom:8px';

    var header = document.createElement('div');
    header.style.cssText = 'padding:14px;background:#f9fafb;display:flex;align-items:center;gap:12px;border-bottom:1px solid #e5e7eb';

    var avatar = document.createElement('div');
    avatar.style.cssText = 'width:40px;height:40px;border-radius:50%;background:var(--grad-gold);display:flex;align-items:center;justify-content:center;color:#000;font-weight:800;font-size:18px';
    avatar.textContent = 'L';
    header.appendChild(avatar);

    var titles = document.createElement('div');
    var title = document.createElement('div');
    title.style.cssText = 'font-weight:800;color:#111';
    title.textContent = (config.siteName || '') + ' Support';
    var subtitle = document.createElement('div');
    subtitle.style.cssText = 'font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px';
    subtitle.textContent = t('support_service');
    titles.appendChild(title);
    titles.appendChild(subtitle);
    header.appendChild(titles);
    card.appendChild(header);

    var body = document.createElement('div');
    body.style.cssText = 'padding:16px';
    var intro = document.createElement('p');
    intro.style.cssText = 'font-size:13px;color:#374151;line-height:1.6;margin-bottom:16px';
    intro.textContent = t('welcome_support');
    body.appendChild(intro);

    var list = document.createElement('div');
    list.style.cssText = 'display:flex;flex-direction:column;gap:8px';
    ['q_deposit', 'q_withdraw', 'q_account', 'q_about', 'q_event'].forEach(function (key) {
      var label = t(key);
      if (!label) return;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.style.cssText = 'width:100%;padding:12px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;font-size:13px;font-weight:600;color:#374151;cursor:pointer;text-align:center';
      btn.textContent = label;
      btn.addEventListener('click', function () { sendQuickMessage(label); });
      list.appendChild(btn);
    });
    body.appendChild(list);
    card.appendChild(body);

    welcomeDiv.appendChild(card);
    messagesDiv.appendChild(welcomeDiv);
  }

  function clearFile() {
    selectedFile = null;
    selectedFileType = null;
    fileInput.value = '';
    filePreview.style.display = 'none';
    previewImg.style.display = 'none';
    previewName.textContent = '';
  }

  function appendMessage(text, isAdmin, timestamp, fileUrl, fileType) {
    var div = document.createElement('div');
    div.style.cssText = 'display:flex;justify-content:' + (isAdmin ? 'flex-start' : 'flex-end');

    var inner = document.createElement('div');
    inner.style.cssText = 'max-width:80%;border-radius:12px;padding:10px 14px;' +
      (isAdmin ? 'background:rgba(255,255,255,0.1);color:var(--text-main)' : 'background:var(--grad-gold);color:#000');

    if (fileUrl) {
      if (fileType === 'image') {
        var img = document.createElement('img');
        img.src = fileUrl;
        img.style.cssText = 'max-width:100%;border-radius:8px;margin-bottom:4px;cursor:pointer';
        img.addEventListener('click', function () { window.open(fileUrl, '_blank', 'noopener'); });
        inner.appendChild(img);
      } else if (fileType === 'video') {
        var video = document.createElement('video');
        video.src = fileUrl;
        video.controls = true;
        video.style.cssText = 'max-width:100%;border-radius:8px;margin-bottom:4px';
        inner.appendChild(video);
      }
    }

    if (text) {
      var p = document.createElement('p');
      p.style.cssText = 'font-size:14px;margin:0';
      p.textContent = text;
      inner.appendChild(p);
    }

    var time = document.createElement('span');
    time.style.cssText = 'font-size:10px;opacity:0.6;display:block;margin-top:4px';
    time.textContent = new Date(timestamp).toLocaleTimeString('bn-BD');
    inner.appendChild(time);

    div.appendChild(inner);
    messagesDiv.appendChild(div);
  }

  function scrollToBottom() {
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
  }

  async function sendMessage() {
    var text = messageInput.value.trim();
    if (!text && !selectedFile) return;

    // ==== রিয়েল-টাইম ফ্রন্টএন্ড ফিল্টার — পাঠানোর আগে শেষবার চেক ====
    if (text && window.contentFilterIsBad && window.contentFilterIsBad(text)) {
      window.alert(t('filter_warning', '⚠️ আপনার লেখায় অনুপযুক্ত/অশ্লীল কনটেন্ট আছে। অনুগ্রহ করে ঠিক করে আবার পাঠান।'));
      return;
    }

    var fileUrl = null;
    var fileType = null;

    if (selectedFile) {
      var formData = new FormData();
      formData.append('file', selectedFile);
      try {
        var res = await fetch('/chat/upload', { method: 'POST', body: formData });
        var data = await res.json();
        fileUrl = data.url;
        fileType = selectedFileType;
      } catch (e) {
        window.alert(t('upload_fail'));
        return;
      }
    }

    socket.emit('send_message', {
      senderId: userId,
      receiverId: null,
      message: text,
      isAdmin: false,
      fileUrl: fileUrl,
      fileType: fileType,
      botMode: botMode
    });

    appendMessage(text, false, new Date(), fileUrl, fileType);
    messageInput.value = '';
    clearFile();
    scrollToBottom();
  }

  function init() {
    config = readConfig();
    userId = config.userId;

    messagesDiv = document.getElementById('messages');
    messageInput = document.getElementById('message-input');
    sendButton = document.getElementById('send-button');
    fileInput = document.getElementById('file-input');
    filePreview = document.getElementById('file-preview');
    previewImg = document.getElementById('preview-img');
    previewName = document.getElementById('preview-name');
    if (!messagesDiv || !messageInput || !sendButton) return;

    socket = window.io();
    socket.emit('join', userId);

    // কুইক-মেসেজ চিপ — বার্তাটা data-* অ্যাট্রিবিউটে
    document.querySelectorAll('[data-quick-msg]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        sendQuickMessage(btn.getAttribute('data-quick-msg'));
      });
    });

    // বট / লাইভ এজেন্ট টগল
    document.querySelectorAll('[data-chat-mode]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        setMode(btn.getAttribute('data-chat-mode') === 'bot');
      });
    });

    document.querySelectorAll('[data-clear-file]').forEach(function (btn) {
      btn.addEventListener('click', clearFile);
    });

    fetch('/chat/history')
      .then(function (res) { return res.json(); })
      .then(function (messages) {
        showWelcome();
        if (Array.isArray(messages)) {
          messages.forEach(function (msg) {
            appendMessage(msg.message, msg.is_admin, msg.created_at, msg.file_url, msg.file_type);
          });
          scrollToBottom();
        }
      });

    fileInput.addEventListener('change', function () {
      var file = fileInput.files[0];
      if (!file) return;
      selectedFile = file;
      selectedFileType = file.type.indexOf('video') === 0 ? 'video' : 'image';
      filePreview.style.display = 'block';
      previewName.textContent = file.name;
      if (selectedFileType === 'image') {
        previewImg.style.display = 'block';
        previewImg.src = URL.createObjectURL(file);
      } else {
        previewImg.style.display = 'none';
      }
    });

    sendButton.addEventListener('click', sendMessage);
    messageInput.addEventListener('keypress', function (e) {
      if (e.key === 'Enter') sendMessage();
    });

    // ==== টাইপ করার সময় রিয়েল-টাইম ভিজুয়াল ওয়ার্নিং (লাল বর্ডার + মেসেজ) ====
    if (window.attachContentFilter) {
      window.attachContentFilter('#message-input', { submitButton: sendButton });
    }

    // ==== ব্যাকএন্ড (socket.js) থেকে ব্লক হলে ইউজারকে জানানো ====
    socket.on('message_blocked', function (data) {
      window.alert('⚠️ ' + (data && data.text ? data.text : t('message_blocked', 'মেসেজটি পাঠানো যায়নি।')));
    });

    socket.on('new_message', function (data) {
      if (data.isAdmin) {
        appendMessage(data.message, true, data.createdAt, data.fileUrl, data.fileType);
        scrollToBottom();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
