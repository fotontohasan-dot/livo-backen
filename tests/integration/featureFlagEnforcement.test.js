// tests/integration/featureFlagEnforcement.test.js
// ---------------------------------------------------------------------------
// ফিচার ফ্ল্যাগের সার্ভার-সাইড প্রয়োগ যাচাই।
//
// যে বাগটা এই টেস্ট লক করছে: services/featureFlags.js আগে *শুধু* অ্যাডমিন CRUD
// পেজে ব্যবহৃত হতো — কোনো ইউজার-ফেসিং রুট কখনো isEnabled() কল করত না (পুরো
// রিপোতে grep করলে একমাত্র consumer ছিল routes/admin.js)। অর্থাৎ অ্যাডমিন একটা
// ফিচার "বন্ধ" করলে বাস্তবে কিছুই বন্ধ হতো না — সরাসরি URL বা API কল আগের মতোই
// কাজ করত।
//
// প্রতিটা দাবি আসল HTTP রিকোয়েস্ট দিয়ে যাচাই করা হয়, সোর্স-গ্রেপ দিয়ে নয়।
// ---------------------------------------------------------------------------

const { getCsrfAgent, uniqueUsername, uniquePhone } = require('../helpers/app');
const { pool } = require('../../db');
const featureFlags = require('../../services/featureFlags');
const registry = require('../../services/featureRegistry');

async function setFlag(key, enabled) {
  await pool.query('UPDATE feature_flags SET enabled=$1 WHERE key=$2', [enabled, key]);
  await featureFlags.invalidateCache();
}

async function makeUserAgent() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername('feat');
  await agent.post('/register').type('form').send({
    username,
    phone: uniquePhone(),
    password: 'SecurePass123',
    confirmPassword: 'SecurePass123',
    _csrf: token
  });
  return { agent, username };
}

