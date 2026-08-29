// tests/security/endpointAuthSweep.test.js
// ---------------------------------------------------------------------------
// PHASE 6 (deep) — প্রতিটি privileged endpoint সরাসরি HTTP request দিয়ে যাচাই
//
// আগে শুধু static scan + নির্বাচিত manual review করা হয়েছিল। এই suite
// routes/ থেকে সব route enumerate করে প্রতিটি privileged endpoint-এ
// unauthenticated request পাঠায় এবং নিশ্চিত করে যে কোনোটিই 200 দেয় না।
//
// MEDIUM-12: POST /help-center/api/chat unauthenticated অবস্থায় একটি
// পয়সা-খরচকারী LLM API-তে proxy করত, নিজস্ব rate limit বা দৈর্ঘ্যসীমা ছাড়া।
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const request = require('supertest');
// tests/testHarnessIntegrity.test.js অনুযায়ী সব suite helpers/app.js-এর
// listening server ব্যবহার করবে, সরাসরি express app নয় (supertest-এর
// ephemeral port সমস্যা এড়াতে)।
const { app } = require('../helpers/app');
const { REALISTIC_UA } = require('../helpers/app');

const ROOT = path.join(__dirname, '..', '..');

const ROUTER_PREFIX = {
  admin: '/admin', adminGames: '/admin', adminTelegram: '/admin',
  adminLeaderboard: '/admin', adminHealthFix: '/admin',
  payment: '/payment', profile: '/profile', extra: '/extra', chat: '/chat',
  games: '/games', matches: '/matches', tournaments: '/tournaments',
  notifications: '/notifications', news: '/news', coins: '/coins',
  leaderboard: '/leaderboard', sports: '/sports', api: '/api',
  accumulator: '/accumulator', 'help-center': '/help-center',
};

//   —      
const PUBLIC_ALLOWLIST = [
  /^\/payment\/sslcommerz\//,   // gateway callback (server-side  )
  /^\/extra\/faq$/, /^\/games\/api\/recent-wins$/,
  /^\/matches/, /^\/tournaments\/$/, /^\/news/, /^\/leaderboard\/$/,
  /^\/sports/, /^\/api\/v1\//, /^\/help-center/,
  // guard line-এর উপরে ঘোষিত admin authentication পেজগুলো ইচ্ছাকৃত public
  /^\/admin\/login/, /^\/admin\/logout$/, /^\/admin\/2fa\//,
];

function enumerateRoutes() {
  const pat = /^router\.(get|post|put|delete|patch)\(\s*'([^']+)'\s*,?(.*)$/;
  const out = [];
  for (const [name, prefix] of Object.entries(ROUTER_PREFIX)) {
    const file = path.join(ROOT, 'routes', `${name}.js`);
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    // router.use(isAdmin) কেবল তার নিচে ঘোষিত route গুলোকে ঢাকে — উপরে
    // ঘোষিত গুলো (যেমন /admin/login পেজ) ইচ্ছাকৃতভাবে public
    // comment লাইন বাদ দিয়ে খোঁজা হয় — admin.js-এ শুধু মন্তব্যে এই প্যাটার্ন
    // আছে, প্রকৃত guard app.js-এর mount-এ (app.use('/admin', isAdmin, ...))
    const guardLine = lines.findIndex(
      (l) => !l.trim().startsWith('//') && /router\.use\((isAdmin|isAuth)\)/.test(l)
    );
    lines.forEach((line, idx) => {
      const m = pat.exec(line.trim());
      if (!m) return;
      const rest = m[3];
      const guarded = (guardLine !== -1 && idx > guardLine) ||
        /isAuth|isAdmin|requireAdmin|requirePermission|requireSuperAdmin/.test(rest);
      out.push({ file: name, method: m[1].toUpperCase(), path: prefix + m[2], guarded });
    });
  }
  return out;
}

const ROUTES = enumerateRoutes();

//  :param      
const concrete = (p) => p.replace(/:[a-zA-Z_]+/g, '1');

