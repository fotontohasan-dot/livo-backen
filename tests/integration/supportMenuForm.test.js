// লাইভ চ্যাট: ক্যাটাগরি মেনু → তথ্য ফর্ম → ব্যাকএন্ড → অ্যাডমিন (Telegram), শুধু লাইভ এজেন্ট।
// আসল PostgreSQL; শুধু api.telegram.org মক।
Object.assign(process.env, {
  TELEGRAM_BOT_TOKEN: '123456789:AAF-abcdefghijklmnopqrstuvwxyz012345',
  TELEGRAM_ADMIN_CHAT_ID: '111'
});

// Cloudinary মক: নেটওয়ার্ক ছাড়াই আপলোড সফল ধরা হয়; destroy কল ট্র্যাক করা হয়
let destroyed = [];
jest.mock('cloudinary', () => {
  const actual = jest.requireActual('cloudinary');
  let n = 0;
  actual.v2.uploader.upload_stream = (opts, cb) => ({
    end: () => { n += 1; cb(null, { secure_url: `https://res.cloudinary.test/${opts.resource_type}/${n}`, public_id: `bet420/support-reports/f${n}` }); }
  });
  actual.v2.uploader.destroy = async (id) => { destroyed.push(id); return { result: 'ok' }; };
  return actual;
});

const { app, getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const { pool } = require('../../db');
const telegramConfig = require('../../services/telegramConfig');
const { validateReport, parseOccurredAt } = require('../../services/supportReports');
const { parseSupportReplyTarget } = require('../../services/telegramAdmin');

const realFetch = global.fetch;
let sent = [];

beforeAll(async () => {
  global.fetch = jest.fn(async (url, options) => {
    if (!String(url).startsWith('https://api.telegram.org/')) return realFetch(url, options);
    sent.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  });
  await pool.query('DELETE FROM telegram_settings');
  telegramConfig.invalidateCache();
});
afterAll(() => { global.fetch = realFetch; });
beforeEach(() => { sent = []; destroyed = []; });

async function newUser() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername('sup');
  await agent.post('/register').type('form').send({
    username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token
  });
  const id = (await pool.query('SELECT id FROM users WHERE username = $1', [username])).rows[0].id;
  const page = await agent.get('/chat');
  const csrf = /<meta name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  const post = (url, body) => agent.post(url).set('X-CSRF-Token', csrf).set('Accept', 'application/json').send(body);
  return { id, username, agent, page, post, csrf };
}
const telegramText = async () => {
  for (let i = 0; i < 200 && !sent.length; i++) await new Promise((r) => setTimeout(r, 25));
  return sent.length ? sent[sent.length - 1].text : null;
};
const status = async (id) => (await pool.query('SELECT support_status FROM users WHERE id=$1', [id])).rows[0].support_status;
const messages = async (id) => (await pool.query('SELECT * FROM chat_messages WHERE sender_id=$1 ORDER BY id', [id])).rows;
const reports = async (id) => (await pool.query(
  `SELECT *, to_char(occurred_at, 'YYYY-MM-DD HH24:MI') AS at FROM support_reports WHERE user_id=$1 ORDER BY id`, [id])).rows;

// ছোট কিন্তু magic byte-সহ বৈধ ফাইল
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(32)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(32)]);

// multipart রিপোর্ট জমা: fields + প্রমাণ-ফাইল (ডিফল্ট: ১টি স্ক্রিনশট + ১টি ভিডিও)
function postReport(u, fields, files = [
  { buf: PNG, name: 'shot.png', type: 'image/png' },
  { buf: MP4, name: 'clip.mp4', type: 'video/mp4' }
]) {
  const req = u.agent.post('/chat/report').set('X-CSRF-Token', u.csrf).set('Accept', 'application/json');
  Object.entries(fields).forEach(([k, v]) => req.field(k, v));
  files.forEach((f) => req.attach('proofs', f.buf, { filename: f.name, contentType: f.type }));
  return req;
}
const proofRows = async (reportId) => (await pool.query(
  'SELECT * FROM support_report_files WHERE report_id=$1 ORDER BY id', [reportId])).rows;

const DEPOSIT = {
  category: 'deposit', senderNumber: '01711-000000', receiverNumber: '০১৮১২০০০০০০',
  transactionId: 'AB12CD34', occurredAt: '2026-01-15T14:30'
};

