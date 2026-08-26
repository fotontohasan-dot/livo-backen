const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const source = fs.readFileSync(path.join(ROOT, 'routes/games.js'), 'utf8');
const code = source
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n');

// /cashout হ্যান্ডলারের অংশটুকু আলাদা করে নেওয়া, যাতে /play-এর কোড
// ভুলবশত এই assertion গুলো পাস করিয়ে না দেয়।
const cashoutHandler = code.slice(code.indexOf("router.post('/cashout'"));

describe('aviator cashout trusts the round row, not the session (P2-10)', () => {
  test('isDemo is derived from the claimed round', () => {
    expect(cashoutHandler).toMatch(/const isDemo = !!round\.is_demo/);
  });

  test('the session copy of isDemo is no longer used to pick a balance column', () => {
    expect(cashoutHandler).not.toMatch(/state\.isDemo/);
    expect(cashoutHandler).not.toMatch(/const isDemo = !!state\.isDemo/);
  });

  test('the claim query still returns is_demo so the row stays authoritative', () => {
    expect(cashoutHandler).toMatch(/RETURNING bet_amount, crash_point, is_demo/);
  });

  test('isDemo is resolved before balanceCol is chosen', () => {
    const isDemoAt = cashoutHandler.indexOf('const isDemo = !!round.is_demo');
    const balanceColAt = cashoutHandler.indexOf("balanceCol = isDemo ? 'demo_balance' : 'coins'");
    expect(isDemoAt).toBeGreaterThan(-1);
    expect(balanceColAt).toBeGreaterThan(isDemoAt);
  });
});

describe('demo rounds do not touch real streak state (P2-11)', () => {
  test('the crash branch guards recordGameResult behind !isDemo', () => {
    const crashBranch = cashoutHandler.slice(
      cashoutHandler.indexOf('if (cashMultiplier > crashPoint)'),
      cashoutHandler.indexOf('const winAmount = Math.floor(betAmount * cashMultiplier)')
    );
    expect(crashBranch).toMatch(/if \(!isDemo\)/);
    expect(crashBranch).toMatch(/recordGameResult\(userId, false\)/);
  });

  test('the /play settle path reaches streak only after the demo branch has returned', () => {
    const playHandler = code.slice(code.indexOf("router.post('/play'"), code.indexOf("router.post('/cashout'"));
    const streakAt = playHandler.indexOf('recordGameResult(userId, winAmount > 0');
    const demoReturnAt = playHandler.lastIndexOf('demo: true', streakAt);
    expect(streakAt).toBeGreaterThan(-1);
    // ডেমো শাখা নিজের রেসপন্স দিয়ে return করে যায়, তাই স্ট্রিক কল তার পরে।
    expect(demoReturnAt).toBeGreaterThan(-1);
    expect(streakAt).toBeGreaterThan(demoReturnAt);
  });

  test('there are exactly three streak call sites', () => {
    expect([...code.matchAll(/recordGameResult\(/g)].length).toBe(3);
  });
});
