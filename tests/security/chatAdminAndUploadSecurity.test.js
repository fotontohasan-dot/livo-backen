// tests/security/chatAdminAndUploadSecurity.test.js
// ---------------------------------------------------------------------------
// PHASE 6 (API SECURITY) + PHASE 7 (FILE UPLOAD SECURITY)
//
//   HIGH-2   : routes/chat.js-এর নিজস্ব isAdmin ban state যাচাই করত না,
//              ফলে ban করা admin সব user-এর private chat পড়তে পারত
//   MEDIUM-6 : chat admin route গুলোতে কোনো permission check ছিল না
//   IDOR     : :userId অবশ্যই integer, অন্য user-এর chat সাধারণ user পাবে না
//   Upload   : extension / MIME / magic-byte spoofing প্রত্যাখ্যাত হয়
// ---------------------------------------------------------------------------

const { pool } = require('../../db');
const rbac = require('../../services/rbac');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA, freshRequest } = require('../helpers/app');

const PASSWORD = 'SecurePass123';

async function makeUser(role = 'user', roleKey = null) {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername('cx');
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
    .send({ username, phone: uniquePhone(), password: PASSWORD, confirmPassword: PASSWORD, _csrf: token });
  const r = await pool.query(
    'UPDATE users SET role = $1, role_key = $2 WHERE username = $3 RETURNING id',
    [role, roleKey, username]
  );
  return { agent, token, username, userId: r.rows[0].id };
}

