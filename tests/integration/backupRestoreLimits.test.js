// রিস্টোরের সীমা এক্সিকিউটেবল করে রাখা।
//
// services/backupManager.js ইচ্ছাকৃতভাবে `ON CONFLICT DO NOTHING` ব্যবহার করে,
// এবং docs/RUNBOOK.md (§৮) ও admin UI-এর confirm ডায়ালগ দুটোই অপারেটরকে বলে:
// "বিদ্যমান ডেটা মোছা হবে না, শুধু নতুন/মিসিং ডেটা যোগ হবে"।
//
// tests/integration/backup.test.js ইতিমধ্যে *মুছে যাওয়া* সারি ফিরে আসা যাচাই
// করে। কিন্তু গ্যারান্টিটার **সীমা** — বদলে যাওয়া সারি ওভাররাইট হয় না, আর
// ব্যাকআপের পরে তৈরি সারি মুছে যায় না — কোথাও পিন করা ছিল না। ফলে ভবিষ্যতে
// কেউ এটাকে destructive restore বানিয়ে ফেললে (বা উল্টোটা ধরে নিয়ে DR প্ল্যান
// লিখলে) কোনো টেস্ট ধরত না।
//
// এই টেস্ট ব্যর্থ হলে সিদ্ধান্তটা বদলেছে — তখন RUNBOOK §৮ ও
// views/admin/backups.ejs-এর confirm বার্তা একসাথে আপডেট করতে হবে।
const backupManager = require('../../services/backupManager');
const { pool } = require('../../db');

jest.setTimeout(180000);

const uname = (p) => `${p}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const phone = () => `01${Math.floor(100000000 + Math.random() * 800000000)}`;

async function makeUser(username, coins) {
  const r = await pool.query(
    `INSERT INTO users (username, password, phone, role, coins) VALUES ($1,'hash',$2,'user',$3) RETURNING id`,
    [username, phone(), coins]
  );
  return r.rows[0].id;
}

const coinsOf = async (id) =>
  Number((await pool.query('SELECT coins FROM users WHERE id=$1', [id])).rows[0].coins);

describe('backup restore — ডকুমেন্টেড non-destructive সীমা', () => {
  test('ব্যাকআপের পরে বদলে যাওয়া সারি restore ওভাররাইট করে না', async () => {
    const name = uname('bkplimit_mut');
    const id = await makeUser(name, 100);

    const record = await backupManager.createDatabaseBackup({ source: 'manual' });
    expect(record.status).toBe('completed');

    // ব্যাকআপের পরে ব্যালেন্স বদলে গেল (যেমন ভুল অ্যাডমিন ক্রেডিট)
    await pool.query('UPDATE users SET coins = 999999 WHERE id = $1', [id]);
    expect(await coinsOf(id)).toBe(999999);

    await backupManager.restoreBackup(record);

    // ON CONFLICT DO NOTHING — সারিটা ইতিমধ্যে আছে, তাই ছোঁয়া হয় না।
    // অর্থাৎ "ভুল ডেটা রোলব্যাক করতে" restore ব্যবহার করা যাবে না।
    expect(await coinsOf(id)).toBe(999999);

    await pool.query('DELETE FROM users WHERE id = $1', [id]);
  });

  test('ব্যাকআপের পরে তৈরি হওয়া সারি restore মুছে ফেলে না', async () => {
    const record = await backupManager.createDatabaseBackup({ source: 'manual' });
    expect(record.status).toBe('completed');

    const name = uname('bkplimit_extra');
    const id = await makeUser(name, 5);

    await backupManager.restoreBackup(record);

    const still = await pool.query('SELECT id FROM users WHERE id = $1', [id]);
    expect(still.rows.length).toBe(1);

    await pool.query('DELETE FROM users WHERE id = $1', [id]);
  });

  test('মুছে যাওয়া সারি ফিরে আসে — গ্যারান্টির যে অংশটা সত্যিই কাজ করে', async () => {
    const name = uname('bkplimit_del');
    const id = await makeUser(name, 4242);

    const record = await backupManager.createDatabaseBackup({ source: 'manual' });
    await pool.query('DELETE FROM users WHERE id = $1', [id]);
    expect((await pool.query('SELECT id FROM users WHERE id=$1', [id])).rows.length).toBe(0);

    await backupManager.restoreBackup(record);

    const back = await pool.query('SELECT coins FROM users WHERE username = $1', [name]);
    expect(back.rows.length).toBe(1);
    expect(Number(back.rows[0].coins)).toBe(4242);

    await pool.query('DELETE FROM users WHERE username = $1', [name]);
  });
});
