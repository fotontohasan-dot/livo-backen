// ডেটাবেস ব্যাকআপ/রিস্টোরের রিগ্রেশন টেস্ট।
// রিস্টোর নন-ডেস্ট্রাক্টিভ (ON CONFLICT DO NOTHING), তাই টেস্টে সিন্থেটিক ব্যাকআপ পে-লোড
// বানিয়ে সেটাই রিস্টোর করা হয় — বিদ্যমান কোনো সারি ওভাররাইট বা মুছে যায় না।
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const crypto = require('crypto');
const bm = require('../services/backupManager');
const { pool } = require('../db');

function writeSyntheticBackup(tables) {
  if (!fs.existsSync(bm.BACKUP_DIR)) fs.mkdirSync(bm.BACKUP_DIR, { recursive: true });
  const json = JSON.stringify({ type: 'database', generated_at: new Date().toISOString(), tables });
  const packed = Buffer.concat([Buffer.from([0x00]), zlib.gzipSync(Buffer.from(json, 'utf8'))]);
  const filename = `test-restore-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.bak`;
  fs.writeFileSync(path.join(bm.BACKUP_DIR, filename), packed);
  return {
    id: null,
    type: 'database',
    filename,
    status: 'completed',
    checksum: crypto.createHash('sha256').update(packed).digest('hex')
  };
}

describe('Database backup', () => {
  test('ব্যাকআপ ফাইল তৈরি হয়, খালি নয়, এবং checksum মেলে', async () => {
    const rec = await bm.createDatabaseBackup({ source: 'manual' });
    expect(rec.status).toBe('completed');
    const fp = bm.getBackupFilePath(rec);
    expect(fs.existsSync(fp)).toBe(true);
    const buf = fs.readFileSync(fp);
    expect(buf.length).toBeGreaterThan(0);
    expect(Number(rec.size_bytes)).toBe(buf.length);
    expect(crypto.createHash('sha256').update(buf).digest('hex')).toBe(rec.checksum);
    await bm.deleteBackup(rec.id);
  });

  test('ডাম্পে ইউজার/সেটিংস/পেমেন্ট ডেটা থাকে, session টেবিল বাদ যায়', async () => {
    const rec = await bm.createDatabaseBackup({ source: 'manual' });
    const buf = fs.readFileSync(bm.getBackupFilePath(rec));
    const parsed = JSON.parse(zlib.gunzipSync(buf.subarray(1)).toString('utf8'));
    expect(parsed.type).toBe('database');
    expect(Object.keys(parsed.tables)).toEqual(expect.arrayContaining(
      ['users', 'site_settings', 'payment_requests', 'coin_transactions']
    ));
    expect(Object.keys(parsed.tables)).not.toContain('session');
    await bm.deleteBackup(rec.id);
  });

  test('checksum না মিললে রিস্টোর বাতিল হয়', async () => {
    const rec = await bm.createDatabaseBackup({ source: 'manual' });
    await expect(bm.restoreBackup({ ...rec, checksum: 'deadbeef' })).rejects.toThrow(/Checksum/);
    await bm.deleteBackup(rec.id);
  });
});

