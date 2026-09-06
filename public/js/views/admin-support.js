// views/admin/support.ejs-এর ক্লায়েন্ট কোড।
// docs/CSP.md ধাপ ৩: এই পেজের body একটা JS template literal, তাই সার্ভার
// মান ${...} দিয়ে আসত। এখন সেগুলো JSON ডেটা ব্লক থেকে পড়া হয়।

(function(){
  var cfg = {};
  var el = document.getElementById('admin-supportConfig');
  if (el) { try { cfg = JSON.parse(el.textContent) || {}; } catch (e) { cfg = {}; } }

  let tickets = cfg.tickets;
  let currentUserId = null;

  function filterTickets(term) {
      term = term.toLowerCase();
      document.querySelectorAll('#ticketsList > div').forEach(el => {
          el.style.display = el.textContent.toLowerCase().includes(term) ? '' : 'none';
      });
  }

  function renderMessages(messages) {
      const chatBox = document.getElementById('chatMessages');
      chatBox.innerHTML = '';
      (messages || []).forEach(m => {
          const msgDiv = document.createElement('div');
          msgDiv.className = m.from === 'admin' ? 'flex justify-end' : '';
          const bubble = document.createElement('div');
          bubble.className = (m.from === 'admin' ? 'bg-blue-600 text-white' : 'bg-white border') + ' max-w-[75%] px-4 py-2 rounded-2xl text-sm';
          bubble.textContent = m.text;
          msgDiv.appendChild(bubble);
          chatBox.appendChild(msgDiv);
      });
      chatBox.scrollTop = chatBox.scrollHeight;
  }

  async function openTicket(userId) {
      currentUserId = userId;
      const ticket = tickets.find(t => t.userId === userId);
      if (!ticket) return;

      document.getElementById('chatUserName').textContent = ticket.username;
      document.getElementById('chatUserId').textContent = '#' + ticket.userId;

      document.querySelectorAll('#ticketsList > div').forEach(el => el.classList.remove('border-blue-300', 'bg-blue-50'));
      const activeEl = document.getElementById('ticket-item-' + userId);
      if (activeEl) activeEl.classList.add('border-blue-300', 'bg-blue-50');

      const chatBox = document.getElementById('chatMessages');
      chatBox.innerHTML = '<div class="text-center text-slate-400 text-xs py-6">লোড হচ্ছে...</div>';
      try {
          const res = await fetch('/admin/api/support/' + userId + '/messages');
          const data = await res.json();
          if (data.success) renderMessages(data.messages);
          else chatBox.innerHTML = '<div class="text-center text-red-400 text-xs py-6">মেসেজ লোড করা যায়নি</div>';
      } catch (e) {
          chatBox.innerHTML = '<div class="text-center text-red-400 text-xs py-6">সার্ভার এরর</div>';
      }
  }

  async function sendReply() {
      const input = document.getElementById('replyInput');
      const message = input.value.trim();
      if (!message || !currentUserId) return;
      try {
          const res = await fetch('/admin/api/support/' + currentUserId + '/reply', {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message })
          });
          const data = await res.json();
          if (data.success) {
              const ticket = tickets.find(t => t.userId === currentUserId);
              if (ticket) ticket.status = 'Resolved';
              input.value = '';
              openTicket(currentUserId);
          } else {
              alert('❌ ' + (data.error || 'সমস্যা হয়েছে'));
          }
      } catch (e) { alert('❌ সার্ভার এরর'); }
  }

  async function resolveTicket() {
      if (!currentUserId) return;
      try {
          const res = await fetch('/admin/api/support/' + currentUserId + '/resolve', { method: 'POST' });
          const data = await res.json();
          if (data.success) {
              alert('✅ টিকেট Resolved হিসেবে মার্ক করা হয়েছে');
              location.reload();
          }
      } catch (e) { alert('❌ সার্ভার এরর'); }
  }

  // টিকিট তালিকা রানটাইমে HTML স্ট্রিং জোড়া দিয়ে বানানো হয়, তাই ওই আইটেমগুলো
  // init-এর সময় DOM-এ থাকে না — ডেলিগেশন লাগে। স্থির বাটন দুটো সরাসরি বাঁধা।
  // সার্চ বক্স — আগে onkeyup ছিল; input ইভেন্টে পেস্ট আর অটোফিলও ধরা পড়ে।
  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('[data-filter-tickets]').forEach(function (el) {
      el.addEventListener('input', function () { filterTickets(el.value); });
    });
  });

  document.addEventListener('click', function (e) {
    if (!e.target || !e.target.closest) return;
    var item = e.target.closest('[data-ticket-id]');
    if (item) { openTicket(Number(item.getAttribute('data-ticket-id'))); return; }
    var btn = e.target.closest('[data-support-action]');
    if (!btn) return;
    var action = btn.getAttribute('data-support-action');
    if (action === 'resolve') resolveTicket();
    else if (action === 'reply') sendReply();
  });
})();
