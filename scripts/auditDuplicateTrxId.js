// scripts/auditDuplicateTrxId.js
// শুধু পড়ার (READ-ONLY) স্ক্রিপ্ট — কোনো ডেটা বদলায় না।
// একই TrxID একাধিক ডিপোজিটে ব্যবহৃত হয়েছে কি না দেখায়, যাতে আপনি পর্যালোচনা করে
// সিদ্ধান্ত নিতে পারেন। ⚠️ approved ডিপোজিট ইতিমধ্যে ব্যালেন্সে যোগ হয়ে থাকতে পারে,
// তাই স্বয়ংক্রিয়ভাবে reject করা হয় না।
// চালান (Render Shell):  node scripts/auditDuplicateTrxId.js
const { pool } = require('../db');

(async () => {
  try {
    const { rows } = await pool.query(`
      SELECT id, user_id, method, amount, transaction_id, status, created_at,
             UPPER(BTRIM(transaction_id)) AS trx_key,
             COUNT(*) OVER (PARTITION BY UPPER(BTRIM(transaction_id))) AS dup_count
      FROM payment_requests
      WHERE type = 'deposit' AND status != 'rejected' AND transaction_id IS NOT NULL
      ORDER BY trx_key, created_at
    `);
    const dups = rows.filter((r) => Number(r.dup_count) > 1);
    if (!dups.length) {
      console.log('✅ কোনো ডুপ্লিকেট TrxID নেই।');
      return;
    }
    console.log(`⚠️ ${new Set(dups.map((r) => r.trx_key)).size}টি TrxID ডুপ্লিকেট:\n`);
    console.table(dups.map((r) => ({
      id: r.id, user: r.user_id, method: r.method, amount: r.amount,
      trx: r.transaction_id, status: r.status, created: r.created_at,
    })));
    console.log(
      '\nপরবর্তী ধাপ: প্রতিটি গ্রুপে প্রথমটি (সবচেয়ে পুরনো) রাখুন। পরেরগুলো pending হলে ' +
      "অ্যাডমিন প্যানেল থেকে reject করুন; approved হলে আগে যাচাই করুন ব্যালেন্স দুইবার যোগ হয়েছে কি না।\n" +
      'ডুপ্লিকেট না থাকলে অ্যাপ রিস্টার্ট করলেই unique index তৈরি হবে।'
    );
  } finally {
    await pool.end();
  }
})().catch((e) => { console.error(e); process.exit(1); });
