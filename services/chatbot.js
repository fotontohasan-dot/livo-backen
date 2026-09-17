// FAQ কীওয়ার্ড রিপ্লাই। SambaNova AI ফলব্যাক সরানো হয়েছে — জটিল/AI-চালিত
// প্রশ্নের জন্য এখন Chatbase এজেন্ট ব্যবহার হয় (দেখুন views/partials/chatbase-widget.ejs),
// কীওয়ার্ড ম্যাচ না পেলে এখানে শুধু Live agent-এ পাঠানো হয়।
const FAQ = [
  { keywords: ['deposit', 'ডিপোজিট', 'টাকা জমা'], reply: 'ডিপোজিট করতে প্রোফাইল > Deposit পেজে যান। সমস্যা হলে সাপোর্টে জানান।' },
  { keywords: ['withdraw', 'উত্তোলন', 'টাকা তোলা'], reply: 'উত্তোলনের জন্য প্রোফাইল > Withdraw পেজে যান। KYC সম্পন্ন থাকা লাগবে।' },
  { keywords: ['kyc'], reply: 'KYC ভেরিফিকেশনের জন্য প্রোফাইল > KYC পেজে গিয়ে ডকুমেন্ট আপলোড করুন।' },
  { keywords: ['bonus', 'বোনাস'], reply: 'বর্তমান বোনাস অফার দেখতে Promotions পেজে যান।' },
];

function findFaqReply(message) {
  const lower = (message || '').toLowerCase();
  for (const item of FAQ) {
    if (item.keywords.some(k => lower.includes(k.toLowerCase()))) {
      return item.reply;
    }
  }
  return null;
}

async function getBotReply(message) {
  const faq = findFaqReply(message);
  if (faq) return faq;
  return 'দুঃখিত, এই প্রশ্নের সরাসরি উত্তর আমার কাছে নেই। নিচের ডান কোণায় থাকা চ্যাট আইকনে ট্যাপ করে আমাদের AI সাপোর্ট এজেন্টের সাথে কথা বলুন, অথবা "Live agent" বেছে নিন।';
}

module.exports = { getBotReply };