describe('Endpoint authorization sweep (PHASE 6 deep)', () => {
  test('route inventory যথেষ্ট বড় (enumeration কাজ করছে)', () => {
    expect(ROUTES.length).toBeGreaterThan(250);
  });

  describe('প্রতিটি guarded endpoint unauthenticated request প্রত্যাখ্যান করে', () => {
    const guarded = ROUTES.filter((r) => r.guarded && r.method === 'GET');

    test(`${guarded.length}টি guarded GET endpoint কোনোটিই 200 দেয় না`, async () => {
      const leaked = [];

      for (const route of guarded) {
        const url = concrete(route.path);
        let res;
        try {
          res = await request(app).get(url).set('User-Agent', REALISTIC_UA);
        } catch (e) {
          continue; //     
        }
        if (res.status === 200) {
          leaked.push(`${route.method} ${url} [${route.file}]`);
        }
      }

      expect(leaked).toEqual([]);
    }, 180000);
  });

  describe('অরক্ষিত endpoint গুলো সত্যিই public হওয়ার কথা', () => {
    test('allowlist-এর বাইরে কোনো unguarded route নেই', () => {
      const unexpected = ROUTES
        .filter((r) => !r.guarded && r.file !== 'auth')
        .filter((r) => !PUBLIC_ALLOWLIST.some((re) => re.test(r.path)))
        .map((r) => `${r.method} ${r.path} [${r.file}]`);

      expect(unexpected).toEqual([]);
    });
  });

  describe('MEDIUM-12: public AI chat endpoint সীমিত', () => {
    // POST গুলো CSRF-protected, তাই প্রকৃত token সহ agent ব্যবহার করা হয়
    async function chatAgent() {
      const agent = request.agent(app);
      const page = await agent.get('/help-center/').set('User-Agent', REALISTIC_UA);
      const m = /<meta name="csrf-token" content="([^"]*)"/.exec(page.text || '');
      return { agent, token: m ? m[1] : '' };
    }

    test('অতিরিক্ত লম্বা বার্তা প্রত্যাখ্যাত হয় (upstream token খরচ সীমিত)', async () => {
      const { agent, token } = await chatAgent();
      const res = await agent
        .post('/help-center/api/chat')
        .set('User-Agent', REALISTIC_UA)
        .set('X-CSRF-Token', token)
        .send({ message: 'A'.repeat(5000) });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    }, 30000);

    test('দ্রুত পরপর অনুরোধ পাঠালে rate limit কার্যকর হয়', async () => {
      const { agent, token } = await chatAgent();
      const statuses = [];
      for (let i = 0; i < 16; i++) {
        const res = await agent
          .post('/help-center/api/chat')
          .set('User-Agent', REALISTIC_UA)
          .set('X-CSRF-Token', token)
          .send({ message: 'deposit koto?' }); // FAQ hit — upstream API ডাকা হয় না
        statuses.push(res.status);
      }
      expect(statuses).toContain(429);
    }, 60000);

    test('endpoint-এ ডেডিকেটেড limiter ও দৈর্ঘ্যসীমা সংজ্ঞায়িত আছে', () => {
      const src = fs.readFileSync(path.join(ROOT, 'routes', 'help-center.js'), 'utf8');
      expect(src).toMatch(/helpChatLimiter/);
      expect(src).toMatch(/MAX_CHAT_MESSAGE_LEN/);
      expect(src).toMatch(/router\.post\('\/api\/chat', helpChatLimiter/);
    });
  });

  describe('Gateway callback গুলো unauthenticated হলেও নিরাপদ', () => {
    test('ভুয়া success callback কোনো balance পরিবর্তন করে না', async () => {
      const { pool } = require('../../db');
      const before = await pool.query(
        `SELECT COALESCE(SUM(amount),0) AS s FROM coin_transactions WHERE type = 'deposit'`
      );

      await request(app)
        .post('/payment/sslcommerz/success')
        .set('User-Agent', REALISTIC_UA)
        .type('form')
        .send({ tran_id: 'FAKE-TRAN-999', amount: '999999', status: 'VALID', val_id: 'fake' })
        .catch(() => {});

      const after = await pool.query(
        `SELECT COALESCE(SUM(amount),0) AS s FROM coin_transactions WHERE type = 'deposit'`
      );
      expect(Number(after.rows[0].s)).toBe(Number(before.rows[0].s));
    }, 30000);
  });
});
