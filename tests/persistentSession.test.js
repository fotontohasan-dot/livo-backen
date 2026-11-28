// স্থায়ী সেশন / রিফ্রেশ টোকেন — ইউনিট টেস্ট (DB মক করা, তাই Postgres ছাড়াই চলে)।
// শেষে HTTP-লেভেলের ইন্টিগ্রেশন সেট (DB থাকলে) আলাদা describe-এ।

jest.mock('../db', () => {
  const client = { query: jest.fn(), release: jest.fn() };
  return { pool: { query: jest.fn(), connect: jest.fn(async () => client), __client: client } };
});

const { pool } = require('../db');
const refreshTokens = require('../services/refreshTokens');
const { hashToken } = require('../utils/tokens');
const persistent = require('../middleware/persistentSession');

const client = pool.__client;
const RAW = 'a'.repeat(64);

beforeEach(() => {
  pool.query.mockReset();
  pool.connect.mockClear();
  client.query.mockReset();
  client.release.mockReset();
  delete process.env.PERSISTENT_SESSION_ENABLED;
});

describe('refreshTokens.issueToken', () => {
  test('শুধু হ্যাশ সংরক্ষণ করে, আসল টোকেন নয়', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 7 }] });
    const out = await refreshTokens.issueToken(42, { sid: 's1', ip: '1.2.3.4', userAgent: 'UA' });
    expect(out.token).toMatch(/^[a-f0-9]{64}$/);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO refresh_tokens/);
    expect(params).toContain(hashToken(out.token));
    expect(params).not.toContain(out.token);
  });

  test('মেয়াদ family-র absolute সীমার বেশি হয় না', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 1 }] });
    const started = new Date(Date.now() - 179 * 24 * 3600 * 1000);
    const out = await refreshTokens.issueToken(1, { familyId: 'fam', familyStartedAt: started });
    const cap = started.getTime() + 180 * 24 * 3600 * 1000;
    expect(out.expiresAt.getTime()).toBeLessThanOrEqual(cap);
  });
});

describe('refreshTokens.rotateToken', () => {
  function row(over = {}) {
    return { id: 1, user_id: 5, family_id: 'fam-1', family_started_at: new Date(), expires_at: new Date(Date.now() + 1e9), rotated_at: null, revoked_at: null, ...over };
  }

  test('ফরম্যাট ভুল হলে DB ছোঁয়ার আগেই invalid', async () => {
    expect((await refreshTokens.rotateToken('nope')).status).toBe('invalid');
    expect((await refreshTokens.rotateToken(undefined)).status).toBe('invalid');
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test('অজানা টোকেন → invalid', async () => {
    client.query.mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT
      .mockResolvedValueOnce({}); // COMMIT
    expect((await refreshTokens.rotateToken(RAW)).status).toBe('invalid');
  });

  test('বৈধ টোকেন → ok, পুরনোটা রোটেটেড, নতুনটা একই family-তে', async () => {
    client.query.mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [row()] }) // SELECT FOR UPDATE
      .mockResolvedValueOnce({}) // UPDATE rotated_at
      .mockResolvedValueOnce({ rows: [{ id: 2 }] }) // INSERT new
      .mockResolvedValueOnce({}); // COMMIT
    const r = await refreshTokens.rotateToken(RAW, { sid: 'sid' });
    expect(r.status).toBe('ok');
    expect(r.userId).toBe(5);
    expect(r.familyId).toBe('fam-1');
    expect(r.token).toMatch(/^[a-f0-9]{64}$/);
    expect(r.token).not.toBe(RAW);
    expect(client.query.mock.calls[2][0]).toMatch(/rotated_at = NOW\(\)/);
    expect(client.query.mock.calls[3][1]).toContain('fam-1');
  });

  test('সদ্য রোটেট হওয়া টোকেন (প্যারালাল রিকোয়েস্ট) → grace, family বাতিল নয়', async () => {
    client.query.mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [row({ rotated_at: new Date(Date.now() - 2000) })] }).mockResolvedValueOnce({});
    const r = await refreshTokens.rotateToken(RAW);
    expect(r.status).toBe('grace');
    expect(client.query.mock.calls.some(c => /SET revoked_at/.test(c[0]))).toBe(false);
  });

  test('অনেক আগে রোটেট হওয়া টোকেন পুনর্ব্যবহার → reuse, পুরো family বাতিল', async () => {
    client.query.mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [row({ rotated_at: new Date(Date.now() - 3600 * 1000) })] }).mockResolvedValueOnce({}).mockResolvedValueOnce({});
    const r = await refreshTokens.rotateToken(RAW);
    expect(r.status).toBe('reuse');
    const revoke = client.query.mock.calls.find(c => /SET revoked_at/.test(c[0]));
    expect(revoke).toBeTruthy();
    expect(revoke[1]).toEqual(['fam-1']);
  });

  test('মেয়াদোত্তীর্ণ → expired এবং family বাতিল', async () => {
    client.query.mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [row({ expires_at: new Date(Date.now() - 1000) })] }).mockResolvedValueOnce({}).mockResolvedValueOnce({});
    expect((await refreshTokens.rotateToken(RAW)).status).toBe('expired');
  });

  test('বাতিল করা টোকেন → invalid', async () => {
    client.query.mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [row({ revoked_at: new Date() })] }).mockResolvedValueOnce({});
    expect((await refreshTokens.rotateToken(RAW)).status).toBe('invalid');
  });

  test('DB ত্রুটিতে ROLLBACK ও কানেকশন রিলিজ', async () => {
    client.query.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({});
    await expect(refreshTokens.rotateToken(RAW)).rejects.toThrow('boom');
    expect(client.query.mock.calls.some(c => c[0] === 'ROLLBACK')).toBe(true);
    expect(client.release).toHaveBeenCalled();
  });
});

