const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const stripComments = (src) =>
  src
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

describe('withdraw turnover gate fails closed (P2-07)', () => {
  const source = () => fs.readFileSync(path.join(ROOT, 'routes/payment.js'), 'utf8');

  test('a failed canWithdraw check aborts the withdrawal', () => {
    const code = stripComments(source());
    // catch ব্লক শুধু লগ করে নিচে চলে গেলে গেটটাই অকেজো — redirect/return থাকতেই হবে।
    const catchBlock = code.match(/catch \(e\) \{[^}]*turnover check error[^}]*\}/);
    expect(catchBlock).not.toBeNull();
    expect(catchBlock[0]).toMatch(/return res\.redirect/);
    expect(catchBlock[0]).toMatch(/payment_turnover_check_failed/);
  });

  test('the failure message exists in both locales', () => {
    const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales/en.json'), 'utf8'));
    const bn = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales/bn.json'), 'utf8'));
    expect(typeof en.payment_turnover_check_failed).toBe('string');
    expect(typeof bn.payment_turnover_check_failed).toBe('string');
    expect(typeof en.payment_limit_check_failed).toBe('string');
    expect(typeof bn.payment_limit_check_failed).toBe('string');
    expect(en.payment_turnover_check_failed.length).toBeGreaterThan(0);
    expect(bn.payment_turnover_check_failed.length).toBeGreaterThan(0);
  });

  test('the daily deposit limit check also fails closed', () => {
    const code = stripComments(source());
    const catchBlock = code.match(/catch \(e\) \{[^}]*deposit limit check error[^}]*\}/);
    expect(catchBlock).not.toBeNull();
    expect(catchBlock[0]).toMatch(/return res\.redirect/);
    expect(catchBlock[0]).toMatch(/payment_limit_check_failed/);
  });

  test('the balance deduction still happens conditionally in one statement', () => {
    const code = stripComments(source());
    expect(code).toMatch(/UPDATE users SET coins = coins - \$1 WHERE id = \$2 AND coins >= \$1/);
  });
});

describe('turnover progress is incremented atomically (P2-08)', () => {
  const source = () => fs.readFileSync(path.join(ROOT, 'services/turnover.js'), 'utf8');

  test('done columns are updated in-place, not from a read value', () => {
    const code = stripComments(source());
    expect(code).toMatch(/sports_done = sports_done \+ \$1/);
    expect(code).toMatch(/casino_done = casino_done \+ \$1/);
    expect(code).not.toMatch(/SET sports_done = \$1/);
    expect(code).not.toMatch(/SET casino_done = \$1/);
    expect(code).not.toMatch(/const newDone/);
  });

  test('increments only apply to still-active bonuses', () => {
    const code = stripComments(source());
    const updates = code.match(/UPDATE bonuses SET (?:sports|casino)_done[^`]*/g) || [];
    expect(updates.length).toBe(2);
    updates.forEach((sql) => expect(sql).toMatch(/status = 'active'/));
  });
});

describe('turnover accumulation semantics (P2-08)', () => {
  // অ্যাটমিক ইনক্রিমেন্টের আসল আচরণ: N-টা সমান্তরাল যোগে কোনোটাই হারায় না।
  // DB ছাড়াই একই লজিক দুই ভাবে চালিয়ে পার্থক্যটা দেখানো হচ্ছে।
  const runReadModifyWrite = async (stakes) => {
    let stored = 0;
    await Promise.all(
      stakes.map(async (stake) => {
        const read = stored; // SELECT
        await new Promise((r) => setImmediate(r)); // অন্য রিকোয়েস্ট ঢোকার সুযোগ
        stored = read + stake; // UPDATE ... SET done = $1
      })
    );
    return stored;
  };

  const runAtomicIncrement = async (stakes) => {
    let stored = 0;
    await Promise.all(
      stakes.map(async (stake) => {
        await new Promise((r) => setImmediate(r));
        stored += stake; // UPDATE ... SET done = done + $1
      })
    );
    return stored;
  };

  const stakes = [100, 250, 75, 500, 25];
  const expected = stakes.reduce((a, b) => a + b, 0);

  test('the old read-modify-write pattern loses concurrent stakes', async () => {
    await expect(runReadModifyWrite(stakes)).resolves.toBeLessThan(expected);
  });

  test('the atomic pattern keeps every stake', async () => {
    await expect(runAtomicIncrement(stakes)).resolves.toBe(expected);
  });
});
