// K10 — 401/403 = "অথ ত্রুটি": সাসপেন্ডে গোনা হয় না (বিদ্যমান আচরণ, tests/unit/autoSuspendProbe.test.js-এ আলাদা পাহারা),
// কিন্তু Integrations Status-এ আলাদা অবস্থা হিসেবে দেখানো হয় যাতে API key মেয়াদ শেষ/ভুল হলে অ্যাডমিন জানে।
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const mockQuery = jest.fn(async () => ({ rows: [], rowCount: 0 }));
jest.mock('../../db', () => ({ pool: { query: (...a) => mockQuery(...a), totalCount: 0, idleCount: 0 } }));
jest.mock('../../services/autoSuspend', () => ({
  recordOutcome: jest.fn(), isSuspendable: () => true, listStates: async () => []
}));

const autoSuspendMock = require('../../services/autoSuspend');
const status = require('../../services/integrationStatus');
const { integrationFetch } = require('../../utils/integrationHttp');

const resp = (code) => ({ status: code, ok: code >= 200 && code < 300, headers: { get: () => null }, body: null });
let n = 0;
const uniq = () => `sports:auth${Date.now()}_${n++}`;

beforeEach(() => { mockQuery.mockClear(); status._lastAuthWrite.clear(); status._lastWrite.clear(); autoSuspendMock.recordOutcome.mockClear(); });

describe('authErrorState (বিশুদ্ধ ফাংশন)', () => {
  const T = (s) => new Date(`2026-11-14T10:00:${s}Z`);
  test('অথ ত্রুটি আছে, সফল কল কখনো আসেনি → সক্রিয়', () => {
    expect(status.authErrorState({ last_auth_error_at: T('10'), last_auth_error_status: 401, auth_error_count: '3' }))
      .toEqual({ active: true, status: 401, lastAt: T('10'), count: 3 });
  });
  test('অথ ত্রুটির পরে সফল কল এলে মিটে যায়', () => {
    expect(status.authErrorState({ last_auth_error_at: T('10'), last_auth_error_status: 403, last_success_at: T('20') }).active).toBe(false);
  });
  test('সফল কলের পরে আবার অথ ত্রুটি এলে আবার সক্রিয়', () => {
    expect(status.authErrorState({ last_auth_error_at: T('30'), last_auth_error_status: 401, last_success_at: T('20') }).active).toBe(true);
  });
  test('কখনো অথ ত্রুটি না থাকলে নিষ্ক্রিয়; সারিই না থাকলেও', () => {
    expect(status.authErrorState({ last_success_at: T('20') }).active).toBe(false);
    expect(status.authErrorState(undefined)).toEqual({ active: false, status: null, lastAt: null, count: 0 });
  });
  test('অচেনা স্ট্যাটাস কোড দেখালে null (শুধু 401/403 প্রদর্শিত)', () => {
    expect(status.authErrorState({ last_auth_error_at: T('10'), last_auth_error_status: 500 }).status).toBeNull();
  });
});