describe('persistentSession middleware', () => {
  function mkReq(over = {}) {
    return {
      method: 'GET', path: '/profile', cookies: {}, headers: {}, ip: '1.1.1.1', sessionID: 'sid-1',
      session: { destroy: jest.fn((cb) => cb()), regenerate: jest.fn((cb) => cb()), save: jest.fn((cb) => cb()) },
      get: () => 'UA', ...over
    };
  }
  function mkRes() { return { cookie: jest.fn(), clearCookie: jest.fn() }; }

  test('রিফ্রেশ কুকি না থাকলে কিছু করে না', async () => {
    const next = jest.fn();
    await persistent.persistentSessionMiddleware(mkReq(), mkRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test('POST রিকোয়েস্টে কুকি থেকে রিস্টোর হয় না', async () => {
    const req = mkReq({ method: 'POST', cookies: { livo_rt: RAW } });
    const next = jest.fn();
    await persistent.persistentSessionMiddleware(req, mkRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(pool.connect).not.toHaveBeenCalled();
    expect(req.session.user).toBeUndefined();
  });

  test('/logout ও মেশিন পাথে রিস্টোর হয় না', () => {
    expect(persistent.isRestorablePath({ method: 'GET', path: '/logout' })).toBe(false);
    expect(persistent.isRestorablePath({ method: 'GET', path: '/provider/wallet/bet' })).toBe(false);
    expect(persistent.isRestorablePath({ method: 'GET', path: '/socket.io/' })).toBe(false);
    expect(persistent.isRestorablePath({ method: 'GET', path: '/profile' })).toBe(true);
    expect(persistent.isRestorablePath({ method: 'GET', path: '/logout-info' })).toBe(true);
  });

  test('সেশন নেই + বৈধ কুকি → সেশন পুনরুদ্ধার ও নতুন কুকি', async () => {
    client.query.mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 1, user_id: 9, family_id: 'f', family_started_at: new Date(), expires_at: new Date(Date.now() + 1e9), rotated_at: null, revoked_at: null }] })
      .mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [{ id: 2 }] }).mockResolvedValueOnce({});
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 9, username: 'u', role: 'user', password: 'HASH', is_banned: false }] }) // users
      .mockResolvedValue({ rows: [] }); // setSid
    const req = mkReq({ cookies: { livo_rt: RAW } });
    const res = mkRes();
    const next = jest.fn();
    await persistent.persistentSessionMiddleware(req, res, next);
    expect(req.session.regenerate).toHaveBeenCalled();
    expect(req.session.user).toMatchObject({ id: 9, username: 'u' });
    expect(req.session.user.password).toBeUndefined(); // পাসওয়ার্ড হ্যাশ সেশনে যায় না
    expect(res.cookie).toHaveBeenCalledWith('livo_rt', expect.stringMatching(/^[a-f0-9]{64}$/), expect.objectContaining({ httpOnly: true, sameSite: 'lax' }));
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('ব্যান করা ইউজার → রিস্টোর হয় না, family বাতিল, কুকি মোছা', async () => {
    client.query.mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [{ id: 1, user_id: 9, family_id: 'f', family_started_at: new Date(), expires_at: new Date(Date.now() + 1e9), rotated_at: null, revoked_at: null }] })
      .mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [{ id: 2 }] }).mockResolvedValueOnce({});
    pool.query.mockResolvedValueOnce({ rows: [{ id: 9, role: 'user', is_banned: true }] }).mockResolvedValue({ rowCount: 1 });
    const req = mkReq({ cookies: { livo_rt: RAW } });
    const res = mkRes();
    await persistent.persistentSessionMiddleware(req, res, jest.fn());
    expect(req.session.user).toBeUndefined();
    expect(res.clearCookie).toHaveBeenCalledWith('livo_rt', expect.any(Object));
    expect(pool.query.mock.calls.some(c => /SET revoked_at/.test(c[0]))).toBe(true);
  });

  test('অ্যাডমিন অ্যাকাউন্ট কুকি দিয়ে রিস্টোর হয় না (2FA এড়ানো যাবে না)', async () => {
    client.query.mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [{ id: 1, user_id: 1, family_id: 'f', family_started_at: new Date(), expires_at: new Date(Date.now() + 1e9), rotated_at: null, revoked_at: null }] })
      .mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [{ id: 2 }] }).mockResolvedValueOnce({});
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1, role: 'admin', is_banned: false }] }).mockResolvedValue({ rowCount: 1 });
    const req = mkReq({ cookies: { livo_rt: RAW } });
    await persistent.persistentSessionMiddleware(req, mkRes(), jest.fn());
    expect(req.session.user).toBeUndefined();
  });

  test('issueForLogin অ্যাডমিনের জন্য টোকেন দেয় না', async () => {
    const res = mkRes();
    const ok = await persistent.issueForLogin(mkReq(), res, { id: 1, role: 'Admin' });
    expect(ok).toBe(false);
    expect(res.cookie).not.toHaveBeenCalled();
  });

  test('issueForLogin সাধারণ ইউজারের জন্য HttpOnly কুকি বসায়', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 3 }] });
    const req = mkReq();
    const res = mkRes();
    expect(await persistent.issueForLogin(req, res, { id: 4, role: 'user' })).toBe(true);
    expect(res.cookie.mock.calls[0][2]).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });
    expect(req.session.rtRotatedAt).toBeGreaterThan(0);
  });

  test('PERSISTENT_SESSION_ENABLED=false হলে সম্পূর্ণ নিষ্ক্রিয়', async () => {
    process.env.PERSISTENT_SESSION_ENABLED = 'false';
    const res = mkRes();
    expect(await persistent.issueForLogin(mkReq(), res, { id: 4, role: 'user' })).toBe(false);
    const next = jest.fn();
    await persistent.persistentSessionMiddleware(mkReq({ cookies: { livo_rt: RAW } }), res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test('সেশন বৈধ ও টোকেন "fresh" হলে রোটেশন হয় না', async () => {
    const req = mkReq({ cookies: { livo_rt: RAW } });
    req.session.user = { id: 4, role: 'user' };
    req.session.rtRotatedAt = Date.now() - 1000;
    await persistent.persistentSessionMiddleware(req, mkRes(), jest.fn());
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test('সেশন বৈধ ও টোকেন due হলে নিঃশব্দে রোটেট হয়ে নতুন কুকি বসে', async () => {
    client.query.mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [{ id: 1, user_id: 4, family_id: 'f', family_started_at: new Date(), expires_at: new Date(Date.now() + 1e9), rotated_at: null, revoked_at: null }] })
      .mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [{ id: 2 }] }).mockResolvedValueOnce({});
    const req = mkReq({ cookies: { livo_rt: RAW } });
    req.session.user = { id: 4, role: 'user' };
    req.session.rtRotatedAt = Date.now() - 25 * 3600 * 1000;
    const res = mkRes();
    await persistent.persistentSessionMiddleware(req, res, jest.fn());
    expect(res.cookie).toHaveBeenCalledWith('livo_rt', expect.any(String), expect.any(Object));
    expect(Date.now() - req.session.rtRotatedAt).toBeLessThan(5000);
  });

  test('কুকির টোকেন অন্য ইউজারের হলে সেশনে জোড়া লাগে না — family বাতিল', async () => {
    client.query.mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [{ id: 1, user_id: 99, family_id: 'other', family_started_at: new Date(), expires_at: new Date(Date.now() + 1e9), rotated_at: null, revoked_at: null }] })
      .mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [{ id: 2 }] }).mockResolvedValueOnce({});
    pool.query.mockResolvedValue({ rowCount: 1 });
    const req = mkReq({ cookies: { livo_rt: RAW } });
    req.session.user = { id: 4, role: 'user' };
    req.session.rtRotatedAt = 0;
    const res = mkRes();
    await persistent.persistentSessionMiddleware(req, res, jest.fn());
    expect(res.cookie).not.toHaveBeenCalled();
    expect(res.clearCookie).toHaveBeenCalled();
  });

  test('revokeForLogout টোকেন বাতিল করে কুকি মোছে', async () => {
    pool.query.mockResolvedValue({ rowCount: 2 });
    const res = mkRes();
    await persistent.revokeForLogout(mkReq({ cookies: { livo_rt: RAW } }), res);
    expect(pool.query.mock.calls[0][0]).toMatch(/SET revoked_at/);
    expect(res.clearCookie).toHaveBeenCalled();
  });
});
