// tests/security/adminLoginHardening.test.js
// ---------------------------------------------------------------------------
// Admin authentication hardening regression suite
//
//   HIGH-1   : banned/deleted admin login  privileged access   
//   MEDIUM-1 : একই TOTP code replay করা যাবে না
//   MEDIUM-2 : ব্যর্থ admin login / 2FA failure audit_logs- 
//   LOW-1    : /admin/logout state change  POST- ; GET   
//
//   :  admin login + TOTP  dashboard    (zero-regression)
//
//        test user     
//        ( production admin  )
// ---------------------------------------------------------------------------
const speakeasy = require('speakeasy');
const bcrypt = require('bcryptjs');
const { pool } = require('../../db');
const secretBox = require('../../utils/secretBox');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');

const PASSWORD = 'SecurePass123';

//        admin  
async function createAdmin({ totp = false, banned = false } = {}) {
  const username = uniqueUsername('adm');
  const phone = uniquePhone();
  const hash = await bcrypt.hash(PASSWORD, 10);
  const secret = totp ? speakeasy.generateSecret({ length: 20 }).base32 : null;

  const r = await pool.query(
    `INSERT INTO users (username, phone, password, role, is_banned, totp_enabled, totp_secret)
     VALUES ($1, $2, $3, 'admin', $4, $5, $6)
     RETURNING id`,
    [username, phone, hash, banned, totp, secret ? secretBox.encrypt(secret) : null]
  );
  return { id: r.rows[0].id, username, secret };
}

function totpFor(secret) {
  return speakeasy.totp({ secret, encoding: 'base32' });
}

async function loginAgent(username) {
  const { agent, token } = await getCsrfAgent('/admin/login');
  const res = await agent
    .post('/admin/login')
    .set('User-Agent', REALISTIC_UA)
    .type('form')
    .send({ username, password: PASSWORD, _csrf: token });
  return { agent, token, res };
}

