// reset-admin.js
// একবার চালানোর স্ক্রিপ্ট: বিদ্যমান সব admin অ্যাকাউন্ট সরিয়ে দিয়ে, ঠিক একটামাত্র নতুন
// admin অ্যাকাউন্ট (তোমার দেওয়া ইমেইল+পাসওয়ার্ড দিয়ে) তৈরি/আপডেট করে।
//
// ⚠️ গুরুত্বপূর্ণ: শুধু Render-এ environment variable সেট করে "Deploy" করলে এই স্ক্রিপ্ট
// কখনো চলবে না। Deploy শুধু অ্যাপটা (app.js) রিস্টার্ট করে — এই আলাদা ফাইলটা কখনো
// স্বয়ংক্রিয়ভাবে রান হয় না। নিচের ধাপ ৩-এ বলা কমান্ডটা ম্যানুয়ালি Render Shell থেকে
// একবার নিজে চালাতে হবে।
//
// ব্যবহার (২টা উপায়ের যেকোনো একটা):
//
// উপায় ১ (সহজ, সুপারিশকৃত) — Render env var দিয়ে:
//   1. Render Dashboard → তোমার সার্ভিস → Environment → এই দুটো Environment Variable যোগ করো:
//        NEW_ADMIN_EMAIL = তোমার চাওয়া ইমেইল
//        NEW_ADMIN_PASSWORD = তোমার চাওয়া পাসওয়ার্ড
//      (Save করলে Render নিজে থেকেই রিডিপ্লয় করবে — কিন্তু এতে স্ক্রিপ্ট চলে না, শুধু ভ্যারিয়েবল সেভ হয়)
//   2. Render Dashboard → তোমার সার্ভিস → উপরে "Shell" ট্যাবে ক্লিক করো (একটা টার্মিনাল খুলবে)
//   3. সেই Shell-এ টাইপ করো:  node reset-admin.js
//   4. ফলাফল দেখবে সেখানেই — "✅ সম্পন্ন" লেখা আসলে হয়ে গেছে
//
// উপায় ২ — ফাইলে সরাসরি বসিয়ে:
//   1. নিচে NEW_ADMIN_EMAIL_FALLBACK আর NEW_ADMIN_PASSWORD_FALLBACK-এ নিজের চাওয়া ইমেইল ও পাসওয়ার্ড বসাও
//   2. তারপর Render Shell থেকে চালাও:  node reset-admin.js
//
// কাজ শেষ হলে এই ফাইলটা ডিলিট করে দাও এবং Render থেকে NEW_ADMIN_EMAIL/NEW_ADMIN_PASSWORD
// environment variable দুটোও মুছে ফেলো (পাসওয়ার্ড প্লেইনটেক্সটে থাকে বলে)।

const NEW_ADMIN_EMAIL_FALLBACK = 'তোমার-নতুন-ইমেইল@example.com';   // <-- উপায় ২ ব্যবহার করলে এখানে বসাও
const NEW_ADMIN_PASSWORD_FALLBACK = 'তোমার-নতুন-শক্তিশালী-পাসওয়ার্ড'; // <-- উপায় ২ ব্যবহার করলে এখানে বসাও

const NEW_ADMIN_EMAIL = process.env.NEW_ADMIN_EMAIL || NEW_ADMIN_EMAIL_FALLBACK;
const NEW_ADMIN_PASSWORD = process.env.NEW_ADMIN_PASSWORD || NEW_ADMIN_PASSWORD_FALLBACK;

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL সেট করা নেই। প্রোডাকশনের DATABASE_URL দিয়ে চালাও।');
  process.exit(1);
}
if (NEW_ADMIN_EMAIL.includes('example.com') || NEW_ADMIN_PASSWORD.includes('তোমার')) {
  console.error('❌ ইমেইল/পাসওয়ার্ড সেট করা হয়নি। হয় Render-এ NEW_ADMIN_EMAIL/NEW_ADMIN_PASSWORD এনভায়রনমেন্ট ভ্যারিয়েবল সেট করো, অথবা এই ফাইলের উপরে সরাসরি বসাও — তারপর node reset-admin.js চালাও।');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ১. বিদ্যমান সব admin-কে সাধারণ user-এ নামিয়ে দেওয়া (অ্যাকাউন্ট ডিলিট হচ্ছে না, শুধু অ্যাডমিন-অ্যাক্সেস চলে যাচ্ছে)
    const demoted = await client.query(
      `UPDATE users SET role = 'user', role_key = NULL WHERE role = 'admin' RETURNING id, username, email`
    );
    console.log(`✅ ${demoted.rows.length}টা পুরনো admin অ্যাকাউন্ট থেকে অ্যাডমিন-অ্যাক্সেস সরানো হলো:`);
    demoted.rows.forEach(r => console.log(`   - #${r.id} ${r.username} (${r.email || 'no email'})`));

    // ২. নতুন ইমেইলে আগে থেকে কোনো ইউজার থাকলে তাকেই admin বানানো হচ্ছে (পাসওয়ার্ডও নতুন করে সেট হবে);
    //    না থাকলে সম্পূর্ণ নতুন admin অ্যাকাউন্ট তৈরি হবে।
    const hashed = await bcrypt.hash(NEW_ADMIN_PASSWORD, 10);
    const existing = await client.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [NEW_ADMIN_EMAIL]);

    if (existing.rows.length > 0) {
      await client.query(
        `UPDATE users SET password = $1, role = 'admin', role_key = NULL, email_verified = true, is_banned = false WHERE id = $2`,
        [hashed, existing.rows[0].id]
      );
      console.log(`✅ বিদ্যমান ইউজার #${existing.rows[0].id}-কে admin বানানো হলো, পাসওয়ার্ড আপডেট হলো: ${NEW_ADMIN_EMAIL}`);
    } else {
      const username = 'admin_' + Math.random().toString(36).slice(2, 8);
      const created = await client.query(
        `INSERT INTO users (username, email, password, role, coins, referral_code, email_verified)
         VALUES ($1, $2, $3, 'admin', 0, $4, true) RETURNING id`,
        [username, NEW_ADMIN_EMAIL, hashed, username.toUpperCase().slice(0, 8)]
      );
      console.log(`✅ নতুন admin অ্যাকাউন্ট তৈরি হলো — #${created.rows[0].id}, username: ${username}, email: ${NEW_ADMIN_EMAIL}`);
    }

    await client.query('COMMIT');
    console.log('\n✅ সম্পন্ন। এখন /admin/login-এ গিয়ে উপরের ইমেইল ও পাসওয়ার্ড দিয়ে লগইন করো।');
    console.log('⚠️  এই স্ক্রিপ্টে পাসওয়ার্ড প্লেইনটেক্সটে লেখা আছে — এখনই এই ফাইলটা ডিলিট করে দাও।');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ ব্যর্থ হয়েছে, কোনো পরিবর্তন হয়নি:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
})();
