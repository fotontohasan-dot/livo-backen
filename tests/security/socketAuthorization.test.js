// tests/security/socketAuthorization.test.js
// ---------------------------------------------------------------------------
// PHASE 8 — SOCKET.IO SECURITY
//
//   HIGH-3   : socket layer session snapshot-এর role বিশ্বাস করত, DB re-check
//              করত না — ban/demote হওয়ার পরেও পুরনো socket admin privilege
//              ধরে রাখত (admins room + isAdmin বার্তা)
//   MEDIUM-7 : non-admin ইচ্ছেমতো receiverId পাঠিয়ে অন্য user-এর
//              conversation-এ বার্তা ঢুকিয়ে দিতে পারত
//   Room isolation / payload validation regression
//
// এই suite socket module-এর authorization যুক্তি সরাসরি পরীক্ষা করে
// (verifyUserState + handler গুলোর source contract), কারণ পূর্ণ Socket.IO
// handshake harness এখানে নেই।
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const { pool } = require('../../db');
const { uniqueUsername, uniquePhone } = require('../helpers/app');

const socketService = require('../../services/socket');
const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'services', 'socket.js'), 'utf8');

async function makeUser(role = 'user', banned = false) {
  const r = await pool.query(
    `INSERT INTO users (username, phone, password, role, is_banned)
     VALUES ($1, $2, 'x', $3, $4) RETURNING id`,
    [uniqueUsername('sk'), uniquePhone(), role, banned]
  );
  return r.rows[0].id;
}

describe('Socket.IO authorization (PHASE 8)', () => {
  describe('HIGH-3: DB state যাচাই, session snapshot নয়', () => {
    test('socket connection handler session-এর role সরাসরি ব্যবহার করে না', () => {
      //  : authUser.role === 'admin'  join('admins')
      expect(SRC).not.toMatch(/if \(authUser\.role === 'admin'\) socket\.join\('admins'\)/);
      expect(SRC).not.toMatch(/if \(u && u\.role === 'admin'\) socket\.join\("admins"\)/);
      expect(SRC).toMatch(/verifyUserState/);
    });

    test('send_message isAdmin session থেকে নয়, verify করা state থেকে নেয়', () => {
      const idx = SRC.indexOf('socket.on("send_message"');
      expect(idx).toBeGreaterThan(-1);
      const block = SRC.slice(idx, idx + 2000);
      expect(block).not.toMatch(/const isAdmin = u\.role === 'admin'/);
      expect(block).toMatch(/const verified = await verifyUserState\(u\.id\)/);
      expect(block).toMatch(/const isAdmin = verified\.isAdmin/);
    });

    test('join_admin DB role যাচাই করে', () => {
      const idx = SRC.indexOf('socket.on("join_admin"');
      const block = SRC.slice(idx, idx + 500);
      expect(block).toMatch(/verifyUserState/);
      expect(block).toMatch(/verified\.isAdmin/);
    });

    test('ban/demote-এ socket auth cache invalidate করার হুক আছে', () => {
      expect(typeof socketService.invalidateSocketAuth).toBe('function');
      const adminSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'routes', 'admin.js'), 'utf8');
      expect(adminSrc).toMatch(/invalidateSocketAuth/);
      //     : ban, promote, demote
      expect((adminSrc.match(/invalidateSocketAuth\(/g) || []).length).toBeGreaterThanOrEqual(3);
    });

    test('invalidateSocketAuth() throw করে না এবং idempotent', async () => {
      const userId = await makeUser('user');
      expect(() => socketService.invalidateSocketAuth(userId)).not.toThrow();
      expect(() => socketService.invalidateSocketAuth(userId)).not.toThrow();
      expect(() => socketService.invalidateSocketAuth(999999999)).not.toThrow();
    });
  });

  describe('MEDIUM-7: cross-user message injection', () => {
    test('non-admin sender-এর receiverId সবসময় null করা হয়', () => {
      const idx = SRC.indexOf('socket.on("send_message"');
      const block = SRC.slice(idx, idx + 2500);
      //  : const receiverId = (data && data.receiverId) || null;
      expect(block).not.toMatch(/const receiverId = \(data && data\.receiverId\) \|\| null/);
      expect(block).toMatch(/let receiverId = null/);
      expect(block).toMatch(/if \(isAdmin\) \{/);
    });

    test('admin-এর receiverId positive integer হিসেবে যাচাই হয়', () => {
      const idx = SRC.indexOf('socket.on("send_message"');
      const block = SRC.slice(idx, idx + 2500);
      expect(block).toMatch(/Number\.isSafeInteger\(parsedReceiver\)/);
      expect(block).toMatch(/parsedReceiver <= 0/);
    });

    test('senderId কখনো client payload থেকে নেওয়া হয় না', () => {
      expect(SRC).not.toMatch(/senderId = data\.senderId/);
      expect(SRC).toMatch(/const senderId = verified\.id/);
    });
  });

  describe('Room isolation', () => {
    test('joinMatch শুধু positive integer গ্রহণ করে', () => {
      const idx = SRC.indexOf('socket.on("joinMatch"');
      const block = SRC.slice(idx, idx + 400);
      expect(block).toMatch(/Number\.isSafeInteger\(id\)/);
      expect(block).not.toMatch(/socket\.join\(`match:\$\{matchId\}`\)/);
    });

    test('user room সবসময় verify করা id দিয়ে তৈরি হয়', () => {
      expect(SRC).toMatch(/socket\.join\(`user:\$\{verified\.id\}`\)/);
    });

    test('admin alert শুধু admins room-এ যায়', () => {
      const idx = SRC.indexOf('const emitAdminAlert');
      const block = SRC.slice(idx, idx + 400);
      expect(block).toMatch(/io\.to\('admins'\)/);
    });
  });

  describe('Payload limits (regression)', () => {
    test('maxHttpBufferSize সীমিত আছে', () => {
      expect(SRC).toMatch(/maxHttpBufferSize:\s*64 \* 1024/);
    });

    test('message দৈর্ঘ্য সীমিত আছে', () => {
      expect(SRC).toMatch(/MAX_MESSAGE_LEN = 4000/);
    });

    test('chat rate limit বহাল আছে', async () => {
      expect(SRC).toMatch(/CHAT_RATE_LIMIT = 15/);
      expect(typeof socketService.allowChatMessage).toBe('function');

      const userId = await makeUser('user');
      let allowed = 0;
      for (let i = 0; i < 20; i++) {
        if (await socketService.allowChatMessage(userId)) allowed++;
      }
      expect(allowed).toBeLessThanOrEqual(15);
      expect(allowed).toBeGreaterThan(0);
    });

    test('CORS origin allow-list ব্যবহার করা হয় (origin: "*" নয়)', () => {
      // comment-এ '*' উল্লেখ থাকতে পারে; কোড-লাইনে আছে কি না সেটাই দেখা হয়
      const codeLines = SRC.split('\n').filter((l) => !l.trim().startsWith('//'));
      expect(codeLines.join('\n')).not.toMatch(/origin:\s*["']\*["']/);
      expect(SRC).toMatch(/isAllowedOrigin/);
    });
  });

  describe('Telegram output escaping (regression)', () => {
    test('chat বার্তা Telegram HTML হিসেবে escape করা হয়', () => {
      expect(SRC).toMatch(/tgEscape/);
      expect(SRC).toMatch(/replace\(\/</);
    });
  });
});
