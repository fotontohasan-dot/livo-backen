// staging গার্ড: APP_ENV=staging না হলে স্ক্রিপ্ট DB খোলার আগেই থামে।
const { spawnSync } = require('child_process');
const path = require('path');
const script = path.join(__dirname, '..', '..', 'scripts', 'stagingCleanupProof.js');
const run = (env) => spawnSync('node', [script, 'seed'], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });

describe('stagingCleanupProof গার্ড', () => {
  test('APP_ENV খালি → exit 2', () => { expect(run({}).status).toBe(2); });
  test('NODE_ENV=production, APP_ENV=production → exit 2', () => {
    const r = run({ NODE_ENV: 'production', APP_ENV: 'production' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/staging/);
  });
});
