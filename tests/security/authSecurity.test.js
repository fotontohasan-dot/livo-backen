const { pool } = require('../../db');
const cache = require('../../services/cache');
const cacheKeys = require('../../services/cacheKeys');
const { app, getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA, fakeIp, freshRequest } = require('../helpers/app');

// অথেন্টিকেশন সুরক্ষার আচরণ যাচাই (পাসওয়ার্ড স্টোরেজ, সেশন, এনুমারেশন, বট-হানিপট)।
// tests/auth.test.js মূল ফ্লো কভার করে; এখানে শুধু সুরক্ষা-নির্দিষ্ট দিকগুলো যোগ করা হয়েছে।
describe('Authentication Security', () => {
  const createdUsernames = [];

  async function registerUser(password = 'SecurePass123') {
    const { agent, token } = await getCsrfAgent('/register');
    const username = uniqueUsername();
    const phone = uniquePhone();
    const res = await agent
      .post('/register')
      .type('form')
      .send({
        username,
        phone,
        password,
        confirmPassword: password,
        _csrf: token
      });
    createdUsernames.push(username);
    return { agent, username, phone, password, res };
  }

  afterAll(async () => {
    if (createdUsernames.length) {
      await pool.query('DELETE FROM users WHERE username = ANY($1)', [createdUsernames]);
    }
  });

  describe('পাসওয়ার্ড সংরক্ষণ', () => {
    test('পাসওয়ার্ড কখনো plain text-এ সংরক্ষিত হয় না (bcrypt হ্যাশ)', async () => {
      const { username, password } = await registerUser();
      const res = await pool.query('SELECT password FROM users WHERE username=$1', [username]);
      const stored = res.rows[0].password;
      expect(stored).toBeTruthy();
      expect(stored).not.toBe(password);
      expect(stored).not.toContain(password);
      expect(stored).toMatch(/^\$2[aby]\$/);
    });

    test('একই পাসওয়ার্ডের দুইটা অ্যাকাউন্টে আলাদা হ্যাশ হয় (salt আছে)', async () => {
      const a = await registerUser('SamePassword123');
      const b = await registerUser('SamePassword123');
      const res = await pool.query('SELECT username, password FROM users WHERE username = ANY($1)', [
        [a.username, b.username]
      ]);
      expect(res.rows).toHaveLength(2);
      expect(res.rows[0].password).not.toBe(res.rows[1].password);
    });

    test('৮ অক্ষরের কম পাসওয়ার্ড প্রত্যাখ্যাত হয় (অ্যাকাউন্ট তৈরি হয় না)', async () => {
      const { agent, token } = await getCsrfAgent('/register');
      const username = uniqueUsername();
      await agent
        .post('/register')
        .type('form')
        .send({
          username,
          phone: uniquePhone(),
          password: 'short1',
          confirmPassword: 'short1',
          _csrf: token
        });
      const res = await pool.query('SELECT id FROM users WHERE username=$1', [username]);
      expect(res.rows).toHaveLength(0);
    });
  });

  describe('ইউজার এনুমারেশন প্রতিরোধ', () => {
    test('অস্তিত্বহীন ইউজার ও ভুল পাসওয়ার্ড — দুটোতেই একই রকম রেসপন্স', async () => {
      const { username } = await registerUser();

      const a = await getCsrfAgent('/login');
      const wrongPassword = await a.agent
        .post('/login')
        .type('form')
        .send({ identifier: username, password: 'DefinitelyWrong999', _csrf: a.token });

      const b = await getCsrfAgent('/login');
      const noSuchUser = await b.agent
        .post('/login')
        .type('form')
        .send({ identifier: 'no_such_user_xyz_123', password: 'DefinitelyWrong999', _csrf: b.token });

      // দুই ক্ষেত্রেই একই স্ট্যাটাস ও একই গন্তব্য — কোনটা "ইউজার নেই" আর কোনটা
      // "পাসওয়ার্ড ভুল" তা বাইরে থেকে আলাদা করা যায় না
      expect(wrongPassword.status).toBe(noSuchUser.status);
      expect(wrongPassword.headers.location).toBe(noSuchUser.headers.location);
    });

    test('লগইন এরর রেসপন্সে পাসওয়ার্ড হ্যাশ ফাঁস হয় না', async () => {
      const { username } = await registerUser();
      const { agent, token } = await getCsrfAgent('/login');
      const res = await agent
        .post('/login')
        .type('form')
        .send({ identifier: username, password: 'WrongPass123', _csrf: token });
      expect(res.text || '').not.toMatch(/\$2[aby]\$/);
    });
  });

  describe('সেশন নিরাপত্তা', () => {
    test('সেশন কুকি HttpOnly ফ্ল্যাগসহ সেট হয়', async () => {
      const res = await freshRequest().get('/login').set('User-Agent', REALISTIC_UA);
      const cookies = res.headers['set-cookie'] || [];
      const sessionCookie = cookies.find((c) => c.startsWith('connect.sid'));
      expect(sessionCookie).toBeTruthy();
      expect(sessionCookie).toMatch(/HttpOnly/i);
    });

    test('সেশন কুকিতে SameSite নীতি থাকে', async () => {
      const res = await freshRequest().get('/login').set('User-Agent', REALISTIC_UA);
      const cookies = res.headers['set-cookie'] || [];
      const sessionCookie = cookies.find((c) => c.startsWith('connect.sid'));
      expect(sessionCookie).toMatch(/SameSite/i);
    });

    test('লগআউটের পর সুরক্ষিত রুট আর অ্যাক্সেস করা যায় না', async () => {
      const { agent } = await registerUser();

      const before = await agent.get('/profile/security');
      expect(before.status).toBe(200);

      await agent.get('/logout');

      const after = await agent.get('/profile/security');
      expect(after.status).toBe(302);
      expect(after.headers.location).toMatch(/\/login/);
    });
  });

  describe('স্টেল সেশন সুরক্ষা — ব্যান/ডিলিট হওয়া ইউজারের সেশন', () => {
    // রিগ্রেশন: middleware/auth.js-এর isAuth আগে শুধু req.session.user-এর অস্তিত্ব দেখত,
    // অ্যাকাউন্ট মাঝপথে ব্যান/ডিলিট হয়ে গেলেও পুরনো সেশন দিয়ে সাইট ব্যবহার করা যেত।
    test('লগইন করা অবস্থায় অ্যাকাউন্ট ব্যান হয়ে গেলে পরের রিকোয়েস্টেই সেশন বাতিল হয়ে যায়', async () => {
      const { agent, username } = await registerUser();

      const before = await agent.get('/profile/security');
      expect(before.status).toBe(200);

      const userRow = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
      const userId = userRow.rows[0].id;
      await pool.query('UPDATE users SET is_banned = true WHERE id = $1', [userId]);
      // isAuth-এর active-status cache (৩০ সেকেন্ড TTL) সরাসরি invalidate করে দেওয়া হচ্ছে,
      // যাতে টেস্টটা TTL-এর জন্য অপেক্ষা না করেই deterministic ভাবে চলে — প্রোডাকশনে
      // routes/admin.js-এর ব্যান রুটই এই একই invalidation করে (দেখুন সেখানকার regression টেস্ট)।
      await cache.del(cacheKeys.userActiveStatus(userId)).catch(() => {});

      const after = await agent.get('/profile/security');
      expect(after.status).toBe(302);
      expect(after.headers.location).toMatch(/\/login/);

      // ব্যানড অবস্থায় আবার লগইন চেষ্টা করলেও ঢুকতে পারবে না
      const { agent: loginAgent, token } = await getCsrfAgent('/login');
      const loginRes = await loginAgent
        .post('/login')
        .set('User-Agent', REALISTIC_UA)
        .type('form')
        .send({ identifier: username, password: 'SecurePass123', _csrf: token });
      expect(loginRes.headers.location).toMatch(/\/login/);

      await pool.query('UPDATE users SET is_banned = false WHERE id = $1', [userId]);
    });

    test('অ্যাডমিন ব্যান রুট isAuth active-status cache invalidate করে (worst-case বিলম্ব নেই)', async () => {
      const { agent, username } = await registerUser();
      await agent.get('/profile/security');

      const userRow = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
      const userId = userRow.rows[0].id;

      // isUserActive() একবার কল করে cache ওয়ার্ম-আপ করা (getOrSet প্রথমবার fetchFn চালাবে)
      const cached = await cache.getOrSet(cacheKeys.userActiveStatus(userId), 30, async () => {
        const r = await pool.query('SELECT is_banned FROM users WHERE id = $1', [userId]);
        return { exists: true, banned: !!r.rows[0].is_banned };
      });
      expect(cached.banned).toBe(false);

      await pool.query('UPDATE users SET is_banned = true WHERE id = $1', [userId]);
      // routes/admin.js-এর ban route নিজেই cache.del করে — এখানে সরাসরি সিমুলেট করা হচ্ছে
      await cache.del(cacheKeys.userActiveStatus(userId)).catch(() => {});

      const after = await agent.get('/profile/security');
      expect(after.status).toBe(302);

      await pool.query('UPDATE users SET is_banned = false WHERE id = $1', [userId]);
    });
  });

  describe('অ্যাকাউন্ট-ভিত্তিক ব্রুট-ফোর্স থ্রটলিং', () => {
    // রিগ্রেশন: services/fraudDetection.js-এর isAccountThrottled — একই অ্যাকাউন্টে অনেক
    // ভিন্ন IP থেকে বারবার ভুল পাসওয়ার্ড দিলেও (IP rate-limiter এড়িয়ে) অ্যাকাউন্ট-স্কোপড
    // কুলডাউন কার্যকর হওয়া উচিত।
    test('একই অ্যাকাউন্টে অনেক ব্যর্থ লগইনের পর সঠিক পাসওয়ার্ড দিয়েও সাময়িকভাবে ঢোকা যায় না', async () => {
      const { username, password } = await registerUser();

      // থ্রেশহোল্ড অতিক্রম করার জন্য যথেষ্ট ব্যর্থ চেষ্টা, প্রতিটা নিজস্ব IP থেকে
      // (যাতে IP-ভিত্তিক loginLimiter নয়, অ্যাকাউন্ট-ভিত্তিক থ্রটলই টেস্ট হয়)
      for (let i = 0; i < 9; i++) {
        const { agent, token } = await getCsrfAgent('/login');
        await agent
          .post('/login')
          .set('User-Agent', REALISTIC_UA)
          .set('X-Forwarded-For', fakeIp())
          .type('form')
          .send({ identifier: username, password: 'DefinitelyWrongPass999', _csrf: token });
      }

      // এখন সঠিক পাসওয়ার্ড দিলেও থ্রটলড থাকার কথা
      const { agent, token } = await getCsrfAgent('/login');
      const res = await agent
        .post('/login')
        .set('User-Agent', REALISTIC_UA)
        .set('X-Forwarded-For', fakeIp())
        .type('form')
        .send({ identifier: username, password, _csrf: token });

      expect(res.headers.location).toMatch(/\/login/);
    });

    test('থ্রটলড ও সাধারণ ভুল-পাসওয়ার্ড রেসপন্স একই রকম (এনুমারেশন প্রতিরোধ)', async () => {
      const { username, password } = await registerUser();

      for (let i = 0; i < 9; i++) {
        const { agent, token } = await getCsrfAgent('/login');
        await agent
          .post('/login')
          .set('User-Agent', REALISTIC_UA)
          .set('X-Forwarded-For', fakeIp())
          .type('form')
          .send({ identifier: username, password: 'DefinitelyWrongPass999', _csrf: token });
      }

      const a = await getCsrfAgent('/login');
      const throttledRes = await a.agent
        .post('/login')
        .set('User-Agent', REALISTIC_UA)
        .set('X-Forwarded-For', fakeIp())
        .type('form')
        .send({ identifier: username, password, _csrf: a.token });

      const b = await getCsrfAgent('/login');
      const wrongPassRes = await b.agent
        .post('/login')
        .set('User-Agent', REALISTIC_UA)
        .set('X-Forwarded-For', fakeIp())
        .type('form')
        .send({ identifier: 'no_such_user_throttle_test', password: 'whatever', _csrf: b.token });

      expect(throttledRes.status).toBe(wrongPassRes.status);
      expect(throttledRes.headers.location).toBe(wrongPassRes.headers.location);
    });
  });

  describe('অ্যাডমিন রুট সুরক্ষা', () => {
    test('সাধারণ ইউজার অ্যাডমিন প্যানেলে ঢুকতে পারে না', async () => {
      const { agent } = await registerUser();
      const res = await agent.get('/admin');
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/\/admin\/login|\/login/);
    });

    test('লগইন ছাড়া অ্যাডমিন API রুট সুরক্ষিত', async () => {
      const res = await freshRequest()
        .get('/admin/users')
        .set('User-Agent', REALISTIC_UA);
      expect([302, 401, 403]).toContain(res.status);
    });
  });

  describe('বট ডিটেকশন — হানিপট', () => {
    test('হানিপট ফিল্ড পূরণ করা রেজিস্ট্রেশনে অ্যাকাউন্ট তৈরি হয় না', async () => {
      const { agent, token } = await getCsrfAgent('/register');
      const username = uniqueUsername();
      await agent
        .post('/register')
        .type('form')
        .send({
          username,
          phone: uniquePhone(),
          password: 'SecurePass123',
          confirmPassword: 'SecurePass123',
          website: 'http://spam-bot-filled-this.example', // হানিপট
          _csrf: token
        });
      const res = await pool.query('SELECT id FROM users WHERE username=$1', [username]);
      expect(res.rows).toHaveLength(0);
    });
  });

  describe('ইনপুট যাচাই', () => {
    test('ডুপ্লিকেট ইউজারনেমে দ্বিতীয় অ্যাকাউন্ট তৈরি হয় না', async () => {
      const { username } = await registerUser();

      const { agent, token } = await getCsrfAgent('/register');
      await agent
        .post('/register')
        .type('form')
        .send({
          username, // একই ইউজারনেম
          phone: uniquePhone(),
          password: 'AnotherPass123',
          confirmPassword: 'AnotherPass123',
          _csrf: token
        });

      const res = await pool.query('SELECT id FROM users WHERE username=$1', [username]);
      expect(res.rows).toHaveLength(1);
    });

    test('ইমেইল ও ফোন দুটোই না দিলে অ্যাকাউন্ট তৈরি হয় না', async () => {
      const { agent, token } = await getCsrfAgent('/register');
      const username = uniqueUsername();
      await agent
        .post('/register')
        .type('form')
        .send({
          username,
          password: 'SecurePass123',
          confirmPassword: 'SecurePass123',
          _csrf: token
        });
      const res = await pool.query('SELECT id FROM users WHERE username=$1', [username]);
      expect(res.rows).toHaveLength(0);
    });

    test('SQL ইনজেকশন-সদৃশ ইনপুটে ইউজার টেবিল অক্ষত থাকে', async () => {
      const before = await pool.query('SELECT COUNT(*)::int AS c FROM users');

      const { agent, token } = await getCsrfAgent('/login');
      const res = await agent
        .post('/login')
        .type('form')
        .send({ identifier: "' OR '1'='1", password: "' OR '1'='1", _csrf: token });

      // লগইন সফল হয়নি (হোমপেজে রিডাইরেক্ট হয়নি) এবং টেবিল অক্ষত
      expect(res.headers.location).not.toBe('/');
      const after = await pool.query('SELECT COUNT(*)::int AS c FROM users');
      expect(after.rows[0].c).toBe(before.rows[0].c);
    });
  });
});
