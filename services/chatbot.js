// FAQ কীওয়ার্ড রিপ্লাই + SambaNova AI ফলব্যাক
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

async function getAiReply(message) {
  try {
    const res = await fetch('https://api.sambanova.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.SAMBANOVA_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'Meta-Llama-3.3-70B-Instruct',
        messages: [
          { role: 'system', content: 'তুমি Livo বেটিং/গেমিং প্ল্যাটফর্মের সাপোর্ট বট। বাংলায় সংক্ষিপ্ত ও সহায়ক উত্তর দাও।' },
          { role: 'user', content: message }
        ],
        max_tokens: 300,
        temperature: 0.3
      })
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content || 'দুঃখিত, এই মুহূর্তে উত্তর দিতে পারছি না। এডমিন শীঘ্রই যোগাযোগ করবে।';
  } catch (err) {
    console.error('SambaNova bot error:', err.message);
    return 'দুঃখিত, বট এখন সাড়া দিচ্ছে না। এডমিন শীঘ্রই যোগাযোগ করবে।';
  }
}

async function getBotReply(message) {
  const faq = findFaqReply(message);
  if (faq) return faq;
  return getAiReply(message);
}

module.exports = { getBotReply };