describe('Database restore', () => {
  // রিগ্রেশন: coin_transactions RESTORE_ORDER-এ ছিল না — ব্যাকআপে ডেটা থাকা সত্ত্বেও রিস্টোরের
  // পর ওয়ালেট লেজার খালি থাকত, যদিও users.coins রিস্টোর হতো।
  test('ইউজার, ওয়ালেট লেজার ও সেটিংস — তিনটাই রিস্টোর হয়', async () => {
    const stamp = Date.now();
    const uid = 900000000 + (stamp % 10000000);
    const rec = writeSyntheticBackup({
      users: [{ id: uid, username: `rst${stamp}`.slice(0, 20), phone: `018${String(stamp).slice(-8)}`, password: 'x'.repeat(20), coins: 4242, role: 'user' }],
      coin_transactions: [{ id: uid, user_id: uid, amount: 4242, type: 'deposit', description: 'restore regression' }],
      site_settings: [{ key: `restore_marker_${stamp}`, value: String(stamp) }]
    });

    const results = await bm.restoreBackup(rec);
    expect(results.users).toBe(1);
    expect(results.coin_transactions).toBe(1);
    expect(results.site_settings).toBe(1);
    expect(results._skipped).toBeUndefined();

    const u = await pool.query('SELECT coins FROM users WHERE id=$1', [uid]);
    expect(Number(u.rows[0].coins)).toBe(4242);
    const tx = await pool.query('SELECT COUNT(*) c FROM coin_transactions WHERE user_id=$1', [uid]);
    expect(Number(tx.rows[0].c)).toBe(1);
    const s = await pool.query('SELECT value FROM site_settings WHERE key=$1', [`restore_marker_${stamp}`]);
    expect(s.rows[0].value).toBe(String(stamp));

    await pool.query('DELETE FROM coin_transactions WHERE user_id=$1', [uid]);
    await pool.query('DELETE FROM users WHERE id=$1', [uid]);
    await pool.query('DELETE FROM site_settings WHERE key=$1', [`restore_marker_${stamp}`]);
    fs.unlinkSync(bm.getBackupFilePath(rec));
  });

  // রিগ্রেশন: users.referred_by_id নিজের টেবিলকেই রেফার করে। রেফারার যদি ডাম্পে পরে থাকে,
  // আগে সেই সারিটা FK violation-এ নীরবে হারিয়ে যেত।
  test('পরে আসা রেফারারকে রেফার করা ইউজারও রিস্টোর হয় এবং লিংক ঠিক থাকে', async () => {
    const stamp = Date.now();
    const referredId = 910000000 + (stamp % 1000000);
    const referrerId = referredId + 1; // রেফারার ডাম্পে পরে, id-ও বড়
    const rec = writeSyntheticBackup({
      users: [
        { id: referredId, username: `rfd${stamp}`.slice(0, 20), phone: `017${String(stamp).slice(-8)}`, password: 'x'.repeat(20), coins: 0, role: 'user', referred_by_id: referrerId },
        { id: referrerId, username: `rfr${stamp}`.slice(0, 20), phone: `016${String(stamp).slice(-8)}`, password: 'x'.repeat(20), coins: 0, role: 'user', referred_by_id: null }
      ]
    });

    const results = await bm.restoreBackup(rec);
    expect(results.users).toBe(2);
    expect(results._skipped).toBeUndefined();

    const link = await pool.query('SELECT referred_by_id FROM users WHERE id=$1', [referredId]);
    expect(Number(link.rows[0].referred_by_id)).toBe(referrerId);

    await pool.query('UPDATE users SET referred_by_id=NULL WHERE id=$1', [referredId]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[referredId, referrerId]]);
    fs.unlinkSync(bm.getBackupFilePath(rec));
  });

  // রিগ্রেশন: roles RESTORE_ORDER-এ ছিল না, তাই users.role_key → roles(key) FK ভেঙে
  // role_key সেট করা প্রতিটা স্টাফ অ্যাকাউন্ট রিস্টোরে হারিয়ে যেত।
  test('কাস্টম role সহ স্টাফ অ্যাকাউন্ট রিস্টোরে হারায় না', async () => {
    const stamp = Date.now();
    const roleKey = `test_role_${stamp}`;
    const uid = 920000000 + (stamp % 1000000);
    const rec = writeSyntheticBackup({
      roles: [{ id: 900000 + (stamp % 100000), key: roleKey, name: 'Test Role', description: null, is_system: false, permissions: { dashboard_view: true } }],
      users: [{ id: uid, username: `stf${stamp}`.slice(0, 20), phone: `015${String(stamp).slice(-8)}`, password: 'x'.repeat(20), coins: 0, role: 'admin', role_key: roleKey }]
    });

    const results = await bm.restoreBackup(rec);
    expect(results.roles).toBe(1);
    expect(results.users).toBe(1);
    expect(results._skipped).toBeUndefined();

    const u = await pool.query('SELECT role_key FROM users WHERE id=$1', [uid]);
    expect(u.rows[0].role_key).toBe(roleKey);

    await pool.query('DELETE FROM users WHERE id=$1', [uid]);
    await pool.query('DELETE FROM roles WHERE key=$1', [roleKey]);
    fs.unlinkSync(bm.getBackupFilePath(rec));
  });
});