describe('Chat admin authorization & upload security (PHASE 6/7)', () => {
  describe('HIGH-2: banned admin chat access', () => {
    test('ban করা admin অন্য user-এর chat history পড়তে পারে না', async () => {
      const victim = await makeUser('user');
      const admin = await makeUser('admin', null);

      //   admin  ,   
      const ok = await admin.agent.get(`/chat/admin/history/${victim.userId}`);
      expect(ok.status).toBe(200);

      await pool.query('UPDATE users SET is_banned = true WHERE id = $1', [admin.userId]);

      const after = await admin.agent.get(`/chat/admin/history/${victim.userId}`);
      expect(after.status).toBe(403);
      expect(Array.isArray(after.body)).toBe(false);
    });

    test('ban করা admin conversation list পায় না', async () => {
      const admin = await makeUser('admin', null);
      expect((await admin.agent.get('/chat/admin/conversations')).status).toBe(200);

      await pool.query('UPDATE users SET is_banned = true WHERE id = $1', [admin.userId]);
      expect((await admin.agent.get('/chat/admin/conversations')).status).toBe(403);
    });
  });

  describe('MEDIUM-6: chat admin permission', () => {
    test('support permission ছাড়া limited admin chat history পড়তে পারে না', async () => {
      const victim = await makeUser('user');
      const role = await rbac.createRole({
        name: `NoSupport ${uniqueUsername('r')}`,
        permissions: { dashboard_view: true }
      });
      const limited = await makeUser('admin', role.key);

      const res = await limited.agent.get(`/chat/admin/history/${victim.userId}`);
      expect(res.status).not.toBe(200);
    });

    test('support_view থাকা admin chat history পড়তে পারে (over-blocking নেই)', async () => {
      const victim = await makeUser('user');
      const role = await rbac.createRole({
        name: `Support ${uniqueUsername('r')}`,
        permissions: { support_view: true, support_reply: true }
      });
      const support = await makeUser('admin', role.key);

      const res = await support.agent.get(`/chat/admin/history/${victim.userId}`);
      expect(res.status).toBe(200);
    });

    test('super admin অপরিবর্তিতভাবে access পায় (zero-regression)', async () => {
      const victim = await makeUser('user');
      const admin = await makeUser('admin', null);
      const res = await admin.agent.get(`/chat/admin/history/${victim.userId}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe('IDOR / input validation', () => {
    test('সাধারণ user chat admin endpoint-এ ঢুকতে পারে না', async () => {
      const victim = await makeUser('user');
      const attacker = await makeUser('user');

      const res = await attacker.agent.get(`/chat/admin/history/${victim.userId}`);
      expect(res.status).toBe(403);
    });

    test('unauthenticated request প্রত্যাখ্যাত হয়', async () => {
      const res = await freshRequest().get('/chat/admin/history/1');
      expect(res.status).toBe(403);
    });

    test('অবৈধ :userId গ্রহণ করা হয় না', async () => {
      const admin = await makeUser('admin', null);
      for (const bad of ['abc', '1;DROP', '-5', '0']) {
        const res = await admin.agent.get(`/chat/admin/history/${encodeURIComponent(bad)}`);
        expect(res.status).toBe(400);
      }
    });

    test('/chat/history নিজের বার্তা ছাড়া অন্য কিছু ফেরত দেয় না', async () => {
      const a = await makeUser('user');
      const b = await makeUser('user');

      await pool.query(
        `INSERT INTO chat_messages (sender_id, receiver_id, message, is_admin, is_read)
         VALUES ($1, NULL, 'secret-of-b', false, false)`,
        [b.userId]
      );

      const res = await a.agent.get('/chat/history');
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain('secret-of-b');
    });
  });

  describe('PHASE 7: upload validation', () => {
    const chatUpload = require('../../routes/chat');

    test('অনুমোদিত extension তালিকা executable/script ফরম্যাট বাদ দেয়', () => {
      const fs = require('fs');
      const path = require('path');
      const src = fs.readFileSync(path.join(__dirname, '..', '..', 'routes', 'chat.js'), 'utf8');
      for (const bad of ['.svg', '.html', '.htm', '.js', '.php', '.exe', '.sh']) {
        expect(src).not.toContain(`'${bad}'`);
      }
      expect(chatUpload).toBeDefined();
    });

    test('extension spoofing (.png নামে HTML) magic byte-এ ধরা পড়ে', async () => {
      const user = await makeUser('user');
      const html = Buffer.from('<html><script>alert(1)</script></html>');
      const res = await user.agent
        .post('/chat/upload')
        .set('X-CSRF-Token', user.token)
        .attach('file', html, { filename: 'evil.png', contentType: 'image/png' });

      expect(res.status).not.toBe(200);
    });

    test('MIME spoofing (image/png বলা .exe) প্রত্যাখ্যাত হয়', async () => {
      const user = await makeUser('user');
      const exe = Buffer.from([0x4D, 0x5A, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00]);
      const res = await user.agent
        .post('/chat/upload')
        .set('X-CSRF-Token', user.token)
        .attach('file', exe, { filename: 'payload.exe', contentType: 'image/png' });

      expect(res.status).not.toBe(200);
    });

    test('SVG upload প্রত্যাখ্যাত হয় (stored XSS vector)', async () => {
      const user = await makeUser('user');
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
      const res = await user.agent
        .post('/chat/upload')
        .set('X-CSRF-Token', user.token)
        .attach('file', svg, { filename: 'x.svg', contentType: 'image/svg+xml' });

      expect(res.status).not.toBe(200);
    });

    test('unauthenticated upload প্রত্যাখ্যাত হয়', async () => {
      const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]);
      const res = await freshRequest()
        .post('/chat/upload')
        .attach('file', png, { filename: 'a.png', contentType: 'image/png' });
      expect(res.status).not.toBe(200);
    });
  });

  describe('KYC document handling (PHASE 7)', () => {
    test('KYC document_url শুধু নির্দিষ্ট Cloudinary path গ্রহণ করে', async () => {
      const user = await makeUser('user');
      const bad = [
        'http://res.cloudinary.com/x/livo/chat/a.png',   // http
        'https://evil.com/livo/chat/a.png',              //  host
        'https://res.cloudinary.com/other/livo/chat/a.png', //  cloud
        'https://res.cloudinary.com/x/other/a.png',      //  path
      ];
      for (const url of bad) {
        const res = await user.agent.post('/extra/kyc').set('X-CSRF-Token', user.token).type('form')
          .send({ full_name: 'Test User', document_number: '1234567890', document_url: url, _csrf: user.token });
        expect(res.headers.location).toBe('/extra/kyc');
      }

      const pending = await pool.query(
        `SELECT COUNT(*)::int c FROM kyc_requests WHERE user_id = $1`, [user.userId]
      );
      expect(pending.rows[0].c).toBe(0);
    });
  });
});