async function auditCount(actorId, action) {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS c FROM audit_logs WHERE actor_id = $1 AND action = $2`,
    [actorId, action]
  );
  return r.rows[0].c;
}

describe('Admin authentication hardening', () => {
  // ---------------- ZERO-REGRESSION BASELINE ----------------
  describe('Baseline: legitimate admin flow  ', () => {
    test(' admin login + TOTP    dashboard   ', async () => {
      const admin = await createAdmin({ totp: true });
      const { agent, res } = await loginAgent(admin.username);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/admin/login/2fa');

      const page = await agent.get('/admin/login/2fa');
      const csrf = /<meta name="csrf-token" content="([^"]*)"/.exec(page.text);

      const verify = await agent
        .post('/admin/login/2fa')
        .set('User-Agent', REALISTIC_UA)
        .type('form')
        .send({ token: totpFor(admin.secret), _csrf: csrf ? csrf[1] : '' });

      expect(verify.status).toBe(302);
      expect(verify.headers.location).toBe('/admin');

      const dash = await agent.get('/admin');
      expect(dash.status).toBe(200);
    });
  });

  // ---------------- HIGH-1 ----------------
  describe('HIGH-1: banned admin ', () => {
    test('banned admin       ', async () => {
      const admin = await createAdmin({ banned: true });
      const { res } = await loginAgent(admin.username);
      expect(res.status).toBe(200); // login page re-render = 
      expect(res.headers.location).toBeUndefined();
    });

    test('banned admin- login denial audit_logs- ', async () => {
      const admin = await createAdmin({ banned: true });
      await loginAgent(admin.username);
      expect(await auditCount(admin.id, 'ADMIN_LOGIN_DENIED')).toBeGreaterThanOrEqual(1);
    });

    test('login-  ban   existing session /admin/*  ', async () => {
      const admin = await createAdmin();
      const { agent } = await loginAgent(admin.username);

      //   2FA enrollment-  ;   session  
      //  isAdmin middleware-      ban enforcement 
      await pool.query('UPDATE users SET totp_enabled = true, is_banned = true WHERE id = $1', [admin.id]);

      const after = await agent.get('/admin/users');
      expect(after.status).toBe(302);
      expect(after.headers.location).toBe('/admin/login');
    });

    test('2FA  ban   session   ', async () => {
      const admin = await createAdmin({ totp: true });
      const { agent } = await loginAgent(admin.username);

      await pool.query('UPDATE users SET is_banned = true WHERE id = $1', [admin.id]);

      const page = await agent.get('/admin/login/2fa');
      const csrf = /<meta name="csrf-token" content="([^"]*)"/.exec(page.text);
      const verify = await agent
        .post('/admin/login/2fa')
        .set('User-Agent', REALISTIC_UA)
        .type('form')
        .send({ token: totpFor(admin.secret), _csrf: csrf ? csrf[1] : '' });

      expect(verify.status).toBe(200); //  redirect  = session  
      const dash = await agent.get('/admin');
      expect(dash.status).toBe(302);
    });
  });

  // ---------------- MEDIUM-1 ----------------
  describe('MEDIUM-1: TOTP replay ', () => {
    test('    TOTP code    ', async () => {
      const admin = await createAdmin({ totp: true });
      const code = totpFor(admin.secret);

      //   
      const first = await loginAgent(admin.username);
      const p1 = await first.agent.get('/admin/login/2fa');
      const c1 = /<meta name="csrf-token" content="([^"]*)"/.exec(p1.text);
      const v1 = await first.agent
        .post('/admin/login/2fa').set('User-Agent', REALISTIC_UA).type('form')
        .send({ token: code, _csrf: c1 ? c1[1] : '' });
      expect(v1.status).toBe(302);
      expect(v1.headers.location).toBe('/admin');

      //     code  session-  replay
      const second = await loginAgent(admin.username);
      const p2 = await second.agent.get('/admin/login/2fa');
      const c2 = /<meta name="csrf-token" content="([^"]*)"/.exec(p2.text);
      const v2 = await second.agent
        .post('/admin/login/2fa').set('User-Agent', REALISTIC_UA).type('form')
        .send({ token: code, _csrf: c2 ? c2[1] : '' });

      expect(v2.status).toBe(200); //  redirect =  
      const dash = await second.agent.get('/admin');
      expect(dash.status).toBe(302);
    });

    test('replay attempt critical audit event  ', async () => {
      const admin = await createAdmin({ totp: true });
      const code = totpFor(admin.secret);

      const a = await loginAgent(admin.username);
      const pa = await a.agent.get('/admin/login/2fa');
      const ca = /<meta name="csrf-token" content="([^"]*)"/.exec(pa.text);
      await a.agent.post('/admin/login/2fa').set('User-Agent', REALISTIC_UA).type('form')
        .send({ token: code, _csrf: ca ? ca[1] : '' });

      const b = await loginAgent(admin.username);
      const pb = await b.agent.get('/admin/login/2fa');
      const cb = /<meta name="csrf-token" content="([^"]*)"/.exec(pb.text);
      await b.agent.post('/admin/login/2fa').set('User-Agent', REALISTIC_UA).type('form')
        .send({ token: code, _csrf: cb ? cb[1] : '' });

      const r = await pool.query(
        `SELECT details FROM audit_logs
          WHERE actor_id = $1 AND action = 'ADMIN_2FA_FAILED'
          ORDER BY id DESC LIMIT 1`,
        [admin.id]
      );
      expect(r.rows.length).toBe(1);
      const details = typeof r.rows[0].details === 'string' ? JSON.parse(r.rows[0].details) : r.rows[0].details;
      expect(details.reason).toBe('totp_replay');
    });

    test('concurrent replay:  code   request-      ', async () => {
      const admin = await createAdmin({ totp: true });
      const code = totpFor(admin.secret);

      const sessions = await Promise.all([loginAgent(admin.username), loginAgent(admin.username)]);
      const prepared = await Promise.all(sessions.map(async (s) => {
        const p = await s.agent.get('/admin/login/2fa');
        const c = /<meta name="csrf-token" content="([^"]*)"/.exec(p.text);
        return { agent: s.agent, csrf: c ? c[1] : '' };
      }));

      const results = await Promise.all(prepared.map((p) =>
        p.agent.post('/admin/login/2fa').set('User-Agent', REALISTIC_UA).type('form')
          .send({ token: code, _csrf: p.csrf })
      ));

      const success = results.filter((r) => r.status === 302 && r.headers.location === '/admin');
      expect(success.length).toBe(1);
    });
  });

  // ---------------- MEDIUM-2 ----------------
  describe('MEDIUM-2: failed admin login / 2FA audit', () => {
    test('  ADMIN_LOGIN_FAILED audit  ', async () => {
      const admin = await createAdmin();
      const { agent, token } = await getCsrfAgent('/admin/login');
      await agent.post('/admin/login').set('User-Agent', REALISTIC_UA).type('form')
        .send({ username: admin.username, password: 'WrongPassword999', _csrf: token });

      expect(await auditCount(admin.id, 'ADMIN_LOGIN_FAILED')).toBeGreaterThanOrEqual(1);
    });

    test(' TOTP  ADMIN_2FA_FAILED audit  ', async () => {
      const admin = await createAdmin({ totp: true });
      const { agent } = await loginAgent(admin.username);
      const p = await agent.get('/admin/login/2fa');
      const c = /<meta name="csrf-token" content="([^"]*)"/.exec(p.text);
      await agent.post('/admin/login/2fa').set('User-Agent', REALISTIC_UA).type('form')
        .send({ token: '000000', _csrf: c ? c[1] : '' });

      expect(await auditCount(admin.id, 'ADMIN_2FA_FAILED')).toBeGreaterThanOrEqual(1);
    });

    test('audit log-  password/TOTP secret/backup code   ', async () => {
      const admin = await createAdmin({ totp: true });
      const { agent, token } = await getCsrfAgent('/admin/login');
      await agent.post('/admin/login').set('User-Agent', REALISTIC_UA).type('form')
        .send({ username: admin.username, password: PASSWORD + 'X', _csrf: token });

      const r = await pool.query(
        `SELECT details::text AS d FROM audit_logs WHERE actor_id = $1 ORDER BY id DESC LIMIT 5`,
        [admin.id]
      );
      const blob = r.rows.map((x) => x.d).join(' ');
      expect(blob).not.toContain(PASSWORD);
      expect(blob).not.toContain(admin.secret);
    });
  });

  // ---------------- LOW-1 ----------------
  describe('LOW-1: logout  state-changing GET  ', () => {
    test('POST /admin/logout session   ', async () => {
      const admin = await createAdmin({ totp: true });
      const { agent } = await loginAgent(admin.username);
      const p = await agent.get('/admin/login/2fa');
      const c = /<meta name="csrf-token" content="([^"]*)"/.exec(p.text);
      await agent.post('/admin/login/2fa').set('User-Agent', REALISTIC_UA).type('form')
        .send({ token: totpFor(admin.secret), _csrf: c ? c[1] : '' });

      const dash = await agent.get('/admin');
      expect(dash.status).toBe(200);
      const csrf = /<meta name="csrf-token" content="([^"]*)"/.exec(dash.text);

      const out = await agent.post('/admin/logout').set('User-Agent', REALISTIC_UA).type('form')
        .send({ _csrf: csrf ? csrf[1] : '' });
      expect(out.status).toBe(302);
      expect(out.headers.location).toBe('/admin/login');

      const after = await agent.get('/admin');
      expect(after.status).toBe(302);
      expect(after.headers.location).toBe('/admin/login');
    });

    test('GET /admin/logout    ( confirm page)', async () => {
      const admin = await createAdmin({ totp: true });
      const { agent } = await loginAgent(admin.username);
      const p = await agent.get('/admin/login/2fa');
      const c = /<meta name="csrf-token" content="([^"]*)"/.exec(p.text);
      await agent.post('/admin/login/2fa').set('User-Agent', REALISTIC_UA).type('form')
        .send({ token: totpFor(admin.secret), _csrf: c ? c[1] : '' });

      const res = await agent.get('/admin/logout');
      expect(res.status).toBe(200);
      expect(res.text).toContain('action="/admin/logout"');

      //  GET-  session   
      const still = await agent.get('/admin');
      expect(still.status).toBe(200);
    });

    test('CSRF token  POST /admin/logout  ', async () => {
      const admin = await createAdmin({ totp: true });
      const { agent } = await loginAgent(admin.username);
      const p = await agent.get('/admin/login/2fa');
      const c = /<meta name="csrf-token" content="([^"]*)"/.exec(p.text);
      await agent.post('/admin/login/2fa').set('User-Agent', REALISTIC_UA).type('form')
        .send({ token: totpFor(admin.secret), _csrf: c ? c[1] : '' });

      const out = await agent.post('/admin/logout').set('User-Agent', REALISTIC_UA).type('form').send({});
      expect(out.status).not.toBe(302);

      const still = await agent.get('/admin');
      expect(still.status).toBe(200);
    });
  });
});
