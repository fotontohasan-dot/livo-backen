// tests/integration/featureFlagMatrix.test.js
// ---------------------------------------------------------------------------
// চূড়ান্ত যাচাই — রেজিস্ট্রির **প্রতিটা** ফিচারের জন্য পুরো লাইফসাইকেল।
//
// আগের enforcement টেস্ট কয়েকটা প্রতিনিধিত্বমূলক ফিচার (lucky_wheel, games,
// deposit…) ধরে যাচাই করত। এখানে ২০টার প্রতিটার জন্য যান্ত্রিকভাবে চালানো হয়:
//   ON → অ্যাক্সেস আছে · OFF → ব্লক · আবার ON → অ্যাক্সেস ফেরে (রিস্টার্ট ছাড়া)
// সাথে DB persistence, ক্যাশ ইনভ্যালিডেশন ও পুরনো সেশনের বাইপাস-অক্ষমতা।
// ---------------------------------------------------------------------------

const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const { pool } = require('../../db');
const featureFlags = require('../../services/featureFlags');
const registry = require('../../services/featureRegistry');

// প্রতিটা ফিচারের একটা প্রতিনিধিত্বমূলক GET রুট, যেটা গেটের আওতায় থাকার কথা।
// `null` = এই ফিচারের কোনো GET পৃষ্ঠা নেই (শুধু POST/অ্যাকশন), তখন সেটা
// আলাদাভাবে POST দিয়ে যাচাই হয়।
const PROBE = {
  games:          { get: '/games' },
  sports:         { get: '/matches' },
  sports_betting: { post: '/matches/1/bet' },
  accumulator:    { get: '/accumulator' },
  tournaments:    { get: '/tournaments' },
  deposit:        { get: '/payment/deposit' },
  withdrawal:     { get: '/payment/withdraw' },
  vip:            { get: '/profile/vip' },
  cashback:       { get: '/profile/cashback' },
  referral:       { get: '/profile/referral' },
  missions:       { get: '/profile/missions' },
  lucky_wheel:    { get: '/profile/wheel' },
  daily_rewards:  { get: '/profile/rewards' },
  free_bet:       { get: '/profile/freebet' },
  leaderboard:    { get: '/leaderboard' },
  promotions:     { get: '/extra/promotion' },
  live_chat:      { get: '/chat' },
  ai_chatbot:     { post: '/help-center/api/chat' },
  news:           { get: '/news' },
  notifications:  { get: '/notifications' }
};

async function setFlag(key, enabled) {
  await pool.query('UPDATE feature_flags SET enabled=$1 WHERE key=$2', [enabled, key]);
  await featureFlags.invalidateCache();
}

let agent;
let csrf;

beforeAll(async () => {
  const reg = await getCsrfAgent('/register');
  await reg.agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
    .send({ username: uniqueUsername('mtx'), phone: uniquePhone(), password: 'SecurePass123',
            confirmPassword: 'SecurePass123', _csrf: reg.token });
  agent = reg.agent;   // সেশনটা সব ফিচার ON থাকা অবস্থায় তৈরি
  csrf = reg.token;
});

afterEach(async () => {
  await pool.query('UPDATE feature_flags SET enabled=true');
  await featureFlags.invalidateCache();
});

afterAll(async () => {
  await pool.query('UPDATE feature_flags SET enabled=true');
  await featureFlags.invalidateCache();
});

describe('রেজিস্ট্রির অখণ্ডতা', () => {
  test('প্রতিটা রেজিস্ট্রি এন্ট্রির জন্য একটা probe রুট সংজ্ঞায়িত', () => {
    expect(Object.keys(PROBE).sort()).toEqual(registry.keys().sort());
  });

  test('প্রতিটা ফিচারের DB সারি আছে (seed হয়েছে)', async () => {
    const rows = (await pool.query('SELECT key FROM feature_flags')).rows.map(r => r.key);
    for (const k of registry.keys()) expect(rows).toContain(k);
  });
});

describe.each(registry.keys())('ফিচার: %s', (key) => {
  const probe = PROBE[key];
  const url = probe.get || probe.post;
  const send = (a) => probe.get
    ? a.get(url).set('Accept', 'text/html')
    : a.post(url).set('Accept', 'application/json').send({ _csrf: csrf });

  test('ON → অ্যাক্সেস ব্লক হয় না', async () => {
    await setFlag(key, true);
    const res = await send(agent);
    // 200/302/400/404 যা-ই হোক — গেট 403 দিয়ে থামায়নি সেটাই যাচাইয়ের বিষয়
    expect(res.status).not.toBe(403);
  });

  test('OFF → সরাসরি URL/API ব্লক হয় (403), এবং কারণটা ফিচার গেটই', async () => {
    await setFlag(key, false);
    const res = await send(agent);
    expect(res.status).toBe(403);
    // 403 অন্য কারণেও (CSRF/অনুমতি) আসতে পারে — তাই বার্তা মিলিয়ে নিশ্চিত
    // করা হচ্ছে যে থামিয়েছে ফিচার গেটই।
    const bn = require('../../locales/bn.json');
    const body = res.text || JSON.stringify(res.body || {});
    expect(body).toContain(bn.feature_currently_disabled);
  });

  test('OFF → আগে থেকে চালু সেশনও বাইপাস করতে পারে না', async () => {
    // agent-এর সেশন beforeAll-এ, সব ফিচার ON থাকা অবস্থায় তৈরি হয়েছে
    await setFlag(key, false);
    expect((await send(agent)).status).toBe(403);
  });

  test('আবার ON → সার্ভার রিস্টার্ট ছাড়াই অ্যাক্সেস ফেরে', async () => {
    await setFlag(key, false);
    expect((await send(agent)).status).toBe(403);
    await setFlag(key, true);
    expect((await send(agent)).status).not.toBe(403);
  });

  test('DB persistence + ক্যাশ ইনভ্যালিডেশন', async () => {
    await featureFlags.setFlag(key, false, null, null);
    const row = (await pool.query('SELECT enabled FROM feature_flags WHERE key=$1', [key])).rows[0];
    expect(row.enabled).toBe(false);                      // persisted
    expect(await featureFlags.isEnabled(key)).toBe(false); // cache invalidated
    await featureFlags.setFlag(key, true, null, null);
    expect(await featureFlags.isEnabled(key)).toBe(true);
  });

  test('OFF → UI locals-এ ফিচারটি false (নেভিগেশন লুকানোর ভিত্তি)', async () => {
    await setFlag(key, false);
    const map = await featureFlags.getEnabledMap();
    expect(map[key]).toBe(false);
  });
});
