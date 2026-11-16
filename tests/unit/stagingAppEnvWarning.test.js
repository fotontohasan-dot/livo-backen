// APP_ENV অনুপস্থিত অথচ staging মনে হলে বুট-সতর্কতা (utils/stagingGuard.js)।
const { stagingWithoutAppEnvWarning } = require('../../utils/stagingGuard');
const fs = require('fs');
const path = require('path');

describe('stagingWithoutAppEnvWarning', () => {
  test('APP_ENV সেট থাকলে সতর্কতা নেই', () => {
    expect(stagingWithoutAppEnvWarning({ APP_ENV: 'staging', RENDER_SERVICE_NAME: 'livo-web-staging' })).toBeNull();
  });
  test('APP_ENV নেই + Render সার্ভিসের নামে staging → সতর্কতা', () => {
    const w = stagingWithoutAppEnvWarning({ RENDER_SERVICE_NAME: 'livo-web-staging' });
    expect(w).toMatch(/APP_ENV/);
  });
  test('APP_ENV নেই + PUBLIC_APP_URL-এ staging → সতর্কতা', () => {
    expect(stagingWithoutAppEnvWarning({ PUBLIC_APP_URL: 'https://livo-web-staging.onrender.com' })).toMatch(/APP_ENV/);
  });
  test('প্রোডাকশন-সদৃশ পরিবেশে সতর্কতা নেই', () => {
    expect(stagingWithoutAppEnvWarning({ RENDER_SERVICE_NAME: 'livo-web', PUBLIC_APP_URL: 'https://livo.example' })).toBeNull();
    expect(stagingWithoutAppEnvWarning({})).toBeNull();
  });
  test('সতর্কতায় কোনো URL/মান ছাপা হয় না', () => {
    const w = stagingWithoutAppEnvWarning({ PUBLIC_APP_URL: 'https://secret-staging.example.com' });
    expect(w).not.toMatch(/secret-staging/);
  });
});

describe('render.staging.yaml — স্পষ্ট APP_ENV ও SSLCZ_IS_LIVE', () => {
  const yaml = fs.readFileSync(path.join(__dirname, '../../render.staging.yaml'), 'utf8');
  test('web ও worker দুটোতেই APP_ENV=staging এবং SSLCZ_IS_LIVE=false', () => {
    const count = (re) => (yaml.match(re) || []).length;
    expect(count(/key: APP_ENV\n\s+value: staging/g)).toBeGreaterThanOrEqual(2);
    expect(count(/key: SSLCZ_IS_LIVE\n\s+value: "false"/g)).toBeGreaterThanOrEqual(2);
  });
});
