// K10 — গেটিং কোথায় আছে আর কোথায় কখনো নেই (সোর্স-স্তরের নিরাপত্তা-জাল)।
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');
const { MATCH_PROVIDER_INTEGRATION, isSuspendable } = require('../../services/autoSuspend');

describe('টাকা/সেটেলমেন্ট পথে autoSuspend কখনো নেই', () => {
  const money = [
    'services/settlement.js', 'services/tournamentSettlement.js', 'services/walletCallback.js',
    'services/sslcommerz.js', 'services/gatewayReconcile.js', 'services/paymentVerification.js',
    'services/wallet/index.js', 'services/wallet/idempotency.js', 'services/wallet/signature.js',
    'routes/providerWallet.js', 'routes/payment.js', 'services/layBet.js'
  ];
  test.each(money.filter((f) => fs.existsSync(path.join(__dirname, '../..', f))))('%s autoSuspend ব্যবহার করে না', (f) => {
    expect(read(f)).not.toMatch(/autoSuspend|integration_suspend/);
  });
  test('SSLCommerz ও ওয়ালেট callback সাসপেন্ডযোগ্য নয়', () => {
    expect(isSuspendable('payment:sslcommerz')).toBe(false);
    expect(isSuspendable('wallet:bkash')).toBe(false);
  });
});

describe('গেট যেখানে থাকার কথা', () => {
  test('একক বাজি: freshness-এর পরে, INSERT INTO bets-এর আগে, 503 STALE_ODDS', () => {
    const src = read('routes/matches.js');
    const a = src.indexOf("code: 'STALE_ODDS', message: req.t('matches_data_stale')");
    const b = src.indexOf('autoSuspend.getMatchProviderSuspension');
    const c = src.indexOf('INSERT INTO bets');
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    expect(src.slice(b, b + 500)).toMatch(/status\(503\)[\s\S]*STALE_ODDS/);
  });
  test('অ্যাকুমুলেটর প্রতিটা লেগে গেট আছে', () => {
    expect(read('services/accumulator.js')).toMatch(/getMatchProviderSuspension[\s\S]{0,300}STALE_ODDS/);
  });
  test('ক্যাসিনো লঞ্চ সেশন তৈরির আগে আটকায়; লবি suspended চিহ্ন দেয়', () => {
    const src = read('routes/games.js');
    expect(src.indexOf('autoSuspend.isSuspended(`casino:${provider}`)')).toBeGreaterThan(0);
    expect(src.indexOf('autoSuspend.isSuspended(`casino:${provider}`)')).toBeLessThan(src.indexOf('INSERT INTO game_sessions'));
    expect(src).toMatch(/suspended: down\.has\(g\.provider\)/);
  });
  test('ম্যাচ-প্রোভাইডার ম্যাপিং', () => {
    expect(MATCH_PROVIDER_INTEGRATION['cricket-cricapi']).toBe('sports:cricapi');
    expect(MATCH_PROVIDER_INTEGRATION['football-rapidapi']).toBe('sports:rapidapi');
  });
  test('বার্তা bn ও en দুটোতেই আছে', () => {
    for (const l of ['bn', 'en']) {
      const j = JSON.parse(read(`locales/${l}.json`));
      for (const k of ['auto_suspend_sports_msg', 'auto_suspend_casino_msg', 'auto_suspend_badge']) expect(j[k]).toBeTruthy();
    }
  });
});
