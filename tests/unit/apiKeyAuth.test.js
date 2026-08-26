// tests/unit/apiKeyAuth.test.js
// db.js মক করে দেওয়া হয়েছে, তাই এই টেস্ট কোনো আসল PostgreSQL সংযোগ ছাড়াই চলে।

jest.mock('../../db', () => ({
  pool: { query: jest.fn() }
}));

const { pool } = require('../../db');
const { requireApiKey, hashKey } = require('../../middleware/apiKeyAuth');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('middleware/apiKeyAuth: requireApiKey', () => {
  beforeEach(() => {
    pool.query.mockReset();
  });

  test('rejects requests with no API key header', async () => {
    const req = { headers: {} };
    const res = mockRes();
    const next = jest.fn();

    await requireApiKey('read:matches')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('rejects an unknown/invalid API key', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const req = { headers: { 'x-api-key': 'invalid-key' } };
    const res = mockRes();
    const next = jest.fn();

    await requireApiKey('read:matches')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('rejects a disabled/revoked API key', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1, enabled: false, scopes: ['read:matches'] }] });
    const req = { headers: { 'x-api-key': 'revoked-key' } };
    const res = mockRes();
    const next = jest.fn();

    await requireApiKey('read:matches')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('rejects an expired API key', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 1, enabled: true, scopes: ['read:matches'], expires_at: '2000-01-01' }]
    });
    const req = { headers: { 'x-api-key': 'expired-key' } };
    const res = mockRes();
    const next = jest.fn();

    await requireApiKey('read:matches')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('rejects a key that lacks the required scope', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1, enabled: true, scopes: ['read:leaderboard'] }] });
    const req = { headers: { 'x-api-key': 'limited-key' } };
    const res = mockRes();
    const next = jest.fn();

    await requireApiKey('read:matches')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('allows a valid, enabled, non-expired key with the right scope', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 1, enabled: true, scopes: ['read:matches'] }] })
      .mockResolvedValueOnce({ rows: [] }); // last_used update query
    const req = { headers: { 'x-api-key': 'valid-key' } };
    const res = mockRes();
    const next = jest.fn();

    await requireApiKey('read:matches')(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.apiKey).toBeTruthy();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('accepts key via Authorization: Bearer header too', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 2, enabled: true, scopes: ['read:matches'] }] })
      .mockResolvedValueOnce({ rows: [] });
    const req = { headers: { authorization: 'Bearer valid-key' } };
    const res = mockRes();
    const next = jest.fn();

    await requireApiKey('read:matches')(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  test('hashKey never returns the raw key (defense in depth check)', () => {
    const raw = 'super-secret-key';
    expect(hashKey(raw)).not.toBe(raw);
    expect(hashKey(raw)).toHaveLength(64); // sha256 hex
  });
});
