// reset-admin.js
// একবার চালানোর স্ক্রিপ্ট: বিদ্যমান সব admin অ্যাকাউন্ট সরিয়ে দিয়ে, ঠিক একটামাত্র নতুন
// admin অ্যাকাউন্ট (তোমার দেওয়া ইমেইল+পাসওয়ার্ড দিয়ে) তৈরি/আপডেট করে।
//
// ব্যবহার:
//   1. নিচে NEW_ADMIN_EMAIL আর NEW_ADMIN_PASSWORD-এ নিজের চাওয়া ইমেইল ও পাসওয়ার্ড বসাও
//   2. এই ফাইলটা প্রোডাকশন সার্ভারে রাখো (Render Shell থেকে, অথবা প্রোডাকশন DATABASE_URL
//      এনভায়রনমেন্ট ভ্যারিয়েবল হিসেবে সেট করে লোকাল থেকেও চালানো যায়)
//   3. চালাও:  node reset-admin.js
//   4. কাজ শেষ হলে এই ফাইলটা ডিলিট করে দাও (পাসওয়ার্ড প্লেইনটেক্সটে আছে বলে)

const NEW_ADMIN_EMAIL = 'তোমার-নতুন-ইমেইল@example.com';   // <-- এখানে বসাও
const NEW_ADMIN_PASSWORD = 'তোমার-নতুন-শক্তিশালী-পাসওয়ার্ড'; // <-- এখানে বসাও

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL সেট করা নেই। প্রোডাকশনের DATABASE_URL দিয়ে চালাও।');
  process.exit(1);
}
if (NEW_ADMIN_EMAIL.includes('example.com') || NEW_ADMIN_PASSWORD.includes('তোমার')) {
  console.error('❌ উপরে NEW_ADMIN_EMAIL ও NEW_ADMIN_PASSWORD বদলাওনি — স্ক্রিপ্ট চালানোর আগে বদলাও।');
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
