const fs = require('fs');
const os = require('os');
const path = require('path');
const { pool } = require('../../db');
const { ensureLogo, syncMatchLogos } = require('../../services/teamLogo');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)]);
const pub = async () => [{ address: '93.184.216.34', family: 4 }];
const mk = (get) => ({ hosts: [], lookup: pub, get, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'lg-')) });

test('downloads once, then serves the cached file without hitting the network again', async () => {
  let calls = 0;
  const deps = mk(async () => { calls++; return { status: 200, headers: {}, body: PNG }; });
  const url = 'https://cdn.example.com/logo-' + Date.now() + '.png';
  const a = await ensureLogo(pool, url, deps);
  const b = await ensureLogo(pool, url, deps);
  expect(a).toMatch(/^\/images\/teams\/[a-f0-9]{32}\.png$/);
  expect(b).toBe(a);
  expect(calls).toBe(1);
});

test('a deleted file (ephemeral disk) is re-downloaded', async () => {
  let calls = 0;
  const deps = mk(async () => { calls++; return { status: 200, headers: {}, body: PNG }; });
  const url = 'https://cdn.example.com/eph-' + Date.now() + '.png';
  const a = await ensureLogo(pool, url, deps);
  fs.unlinkSync(path.join(deps.dir, path.basename(a)));
  await ensureLogo(pool, url, deps);
  expect(calls).toBe(2);
});

test('failures are remembered and not retried immediately; unsafe urls never reach the network', async () => {
  let calls = 0;
  const deps = mk(async () => { calls++; return { status: 500, headers: {}, body: Buffer.alloc(0) }; });
  const url = 'https://cdn.example.com/bad-' + Date.now() + '.png';
  expect(await ensureLogo(pool, url, deps)).toBeNull();
  expect(await ensureLogo(pool, url, deps)).toBeNull();
  expect(calls).toBe(1);
  expect(await ensureLogo(pool, 'https://169.254.169.254/latest', deps)).toBeNull();
  expect(await ensureLogo(pool, 'http://cdn.example.com/a.png', deps)).toBeNull();
  expect(calls).toBe(1);
});

test('syncMatchLogos stores the local path on the match and keeps the old one when a fetch fails', async () => {
  const m = await pool.query(`INSERT INTO matches (title, team_a, team_b, sport, status) VALUES ('L','A','B','cricket','live') RETURNING id`);
  const id = m.rows[0].id;
  const good = mk(async () => ({ status: 200, headers: {}, body: PNG }));
  const r = await syncMatchLogos(pool, id, { team_a_logo_url: 'https://cdn.example.com/a-' + Date.now() + '.png' }, good);
  const row = (await pool.query('SELECT team_a_logo, team_b_logo FROM matches WHERE id=$1', [id])).rows[0];
  expect(row.team_a_logo).toBe(r.a);
  expect(row.team_b_logo).toBeNull();
  const bad = mk(async () => ({ status: 404, headers: {}, body: Buffer.alloc(0) }));
  await syncMatchLogos(pool, id, { team_a_logo_url: 'https://cdn.example.com/zz-' + Date.now() + '.png' }, bad);
  expect((await pool.query('SELECT team_a_logo FROM matches WHERE id=$1', [id])).rows[0].team_a_logo).toBe(r.a);
});
