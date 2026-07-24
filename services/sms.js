// services/sms.js
// ==================== SMS পাঠানোর সার্ভিস (পাবলিক জেনেরিক HTTP গেটওয়ে সাপোর্ট) ====================
// SMS_API_URL/SMS_API_KEY কনফিগার করা না থাকলে এটা প্রকৃতপক্ষে কিছু পাঠায় না — বরং
// স্পষ্টভাবে "সিমুলেটেড" ফলাফল রিটার্ন করে, যাতে Test Send ফিচার মিথ্যা সাফল্য না দেখায়।

async function sendSms(to, message) {
  const apiUrl = process.env.SMS_API_URL;
  const apiKey = process.env.SMS_API_KEY;

  if (!apiUrl || !apiKey) {
    console.log(`📱 [SMS - সিমুলেটেড, গেটওয়ে কনফিগার করা নেই] to=${to}: ${message}`);
    return { ok: true, simulated: true, message: 'SMS গেটওয়ে কনফিগার করা নেই — এটি সিমুলেটেড পাঠানো (SMS_API_URL/SMS_API_KEY সেট করুন লাইভ পাঠাতে)' };
  }

  if (typeof fetch !== 'function') {
    return { ok: false, simulated: false, message: 'এই Node.js ভার্সনে global fetch নেই (Node 18+ দরকার)' };
  }

  try {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ to, message })
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`SMS গেটওয়ে এরর (${res.status}): ${text.slice(0, 200)}`);
    }
    return { ok: true, simulated: false, message: 'SMS পাঠানো হয়েছে' };
  } catch (err) {
    return { ok: false, simulated: false, message: err.message };
  }
}

module.exports = { sendSms };
