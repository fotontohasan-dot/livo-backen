// tests/security/socketHandshakeLive.test.js
// ---------------------------------------------------------------------------
// PHASE 8 (deep) — প্রকৃত Socket.IO handshake দিয়ে authorization যাচাই
//
// আগের socketAuthorization.test.js শুধু source contract পরীক্ষা করত।
// এই suite একটি সত্যিকারের HTTP + Socket.IO server চালু করে, প্রকৃত session
// cookie দিয়ে handshake করে এবং live connection-এর উপর যাচাই করে:
//
//   HIGH-3   : ban/demote হওয়ার পরে পুরনো socket admin privilege হারায়
//   MEDIUM-7 : non-admin অন্য user-এর conversation-এ বার্তা ঢোকাতে পারে না
//   Room isolation : একজন user অন্যজনের user:<id> room-এর event পায় না
// ---------------------------------------------------------------------------

const { io: ioClient } = require('socket.io-client');
const request = require('supertest');
const bcrypt = require('bcryptjs');

// app.js নিজেই http server তৈরি করে এবং initSocket() দিয়ে Socket.IO যুক্ত করে,
// তাই এখানে সেই server-টিই ব্যবহার করা হয় — production wiring-এর সাথে অভিন্ন।
const app = require('../../app');
const server = app.httpServer;
const { pool } = require('../../db');
const { invalidateSocketAuth, emitAdminAlert } = require('../../services/socket');
const { uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');

const PASSWORD = 'SecurePass123';

let baseUrl;

//     +      
async function makeUser(role = 'user') {
  const username = uniqueUsername('sh');
  const phone = uniquePhone();
  const hash = await bcrypt.hash(PASSWORD, 10);
  const r = await pool.query(
    `INSERT INTO users (username, phone, password, role) VALUES ($1,$2,$3,$4) RETURNING id`,
    [username, phone, hash, role]
  );
  return { id: r.rows[0].id, username, phone };
}

//    session cookie   ( login flow-  )
async function loginCookie(user) {
  const agent = request.agent(server);
  const page = await agent.get('/login');
  const m = /<meta name="csrf-token" content="([^"]*)"/.exec(page.text);
  const res = await agent.post('/login').set('User-Agent', REALISTIC_UA).type('form')
    .send({ identifier: user.phone, password: PASSWORD, _csrf: m ? m[1] : '' });
  const raw = res.headers['set-cookie'] || page.headers['set-cookie'] || [];
  return raw.map((c) => c.split(';')[0]).join('; ');
}

function connect(cookie) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(baseUrl, {
      transports: ['websocket'],
      extraHeaders: { Cookie: cookie },
      reconnection: false,
      timeout: 8000,
    });
    const timer = setTimeout(() => { socket.close(); reject(new Error('connect timeout')); }, 9000);
    socket.on('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.on('connect_error', (e) => { clearTimeout(timer); reject(e); });
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

//     event  ,   null
function waitForEvent(socket, event, ms = 1200) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
  });
}

beforeAll(async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}, 30000);