describe('পেজ', () => {
  test('মেনু ও ফর্ম আছে; কোনো AI/বট নেই', async () => {
    const u = await newUser();
    for (const key of ['deposit', 'withdraw', 'bonus', 'login', 'kyc', 'ticket', 'football', 'other']) {
      expect(u.page.text).toContain(`data-category="${key}"`);
    }
    for (const field of ['senderNumber', 'receiverNumber', 'transactionId', 'occurredAt']) {
      expect(u.page.text).toContain(`name="${field}"`);
    }
    expect(u.page.text).not.toMatch(/chatbase|<iframe/i);
    expect(u.page.headers['content-security-policy']).not.toMatch(/chatbase/);
    expect((await u.agent.get('/profile/chat')).text).toContain('data-category="deposit"');
    const help = await u.agent.get('/help-center');
    expect(help.text).toContain('/chat?category=deposit');
    expect(help.text).not.toContain('chat-input');
  });
});

describe('যাচাই', () => {
  test.each([
    [{ category: 'bonus' }, 'category'],
    [{ category: '__proto__' }, 'category'],
    [{ ...DEPOSIT, senderNumber: '' }, 'senderNumber'],
    [{ ...DEPOSIT, receiverNumber: 'abc' }, 'receiverNumber'],
    [{ ...DEPOSIT, transactionId: '<b>x</b>' }, 'transactionId'],
    [{ ...DEPOSIT, transactionId: ['AB12CD34'] }, 'transactionId'],
    [{ ...DEPOSIT, occurredAt: '2026-02-31T10:00' }, 'occurredAt'],
    [{ ...DEPOSIT, occurredAt: '2999-01-01T10:00' }, 'occurredAt']
  ])('ভুল ইনপুট %#', (body, field) => {
    expect(validateReport(body)).toEqual({ ok: false, field });
  });

  test('উইথড্রয় প্রেরক নম্বর ও TrxID ঐচ্ছিক; রিসিভার ও সময় লাগে', () => {
    const base = { category: 'withdraw', receiverNumber: '01812000000', occurredAt: '2026-01-15T14:30' };
    expect(validateReport(base).data).toMatchObject({ senderNumber: null, transactionId: null });
    expect(validateReport({ ...base, receiverNumber: '' }).field).toBe('receiverNumber');
  });

  test('সময় বাংলাদেশ ঘড়িতে যাচাই হয়', () => {
    const now = new Date('2026-01-15T10:00:00Z'); // ঢাকায় ১৬:০০
    expect(parseOccurredAt('2026-01-15T15:59', now)).toBe('2026-01-15 15:59');
    expect(parseOccurredAt('2026-01-15T17:30', now)).toBeNull();
  });
});

