// tests/security/twoFactorSingleUse.test.js
// ---------------------------------------------------------------------------
// অ্যাডমিন 2FA — ব্যাকআপ কোডের single-use নিশ্চয়তা ও TOTP replay protection।
//
// AUDIT FINDING ১ (ঠিক করা হয়েছে): /admin/login/2fa-এর ব্যাকআপ কোড শাখা lock ছাড়া
// read-modify-write ছিল। verifyAndConsumeBackupCode() রুটের শুরুতে পড়া স্ন্যাপশট
// থেকে "বাকি কোড" বানিয়ে সরাসরি UPDATE করত। ফলে —
//   (ক) একই কোড নিয়ে সমান্তরাল রিকোয়েস্ট এলে সবগুলোই একই স্ন্যাপশট পড়ে valid হতো,
//       অর্থাৎ single-use কোড একাধিকবার ব্যবহারযোগ্য;
//   (খ) দুটো ভিন্ন কোড সমান্তরালে ব্যবহার করলে পরের UPDATE আগেরটাকে ওভাররাইট করত,
//       ফলে খরচ হয়ে যাওয়া কোড তালিকায় ফিরে আসত।
// একই হ্যান্ডলারের TOTP শাখা atomic conditional UPDATE ব্যবহার করে — অর্থাৎ এটা
// নকশা নয়, নজর এড়িয়ে যাওয়া।
//
// AUDIT FINDING ২ (ঠিক করা হয়েছে): /admin/2fa/disable-এ verifyTotpToken() ব্যবহার
// হতো, কোনো replay protection ছাড়া — অথচ লগইন রুট verifyTotpTokenWithStep() +
// atomic step claim ব্যবহার করে। ৩০ সেকেন্ডের উইন্ডোয় একবার দেখা কোড দিয়েই
// দ্বিতীয় ফ্যাক্টর একেবারে বন্ধ করে দেওয়া যেত।
//
// এখানে আসল bcrypt হ্যাশ ও আসল speakeasy TOTP ব্যবহার করা হয়েছে — যাচাইয়ের
// যুক্তি mock করা হয়নি, তাই টেস্ট পাস করা মানে সত্যিই কোডপথটাই পরীক্ষিত।
// ---------------------------------------------------------------------------

const speakeasy = require('speakeasy');
const { pool } = require('../../db');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA, extractCsrfToken } = require('../helpers/app');
const { generateBackupCodes, hashBackupCodes } = require('../../services/twofactor');
const secretBox = require('../../utils/secretBox');

let seq = 0;

// 2FA চালু করা একজন অ্যাডমিন তৈরি — সরাসরি DB-তে, যাতে এনরোলমেন্ট UI-র ওপর
// নির্ভর না করে ঠিক যে অবস্থাটা পরীক্ষা করতে চাই সেটাই বসানো যায়।
async function makeAdminWith2FA(password = 'SecurePass123') {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form').send({
    username, phone: uniquePhone(), password,
    confirmPassword: password, _csrf: token
  });

  const secret = speakeasy.generateSecret({ length: 20 }).base32;
  const codes = generateBackupCodes(5);
  const hashed = await hashBackupCodes(codes);

  const res = await pool.query(
    `UPDATE users SET role = 'admin', totp_secret = $1, totp_enabled = true,
            totp_backup_codes = $2, totp_last_used_step = NULL
     WHERE username = $3 RETURNING id`,
    [secretBox.encrypt(secret), hashed, username]
  );
  return { id: res.rows[0].id, username, password, secret, codes };
}

const remainingCodes = async (id) => {
  const r = await pool.query('SELECT totp_backup_codes FROM users WHERE id=$1', [id]);
  const raw = r.rows[0].totp_backup_codes;
  return raw ? JSON.parse(raw) : [];
};

