// services/sms.js
// ==================== SMS পাঠানোর সার্ভিস (পাবলিক জেনেরিক HTTP গেটওয়ে সাপোর্ট) ====================
// SMS_API_URL/SMS_API_KEY কনফিগার করা না থাকলে এটা প্রকৃতপক্ষে কিছু পাঠায় না — বরং
// স্পষ্টভাবে "সিমুলেটেড" ফলাফল রিটার্ন করে, যাতে Test Send ফিচার মিথ্যা সাফল্য না দেখায়।

async function sendSms(to, message) {
  const apiUrl = process.env.SMS_API_URL;
  const apiKey = process.env.SMS_API_KEY;

  if (!apiUrl || !apiKey) {
    // আগে এখানে `ok: true` ফেরত যেত। কলাররা সাধারণত শুধু `ok` দেখে, তাই
    // গেটওয়ে কনফিগার না থাকলেও ইউজারকে "SMS পাঠানো হয়েছে" দেখানো হতো —
    // অথচ কিছুই পাঠানো হয়নি। OTP বা উইথড্র অ্যালার্টের ক্ষেত্রে ইউজার
    // অপেক্ষা করত এমন একটা বার্তার জন্য যা কখনো আসবে না।
    //
    // এখন fail-closed: `ok: false` ও স্পষ্ট কোড। ডেভেলপমেন্টে বার্তাটা
    // কনসোলে দেখা যায়, যাতে লোকাল টেস্টিং আটকে না যায়।
    if (process.env.NODE_ENV !== 'production') {
      console.log(`📱 [SMS - সিমুলেটেড, গেটওয়ে কনফিগার করা নেই] to=${to}: ${message}`);
    }
    return {
      ok: false,
      simulated: true,
      code: 'SMS_NOT_CONFIGURED',
      message: 'SMS গেটওয়ে কনফিগার করা নেই — বার্তা পাঠানো হয়নি (SMS_API_URL/SMS_API_KEY সেট করুন)'
    };
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
