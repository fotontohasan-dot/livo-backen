const request = require('supertest');
const { pool } = require('../../db');
const {
  app, extractCsrfToken, uniqueUsername, uniquePhone, fakeIp, wrapAgentWithIp, getCsrfAgent
} = require('../helpers/app');

// ==================== Step 4B — A2: লগইন লক-আউট অপব্যবহার ====================
// প্রতিটা টেস্ট নিজস্ব র‍্যান্ডম IP ও নতুন ইউজার ব্যবহার করে, তাই একটা টেস্টের কাউন্টার অন্যটায় লিক করে না।
jest.setTimeout(120000);

const PASSWORD = 'SecurePass123';
const createdUsernames = [];

async function registerUser({ withEmail = false } = {}) {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername('lk');
  const phone = uniquePhone();
  const email = withEmail ? `${username}@lockout.test` : undefined;
  const res = await agent.post('/register').type('form')
    .send({ username, phone, email, password: PASSWORD, confirmPassword: PASSWORD, _csrf: token });
  expect(res.status).toBe(302);
  createdUsernames.push(username);
  return { username, phone, email, password: PASSWORD };
}

async function agentAt(ip, path = '/login') {
  const agent = wrapAgentWithIp(request.agent(app), ip);
  const page = await agent.get(path);
  return { agent, token: extractCsrfToken(page.text), page };
}

async function postLogin(ip, identifier, password) {
  const { agent, token } = await agentAt(ip);
  const res = await agent.post('/login').type('form').send({ identifier, password, _csrf: token });
  return { res, agent, token };
}

// CAPTCHA-সহ সম্পূর্ণ লগইন ফ্লো (আসল ইউজারের মতো): POST → /login-এ ফেরত → CAPTCHA পড়া → সমাধান → POST
async function loginSolvingCaptchaIfAsked(ip, identifier, password) {
  const first = await postLogin(ip, identifier, password);
  if (first.res.status !== 302 || !/\/login/.test(first.res.headers.location || '')) return { ...first, askedCaptcha: false };
  const page = await first.agent.get('/login');
  const m = /(\d+)\s*([+-])\s*(\d+)\s*=\s*\?/.exec(page.text || '');
  if (!m) return { ...first, askedCaptcha: false };
  const answer = m[2] === '+' ? Number(m[1]) + Number(m[3]) : Number(m[1]) - Number(m[3]);
  const token = extractCsrfToken(page.text);
  const res = await first.agent.post('/login').type('form')
    .send({ identifier, password, captcha_answer: String(answer), _csrf: token });
  return { res, agent: first.agent, askedCaptcha: true };
}

const loggedIn = (res) => res.status === 302 && !/\/login/.test(res.headers.location || '');

const whitelisted = [];
// bot-detection-এর velocity সংকেত (একই IP থেকে দ্রুত অনেক রিকোয়েস্ট → CAPTCHA) limiter থেকে আলাদা জিনিস।
// যে টেস্ট শুধু limiter-এর গণনা মাপতে চায় সেখানে IP whitelist করা হয়, যাতে সেই সংকেত ফলাফল না বদলায়।
async function whitelistIp(ip) {
  await require('../../services/ipRules').setIpRule(ip, 'whitelist', 'loginLockoutAbuse test', null);
  whitelisted.push(ip);
}

afterAll(async () => {
  if (whitelisted.length) await pool.query('DELETE FROM ip_rules WHERE ip = ANY($1)', [whitelisted]).catch(() => {});
  if (createdUsernames.length) {
    await pool.query('DELETE FROM admin_logs WHERE admin_id IN (SELECT id FROM users WHERE username = ANY($1))', [createdUsernames]).catch(() => {});
    await pool.query('DELETE FROM users WHERE username = ANY($1)', [createdUsernames]);
  }
});

