// views/admin/notification-template-form.ejs-এর ক্লায়েন্ট কোড (দুটো ইনলাইন ব্লক একত্রে)।
// docs/CSP.md ধাপ ৩: টেমপ্লেট id JSON ডেটা ব্লক থেকে আসে।

(function(){
  var cfg = {};
  var el = document.getElementById('admin-notification-template-formConfig');
  if (el) { try { cfg = JSON.parse(el.textContent) || {}; } catch (e) { cfg = {}; } }

  (function() {
        const tmplId = cfg.templateId;
        const previewBtn = document.getElementById('previewBtn');
        const previewPanel = document.getElementById('previewPanel');
        const previewSubject = document.getElementById('previewSubject');
        const previewBody = document.getElementById('previewBody');

        previewBtn.addEventListener('click', async () => {
          previewBtn.disabled = true;
          try {
            const res = await fetch('/admin/notification-templates/' + tmplId + '/preview', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({}) });
            const data = await res.json();
            if (!data.success) throw new Error(data.error || 'প্রিভিউ ব্যর্থ');
            previewSubject.textContent = data.subject || '';
            previewBody.innerHTML = data.body || '';
            previewPanel.classList.remove('hidden');
          } catch (e) {
            alert('প্রিভিউ ব্যর্থ: ' + e.message);
          } finally {
            previewBtn.disabled = false;
          }
        });

        const testSendBtn = document.getElementById('testSendBtn');
        const testResult = document.getElementById('testResult');
        testSendBtn.addEventListener('click', async () => {
          const target = document.getElementById('testTarget').value.trim();
          if (!target) { testResult.innerHTML = '<span class="text-red-500">টার্গেট দিন</span>'; return; }
          testSendBtn.disabled = true;
          testResult.innerHTML = '<span class="text-slate-400">পাঠানো হচ্ছে...</span>';
          try {
            const res = await fetch('/admin/notification-templates/' + tmplId + '/test-send', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ target }) });
            const data = await res.json();
            if (!data.success) throw new Error(data.error || 'টেস্ট-সেন্ড ব্যর্থ');
            testResult.innerHTML = '<span class="text-emerald-600 font-medium">✅ ' + (data.message || 'পাঠানো হয়েছে') + (data.simulated ? ' <span class=\'text-amber-500\'>(সিমুলেটেড)</span>' : '') + '</span>';
          } catch (e) {
            testResult.innerHTML = '<span class="text-red-500">❌ ' + e.message + '</span>';
          } finally {
            testSendBtn.disabled = false;
          }
        });
      })();

  (function() {
        const channelSelect = document.getElementById('channelSelect');
        const subjectField = document.getElementById('subjectField');
        function toggleSubject() {
          subjectField.style.display = channelSelect.value === 'email' ? '' : 'none';
        }
        channelSelect.addEventListener('change', toggleSubject);
        toggleSubject();
      })();
})();