describe('ফর্ম জমা', () => {
  test('ডেটাবেজ, চ্যাট, স্ট্যাটাস ও Telegram ফরম্যাট', async () => {
    const u = await newUser();
    const res = await postReport(u, DEPOSIT);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'waiting', duplicate: false });

    const [row] = await reports(u.id);
    expect(row).toMatchObject({
      category: 'deposit', sender_number: '01711000000', receiver_number: '01812000000',
      transaction_id: 'AB12CD34', at: '2026-01-15 14:30'
    });
    const [chat] = await messages(u.id);
    expect(row.chat_message_id).toBe(chat.id);
    expect(chat.is_admin).toBe(false);
    expect(chat.message).toContain('AB12CD34');
    expect(chat.message).toContain(`#R${row.id}`);
    expect(await status(u.id)).toBe('waiting');

    // প্রমাণ-ফাইল ডেটাবেজে সংরক্ষিত — এজেন্ট রিপোর্টের সাথে দেখতে পায়
    const proofs = await proofRows(row.id);
    expect(proofs.map((p) => p.file_type).sort()).toEqual(['image', 'video']);
    expect(proofs.every((p) => p.file_url.startsWith('https://res.cloudinary.test/'))).toBe(true);
    expect(chat.message).toContain('🖼 1');

    const text = await telegramText();
    expect(text).toContain('https://res.cloudinary.test/');
    expect(text.split('\n')[0]).toBe(`🎫 SUPPORT #U${u.id} #M${chat.id}`);
    expect(text).toContain('জমার সমস্যা');
    expect(text).toContain('প্রেরকের নম্বর: <code>01711000000</code>');
    expect(text).toContain('রিসিভার নম্বর: <code>01812000000</code>');
    expect(text).toContain('ট্রানজ্যাকশন আইডি: <code>AB12CD34</code>');
    expect(text).toContain('সময়: 2026-01-15 14:30');
    // এই নোটিফিকেশনে Reply দিলে সঠিক ইউজার চেনা যায়
    expect(parseSupportReplyTarget({ from: { id: 123456789 }, text }, process.env.TELEGRAM_BOT_TOKEN)).toBe(u.id);
  });

  test('একই তথ্য আবার জমা দিলে ডুপ্লিকেট রিপোর্ট/নোটিফিকেশন হয় না', async () => {
    const u = await newUser();
    const both = await Promise.all([postReport(u, DEPOSIT), postReport(u, DEPOSIT)]);
    expect(both.map((r) => r.body.duplicate).sort()).toEqual([false, true]);
    expect(await reports(u.id)).toHaveLength(1);
    expect(await messages(u.id)).toHaveLength(1);
    await telegramText();
    await new Promise((r) => setTimeout(r, 200));
    expect(sent).toHaveLength(1);
  });

  test('ভুল তথ্য 400 ও কিছু জমা হয় না; লগইন ছাড়া ও CSRF ছাড়া চলে না', async () => {
    const u = await newUser();
    const bad = await postReport(u, { ...DEPOSIT, transactionId: '' });
    expect(bad.status).toBe(400);
    expect(bad.body.field).toBe('transactionId');
    expect(await reports(u.id)).toHaveLength(0);
    expect((await u.agent.post('/chat/report').set('Accept', 'application/json').field('category', 'deposit')).status).toBe(403);
    const request = require('supertest');
    const anon = await request(app).post('/chat/report').set('User-Agent', REALISTIC_UA).send(DEPOSIT);
    expect(anon.status).not.toBe(200);
  });

  test('প্রমাণ বাধ্যতামূলক: স্ক্রিনশট বা ভিডিও না থাকলে 400, কিছু জমা/আপলোড হয় না', async () => {
    const u = await newUser();
    const none = await postReport(u, DEPOSIT, []);
    expect(none.status).toBe(400);
    expect(none.body.field).toBe('proofs');
    const onlyShot = await postReport(u, DEPOSIT, [{ buf: PNG, name: 'shot.png', type: 'image/png' }]);
    expect(onlyShot.status).toBe(400);
    expect(onlyShot.body.error).toMatch(/ভিডিও/);
    const onlyVideo = await postReport(u, DEPOSIT, [{ buf: MP4, name: 'clip.mp4', type: 'video/mp4' }]);
    expect(onlyVideo.status).toBe(400);
    expect(onlyVideo.body.error).toMatch(/স্ক্রিনশট/);
    expect(await reports(u.id)).toHaveLength(0);
  });

  test('ফাইলের আসল কনটেন্ট না মিললে (নকল extension) 400', async () => {
    const u = await newUser();
    const fake = await postReport(u, DEPOSIT, [
      { buf: Buffer.from('<?php echo 1; ?> padding padding'), name: 'shot.png', type: 'image/png' },
      { buf: MP4, name: 'clip.mp4', type: 'video/mp4' }
    ]);
    expect(fake.status).toBe(400);
    expect(await reports(u.id)).toHaveLength(0);
  });

  test('৪টির বেশি ফাইল 400', async () => {
    const u = await newUser();
    const many = await postReport(u, DEPOSIT, Array.from({ length: 5 }, (_, i) =>
      ({ buf: PNG, name: `s${i}.png`, type: 'image/png' })));
    expect(many.status).toBe(400);
    expect(await reports(u.id)).toHaveLength(0);
  });

  test('ডুপ্লিকেট জমায় এতিম আপলোড Cloudinary থেকে মোছা হয়', async () => {
    const u = await newUser();
    expect((await postReport(u, DEPOSIT)).body.duplicate).toBe(false);
    destroyed = [];
    expect((await postReport(u, DEPOSIT)).body.duplicate).toBe(true);
    expect(destroyed).toHaveLength(2);
  });

  test('connected কথোপকথন waiting-এ ফেরত যায় না', async () => {
    const u = await newUser();
    await pool.query(`UPDATE users SET support_status='connected' WHERE id=$1`, [u.id]);
    expect((await postReport(u, DEPOSIT)).body.status).toBe('connected');
  });
});

describe('মেনু থেকে লাইভ এজেন্ট', () => {
  test('ক্যাটাগরি চ্যাট ও Telegram-এ যায়, একবারই', async () => {
    const u = await newUser();
    const res = await u.post('/chat/live-agent', { category: 'bonus' });
    expect(res.body.status).toBe('waiting');
    expect(res.body.message.message).toContain('📌');
    const text = await telegramText();
    expect(text).toContain('বিষয়: বোনাস সমস্যা');

    sent = [];
    const again = await u.post('/chat/live-agent', { category: 'bonus' });
    expect(again.body).toEqual({ status: 'waiting', message: null });
    expect(await messages(u.id)).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 200));
    expect(sent).toHaveLength(0);
  });

  test('অজানা ক্যাটাগরি 400', async () => {
    const u = await newUser();
    expect((await u.post('/chat/live-agent', { category: 'toString' })).status).toBe(400);
    expect(await status(u.id)).toBe('ai');
  });
});