// প্রতিটা লগইন চেষ্টার জন্য আলাদা এজেন্ট — pending2FA সেশনে বসে, আর
// সমান্তরাল চেষ্টাগুলো যেন একে অপরের সেশন শেয়ার না করে।
async function loginToPending2FA(username, password) {
  const { agent } = await getCsrfAgent('/admin/login');
  const page = await agent.get('/admin/login');
  const csrf = extractCsrfToken(page.text);
  // /admin/login `username` ফিল্ড পড়ে এবং username/email মেলায় — phone নয়।
  await agent.post('/admin/login').set('User-Agent', REALISTIC_UA).type('form')
    .send({ username, password, _csrf: csrf });
  const twofa = await agent.get('/admin/login/2fa');
  // এই অ্যাসারশনটা জরুরি: pending2FA না বসলে পরের POST নীরবে /admin/login-এ
  // রিডাইরেক্ট হতো আর "কিছু বদলায়নি" ধরনের অ্যাসারশনগুলো ভুলভাবে পাস করত।
  if (twofa.status !== 200) {
    throw new Error(`pending2FA অবস্থায় পৌঁছানো যায়নি (status ${twofa.status})`);
  }
  return { agent, csrf: extractCsrfToken(twofa.text) || csrf };
}

afterAll(async () => { await pool.end().catch(() => {}); });

describe('ব্যাকআপ কোড single-use', () => {
  test('একটা ব্যাকআপ কোড ব্যবহারের পর তালিকা থেকে বাদ যায়', async () => {
    const admin = await makeAdminWith2FA();
    expect(await remainingCodes(admin.id)).toHaveLength(5);

    const { agent, csrf } = await loginToPending2FA(admin.username, admin.password);
    await agent.post('/admin/login/2fa').type('form')
      .send({ backupCode: admin.codes[0], _csrf: csrf });

    expect(await remainingCodes(admin.id)).toHaveLength(4);
  });

  test('একই ব্যাকআপ কোড দ্বিতীয়বার আর কাজ করে না', async () => {
    const admin = await makeAdminWith2FA();
    const a = await loginToPending2FA(admin.username, admin.password);
    await a.agent.post('/admin/login/2fa').type('form')
      .send({ backupCode: admin.codes[0], _csrf: a.csrf });
    expect(await remainingCodes(admin.id)).toHaveLength(4);

    const b = await loginToPending2FA(admin.username, admin.password);
    await b.agent.post('/admin/login/2fa').type('form')
      .send({ backupCode: admin.codes[0], _csrf: b.csrf });

    // দ্বিতীয়বার consume হয়নি — তালিকা ৪-এই আছে
    expect(await remainingCodes(admin.id)).toHaveLength(4);
  });

  test('একই কোড নিয়ে ৫টি সমান্তরাল রিকোয়েস্ট — ঠিক একটাই কোড খরচ হয়', async () => {
    const admin = await makeAdminWith2FA();
    const sessions = await Promise.all(
      Array.from({ length: 5 }, () => loginToPending2FA(admin.username, admin.password))
    );

    await Promise.all(sessions.map(s =>
      s.agent.post('/admin/login/2fa').type('form')
        .send({ backupCode: admin.codes[0], _csrf: s.csrf })
    ));

    // lock ছাড়া আগে সবগুলোই একই স্ন্যাপশট পড়ে valid হতো
    expect(await remainingCodes(admin.id)).toHaveLength(4);
  });

  test('ভিন্ন ভিন্ন কোড সমান্তরালে ব্যবহার করলে কোনো খরচ হওয়া কোড ফিরে আসে না', async () => {
    const admin = await makeAdminWith2FA();
    const sessions = await Promise.all(
      Array.from({ length: 3 }, () => loginToPending2FA(admin.username, admin.password))
    );

    await Promise.all(sessions.map((s, i) =>
      s.agent.post('/admin/login/2fa').type('form')
        .send({ backupCode: admin.codes[i], _csrf: s.csrf })
    ));

    // তিনটে ভিন্ন কোড খরচ হওয়ার কথা; ওভাররাইট হলে ৪টা বাকি থাকত
    expect(await remainingCodes(admin.id)).toHaveLength(2);
  });

  test('ভুল ব্যাকআপ কোড কোনো কোড খরচ করে না', async () => {
    const admin = await makeAdminWith2FA();
    const { agent, csrf } = await loginToPending2FA(admin.username, admin.password);
    await agent.post('/admin/login/2fa').type('form')
      .send({ backupCode: 'NOTAREALCODE', _csrf: csrf });

    expect(await remainingCodes(admin.id)).toHaveLength(5);
  });
});