describe('recordAuthError', () => {
  test('শুধু 401/403 লেখে; 400/404/429/500/200 নয়', async () => {
    for (const c of [200, 400, 404, 429, 500]) expect(await status.recordAuthError(uniq(), c)).toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(await status.recordAuthError(uniq(), 401)).toBe(true);
    expect(await status.recordAuthError(uniq(), 403)).toBe(true);
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  test('শুধু নাম ও স্ট্যাটাস কোড লেখা হয় — বার্তা/বডি/হেডার/কী নয়', async () => {
    const name = uniq();
    await status.recordAuthError(name, 401);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toMatch(/INSERT INTO integration_status/);
    expect(String(sql)).toMatch(/last_auth_error_at/);
    expect(params).toEqual([name, 401]);
  });

  test('একই নামে ৫ সেকেন্ডের মধ্যে আবার লেখে না (throttle)', async () => {
    const name = uniq();
    expect(await status.recordAuthError(name, 401)).toBe(true);
    expect(await status.recordAuthError(name, 401)).toBe(false);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test('DB ব্যর্থ হলেও reject/throw করে না', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection refused'));
    await expect(status.recordAuthError(uniq(), 401)).resolves.toBe(false);
  });
});

describe('integrationFetch: 401/403 → অথ ত্রুটি রেকর্ড; সাসপেন্ডে গোনা নয়', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  test.each([401, 403])('HTTP %i: অথ ত্রুটি রেকর্ড হয়, কিন্তু recordOutcome (সাসপেন্ড-গণনা) ডাকা হয় না', async (code) => {
    global.fetch = jest.fn(async () => resp(code));
    const name = uniq();
    const res = await integrationFetch(name, 'http://x.invalid/a');
    expect(res.status).toBe(code);                       // কলার আগের মতোই রেসপন্স পায়
    // integrationHttp destructure করে আনে, তাই spy নয় — আসল লেখা DB-কোয়েরিতে দেখি
    const authWrites = mockQuery.mock.calls.filter(([sql]) => /last_auth_error_at/.test(String(sql)));
    expect(authWrites).toHaveLength(1);
    expect(authWrites[0][1]).toEqual([name, code]);
    expect(autoSuspendMock.recordOutcome).not.toHaveBeenCalled();
  });

  test.each([200, 400, 404, 422, 429, 500, 503])('HTTP %i: অথ ত্রুটি রেকর্ড হয় না', async (code) => {
    global.fetch = jest.fn(async () => resp(code));
    await integrationFetch(uniq(), 'http://x.invalid/a');
    expect(mockQuery.mock.calls.filter(([sql]) => /last_auth_error_at/.test(String(sql)))).toHaveLength(0);
  });

  test('breaker-মুক্ত (payment) পথেও 401 রেকর্ড হয়', async () => {
    global.fetch = jest.fn(async () => resp(401));
    const name = 'payment:test' + n++;
    await integrationFetch(name, 'http://x.invalid/a', {}, { breaker: false });
    const authWrites = mockQuery.mock.calls.filter(([sql]) => /last_auth_error_at/.test(String(sql)));
    expect(authWrites).toHaveLength(1);
    expect(authWrites[0][1]).toEqual([name, 401]);
  });
});

describe('Integrations Status ভিউ', () => {
  const view = path.join(__dirname, '../../views/admin/integrations.ejs');
  const base = { id: 'sports:cricapi', label: 'CricAPI', group: 'sports', configured: { web: true, worker: true },
    lastSuccessAt: null, lastErrorAt: null, lastError: null, breaker: { web: null, worker: null },
    suspend: { suspendable: true, suspended: false, suspendCount: 0 } };
  const render = (integration) => ejs.renderFile(view, {
    report: { integrations: [integration], processes: [] }, canManage: false, user: { id: 1, username: 'a' },
    t: (k) => k, layout: false, cspNonce: 'n', jsonScriptSafe: (v) => JSON.stringify(v === undefined ? null : v), csrfToken: 'c',
    currentUser: { id: 1, username: 'a', role: 'admin' }, lang: 'en', locale: 'en', assetVersion: 'x', permissions: [],
    req: { path: '/admin/integrations' }, flash: {}, success: [], error: [], messages: {}
  });

  test('অথ ত্রুটি সক্রিয় হলে আলাদা ব্যাজ + HTTP কোড + সংখ্যা দেখায়', async () => {
    const html = await render({ ...base, authError: { active: true, status: 401, lastAt: new Date('2026-11-14T10:00:00Z'), count: 7 } });
    expect(html).toMatch(/data-auth-error="1"/);
    expect(html).toMatch(/aci_auth_error/);
    expect(html).toMatch(/HTTP 401/);
    expect(html).toMatch(/7 aci_auth_error_count/);
  });

  test('সক্রিয় না হলে বা ক্ষেত্র না থাকলে ব্যাজ নেই', async () => {
    expect(await render({ ...base, authError: { active: false, status: 401, lastAt: new Date(), count: 2 } })).not.toMatch(/data-auth-error/);
    expect(await render(base)).not.toMatch(/data-auth-error/);
  });
});

describe('locale (bn + en)', () => {
  test.each(['aci_auth_error', 'aci_auth_error_hint', 'aci_auth_error_last', 'aci_auth_error_count'])('%s দুই ভাষাতেই আছে', (key) => {
    for (const l of ['bn', 'en']) {
      const j = JSON.parse(fs.readFileSync(path.join(__dirname, '../../locales', `${l}.json`), 'utf8'));
      expect(j[key]).toBeTruthy();
    }
  });
});