afterAll(async () => {
  // খোলা keep-alive connection থাকলে server.close() ঝুলে যেতে পারে,
  // তাই Socket.IO connection গুলো আগে বন্ধ করা হয় এবং close()-এ timeout guard।
  try {
    const io = app.get && app.get('io');
    if (io) io.close();
  } catch (e) { /* ignore */ }

  await Promise.race([
    new Promise((resolve) => server.close(resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
}, 20000);

describe('Socket.IO live handshake authorization (PHASE 8 deep)', () => {
  describe('HIGH-3: ban/demote live connection-এ কার্যকর হয়', () => {
    test('admin socket admins room-এর alert পায়', async () => {
      // admin হিসেবে /login করলে mandatory 2FA enrollment-এ পাঠানো হয়, তাই
      // সাধারণ user হিসেবে login করে DB-তে promote করা হয়। এতে বরং আরও
      // জোরালোভাবে প্রমাণ হয় যে privilege session snapshot নয়, DB state থেকে আসে।
      const admin = await makeUser('user');
      const cookie = await loginCookie(admin);

      await pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [admin.id]);
      invalidateSocketAuth(admin.id);

      const socket = await connect(cookie);
      await wait(600); // connection-এ DB verify শেষ হওয়ার সময়

      const received = waitForEvent(socket, 'admin_alert');
      emitAdminAlert('test', { message: 'hello-admin' });

      const payload = await received;
      expect(payload).not.toBeNull();
      expect(payload.message).toBe('hello-admin');
      socket.close();
    }, 30000);

    test('সাধারণ user admins room-এর alert পায় না (room isolation)', async () => {
      const user = await makeUser('user');
      const cookie = await loginCookie(user);
      const socket = await connect(cookie);
      await wait(400);

      const received = waitForEvent(socket, 'admin_alert');
      emitAdminAlert('test', { message: 'secret-admin-only' });

      expect(await received).toBeNull();
      socket.close();
    }, 30000);

    test('ban করার পরে নতুন socket connection admins room পায় না', async () => {
      const admin = await makeUser('user');
      const cookie = await loginCookie(admin);
      await pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [admin.id]);

      // session তৈরির পরে ban করা হয় — session snapshot এখনো admin বলবে
      await pool.query('UPDATE users SET is_banned = true WHERE id = $1', [admin.id]);
      invalidateSocketAuth(admin.id);

      const socket = await connect(cookie);
      await wait(500);

      const received = waitForEvent(socket, 'admin_alert');
      emitAdminAlert('test', { message: 'must-not-reach-banned' });

      expect(await received).toBeNull();
      socket.close();
    }, 30000);

    test('demote করার পরে নতুন connection admin privilege পায় না', async () => {
      const admin = await makeUser('user');
      const cookie = await loginCookie(admin);
      await pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [admin.id]);

      // session তৈরির পরে demote করা হয়
      await pool.query("UPDATE users SET role = 'user' WHERE id = $1", [admin.id]);
      invalidateSocketAuth(admin.id);

      const socket = await connect(cookie);
      await wait(500);

      const received = waitForEvent(socket, 'admin_alert');
      emitAdminAlert('test', { message: 'must-not-reach-demoted' });

      expect(await received).toBeNull();
      socket.close();
    }, 30000);

    test('join_admin event দিয়ে সাধারণ user admins room-এ ঢুকতে পারে না', async () => {
      const user = await makeUser('user');
      const cookie = await loginCookie(user);
      const socket = await connect(cookie);
      await wait(400);

      socket.emit('join_admin');
      await wait(600);

      const received = waitForEvent(socket, 'admin_alert');
      emitAdminAlert('test', { message: 'join-admin-bypass-attempt' });

      expect(await received).toBeNull();
      socket.close();
    }, 30000);
  });

  describe('MEDIUM-7: cross-user message injection live', () => {
    test('non-admin receiverId পাঠালেও DB-তে receiver null থাকে', async () => {
      const sender = await makeUser('user');
      const victim = await makeUser('user');
      const cookie = await loginCookie(sender);
      const socket = await connect(cookie);
      await wait(400);

      const marker = `injection-attempt-${Date.now()}`;
      socket.emit('send_message', { message: marker, receiverId: victim.id });
      await wait(1200);

      const row = await pool.query(
        `SELECT sender_id, receiver_id, is_admin FROM chat_messages WHERE message = $1`,
        [marker]
      );

      if (row.rows.length > 0) {
        //   ,  victim-    
        expect(row.rows[0].receiver_id).toBeNull();
        expect(Number(row.rows[0].sender_id)).toBe(sender.id);
        expect(row.rows[0].is_admin).toBe(false);
      }

      //   victim-  history-   
      const victimHistory = await pool.query(
        `SELECT 1 FROM chat_messages WHERE (sender_id = $1 OR receiver_id = $1) AND message = $2`,
        [victim.id, marker]
      );
      expect(victimHistory.rowCount).toBe(0);

      socket.close();
    }, 30000);

    test('non-admin বার্তা isAdmin হিসেবে সংরক্ষিত হয় না', async () => {
      const sender = await makeUser('user');
      const cookie = await loginCookie(sender);
      const socket = await connect(cookie);
      await wait(400);

      const marker = `not-admin-${Date.now()}`;
      socket.emit('send_message', { message: marker, isAdmin: true, senderId: 999999 });
      await wait(1200);

      const row = await pool.query(
        `SELECT sender_id, is_admin FROM chat_messages WHERE message = $1`, [marker]
      );
      if (row.rows.length > 0) {
        expect(row.rows[0].is_admin).toBe(false);
        //  senderId  client payload   
        expect(Number(row.rows[0].sender_id)).toBe(sender.id);
      }
      socket.close();
    }, 30000);
  });

  describe('Payload limits live', () => {
    test('অতিরিক্ত লম্বা বার্তা সংরক্ষিত হয় না বা কেটে দেওয়া হয়', async () => {
      const sender = await makeUser('user');
      const cookie = await loginCookie(sender);
      const socket = await connect(cookie);
      await wait(400);

      const marker = `long-${Date.now()}`;
      socket.emit('send_message', { message: marker + 'A'.repeat(8000) });
      await wait(1200);

      const row = await pool.query(
        `SELECT message FROM chat_messages WHERE message LIKE $1`, [`${marker}%`]
      );
      if (row.rows.length > 0) {
        expect(row.rows[0].message.length).toBeLessThanOrEqual(4000);
      }
      socket.close();
    }, 30000);
  });
});