describe('A2 — লগইন লক-আউট অপব্যবহার ঠেকানো', () => {
  // ---------- টেস্ট (1) ----------
  test('(1) আক্রমণকারী IP ভিকটিমের অ্যাকাউন্টে ৫০ বার ব্যর্থ হলেও আসল মালিক অন্য IP থেকে ঢুকতে পারে', async () => {
    const victim = await registerUser();
    const attackerIp = fakeIp();
    const ownerIp = fakeIp();

    const { agent, token } = await agentAt(attackerIp);
    const statuses = [];
    for (let i = 0; i < 50; i++) {
      const r = await agent.post('/login').type('form')
        .send({ identifier: victim.username, password: 'WrongPassword999', _csrf: token });
      statuses.push(r.status);
    }
    // আক্রমণকারী নিজের IP+অ্যাকাউন্ট জোড়ায় আটকায় (প্রথম ১০টা ৩০২, তারপর ৪২৯)
    expect(statuses.slice(0, 10).every((s) => s === 302)).toBe(true);
    expect(statuses.slice(10).every((s) => s === 429)).toBe(true);

    // আসল মালিক নিজের IP থেকে: ৪২৯ নয়; CAPTCHA চাইলেও সমাধান করে ঢুকতে পারে (নরম প্রতিক্রিয়া, লক নয়)
    const owner = await loginSolvingCaptchaIfAsked(ownerIp, victim.username, victim.password);
    expect(owner.res.status).not.toBe(429);
    expect(loggedIn(owner.res)).toBe(true);
    const profile = await owner.agent.get('/profile');
    expect(profile.status).toBe(200);
  });

  test('(1b) আক্রমণকারীর IP-তে আটকে থাকা অবস্থাতেও একই IP-র *অন্য* অ্যাকাউন্ট আটকায় না (CGNAT)', async () => {
    const victim = await registerUser();
    const bystander = await registerUser();
    const sharedIp = fakeIp();

    const { agent, token } = await agentAt(sharedIp);
    for (let i = 0; i < 12; i++) {
      await agent.post('/login').type('form').send({ identifier: victim.username, password: 'WrongPassword999', _csrf: token });
    }
    const blocked = await agent.post('/login').type('form').send({ identifier: victim.username, password: 'WrongPassword999', _csrf: token });
    expect(blocked.status).toBe(429);

    const ok = await postLogin(sharedIp, bystander.username, bystander.password);
    expect(loggedIn(ok.res)).toBe(true);
  });

  // ---------- টেস্ট (2) ----------
  test('(2) সফল লগইন ব্যর্থ-চেষ্টার বাজেট খরচ করে না', async () => {
    const user = await registerUser();
    const ip = fakeIp();
    await whitelistIp(ip);

    // বাজেট (১০) ছাড়িয়ে ১৫ বার সফল লগইন — একটাও ৪২৯ নয়
    for (let i = 0; i < 15; i++) {
      const { res } = await postLogin(ip, user.username, user.password);
      expect(res.status).not.toBe(429);
      expect(loggedIn(res)).toBe(true);
    }
    // বাজেট অক্ষত: ঠিক ১০টা ব্যর্থ চেষ্টা চলে, ১১তমটা ৪২৯
    const { agent, token } = await agentAt(ip);
    const codes = [];
    for (let i = 0; i < 11; i++) {
      const r = await agent.post('/login').type('form')
        .send({ identifier: user.username, password: 'WrongPassword999', _csrf: token });
      codes.push(r.status);
    }
    expect(codes.slice(0, 10).every((c) => c === 302)).toBe(true);
    expect(codes[10]).toBe(429);
  });

  // ---------- টেস্ট (3) ----------
  describe('(3) রিসেট: অস্তিত্বশীল ও অনস্তিত্ব অ্যাকাউন্টে অভিন্ন রেসপন্স', () => {
    const normalize = (html) => String(html || '')
      .replace(/(<meta name="csrf-token" content=")[^"]*(")/g, '$1X$2')
      .replace(/(name="_csrf"[^>]*value=")[^"]*(")/g, '$1X$2')
      .replace(/(name="form_rendered_at"[^>]*value=")[^"]*(")/g, '$1X$2')
      .replace(/nonce="[^"]*"/g, 'nonce="X"');

    async function requestReset(ip, email) {
      const { agent, token } = await agentAt(ip, '/forgot-password');
      return agent.post('/forgot-password').type('form').send({ email, _csrf: token });
    }

    test('স্ট্যাটাস, হেডার ও বডি অভিন্ন', async () => {
      const u = await registerUser({ withEmail: true });
      const known = await requestReset(fakeIp(), u.email);
      const unknown = await requestReset(fakeIp(), `nobody-${Date.now()}@lockout.test`);

      expect(known.status).toBe(unknown.status);
      expect(known.headers.location || '').toBe(unknown.headers.location || '');
      expect(known.headers['content-type']).toBe(unknown.headers['content-type']);
      expect(normalize(known.text)).toBe(normalize(unknown.text));
    });

    test('সীমা-ছোঁয়া (৪২৯) রেসপন্সও অভিন্ন — একই IP থেকে ৬ষ্ঠ রিকোয়েস্টে', async () => {
      const u = await registerUser({ withEmail: true });
      const ghost = `ghost-${Date.now()}@lockout.test`;
      const ipA = fakeIp();
      const ipB = fakeIp();
      let lastKnown; let lastUnknown;
      for (let i = 0; i < 6; i++) {
        lastKnown = await requestReset(ipA, u.email);
        lastUnknown = await requestReset(ipB, ghost);
      }
      expect(lastKnown.status).toBe(429);
      expect(lastUnknown.status).toBe(429);
      expect(normalize(lastKnown.text)).toBe(normalize(lastUnknown.text));
    });

    test('রেসপন্স-টাইম অস্তিত্বের ওপর নির্ভর করে না: টোকেন-ইস্যুর ধীর DB লেখা রেসপন্স আটকায় না', async () => {
      const u = await registerUser({ withEmail: true });
      const realQuery = pool.query.bind(pool);
      const spy = jest.spyOn(pool, 'query').mockImplementation(async (sql, ...rest) => {
        if (typeof sql === 'string' && /UPDATE users SET reset_token/.test(sql)) {
          await new Promise((r) => setTimeout(r, 1500)); // ইচ্ছাকৃত ধীর
        }
        return realQuery(sql, ...rest);
      });
      try {
        const t0 = Date.now();
        const res = await requestReset(fakeIp(), u.email);
        const elapsed = Date.now() - t0;
        expect(res.status).toBe(200);
        // ধীর UPDATE (১.৫ সেকেন্ড) রেসপন্স-পথে নেই
        expect(elapsed).toBeLessThan(1200);

        // কিন্তু কাজটা ঠিকই হয় (ব্যাকগ্রাউন্ডে) — টোকেন শেষে সেভ হয়
        let stored = null;
        for (let i = 0; i < 40 && !stored; i++) {
          await new Promise((r) => setTimeout(r, 100));
          const row = await realQuery('SELECT reset_token FROM users WHERE email = $1', [u.email]);
          stored = row.rows[0] && row.rows[0].reset_token;
        }
        expect(stored).toBeTruthy();
      } finally {
        spy.mockRestore();
      }
    });

    test('রিসেট কী = অ্যাকাউন্ট+IP: আক্রমণকারী IP ভিকটিমের রিসেট-বাজেট পোড়ালেও মালিক অন্য IP থেকে পায়', async () => {
      const u = await registerUser({ withEmail: true });
      const attackerIp = fakeIp();
      for (let i = 0; i < 7; i++) await requestReset(attackerIp, u.email);
      const blocked = await requestReset(attackerIp, u.email);
      expect(blocked.status).toBe(429);

      const owner = await requestReset(fakeIp(), u.email);
      expect(owner.status).toBe(200);
    });
  });

  // ---------- টেস্ট (4) ----------
  describe('(4) বিদ্যমান সীমা ঢিলা হয়নি', () => {
    test('একক অ্যাকাউন্ট+IP: ঠিক ১০টা ব্যর্থ লগইন, ১১তম ৪২৯', async () => {
      const u = await registerUser();
      const { agent, token } = await agentAt(fakeIp());
      const codes = [];
      for (let i = 0; i < 11; i++) {
        const r = await agent.post('/login').type('form').send({ identifier: u.username, password: 'WrongPassword999', _csrf: token });
        codes.push(r.status);
      }
      expect(codes.filter((c) => c === 302)).toHaveLength(10);
      expect(codes[10]).toBe(429);
    });

    test('একই IP থেকে অ্যাকাউন্ট ঘুরিয়ে চেষ্টা: identifier-ছাড়া POST এখনো কড়া IP-কী (১০/১৫মি)', async () => {
      const { agent, token } = await agentAt(fakeIp());
      const codes = [];
      for (let i = 0; i < 11; i++) {
        const r = await agent.post('/login').type('form').send({ password: 'x', _csrf: token });
        codes.push(r.status);
      }
      expect(codes[10]).toBe(429);
    });

    test('রিসেট: একক অ্যাকাউন্ট+IP-তে ঠিক ৫টা, ৬ষ্ঠ ৪২৯', async () => {
      const u = await registerUser({ withEmail: true });
      const { agent, token } = await agentAt(fakeIp(), '/forgot-password');
      const codes = [];
      for (let i = 0; i < 6; i++) {
        const r = await agent.post('/forgot-password').type('form').send({ email: u.email, _csrf: token });
        codes.push(r.status);
      }
      expect(codes.slice(0, 5).every((c) => c === 200)).toBe(true);
      expect(codes[5]).toBe(429);
    });

    test('সোর্সে সীমার সংখ্যা অপরিবর্তিত (১০ / ১০০ / ৫ / ৮) ও অ্যাকাউন্ট-ব্যাপী লিমিটার নরম (handler → next)', () => {
      const fs = require('fs');
      const path = require('path');
      const read = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');
      expect(read('app.js')).toMatch(/const loginLimiter = rateLimit\(\{[\s\S]*?max: 10,[\s\S]*?skipSuccessfulRequests: true/);
      expect(read('app.js')).toMatch(/const loginIpCeilingLimiter = rateLimit\(\{[\s\S]*?max: 100,[\s\S]*?skipSuccessfulRequests: true/);
      expect(read('routes/auth.js')).toMatch(/const resetLimiter = rateLimit\(\{[\s\S]*?max: 5,/);
      expect(read('routes/admin.js')).toMatch(/const adminLoginLimiter = rateLimit\(\{[\s\S]*?max: 8,[\s\S]*?skipSuccessfulRequests: true/);
      const soft = read('middleware/loginLimiters.js');
      expect(soft).toMatch(/handler: soft\(1000\)/);
      expect(soft).toMatch(/handler: soft\(5000\)/);
      expect(soft).not.toMatch(/status\(429\)/); // অ্যাকাউন্ট-ব্যাপী পথে কোনো হার্ড রিজেক্ট নেই
    });
  });

  // ---------- অতিরিক্ত: নরম থ্রটলের আচরণ ----------
  describe('অ্যাকাউন্ট-ব্যাপী নরম থ্রটল: লক নয়, এবং অস্তিত্ব-নিরপেক্ষ', () => {
    async function burnAcrossIps(identifier, n = 9) {
      for (let i = 0; i < n; i++) await postLogin(fakeIp(), identifier, 'WrongPassword999');
    }

    test('বহু IP থেকে ব্যর্থ চেষ্টার পর সঠিক পাসওয়ার্ড: প্রথমে CAPTCHA চায়, সমাধানে ঢোকা যায়', async () => {
      const u = await registerUser();
      await burnAcrossIps(u.username);
      const r = await loginSolvingCaptchaIfAsked(fakeIp(), u.username, u.password);
      expect(r.askedCaptcha).toBe(true);
      expect(loggedIn(r.res)).toBe(true);
    });

    test('অনস্তিত্ব identifier-এও একই আচরণ (CAPTCHA চায়) — অস্তিত্ব ফাঁস হয় না', async () => {
      const ghost = `ghost_${Date.now()}`;
      await burnAcrossIps(ghost);
      const first = await postLogin(fakeIp(), ghost, 'WhateverPass123');
      expect(first.res.status).toBe(302);
      expect(first.res.headers.location).toMatch(/\/login/);
      const page = await first.agent.get('/login');
      expect(page.text).toMatch(/\d+\s*[+-]\s*\d+\s*=\s*\?/); // CAPTCHA দেখানো হয়েছে
    });
  });

  // ---------- অ্যাডমিন লগইন ----------
  test('অ্যাডমিন লগইন: সফল চেষ্টা বাজেট খায় না; ব্যর্থ সীমা ৮ অপরিবর্তিত; কী অ্যাকাউন্ট+IP', async () => {
    const admin = await registerUser();
    await pool.query('UPDATE users SET role = $1 WHERE username = $2', ['admin', admin.username]);
    const ip = fakeIp();

    const adminPost = async (username, password, ipAddr = ip) => {
      const { agent, token } = await agentAt(ipAddr, '/admin/login');
      return agent.post('/admin/login').type('form').send({ username, password, _csrf: token });
    };

    // ৮-এর বেশি সফল পাসওয়ার্ড-যাচাই — একটাও ৪২৯ নয়
    for (let i = 0; i < 10; i++) {
      const r = await adminPost(admin.username, admin.password);
      expect(r.status).not.toBe(429);
    }
    // ঠিক ৮টা ব্যর্থ চলে, ৯ম ৪২৯ (একই IP+অ্যাকাউন্ট)
    const codes = [];
    for (let i = 0; i < 9; i++) codes.push((await adminPost(admin.username, 'WrongPassword999')).status);
    expect(codes.slice(0, 8).every((c) => c !== 429)).toBe(true);
    expect(codes[8]).toBe(429);

    // অন্য IP থেকে একই অ্যাডমিন ব্লক নয়
    const other = await adminPost(admin.username, admin.password, fakeIp());
    expect(other.status).not.toBe(429);
  });
});