describe('ফিচার ফ্ল্যাগ — সার্ভার-সাইড প্রয়োগ', () => {
  let agent;

  beforeAll(async () => {
    const made = await makeUserAgent();
    agent = made.agent;
  });

  afterEach(async () => {
    // প্রতিটা টেস্টের পর সব ফ্ল্যাগ আবার চালু — অন্য টেস্ট প্রভাবিত না হয়
    await pool.query('UPDATE feature_flags SET enabled=true');
    await featureFlags.invalidateCache();
  });

  // afterEach ছাড়াও afterAll — কোনো টেস্ট মাঝপথে throw করলে (বা beforeAll
  // ব্যর্থ হলে) afterEach চলে না, আর feature_flags টেবিলটা পুরো টেস্ট DB-তে
  // শেয়ার্ড। ফ্ল্যাগ বন্ধ অবস্থায় ছেড়ে গেলে পরের suite-গুলোর (/games,
  // /matches, /coins) রুট 403 পেত — অর্থাৎ সম্পূর্ণ অসম্পর্কিত টেস্ট ফেল করত।
  afterAll(async () => {
    await pool.query('UPDATE feature_flags SET enabled=true');
    await featureFlags.invalidateCache();
  });

  test('টেস্ট হার্নেস কার্যকর — সেশন প্রতিষ্ঠিত হয়েছে', async () => {
    const res = await agent.get('/profile');
    expect(res.status).toBe(200);
  });

  describe('lucky_wheel — স্পেসিফিকেশনের রেফারেন্স কেস', () => {
    test('ON থাকলে ইউজার পেজে ঢুকতে পারে', async () => {
      await setFlag('lucky_wheel', true);
      expect((await agent.get('/profile/wheel')).status).toBe(200);
    });

    test('OFF করলে সরাসরি URL আর কাজ করে না', async () => {
      await setFlag('lucky_wheel', false);
      expect((await agent.get('/profile/wheel')).status).toBe(403);
    });

    test('OFF অবস্থায় POST/API রিকোয়েস্টও প্রত্যাখ্যাত হয় (UI বাইপাস করা যায় না)', async () => {
      await setFlag('lucky_wheel', false);
      const res = await agent.post('/profile/wheel/spin')
        .set('Accept', 'application/json').send({});
      expect(res.status).toBe(403);
    });

    test('আগে থেকে লগইন করা সেশনও বন্ধ ফিচার ব্যবহার করতে পারে না', async () => {
      await setFlag('lucky_wheel', true);
      expect((await agent.get('/profile/wheel')).status).toBe(200);
      await setFlag('lucky_wheel', false);
      // একই এজেন্ট, একই কুকি — তবু ব্লক
      expect((await agent.get('/profile/wheel')).status).toBe(403);
    });

    test('আবার ON করলে অ্যাক্সেস ফিরে আসে (সার্ভার রিস্টার্ট ছাড়াই)', async () => {
      await setFlag('lucky_wheel', false);
      expect((await agent.get('/profile/wheel')).status).toBe(403);
      await setFlag('lucky_wheel', true);
      expect((await agent.get('/profile/wheel')).status).toBe(200);
    });

    test('বন্ধ থাকার বার্তা ইউজার-নিরাপদ — key/DB বিবরণ ফাঁস করে না', async () => {
      await setFlag('lucky_wheel', false);
      const res = await agent.get('/profile/wheel');
      expect(res.text).not.toMatch(/lucky_wheel/);
      expect(res.text).not.toMatch(/feature_flags/);
      expect(res.text).not.toMatch(/SELECT |pg_|ECONNREFUSED/i);
    });
  });

  describe('রাউটার-লেভেল গেট — সাব-পাথও বাদ পড়ে না', () => {
    test('games OFF হলে সাব-রুট ও API দুটোই ব্লক হয়', async () => {
      await setFlag('games', false);
      expect((await agent.get('/games/play')).status).toBe(403);
      expect((await agent.get('/games/api/recent-wins')).status).toBe(403);
    });

    test('leaderboard OFF হলে পাবলিক পেজ ব্লক হয়', async () => {
      await setFlag('leaderboard', false);
      expect((await agent.get('/leaderboard')).status).toBe(403);
    });
  });

  describe('অডিটে পাওয়া ফাঁক — কয়েন-প্রদানকারী ও ব্রাউজিং রুট', () => {
    test('daily_rewards OFF হলে /coins/daily-bonus কয়েন দেয় না', async () => {
      // Phase 2 অডিটে পাওয়া: এই রুট ১০০ কয়েন দিত কিন্তু ফ্ল্যাগ দেখত না।
      await setFlag('daily_rewards', false);
      const res = await agent.post('/coins/daily-bonus')
        .set('Accept', 'application/json').send({});
      expect(res.status).toBe(403);
    });

    test('sports OFF হলে ম্যাচ ব্রাউজিংও বন্ধ হয় (শুধু বেটিং নয়)', async () => {
      await setFlag('sports', false);
      expect((await agent.get('/matches')).status).toBe(403);
      expect((await agent.get('/matches/cricket')).status).toBe(403);
    });

    test('sports ON কিন্তু sports_betting OFF — ম্যাচ দেখা যায়, বাজি ধরা যায় না', async () => {
      await setFlag('sports', true);
      await setFlag('sports_betting', false);
      expect((await agent.get('/matches')).status).toBe(200);
      const bet = await agent.post('/matches/1/bet')
        .set('Accept', 'application/json').send({ stake: '10' });
      expect(bet.status).toBe(403);
    });
  });

  describe('আর্থিক ফিচার', () => {
    test('deposit OFF হলে নতুন ডিপোজিট পেজ নেওয়া হয় না', async () => {
      await setFlag('deposit', false);
      expect((await agent.get('/payment/deposit')).status).toBe(403);
    });

    test('withdrawal OFF হলে নতুন উইথড্র পেজ নেওয়া হয় না', async () => {
      await setFlag('withdrawal', false);
      expect((await agent.get('/payment/withdraw')).status).toBe(403);
    });

    test('deposit OFF থাকলেও গেটওয়ে কলব্যাক ফিচার গেটে আটকায় না (চলমান টাকা আটকে যায় না)', async () => {
      await setFlag('deposit', false);
      const res = await agent.post('/payment/sslcommerz/fail')
        .type('form').send({ tran_id: 'nonexistent-tran' });
      expect(res.status).not.toBe(403);
    });
  });

  describe('গেটের আওতা সীমিত — মূল অ্যাকাউন্ট কাজ অক্ষত', () => {
    test('সব রিওয়ার্ড ফিচার বন্ধ থাকলেও প্রোফাইল ও ওয়ালেট খোলে', async () => {
      await pool.query('UPDATE feature_flags SET enabled=false WHERE key = ANY($1)',
        [['lucky_wheel', 'missions', 'cashback', 'vip', 'referral', 'daily_rewards', 'free_bet']]);
      await featureFlags.invalidateCache();
      expect((await agent.get('/profile')).status).toBe(200);
      expect((await agent.get('/payment/wallet')).status).toBe(200);
    });
  });

  describe('ক্যাশ ইনভ্যালিডেশন', () => {
    test('setFlag() করার সাথে সাথেই পরের রিড নতুন মান দেখে', async () => {
      await featureFlags.setFlag('missions', false, null, null);
      expect(await featureFlags.isEnabled('missions')).toBe(false);
      await featureFlags.setFlag('missions', true, null, null);
      expect(await featureFlags.isEnabled('missions')).toBe(true);
    });

    test('DB সারি না থাকলে রেজিস্ট্রির ডিফল্টে ফিরে যায় (fail-safe)', async () => {
      const saved = await pool.query('SELECT * FROM feature_flags WHERE key=$1', ['news']);
      await pool.query('DELETE FROM feature_flags WHERE key=$1', ['news']);
      await featureFlags.invalidateCache();
      expect(await featureFlags.isEnabled('news')).toBe(registry.defaultFor('news'));
      const row = saved.rows[0];
      await pool.query(
        'INSERT INTO feature_flags (key,label,category,enabled,description) VALUES ($1,$2,$3,$4,$5)',
        [row.key, row.label, row.category, row.enabled, row.description]);
      await featureFlags.invalidateCache();
    });
  });
});
