// Turnover V2 — DB ছাড়া লজিক টেস্ট (fake client)।
jest.mock('../../db', () => ({ pool: { connect: jest.fn(), query: jest.fn() } }));
const settings = {};
jest.mock('../../services/settings', () => ({ getSetting: async (k) => settings[k] }));

const { pool } = require('../../db');
const T = require('../../services/turnover');

function fakeClient(rows = []) {
  const state = { rows, events: new Set(), inserted: [], updates: [] };
  const client = {
    state,
    release: jest.fn(),
    query: jest.fn(async (sql, params) => {
      if (/INSERT INTO deposit_turnovers/.test(sql)) { state.inserted.push(params); return { rows: [{ id: 1 }], rowCount: 1 }; }
      if (/INSERT INTO turnover_events/.test(sql)) {
        const key = `${params[0]}|${params[1]}`;
        if (state.events.has(key)) return { rows: [], rowCount: 0 };
        state.events.add(key); return { rows: [{ id: 1 }], rowCount: 1 };
      }
      if (/FROM deposit_turnovers[\s\S]*expires_at/.test(sql)) return { rows: [], rowCount: 0 };
      if (/SELECT id, required/.test(sql)) return { rows: state.rows, rowCount: state.rows.length };
      if (/UPDATE deposit_turnovers/.test(sql)) { state.updates.push(params); return { rows: [], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    })
  };
  return client;
}

beforeEach(() => {
  Object.keys(settings).forEach((k) => delete settings[k]);
  Object.assign(settings, { turnover_multiplier: '5', turnover_no_bonus_multiplier: '2', turnover_min_odds: '1.5', turnover_expiry_hours: '0', turnover_cashout_counts: '0' });
});

describe('required turnover formula (ডিপোজিট ২x + বোনাস ৫x)', () => {
  test('ডিপোজিট ১০০০ + বোনাস ১০০০: ২০০০ + ৫০০০ = ৭০০০', async () => {
    const c = fakeClient();
    await T.createDepositTurnover(c, { userId: 1, depositId: 10, depositAmount: 1000, bonusAmount: 1000 });
    expect(Number(c.state.inserted[0][6])).toBe(7000);
  });
  test('ডিপোজিট ১০০০ + বোনাস ৫০০: ২০০০ + ২৫০০ = ৪৫০০', async () => {
    const c = fakeClient();
    await T.createDepositTurnover(c, { userId: 1, depositId: 13, depositAmount: 1000, bonusAmount: 500 });
    expect(Number(c.state.inserted[0][6])).toBe(4500);
  });
  test('বোনাস ছাড়া: ডিপোজিট × ২', async () => {
    const c = fakeClient();
    await T.createDepositTurnover(c, { userId: 1, depositId: 11, depositAmount: 1000, bonusAmount: 0 });
    expect(Number(c.state.inserted[0][6])).toBe(2000);
    expect(Number(c.state.inserted[0][5])).toBe(2);
  });
  test('বোনাস-অনলি (ফ্রি বেট/গোল্ডেন এগ/হুইল): বোনাস × ৫', async () => {
    const c = fakeClient();
    await T.createBonus(c, 1, 'daily', 100);
    expect(Number(c.state.inserted[0][6])).toBe(500);
    expect(Number(c.state.inserted[0][5])).toBe(5);
  });
  test('গুণক অ্যাডমিন সেটিং থেকে আসে (বোনাস অংশ)', async () => {
    settings.turnover_multiplier = '10';
    const c = fakeClient();
    await T.createDepositTurnover(c, { userId: 1, depositId: 12, depositAmount: 500, bonusAmount: 100 });
    expect(Number(c.state.inserted[0][6])).toBe(2000); // ৫০০×২ + ১০০×১০
  });
});

describe('eligibility', () => {
  const rows = [{ id: 1, required: 1000, sports_done: 0, casino_done: 0 }];
  test('void / cancelled / refund never count', async () => {
    for (const kind of ['void', 'cancelled', 'refund']) {
      const r = await T.addTurnover(fakeClient(rows), 1, 'sports', 100, { odds: 2, kind, ref: 'x' + kind });
      expect(r.counted).toBe(0);
    }
  });
  test('cash-out is excluded by default and included only when admin enables it', async () => {
    expect((await T.addTurnover(fakeClient(rows), 1, 'sports', 100, { odds: 2, kind: 'cashout', ref: 'c1' })).counted).toBe(0);
    settings.turnover_cashout_counts = '1';
    expect((await T.addTurnover(fakeClient(rows), 1, 'sports', 100, { odds: 2, kind: 'cashout', ref: 'c2' })).counted).toBe(100);
  });
  test('sports bet below min odds (or unknown odds) does not count; casino ignores odds', async () => {
    expect((await T.addTurnover(fakeClient(rows), 1, 'sports', 100, { odds: 1.2, ref: 'o1' })).counted).toBe(0);
    expect((await T.addTurnover(fakeClient(rows), 1, 'sports', 100, { ref: 'o2' })).counted).toBe(0);
    expect((await T.addTurnover(fakeClient(rows), 1, 'sports', 100, { odds: 1.5, ref: 'o3' })).counted).toBe(100);
    expect((await T.addTurnover(fakeClient(rows), 1, 'casino', 100, { ref: 'o4' })).counted).toBe(100);
  });
  test('the same bet ref is counted only once', async () => {
    const c = fakeClient(rows);
    expect((await T.addTurnover(c, 1, 'sports', 100, { odds: 2, ref: 'bet:9' })).counted).toBe(100);
    expect((await T.addTurnover(c, 1, 'sports', 100, { odds: 2, ref: 'bet:9' })).reason).toBe('duplicate');
  });
});

describe('multiple deposits are tracked separately (FIFO with spill-over)', () => {
  test('stake fills the oldest deposit first and spills to the next', async () => {
    const c = fakeClient([
      { id: 1, required: 300, sports_done: 200, casino_done: 0 },   // 100 left
      { id: 2, required: 1000, sports_done: 0, casino_done: 0 }
    ]);
    const r = await T.addTurnover(c, 1, 'casino', 250, { ref: 'c:1' });
    expect(r.counted).toBe(250);
    expect(c.state.updates.map((u) => [Number(u[0]), u[1]])).toEqual([[100, 1], [150, 2]]);
  });
});
