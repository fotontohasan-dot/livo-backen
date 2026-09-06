// public/offline.html-এর রিট্রাই বাটন।
// docs/CSP.md ধাপ ৩: এই পেজটা service worker থেকে পরিবেশিত হয় এবং কোনো
// লেআউট বা শেয়ার করা স্ক্রিপ্ট পায় না, তাই নিজস্ব ফাইল।

// অফলাইন পেজটা service worker থেকে পরিবেশিত হয় এবং কোনো লেআউট বা
// শেয়ার করা স্ক্রিপ্ট পায় না, তাই বাঁধাটা এখানেই।
document.getElementById('offlineRetry').addEventListener('click', function () {
  location.reload();
});
