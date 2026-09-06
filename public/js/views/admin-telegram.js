// views/admin/telegram.ejs-এর ক্লায়েন্ট কোড।
// আগে টেমপ্লেটের ভেতরে ইনলাইন ব্লক ছিল; docs/CSP.md ধাপ ৩ অনুযায়ী বাইরে
// আনা হয়েছে যাতে CSP-র script-src থেকে unsafe-inline সরানো যায়।
// এই ব্লকে কোনো সার্ভার-সাইড মান ছিল না, তাই ফাইলটা স্ট্যাটিক।

function tgResult(html, ok) {
  document.getElementById('testResult').innerHTML =
    '<div class="px-4 py-3 rounded-2xl ' + (ok ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600') + '">' + html + '</div>';
}

async function runTest(sendMessage) {
  tgResult('<span class="livo-spinner"></span> টেস্ট চলছে...', true);
  try {
    const res = await fetch('/admin/telegram/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ send_message: !!sendMessage })
    });
    const data = await res.json();
    if (data.success) {
      tgResult('<i class="fas fa-check-circle"></i> কানেকশন ঠিক আছে' + (data.botUsername ? ' — ' + data.botUsername : '') + (data.messageSent ? ' (টেস্ট মেসেজ পাঠানো হয়েছে)' : ''), true);
    } else {
      tgResult('<i class="fas fa-circle-exclamation"></i> ' + (data.error || 'টেস্ট ব্যর্থ'), false);
    }
  } catch (e) {
    tgResult('<i class="fas fa-circle-exclamation"></i> রিকোয়েস্ট ব্যর্থ: ' + e.message, false);
  }
}

async function sendTest(category) {
  tgResult('<span class="livo-spinner"></span> নোটিফিকেশন পাঠানো হচ্ছে...', true);
  try {
    const res = await fetch('/admin/telegram/test-notification', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: category })
    });
    const data = await res.json();
    tgResult((data.success ? '<i class="fas fa-check-circle"></i> ' + data.message : '<i class="fas fa-circle-exclamation"></i> ' + (data.error || 'পাঠানো যায়নি')), !!data.success);
  } catch (e) {
    tgResult('<i class="fas fa-circle-exclamation"></i> রিকোয়েস্ট ব্যর্থ: ' + e.message, false);
  }
}

// ক্যাটাগরির সারি রানটাইমে স্ট্রিং জোড়া দিয়ে বানানো হয় — তাই "টেস্ট পাঠান"
// বাটনগুলোর জন্য ডেলিগেশন। আগে key সরাসরি onclick-এর ভেতরে বসত, কোনো
// এস্কেপিং ছাড়াই (docs/CSP.md ধাপ ২)।
document.addEventListener('click', function (e) {
  if (!e.target || !e.target.closest) return;
  var test = e.target.closest('[data-send-test]');
  if (test) { sendTest(test.getAttribute('data-send-test')); return; }
  var run = e.target.closest('[data-run-test]');
  if (run) runTest(run.getAttribute('data-run-test') === 'true');
});
