// tests/helpers/cleanup.js
// ---------------------------------------------------------------------------
// টেস্টে তৈরি করা সারি পরিষ্কার করার সাহায্যকারী।
//
// কেন দরকার: পুরো suite একটাই Postgres ডাটাবেস শেয়ার করে এবং CI-তে ১০৮টা suite
// একই প্রসেসে পরপর চলে। কোনো suite যদি অ্যাডমিন ইউজার বা pending KYC/পেমেন্ট
// সারি রেখে যায়, পরে চলা suite-গুলো — যেগুলো গণনা/তালিকার দৈর্ঘ্য যাচাই করে
// (admin, rbac, backup, deferredItemsIntegrity, payment-sslcommerz) — ভুল
// সংখ্যা দেখে ফেল করে।
//
// ব্যাচে চালালে প্রতিটা ব্যাচ আলাদা প্রসেস ও নতুন অবস্থায় শুরু হয়, তাই সমস্যাটা
// লোকালি ধরা পড়ত না — শুধু CI-এর একটানা পূর্ণ রানেই দেখা যেত।
//
// দ্রষ্টব্য: admin_logs.admin_id-তে FK আছে (অডিট ট্রেইল ইচ্ছাকৃতভাবে সুরক্ষিত),
// তাই যে ইউজার অ্যাডমিন অ্যাকশন করেছে তাকে হার্ড-ডিলিট করা যায় না। সেক্ষেত্রে
// role ফিরিয়ে 'user' করা হয় — এতে অ্যাডমিন-গণনা নির্ভর টেস্ট আর প্রভাবিত হয় না।
// ---------------------------------------------------------------------------

const { pool } = require('../../db');

async function cleanupUsers(userIds) {
  const ids = (userIds || []).filter(Boolean);
  if (!ids.length) return;
  try {
    await pool.query('DELETE FROM kyc_requests WHERE user_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM payment_requests WHERE user_id = ANY($1)', [ids]);
    // আগে role নামিয়ে দেওয়া হয় — ডিলিট FK-তে আটকালেও অ্যাডমিন গণনা ঠিক থাকে।
    await pool.query("UPDATE users SET role = 'user', role_key = NULL WHERE id = ANY($1)", [ids]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [ids]).catch(() => {});
  } catch (e) {
    // পরিষ্কার করতে ব্যর্থ হলে টেস্ট ফেল করানো হয় না — role ইতিমধ্যে নামানো হয়েছে।
    console.error('[cleanup] ', e.message);
  }
}

module.exports = { cleanupUsers };
