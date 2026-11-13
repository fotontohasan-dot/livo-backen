// middleware/auth.js — must_reset_password থাকলে শুধু পাসওয়ার্ড-বদল ও লগআউট চলে।
jest.mock('../../db', () => ({ pool: { query: jest.fn() } }));
jest.mock('../../services/cache', () => ({
  getOrSet: jest.fn(async (_k, _ttl, fn) => fn()),
  del: jest.fn(async () => {}),
}));

const { pool } = require('../../db');
const { isAuth } = require('../../middleware/auth');

function call(url, { mustReset, api = false } = {}) {
  pool.query.mockResolvedValue({ rows: [{ is_banned: false, self_exclude_until: null, must_reset_password: !!mustReset }] });
  const req = {
    session: { user: { id: 5 } }, originalUrl: url, url, path: url.split('?')[0],
    flash: jest.fn(), t: (k) => k,
  };
  const res = { redirect: jest.fn(), status: jest.fn(function () { return this; }), json: jest.fn(), render: jest.fn() };
  const next = jest.fn();
  return isAuth(req, res, next).then(() => ({ req, res, next }));
}

describe('isAuth + must_reset_password', () => {
  test('ফ্ল্যাগ নেই → পাস', async () => {
    const { next } = await call('/profile/cards', { mustReset: false });
    expect(next).toHaveBeenCalled();
  });
  test('ফ্ল্যাগ আছে + অন্য পাতা → পাসওয়ার্ড-বদল পাতায় রিডাইরেক্ট', async () => {
    const { res, next } = await call('/profile/cards', { mustReset: true });
    expect(next).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith('/profile/security/login-password');
  });
  test('ফ্ল্যাগ আছে + API পথ → 403 JSON', async () => {
    const { res, next } = await call('/api/wallet', { mustReset: true });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
  test.each([
    '/profile/security/login-password',
    '/profile/security/login-password?x=1',
    '/profile/change-password',
    '/logout',
  ])('ফ্ল্যাগ আছে + অনুমোদিত পথ %s → পাস', async (url) => {
    const { next } = await call(url, { mustReset: true });
    expect(next).toHaveBeenCalled();
  });
  test('অনুমোদিত পথের মতো দেখতে প্রতারক পথ আটকায়', async () => {
    const { next, res } = await call('/profile/security/login-password/../../cards', { mustReset: true });
    expect(next).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalled();
  });
});
