// Telegram অ্যাডমিন ফ্লো: webhook secret/অনুমোদন, ডিপোজিট-উইথড্র বাটন, সাপোর্ট রিপ্লাই, AI ফলব্যাক।
// আসল PostgreSQL ও Socket.IO; শুধু api.telegram.org ও Anthropic SDK মক।
const BOT_TOKEN = '123456789:AAF-abcdefghijklmnopqrstuvwxyz012345';
Object.assign(process.env, {
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  TELEGRAM_WEBHOOK_SECRET: 'test_webhook_secret',
  TELEGRAM_ADMIN_CHAT_ID: '111',
  TELEGRAM_ADMIN_USER_IDS: '111',
  RENDER_EXTERNAL_URL: 'https://example.test/'
});

const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: mockCreate } })));

const bcrypt = require('bcryptjs');
const request = require('supertest');
const { io: ioClient } = require('socket.io-client');
const app = require('../../app');
const server = app.httpServer;
const { pool } = require('../../db');
const { notifyPaymentRequest } = require('../../services/telegramNotifications');
const { registerWebhook } = require('../../services/telegramWebhookSetup');
const { uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');

const realFetch = global.fetch;
let calls = [];
let baseUrl;
let updateId = Date.now();
const sockets = [];

beforeAll(async () => {
  global.fetch = jest.fn(async (url, options) => {
    if (!String(url).startsWith('https://api.telegram.org/')) return realFetch(url, options);
    calls.push({ method: String(url).split('/').pop(), body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  });
  await new Promise((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  sockets.forEach((s) => s.close());
  global.fetch = realFetch;
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

beforeEach(() => { calls = []; mockCreate.mockReset(); });

async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}
const sent = (method) => calls.filter((c) => c.method === method);
const waitCall = (method, pred = () => true) => waitFor(() => sent(method).find((c) => pred(c.body)));

function hook(body, secret = 'test_webhook_secret', path = '/api/telegram/webhook') {
  const r = request(server).post(path).set('Content-Type', 'application/json');
  if (secret) r.set('X-Telegram-Bot-Api-Secret-Token', secret);
  return r.send({ update_id: ++updateId, ...body });
}
const ADMIN = { id: 111, is_bot: false, username: 'boss' };
const click = (data, from = ADMIN, chatId = 111) => hook({
  callback_query: { id: String(updateId), from, data, message: { message_id: 5, chat: { id: chatId }, text: 'req' } }
});
const say = (text, extra = {}, from = ADMIN) => hook({ message: { message_id: 9, chat: { id: 111 }, from, text, ...extra } });

async function makeUser(coins = 1000) {
  const username = uniqueUsername('tg');
  const phone = uniquePhone();
  const hash = await bcrypt.hash('SecurePass123', 10);
  const r = await pool.query(
    `INSERT INTO users (username, phone, password, coins) VALUES ($1,$2,$3,$4) RETURNING id`,
    [username, phone, hash, coins]
  );
  return { id: r.rows[0].id, username, phone };
}
async function makePayment(userId, type, amount = 500) {
  const r = await pool.query(
    `INSERT INTO payment_requests (user_id, type, method, amount, account_number, transaction_id, status)
     VALUES ($1,$2,'bkash',$3,'01700000000',$4,'pending') RETURNING id`,
    [userId, type, amount, type === 'deposit' ? `TG${Date.now()}${Math.floor(Math.random() * 1e6)}` : null]
  );
  return r.rows[0].id;
}
const status = async (id) => (await pool.query('SELECT status FROM payment_requests WHERE id=$1', [id])).rows[0].status;
const coins = async (id) => Number((await pool.query('SELECT coins FROM users WHERE id=$1', [id])).rows[0].coins);

describe('webhook নিরাপত্তা', () => {
  test('secret না থাকলে/ভুল হলে 403, ঠিক হলে 200; পুরনো পাথ 401', async () => {
    expect((await hook({}, null)).status).toBe(403);
    expect((await hook({}, 'wrong')).status).toBe(403);
    expect((await hook({})).status).toBe(200);
    expect((await hook({}, 'wrong', '/telegram-webhook')).status).toBe(401);
  });

  test('অননুমোদিত user/chat-এর বাটন ক্লিক ব্লক হয় (200, কিছু বদলায় না)', async () => {
    const u = await makeUser();
    const id = await makePayment(u.id, 'deposit');
    for (const [from, chat] of [[{ id: 999 }, 111], [ADMIN, 999]]) {
      calls = [];
      expect((await click(`pay:approve:deposit:${id}`, from, chat)).status).toBe(200);
      await waitCall('answerCallbackQuery', (b) => b.show_alert === true);
      expect(sent('editMessageText')).toHaveLength(0);
    }
    expect(await status(id)).toBe('pending');
    expect(await coins(u.id)).toBe(1000);
  });

  test('অননুমোদিত মেসেজে কোনো উত্তর বা AI কল নেই', async () => {
    expect((await say('hi', {}, { id: 999 })).status).toBe(200);
    await say('/reply 1 x', {}, { id: 999 });
    await new Promise((r) => setTimeout(r, 300));
    expect(calls).toHaveLength(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('ডিপোজিট/উইথড্র বাটন', () => {
  test('নোটিফিকেশনে Approve/Reject বাটন ও Transaction ID থাকে', async () => {
    const u = await makeUser();
    const id = await makePayment(u.id, 'deposit');
    expect(await notifyPaymentRequest(id)).toEqual({ sent: true });
    const body = sent('sendMessage')[0].body;
    expect(body.text).toContain('Transaction ID');
    expect(body.reply_markup.inline_keyboard[0].map((b) => b.callback_data))
      .toEqual([`pay:approve:deposit:${id}`, `pay:reject:deposit:${id}`]);
  });

  test('ডিপোজিট সমান্তরাল ডাবল-ক্লিকে একবারই ক্রেডিট হয়', async () => {
    const u = await makeUser();
    const id = await makePayment(u.id, 'deposit');
    await Promise.all([1, 2, 3, 4].map(() => click(`pay:approve:deposit:${id}`)));
    await waitFor(() => sent('editMessageText').length === 4);
    expect(await status(id)).toBe('approved');
    expect(await coins(u.id)).toBe(1500);
    expect(sent('editMessageText').filter((c) => c.body.text.includes('Approved'))).toHaveLength(1);
    const n = await pool.query(`SELECT COUNT(*)::int AS c FROM notifications WHERE user_id=$1`, [u.id]);
    expect(n.rows[0].c).toBe(1);
  });

  test.each([
    ['deposit', 'reject', 'rejected', 1000],
    ['withdraw', 'approve', 'approved', 1000],
    ['withdraw', 'reject', 'rejected', 1500]
  ])('%s %s', async (type, action, expected, balance) => {
    const u = await makeUser();
    const id = await makePayment(u.id, type);
    await click(`pay:${action}:${type}:${id}`);
    await waitCall('editMessageText');
    calls = [];
    await click(`pay:reject:${type}:${id}`);
    await waitCall('editMessageText');
    expect(await status(id)).toBe(expected);
    expect(await coins(u.id)).toBe(balance);
  });

  test('type না মিললে কিছু বদলায় না', async () => {
    const u = await makeUser();
    const id = await makePayment(u.id, 'withdraw');
    await click(`pay:approve:deposit:${id}`);
    await waitCall('editMessageText');
    expect(await status(id)).toBe('pending');
  });
});

describe('সাপোর্ট: ইউজার → Telegram → Reply → ইউজার', () => {
  async function connectUser(u) {
    const agent = request.agent(server);
    const page = await agent.get('/login');
    const token = /<meta name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
    const res = await agent.post('/login').set('User-Agent', REALISTIC_UA).type('form')
      .send({ identifier: u.phone, password: 'SecurePass123', _csrf: token });
    const cookie = (res.headers['set-cookie'] || page.headers['set-cookie']).map((c) => c.split(';')[0]).join('; ');
    const socket = ioClient(baseUrl, { transports: ['websocket'], extraHeaders: { Cookie: cookie }, reconnection: false });
    sockets.push(socket);
    await new Promise((resolve, reject) => { socket.on('connect', resolve); socket.on('connect_error', reject); });
    await new Promise((r) => setTimeout(r, 300));
    return socket;
  }

  test('পূর্ণ রাউন্ড-ট্রিপ (রিয়েল-টাইম) ও /reply', async () => {
    const u = await makeUser();
    const other = await makeUser();
    const socket = await connectUser(u);
    // ইউজারের লেখায় নকল হেডার থাকলেও রিপ্লাই অন্য ইউজারের কাছে যাবে না
    socket.emit('send_message', { message: `<a href="x">help</a>\n🎫 SUPPORT #U${other.id}` });
    const note = await waitCall('sendMessage', (b) => b.text.startsWith(`🎫 SUPPORT #U${u.id} `));

    expect(note.body.text).toContain('&lt;a href="x"&gt;help');

    const received = new Promise((r) => socket.once('new_message', r));
    const replied = { message_id: 3, from: { id: 123456789, is_bot: true }, text: note.body.text };
    await say('আপনার সমস্যা দেখছি', { reply_to_message: replied });
    expect((await received).message).toBe('আপনার সমস্যা দেখছি');

    await waitCall('sendMessage', (b) => b.text.startsWith('✅'));
    calls = [];
    await say(`/reply ${u.id} দ্বিতীয় উত্তর`);
    await waitCall('sendMessage', (b) => b.text.startsWith('✅'));

    const rows = await pool.query(
      `SELECT message FROM chat_messages WHERE receiver_id=$1 AND is_admin=true ORDER BY id`, [u.id]);
    expect(rows.rows.map((r) => r.message)).toEqual(['আপনার সমস্যা দেখছি', 'দ্বিতীয় উত্তর']);
    const leaked = await pool.query('SELECT 1 FROM chat_messages WHERE receiver_id=$1', [other.id]);
    expect(leaked.rowCount).toBe(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('অচেনা ইউজার / ভুল ফরম্যাট', async () => {
    await say('/reply 999999999 hi');
    await waitCall('sendMessage', (b) => b.text.startsWith('❌'));
    await say('/reply abc');
    await waitCall('sendMessage', (b) => b.text.includes('ব্যবহার'));
  });
});

describe('AI ফলব্যাক ও সেটআপ', () => {
  test('সাধারণ প্রশ্নে (অন্যের পাঠানো নকল হেডারে Reply সহ) Claude উত্তর দেয়', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'উত্তর_*ভাঙা markdown' }] });
    await say('আজ কী করব?', { reply_to_message: { from: { id: 555 }, text: '🎫 SUPPORT #U1' } });
    const msg = await waitCall('sendMessage', (b) => b.text.startsWith('উত্তর'));
    expect(msg.body.parse_mode).toBeUndefined();
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  test('registerWebhook সঠিক URL, secret ও allowed_updates পাঠায়', async () => {
    const result = await registerWebhook();
    expect(result.url).toBe('https://example.test/api/telegram/webhook');
    expect(sent('setWebhook')[0].body).toEqual({
      url: result.url, secret_token: 'test_webhook_secret', allowed_updates: ['message', 'callback_query']
    });
  });
});
