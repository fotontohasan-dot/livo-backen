// tests/render/rewardsNestedFeatures.test.js
// ---------------------------------------------------------------------------
// Lucky Wheel, Badges, Loyalty, Daily Streak, Free Bet, Periodic Reward,
// Contest — এই ৭টা ফিচার আগে প্রোফাইল হোমপেজের ফ্ল্যাট গ্রিডে (member center)
// আলাদা আলাদা টাইল ছিল। এখন এগুলো সরিয়ে "Reward Center" (/profile/rewards,
// যেটা "Daily Reward" পেজ — t.daily_reward_title) পেজের ভেতরে নেস্ট করা
// হয়েছে। এই টেস্ট নিশ্চিত করে —
//   ১) প্রোফাইল হোমপেজে এই ৭টার কোনোটাই আর সরাসরি টাইল/লিংক নয়;
//   ২) Reward Center পেজে ৭টাই লিংক হিসেবে আছে (কোনোটা হারায়নি);
//   ৩) ব্যাকএন্ড রুটগুলো নিজেরাই অপরিবর্তিত ও এখনো কাজ করে।
// ---------------------------------------------------------------------------

const { getCsrfAgent, uniqueUsername, uniquePhone } = require('../helpers/app');

const MOVED_DESTINATIONS = [
  '/profile/wheel',
  '/profile/badges',
  '/profile/loyalty',
  '/profile/streak',
  '/profile/freebet',
  '/profile/periodic',
  '/profile/contest'
];

async function makeUserAgent() {
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
      _csrf: token
    });
  return { agent, username };
}

describe('রিওয়ার্ড ফিচার — প্রোফাইল হোমপেজ থেকে সরানো', () => {
  let html;

  beforeAll(async () => {
    const { agent } = await makeUserAgent();
    const res = await agent.get('/profile');
    expect(res.status).toBe(200);
    html = res.text;
  });

  test.each(MOVED_DESTINATIONS)('%s আর প্রোফাইল হোমপেজের সরাসরি টাইল নয়', (dest) => {
    expect(html).not.toContain(`href="${dest}"`);
  });

  test('Reward Center-এর টাইল এখনো আছে (গন্তব্যগুলোর প্যারেন্ট)', () => {
    expect(html).toContain('href="/profile/rewards"');
  });
});

describe('রিওয়ার্ড ফিচার — Reward Center পেজের ভিতরে নেস্ট করা', () => {
  let html;

  beforeAll(async () => {
    const { agent } = await makeUserAgent();
    const res = await agent.get('/profile/rewards');
    expect(res.status).toBe(200);
    html = res.text;
  });

  test.each(MOVED_DESTINATIONS)('%s Reward Center পেজে লিংক হিসেবে আছে', (dest) => {
    expect(html).toContain(`href="${dest}"`);
  });
});

describe('রিওয়ার্ড ফিচার — ব্যাকএন্ড রুট অপরিবর্তিত', () => {
  test.each(MOVED_DESTINATIONS)('%s এখনো লগইন অবস্থায় খোলে (রুট/লজিক অপরিবর্তিত)', async (dest) => {
    const { agent } = await makeUserAgent();
    const res = await agent.get(dest);
    expect(res.status).toBe(200);
  });

  test.each(MOVED_DESTINATIONS)('%s লগআউট অবস্থায় সুরক্ষিত', async (dest) => {
    const { freshRequest } = require('../helpers/app');
    const res = await freshRequest().get(dest);
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/login/);
  });
});