describe('TOTP replay protection', () => {
  test('লগইনে একই TOTP কোড দুবার ব্যবহার করা যায় না', async () => {
    const admin = await makeAdminWith2FA();
    const code = speakeasy.totp({ secret: admin.secret, encoding: 'base32' });

    const a = await loginToPending2FA(admin.username, admin.password);
    await a.agent.post('/admin/login/2fa').type('form').send({ token: code, _csrf: a.csrf });

    const stepAfter = (await pool.query(
      'SELECT totp_last_used_step FROM users WHERE id=$1', [admin.id]
    )).rows[0].totp_last_used_step;
    expect(stepAfter).not.toBeNull();

    // একই কোড আবার — step ইতিমধ্যে claim করা, তাই আর ঢোকা যাবে না
    const b = await loginToPending2FA(admin.username, admin.password);
    const res = await b.agent.post('/admin/login/2fa').type('form')
      .send({ token: code, _csrf: b.csrf });
    const dash = await b.agent.get('/admin');
    expect([302, 200]).toContain(res.status);
    expect(dash.status).toBe(302); // ড্যাশবোর্ডে ঢুকতে পারেনি
  });

  test('/admin/2fa/disable — লগইনে ব্যবহৃত TOTP কোড আর গ্রহণ করা হয় না (replay)', async () => {
    const admin = await makeAdminWith2FA();
    const code = speakeasy.totp({ secret: admin.secret, encoding: 'base32' });

    // প্রথমে লগইন সম্পন্ন — এই কোডের step এখানেই খরচ হয়ে যায়
    const a = await loginToPending2FA(admin.username, admin.password);
    await a.agent.post('/admin/login/2fa').type('form').send({ token: code, _csrf: a.csrf });

    const setup = await a.agent.get('/admin/2fa/setup');
    const csrf = extractCsrfToken(setup.text);
    await a.agent.post('/admin/2fa/disable').type('form')
      .send({ password: admin.password, token: code, _csrf: csrf });

    // replay protection না থাকলে 2FA বন্ধ হয়ে যেত
    const row = await pool.query('SELECT totp_enabled FROM users WHERE id=$1', [admin.id]);
    expect(row.rows[0].totp_enabled).toBe(true);
  });

  test('/admin/2fa/disable — ভুল পাসওয়ার্ড দিলে TOTP step খরচ হয় না', async () => {
    const admin = await makeAdminWith2FA();
    const loginCode = speakeasy.totp({ secret: admin.secret, encoding: 'base32' });
    const a = await loginToPending2FA(admin.username, admin.password);
    await a.agent.post('/admin/login/2fa').type('form').send({ token: loginCode, _csrf: a.csrf });

    const before = (await pool.query(
      'SELECT totp_last_used_step FROM users WHERE id=$1', [admin.id]
    )).rows[0].totp_last_used_step;

    const setup = await a.agent.get('/admin/2fa/setup');
    const csrf = extractCsrfToken(setup.text);
    await a.agent.post('/admin/2fa/disable').type('form')
      .send({ password: 'WrongPassword999', token: loginCode, _csrf: csrf });

    const after = (await pool.query(
      'SELECT totp_last_used_step FROM users WHERE id=$1', [admin.id]
    )).rows[0].totp_last_used_step;
    expect(String(after)).toBe(String(before));
  });
});
