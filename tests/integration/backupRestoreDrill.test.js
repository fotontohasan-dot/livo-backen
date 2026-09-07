// tests/integration/backupRestoreDrill.test.js
// ---------------------------------------------------------------------------
// Phase ১৮ — ব্যাকআপ রিস্টোর ড্রিল।
//
// রেপোতে ব্যাকআপ নিয়ে আগে থেকেই টেস্ট আছে, কিন্তু সেগুলো *ব্যাকআপ তৈরি হয়
// কি না*, *checksum মেলে কি না*, *ভুল রেকর্ড প্রত্যাখ্যাত হয় কি না* — এসব
// দেখে। একটাও দেখে না যেটা আসল দুর্যোগের সময় জানা দরকার:
//
//     ডেটা হারিয়ে গেলে ব্যাকআপ থেকে সেটা হুবহু ফিরে আসে তো?
//
// এখানে সেটাই করা হয়: আসল সারি লেখা → ব্যাকআপ → সারিগুলো মুছে ফেলা →
// রিস্টোর → প্রতিটা কলাম আগের মানের সাথে মিলিয়ে দেখা।
//
// ড্রিলটা নিজের তৈরি সারির উপরেই চলে (ইউনিক username/phone), তাই অন্য সুটের
// ডেটা ছোঁয় না। রিস্টোর নন-ডেস্ট্রাক্টিভ (INSERT ... ON CONFLICT DO NOTHING),
// তাই অন্য সারিতেও হাত পড়ে না — সেটাও এখানে যাচাই করা হয়েছে।
// ---------------------------------------------------------------------------
const { pool } = require('../../db');
const backupManager = require('../../services/backupManager');

jest.setTimeout(120000);

const TAG = 'drill_' + Date.now();

async function makeUser(suffix) {
  const username = `${TAG}_${suffix}`;
  const phone = '019' + String(Date.now()).slice(-8) + suffix;
  const r = await pool.query(
    `INSERT INTO users (username, phone, password, coins, role, created_at)
     VALUES ($1, $2, $3, $4, 'user', NOW()) RETURNING *`,
    [username, phone, 'hashed_placeholder_' + suffix, 1234 + suffix]
  );
  return r.rows[0];
}

async function snapshot(userId) {
  const u = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
  const t = await pool.query(
    'SELECT * FROM coin_transactions WHERE user_id = $1 ORDER BY id', [userId]
  );
  return { user: u.rows[0], txns: t.rows };
}

describe('Phase ১৮ — ব্যাকআপ রিস্টোর ড্রিল', () => {
  let victim;      // মুছে ফেলা হবে, রিস্টোরে ফিরে আসা উচিত
  let bystander;   // মোছা হবে না, রিস্টোরে অপরিবর্তিত থাকা উচিত
  let before;
  let bystanderBefore;
  let record;

  beforeAll(async () => {
    victim = await makeUser(1);
    bystander = await makeUser(2);

    // ডেটা যেন শুধু একটা টেবিলে না থাকে — সম্পর্কযুক্ত সারিও রাখা হচ্ছে,
    // নইলে FK-নির্ভর রিস্টোর ক্রম যাচাই হত না
    for (const amount of [500, -250, 75]) {
      await pool.query(
        `INSERT INTO coin_transactions (user_id, amount, type, description, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [victim.id, amount, 'drill', `drill txn ${amount}`]
      );
    }

    before = await snapshot(victim.id);
    bystanderBefore = await snapshot(bystander.id);

    // ড্রিল অর্থবহ কি না তার পূর্বশর্ত — ডেটা সত্যিই আছে
    expect(before.user).toBeTruthy();
    expect(before.txns.length).toBe(3);

    record = await backupManager.createDatabaseBackup({ source: 'manual' });
    expect(record.status).toBe('completed');
  });

  afterAll(async () => {
    await pool.query('DELETE FROM coin_transactions WHERE user_id = ANY($1)', [[victim.id, bystander.id]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[victim.id, bystander.id]]);
  });

  test('ব্যাকআপ ফাইলে ড্রিলের সারিগুলো সত্যিই ঢুকেছে', async () => {
    // ফাইলে না থাকলে নিচের রিস্টোর টেস্ট "পাস" করেও কিছু প্রমাণ করত না —
    // এই রেপোতে আগে ঠিক এই ধরনের ফাঁকা-সবুজ টেস্ট ধরা পড়েছে
    // verifyBackupFile/unpackBuffer এক্সপোর্ট করা নয়, তাই ফাইলটা এখানেই খোলা
    // হচ্ছে — ফরম্যাট: প্রথম বাইট flag (0x00 = শুধু gzip, 0x01 = gzip+AES-GCM)
    const buffer = require('fs').readFileSync(backupManager.getBackupFilePath(record));
    expect(buffer[0]).toBe(backupManager.isEncryptionEnabled() ? 0x01 : 0x00);
    if (buffer[0] === 0x01) return; // এনক্রিপ্টেড হলে কনটেন্ট এখান থেকে পড়া যাবে না
    const text = require('zlib').gunzipSync(buffer.subarray(1)).toString('utf8');
    const parsed = JSON.parse(text);
    const users = parsed.tables.users || [];
    const txns = parsed.tables.coin_transactions || [];
    expect(users.some((u) => u.id === victim.id)).toBe(true);
    expect(txns.filter((t) => t.user_id === victim.id).length).toBe(3);
  });

  test('ডেটা মুছে ফেলার পরে রিস্টোর হুবহু ফিরিয়ে আনে', async () => {
    // ১. দুর্যোগ
    await pool.query('DELETE FROM coin_transactions WHERE user_id = $1', [victim.id]);
    await pool.query('DELETE FROM users WHERE id = $1', [victim.id]);

    const gone = await snapshot(victim.id);
    expect(gone.user).toBeUndefined();
    expect(gone.txns.length).toBe(0);

    // ২. রিস্টোর
    const results = await backupManager.restoreBackup(record);
    expect(results).toBeDefined();

    // ৩. যাচাই — "কাজটা সত্যিই ঘটেছে"
    const after = await snapshot(victim.id);
    expect(after.user).toBeTruthy();
    expect(after.txns.length).toBe(3);

    // প্রতিটা কলাম মিলিয়ে দেখা, শুধু সারি ফিরেছে বললেই যথেষ্ট নয়
    for (const col of Object.keys(before.user)) {
      expect({ col, v: after.user[col] }).toEqual({ col, v: before.user[col] });
    }
    const beforeAmounts = before.txns.map((t) => Number(t.amount)).sort((a, b) => a - b);
    const afterAmounts = after.txns.map((t) => Number(t.amount)).sort((a, b) => a - b);
    expect(afterAmounts).toEqual(beforeAmounts);
  });

  test('রিস্টোর নন-ডেস্ট্রাক্টিভ — যে সারি মোছা হয়নি সেটা বদলায় না বা দুবার হয় না', async () => {
    const after = await snapshot(bystander.id);
    expect(after.user).toBeTruthy();
    for (const col of Object.keys(bystanderBefore.user)) {
      expect({ col, v: after.user[col] }).toEqual({ col, v: bystanderBefore.user[col] });
    }
    const dup = await pool.query('SELECT COUNT(*)::int AS n FROM users WHERE id = $1', [bystander.id]);
    expect(dup.rows[0].n).toBe(1);
  });
});
