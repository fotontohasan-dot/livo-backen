// views/profile/chat.ejs-এর আচরণ: ক্যাটাগরি মেনু, তথ্য-ফর্ম ও লাইভ এজেন্ট চ্যাট।
// কোনো ইনলাইন হ্যান্ডলার নেই (CSP script-src-attr 'none')।
//
// সার্ভার-সাইড মান (user id, ক্যাটাগরি, অনুবাদ) একটা
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

  // ==== মেনু → (ফর্ম) → লাইভ এজেন্ট চ্যাট ====
  // তিনটি ভিউর একটিই একসময় দেখা যায়: ক্যাটাগরি মেনু, তথ্য-ফর্ম, লাইভ চ্যাট।
  var menuPanel, reportPanel, chatPanel, statusBanner, openChatBtn, newReplyNotice;
  var reportForm, reportTitle, reportError, reportSubmit;
  var currentView = null;
  var activeCategory = null;
  var historyReady = null;

  function isActiveStatus(status) {
    return status === 'waiting' || status === 'connected';
  }

  function showView(name) {
    currentView = name;
    menuPanel.hidden = name !== 'menu';
    reportPanel.hidden = name !== 'form';
    chatPanel.hidden = name !== 'chat';
    if (name === 'chat') {
      newReplyNotice.hidden = true;
      scrollToBottom();
    }
  }

  function applyStatus(status) {
    if (!statusBanner) return;
    if (status === 'waiting') statusBanner.textContent = t('chat_status_waiting');
    else if (status === 'connected') statusBanner.textContent = t('chat_status_connected');
    else if (status === 'resolved') statusBanner.textContent = t('chat_status_resolved');
    else statusBanner.textContent = '';
  }

  // এজেন্টের উত্তর এলে ইউজার যেন দেখতে পান। ফর্ম পূরণের মাঝখানে হঠাৎ ভিউ বদলানো
  // হয় না (লেখা হারানোর অনুভূতি হয়) — বদলে ওপরে একটা নোটিশ দেখানো হয়।
  function surfaceAgentActivity() {
    if (openChatBtn) openChatBtn.hidden = false;
    if (currentView === 'form') newReplyNotice.hidden = false;
    else if (currentView !== 'chat') showView('chat');
  }

  function postJson(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { ok: res.ok, data: data || {} };
      });
    });
  }

  // multipart (ফাইলসহ) POST — Content-Type ব্রাউজার নিজেই boundary-সহ বসায়
  function postForm(url, formData) {
    return fetch(url, { method: 'POST', headers: { 'Accept': 'application/json' }, body: formData })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          return { ok: res.ok, data: data || {} };
        });
      });
  }

  var MAX_PROOF_FILES = 4;
  var MAX_PROOF_BYTES = 30 * 1024 * 1024;
  function proofKind(file) {
    if (/^image\//.test(file.type)) return 'image';
    if (/^video\//.test(file.type)) return 'video';
    return null;
  }

  function renderProofList() {
    var list = document.getElementById('report-proof-list');
    var input = reportForm.elements.namedItem('proofs');
    if (!list || !input) return;
    list.textContent = '';
    Array.prototype.forEach.call(input.files, function (file) {
      var li = document.createElement('li');
      li.textContent = (proofKind(file) === 'video' ? '🎥 ' : '🖼 ') + file.name;
      list.appendChild(li);
    });
  }

  function showSubmitted(data) {
    if (data.message) {
      appendMessage(data.message.message, false, data.message.createdAt);
    }
    applyStatus(data.status);
    openChatBtn.hidden = false;
    showView('chat');
  }

  // ---- মেনু ----
  function setMenuBusy(busy) {
    document.querySelectorAll('[data-category]').forEach(function (btn) { btn.disabled = busy; });
  }

  function chooseCategory(key) {
    var category = config.categories && config.categories[key];
    if (!category) return;
    if (category.form) {
      openForm(key);
      return;
    }
    setMenuBusy(true);
    historyReady
      .then(function () { return postJson('/chat/live-agent', { category: key }); })
      .then(function (r) {
        if (!r.ok) { window.alert(r.data.error || t('chat_report_failed')); return; }
        showSubmitted(r.data);
      })
      .catch(function () { window.alert(t('chat_report_failed')); })
      .then(function () { setMenuBusy(false); });
  }

  // ---- ফর্ম ----
  function clearFormError() {
    reportError.hidden = true;
    reportForm.querySelectorAll('input').forEach(function (input) {
      input.classList.remove('sc-input-invalid');
    });
  }

  function showFormError(text, field) {
    reportError.textContent = text;
    reportError.hidden = false;
    var input = field && reportForm.elements.namedItem(field);
    if (input) {
      input.classList.add('sc-input-invalid');
      input.focus();
    }
  }

  function openForm(key) {
    var category = config.categories[key];
    if (activeCategory !== key) { reportForm.reset(); renderProofList(); }
    activeCategory = key;
    clearFormError();
    reportTitle.textContent = category.title;
    reportForm.querySelectorAll('[data-optional]').forEach(function (mark) {
      mark.hidden = category.required.indexOf(mark.getAttribute('data-optional')) !== -1;
    });
    showView('form');
  }

  function submitReport(event) {
    event.preventDefault();
    clearFormError();
    var category = config.categories[activeCategory];
    if (!category) return;

    var body = { category: activeCategory };
    var missing = null;
    ['senderNumber', 'receiverNumber', 'transactionId', 'occurredAt'].forEach(function (field) {
      var input = reportForm.elements.namedItem(field);
      body[field] = input.value.trim();
      if (!missing && !body[field] && category.required.indexOf(field) !== -1) missing = field;
    });
    if (missing) {
      showFormError(t('chat_report_required'), missing);
      return;
    }

    // প্রমাণ: কমপক্ষে ১টি স্ক্রিনশট ও ১টি ভিডিও বাধ্যতামূলক
    var formData = new FormData();
    Object.keys(body).forEach(function (k) { formData.append(k, body[k]); });
    if (category.proofRequired) {
      var proofInput = reportForm.elements.namedItem('proofs');
      var picked = Array.prototype.slice.call(proofInput.files);
      var hasImage = picked.some(function (f) { return proofKind(f) === 'image'; });
      var hasVideo = picked.some(function (f) { return proofKind(f) === 'video'; });
      if (!hasImage) { showFormError(t('chat_report_proof_screenshot_missing'), 'proofs'); return; }
      if (!hasVideo) { showFormError(t('chat_report_proof_video_missing'), 'proofs'); return; }
      if (picked.length > MAX_PROOF_FILES) { showFormError(t('chat_report_proof_too_many'), 'proofs'); return; }
      if (picked.some(function (f) { return f.size > MAX_PROOF_BYTES; })) { showFormError(t('chat_report_proof_too_big'), 'proofs'); return; }
      picked.forEach(function (f) { formData.append('proofs', f); });
    }

    reportSubmit.disabled = true;
    historyReady
      .then(function () { return postForm('/chat/report', formData); })
      .then(function (r) {
        if (!r.ok) {
          showFormError(r.data.error || t('chat_report_failed'), r.data.field);
          return;
        }
        reportForm.reset();
        renderProofList();
        activeCategory = null;
        showSubmitted(r.data);
        if (r.data.duplicate) statusBanner.textContent = t('chat_report_duplicate');
      })
      .catch(function () { showFormError(t('chat_report_failed')); })
      .then(function () { reportSubmit.disabled = false; });
  }

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
    inner.style.cssText = 'max-width:85%;border-radius:12px;padding:8px 11px;' +
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
      p.style.cssText = 'font-size:13px;margin:0;white-space:pre-wrap;overflow-wrap:anywhere';
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
      fileType: fileType
    });

    appendMessage(text, false, new Date(), fileUrl, fileType);
    openChatBtn.hidden = false;
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

    menuPanel = document.getElementById('support-menu');
    reportPanel = document.getElementById('report-panel');
    chatPanel = document.getElementById('live-chat-panel');
    statusBanner = document.getElementById('support-status-banner');
    openChatBtn = document.getElementById('open-chat');
    newReplyNotice = document.getElementById('new-reply-notice');
    reportForm = document.getElementById('report-form');
    reportTitle = document.getElementById('report-title');
    reportError = document.getElementById('report-error');
    reportSubmit = document.getElementById('report-submit');
    if (!menuPanel || !reportPanel || !chatPanel || !reportForm) return;

    document.querySelectorAll('[data-category]').forEach(function (btn) {
      btn.addEventListener('click', function () { chooseCategory(btn.getAttribute('data-category')); });
    });
    document.querySelectorAll('[data-show-menu]').forEach(function (btn) {
      btn.addEventListener('click', function () { showView('menu'); });
    });
    openChatBtn.addEventListener('click', function () { showView('chat'); });
    newReplyNotice.addEventListener('click', function () { showView('chat'); });
    reportForm.addEventListener('submit', submitReport);
    var proofsField = reportForm.elements.namedItem('proofs');
    if (proofsField) proofsField.addEventListener('change', renderProofList);

    socket = window.livoSocket();
    socket.emit('join', userId);

    document.querySelectorAll('[data-clear-file]').forEach(function (btn) {
      btn.addEventListener('click', clearFile);
    });

    var statusReady = fetch('/chat/status')
      .then(function (res) { return res.json(); })
      .then(function (data) { applyStatus(data && data.status); return data && data.status; })
      .catch(function () { return null; });

    historyReady = fetch('/chat/history')
      .then(function (res) { return res.json(); })
      .then(function (messages) {
        if (!Array.isArray(messages)) return [];
        messagesDiv.textContent = '';
        messages.forEach(function (msg) {
          appendMessage(msg.message, msg.is_admin, msg.created_at, msg.file_url, msg.file_type);
        });
        scrollToBottom();
        return messages;
      })
      .catch(function () { return []; });

    // হেল্প সেন্টার থেকে ?category=deposit|withdraw দিয়ে এলে সরাসরি ফর্ম খোলে
    var requested = new URLSearchParams(window.location.search).get('category');
    var preset = requested && Object.prototype.hasOwnProperty.call(config.categories || {}, requested)
      && config.categories[requested].form ? requested : null;
    if (preset) openForm(preset);

    // চলমান কথোপকথন বা না-পড়া উত্তর থাকলে চ্যাট, নাহলে আগে মেনু
    Promise.all([statusReady, historyReady]).then(function (results) {
      var messages = results[1];
      openChatBtn.hidden = messages.length === 0;
      var unread = messages.some(function (m) { return m.is_admin && !m.is_read; });
      if (currentView === null) {
        showView(isActiveStatus(results[0]) || unread ? 'chat' : 'menu');
      } else if (unread) {
        surfaceAgentActivity();
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
        surfaceAgentActivity();
      }
    });

    // অ্যাডমিন accept/resolve করলে (routes/chat.js) রিয়েল-টাইমে ব্যানার/প্যানেল আপডেট
    socket.on('support_status', function (data) {
      var status = data && data.status;
      applyStatus(status);
      if (status === 'connected' && currentView === 'menu') showView('chat');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
