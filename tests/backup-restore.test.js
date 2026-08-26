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

describe('Backup path containment', () => {
  // রিগ্রেশন: getBackupFilePath() আগে শুধু path.join(BACKUP_DIR, filename) করত। filename
  // সার্ভার-জেনারেটেড হলেও backup_history নিজেই একটা রিস্টোরযোগ্য টেবিল, তাই ব্যাকআপ পে-লোড
  // থেকে আসা মান ওই কলামে বসতে পারত এবং '../' দিয়ে ডিরেক্টরির বাইরে বেরোনো যেত।
  test('স্বাভাবিক সার্ভার-জেনারেটেড ফাইলনেম আগের মতোই কাজ করে', async () => {
    const rec = await bm.createDatabaseBackup({ source: 'manual' });
    const fp = bm.getBackupFilePath(rec);
    expect(fp).toBe(path.join(path.resolve(bm.BACKUP_DIR), rec.filename));
    expect(fs.existsSync(fp)).toBe(true);
    await bm.deleteBackup(rec.id);
  });

  test.each([
    '../../etc/passwd',
    '..%2f..%2fetc%2fpasswd'.replace(/%2f/g, '/'),
    'sub/dir/file.bak',
    '/etc/passwd',
    '..',
    ''
  ])('ডিরেক্টরির বাইরের পাথ প্রত্যাখ্যাত হয়: %s', (filename) => {
    expect(() => bm.getBackupFilePath({ filename })).toThrow(/অবৈধ/);
  });

  // path.resolve() সিমলিংক অনুসরণ করে না, তাই BACKUP_DIR-এর ভেতরে বসানো একটা সিমলিংক
  // লেক্সিক্যাল চেক পাস করেও বাইরের ফাইল পড়তে/মুছতে পারত — realpath যাচাই সেটা আটকায়।
  test('BACKUP_DIR-এর ভেতরের সিমলিংক বাইরে নির্দেশ করলে প্রত্যাখ্যাত হয়', () => {
    const os = require('os');
    const outside = path.join(os.tmpdir(), `outside-${Date.now()}.txt`);
    fs.writeFileSync(outside, 'SECRET');
    const linkName = `symlink-${Date.now()}.bak`;
    const linkPath = path.join(bm.BACKUP_DIR, linkName);
    fs.symlinkSync(outside, linkPath);
    try {
      expect(() => bm.getBackupFilePath({ filename: linkName })).toThrow(/অবৈধ/);
    } finally {
      fs.unlinkSync(linkPath);
      fs.unlinkSync(outside);
    }
  });

  test('BACKUP_DIR-এর ভেতরে থাকা সিমলিংক (ভেতরের ফাইলেই নির্দেশ করলে) গ্রহণযোগ্য', async () => {
    const rec = await bm.createDatabaseBackup({ source: 'manual' });
    const linkName = `inner-${Date.now()}.bak`;
    fs.symlinkSync(bm.getBackupFilePath(rec), path.join(bm.BACKUP_DIR, linkName));
    try {
      expect(() => bm.getBackupFilePath({ filename: linkName })).not.toThrow();
    } finally {
      fs.unlinkSync(path.join(bm.BACKUP_DIR, linkName));
      await bm.deleteBackup(rec.id);
    }
  });

  test('এখনো তৈরি হয়নি এমন বৈধ ফাইলনেম গ্রহণযোগ্য (তৈরির পথ ভাঙে না)', () => {
    expect(() => bm.getBackupFilePath({ filename: 'db-does-not-exist-yet.bak' })).not.toThrow();
  });

  test('জাল filename-এর রেকর্ড restore/verify করা যায় না', async () => {
    const forged = (await pool.query(
      `INSERT INTO backup_history (type, filename, size_bytes, encrypted, compressed, status, source)
       VALUES ('database','../../etc/passwd',1,false,true,'completed','manual') RETURNING *`
    )).rows[0];
    await expect(bm.restoreBackup(forged)).rejects.toThrow(/অবৈধ/);
    // তবু অ্যাডমিন যেন খারাপ সারিটা মুছে ফেলতে পারে
    await expect(bm.deleteBackup(forged.id)).resolves.toBe(true);
    expect(await bm.getBackupById(forged.id)).toBeNull();
  });
});

describe('Backup path containment — HTTP স্তরে', () => {
  const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('./helpers/app');

  async function makeBackupAdmin() {
    const { agent, token } = await getCsrfAgent('/register');
    const username = uniqueUsername();
    await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
      .send({ username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
    await pool.query("UPDATE users SET role='admin', role_key='super_admin' WHERE username=$1", [username]);
    return { agent, token };
  }

  async function forgeRecord(filename) {
    return (await pool.query(
      `INSERT INTO backup_history (type, filename, size_bytes, encrypted, compressed, status, source)
       VALUES ('database',$1,1,false,true,'completed','manual') RETURNING *`,
      [filename]
    )).rows[0];
  }

  test.each([
    ['ট্রাভার্সাল', '../../etc/passwd'],
    ['অ্যাবসোলিউট পাথ', '/etc/passwd'],
    ['সিবলিং ডিরেক্টরি', '../public/uploads/../../etc/hostname']
  ])('%s filename দিয়ে ডাউনলোড ফাইল সার্ভ করে না', async (_label, filename) => {
    const admin = await makeBackupAdmin();
    const rec = await forgeRecord(filename);
    const res = await admin.agent.get(`/admin/backups/${rec.id}/download`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.text || '').not.toMatch(/root:x:/);
    await pool.query('DELETE FROM backup_history WHERE id=$1', [rec.id]);
  });

  test('ট্রাভার্সাল filename দিয়ে রিস্টোর করা যায় না (এরর পেজে রিডাইরেক্ট)', async () => {
    const admin = await makeBackupAdmin();
    const rec = await forgeRecord('../../etc/passwd');
    const res = await admin.agent.post(`/admin/backups/${rec.id}/restore`)
      .type('form').send({ _csrf: admin.token });
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/error=/);
    await pool.query('DELETE FROM backup_history WHERE id=$1', [rec.id]);
  });

  test('বৈধ ব্যাকআপ আগের মতোই ডাউনলোড হয় (রিগ্রেশন গার্ড)', async () => {
    const admin = await makeBackupAdmin();
    const rec = await bm.createDatabaseBackup({ source: 'manual' });
    const res = await admin.agent.get(`/admin/backups/${rec.id}/download`);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(new RegExp(rec.filename));
    await bm.deleteBackup(rec.id);
  });
});
