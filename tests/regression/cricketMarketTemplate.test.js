// ক্রিকেট মার্কেট টেমপ্লেট (services/cricketMarketTemplate.js + POST /admin/markets/:id/cricket-template)
// এবং হোমপেজ থেকে ১৮+ ওভারলে সরানো।
const fs = require('fs');
const path = require('path');
const { pool } = require('../../db');
const { buildRows } = require('../../services/cricketMarketTemplate');
const { resolveOdd } = require('../../services/oddsResolver');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const { cleanupUsers } = require('../helpers/cleanup');

const ROOT = path.join(__dirname, '..', '..');
const match = { team_a: 'Afghanistan', team_b: 'Bangladesh' };

describe('buildRows — যাচাই ও সারি তৈরি', () => {
  test('উইনার + তিনটা লাইন: ৮টা সারি, অডস অ্যাডমিনের দেওয়া মানই', () => {
    const { rows, error } = buildRows(match, {
      home_odds: '1.60', away_odds: '2.30',
      runs_line: '280.5', wickets_line: '7.5', overs_line: '45.5',
      over_odds: '1.90', under_odds: '1.85'
    });
    expect(error).toBeNull();
    expect(rows).toHaveLength(8);
    expect(rows.find((r) => r.name === 'Afghanistan Win').odds).toBe(1.6);
    expect(rows.find((r) => r.name === 'Bangladesh Win').odds).toBe(2.3);
    expect(rows.find((r) => r.name === 'Total Runs Over 280.5')).toMatchObject({ type: 'total_runs', odds: 1.9 });
    expect(rows.find((r) => r.name === 'Total Runs Under 280.5')).toMatchObject({ type: 'total_runs', odds: 1.85 });
    expect(rows.find((r) => r.name === 'Total Wickets Over 7.5').type).toBe('total_wickets');
    expect(rows.find((r) => r.name === 'Total Overs Under 45.5').type).toBe('total_overs');
  });

  test('কোনো ডিফল্ট অডস বসে না: খালি ফর্মে কিছুই তৈরি হয় না', () => {
    expect(buildRows(match, {}).error).toBe('nothing_to_create');
    expect(buildRows(match, { runs_line: '', home_odds: '' }).error).toBe('nothing_to_create');
  });

  test('শুধু একটা দলের অডস বা লাইন-সহ একটা অডস দিলে প্রত্যাখ্যাত', () => {
    expect(buildRows(match, { home_odds: '1.8' }).error).toBe('winner_needs_both_odds');
    expect(buildRows(match, { runs_line: '280.5', over_odds: '1.9' }).error).toBe('ou_needs_both_odds');
    expect(buildRows(match, { runs_line: '280.5' }).error).toBe('ou_needs_both_odds');
  });

  test.each([['1'], ['0.5'], ['-2'], ['abc'], ['1001'], ['Infinity'], ['NaN']])('অবৈধ অডস %s প্রত্যাখ্যাত', (bad) => {
    expect(buildRows(match, { home_odds: bad, away_odds: '2.0' }).error).toBe('invalid_odds');
    expect(buildRows(match, { runs_line: '280.5', over_odds: bad, under_odds: '1.9' }).error).toBe('invalid_odds');
  });

  test.each([['0'], ['-5'], ['abc'], ['10001']])('অবৈধ লাইন %s প্রত্যাখ্যাত', (bad) => {
    expect(buildRows(match, { runs_line: bad, over_odds: '1.9', under_odds: '1.9' }).error).toBe('invalid_line');
  });

  test('দলের নাম ফাঁকা হলে নিরাপদ ফলব্যাক', () => {
    const { rows } = buildRows({ team_a: '', team_b: null }, { home_odds: '1.5', away_odds: '2.5' });
    expect(rows.map((r) => r.name)).toEqual(['Team A Win', 'Team B Win']);
  });

  test('তৈরি সারির অডস oddsResolver-এ yes-রানারে বৈধ', () => {
    const { rows } = buildRows(match, { runs_line: '280.5', over_odds: '1.9', under_odds: '1.85' });
    for (const r of rows) {
      expect(resolveOdd({ type: r.type, odds: r.odds }, 'yes')).toBe(r.odds);
    }
  });
});

describe('POST /admin/markets/:matchId/cricket-template', () => {
  const userIds = [];
  const matchIds = [];

  async function adminAgent() {
    const { agent, token } = await getCsrfAgent('/register');
    const username = uniqueUsername();
    await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
      .send({ username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
    const u = await pool.query('UPDATE users SET role = $1 WHERE username = $2 RETURNING id', ['admin', username]);
    userIds.push(u.rows[0].id);
    return { agent, token };
  }

  async function makeMatch(sport = 'cricket') {
    const r = await pool.query(
      `INSERT INTO matches (title, team_a, team_b, sport) VALUES ('Tpl Test','Afghanistan','Bangladesh',$1) RETURNING id`, [sport]);
    matchIds.push(r.rows[0].id);
    return r.rows[0].id;
  }

  afterAll(async () => {
    if (matchIds.length) {
      // বাজি-টেস্ট bets সারি রেখে যায়; ম্যাচ মোছার আগে সেগুলো (ও সংশ্লিষ্ট সারি) সরাতে হয়
      await pool.query('DELETE FROM bets WHERE match_id = ANY($1)', [matchIds]);
      await pool.query('DELETE FROM markets WHERE match_id = ANY($1)', [matchIds]);
      await pool.query('DELETE FROM matches WHERE id = ANY($1)', [matchIds]);
    }
    await cleanupUsers(userIds);
  });

  const form = (o) => ({
    home_odds: '1.60', away_odds: '2.30', runs_line: '280.5', over_odds: '1.90', under_odds: '1.85', ...o
  });

  test('সারিগুলো suspended তৈরি হয় — ইউজার-পেজে দেখায় না, বাজি ধরা যায় না', async () => {
    const { agent, token } = await adminAgent();
    const id = await makeMatch();
    const res = await agent.post(`/admin/markets/${id}/cricket-template`).set('X-CSRF-Token', token).type('form').send(form());
    expect(res.status).toBe(302);
    const rows = (await pool.query('SELECT type,name,odds,status FROM markets WHERE match_id=$1 ORDER BY id', [id])).rows;
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.status === 'suspended')).toBe(true);
    expect(rows.find((r) => r.name === 'Total Runs Over 280.5').odds).toEqual({ yes: 1.9 });
  });

  test('open_now=1 দিলে সারিগুলো open হয়', async () => {
    const { agent, token } = await adminAgent();
    const id = await makeMatch();
    await agent.post(`/admin/markets/${id}/cricket-template`).set('X-CSRF-Token', token).type('form').send(form({ open_now: '1' }));
    const rows = (await pool.query('SELECT status FROM markets WHERE match_id=$1', [id])).rows;
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.status === 'open')).toBe(true);
  });

  test('আবার জমা দিলে ডুপ্লিকেট হয় না, শুধু অডস বদলায়; সেটেল হওয়া সারি অক্ষত', async () => {
    const { agent, token } = await adminAgent();
    const id = await makeMatch();
    await agent.post(`/admin/markets/${id}/cricket-template`).set('X-CSRF-Token', token).type('form').send(form());
    await pool.query(`UPDATE markets SET status='settled' WHERE match_id=$1 AND name='Total Runs Over 280.5'`, [id]);
    await agent.post(`/admin/markets/${id}/cricket-template`).set('X-CSRF-Token', token).type('form')
      .send(form({ over_odds: '2.50', under_odds: '1.50', open_now: '1' }));
    const rows = (await pool.query('SELECT name,odds,status FROM markets WHERE match_id=$1', [id])).rows;
    expect(rows).toHaveLength(4);
    const settled = rows.find((r) => r.name === 'Total Runs Over 280.5');
    expect(settled.status).toBe('settled');
    expect(settled.odds).toEqual({ yes: 1.9 }); // সেটেল সারির অডস বদলায়নি
    const under = rows.find((r) => r.name === 'Total Runs Under 280.5');
    expect(under.odds).toEqual({ yes: 1.5 });
    expect(under.status).toBe('open');
  });

  // রুট-কজ রিগ্রেশন: আগে POST /admin/markets/update ON CONFLICT (match_id,type,name) ব্যবহার করত,
  // অথচ ওই কলামে কোনো ইউনিক ইনডেক্স নেই — তাই SQL এরর হতো, 302 ফিরত, কিন্তু কোনো মার্কেট তৈরি হতো না।
  test('বিদ্যমান "মার্কেট সেভ" ফর্ম সত্যিই মার্কেট তৈরি/আপডেট করে, সেটেল সারি ছোঁয় না', async () => {
    const { agent, token } = await adminAgent();
    const id = await makeMatch();
    const post = (o) => agent.post('/admin/markets/update').set('X-CSRF-Token', token).type('form')
      .send({ match_id: id, type: 'match_winner', name: 'Afghanistan Win', ...o });

    await post({ odds: '1.85' });
    let rows = (await pool.query('SELECT odds,status FROM markets WHERE match_id=$1', [id])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].odds).toEqual({ yes: 1.85 });
    expect(rows[0].status).toBe('open');

    await post({ odds: '2.10', status: 'suspended' });
    rows = (await pool.query('SELECT odds,status FROM markets WHERE match_id=$1', [id])).rows;
    expect(rows).toHaveLength(1); // ডুপ্লিকেট নয়
    expect(rows[0].odds).toEqual({ yes: 2.1 });
    expect(rows[0].status).toBe('suspended');

    await pool.query(`UPDATE markets SET status='settled' WHERE match_id=$1`, [id]);
    await post({ odds: '9.99', status: 'open' });
    rows = (await pool.query('SELECT odds,status FROM markets WHERE match_id=$1', [id])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('settled'); // জানা ফলাফলে আবার খোলা যায় না
    expect(rows[0].odds).toEqual({ yes: 2.1 });
  });

  test('"মার্কেট সেভ" ফর্মে অবৈধ অডস প্রত্যাখ্যাত, আর status=settled দিয়ে সেটেল গার্ড এড়ানো যায় না', async () => {
    const { agent, token } = await adminAgent();
    const id = await makeMatch();
    const post = (o) => agent.post('/admin/markets/update').set('X-CSRF-Token', token).type('form')
      .send({ match_id: id, type: 'match_winner', name: 'X Win', ...o });
    for (const bad of ['0.5', '1', '-3', 'abc', '5000', '']) await post({ odds: bad });
    let c = await pool.query('SELECT COUNT(*)::int AS c FROM markets WHERE match_id=$1', [id]);
    expect(c.rows[0].c).toBe(0);

    await post({ odds: '1.9', status: 'settled' });
    const r = (await pool.query('SELECT status FROM markets WHERE match_id=$1', [id])).rows;
    expect(r).toHaveLength(1);
    expect(r[0].status).toBe('open'); // 'settled' উপেক্ষিত, ডিফল্ট open
  });

  // রিগ্রেশন: ইউজার-পেজে দেখানো অডস = ডাটাবেসে সংরক্ষিত = বাজিতে ধরা অডস (আগে পেজে সবসময় ১.৭৫ দেখাত)
  test('ম্যাচ-পেজে দেখানো অডস অ্যাডমিনের দেওয়া অডসের সমান, বাজিতেও তাই ধরা হয়', async () => {
    const { agent, token } = await adminAgent();
    const id = await makeMatch();
    await agent.post(`/admin/markets/${id}/cricket-template`).set('X-CSRF-Token', token).type('form')
      .send(form({ home_odds: '1.60', away_odds: '2.30', over_odds: '1.90', under_odds: '1.50', open_now: '1' }));
    const player = await getCsrfAgent('/register');
    const pn = uniqueUsername();
    await player.agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
      .send({ username: pn, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: player.token });
    const pu = await pool.query('UPDATE users SET coins = 1000 WHERE username = $1 RETURNING id', [pn]);
    userIds.push(pu.rows[0].id);

    const html = (await player.agent.get('/matches/' + id)).text;
    // প্রতিটা market-box আলাদা করে: হেডারের নাম + তার ভেতরের data-odd
    const byName = {};
    for (const box of html.split('<div class="market-box">').slice(1)) {
      const name = (box.match(/market-header">\s*\S+\s+([^<]+?)\s*</) || [])[1];
      const odd = (box.match(/data-odd="([0-9.]+)"/) || [])[1];
      if (name && odd) byName[name] = Number(odd);
    }
    expect(byName).toEqual({ 'Afghanistan Win': 1.6, 'Bangladesh Win': 2.3, 'Total Runs Over 280.5': 1.9, 'Total Runs Under 280.5': 1.5 });

    const under = (await pool.query("SELECT id FROM markets WHERE match_id=$1 AND name='Total Runs Under 280.5'", [id])).rows[0].id;
    const r = await player.agent.post(`/matches/${id}/bet`).set('X-CSRF-Token', player.token).send({ market_id: under, runner: 'yes', stake: 100 });
    expect(r.body.success).toBe(true);
    const bet = await pool.query('SELECT odd FROM bets WHERE user_id=$1', [pu.rows[0].id]);
    expect(Number(bet.rows[0].odd)).toBe(1.5);
  });

  test('অবৈধ ইনপুটে কিছুই তৈরি হয় না', async () => {
    const { agent, token } = await adminAgent();
    const id = await makeMatch();
    const res = await agent.post(`/admin/markets/${id}/cricket-template`).set('X-CSRF-Token', token).type('form').send(form({ over_odds: '0.9' }));
    expect(res.status).toBe(302);
    const c = await pool.query('SELECT COUNT(*)::int AS c FROM markets WHERE match_id=$1', [id]);
    expect(c.rows[0].c).toBe(0);
  });

  test('অ্যাডমিন নয় এমন ইউজার মার্কেট বানাতে পারে না', async () => {
    const { agent, token } = await getCsrfAgent('/register');
    const username = uniqueUsername();
    await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
      .send({ username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
    const u = await pool.query('SELECT id FROM users WHERE username=$1', [username]);
    userIds.push(u.rows[0].id);
    const id = await makeMatch();
    await agent.post(`/admin/markets/${id}/cricket-template`).set('X-CSRF-Token', token).type('form').send(form());
    const c = await pool.query('SELECT COUNT(*)::int AS c FROM markets WHERE match_id=$1', [id]);
    expect(c.rows[0].c).toBe(0);
  });
});

describe('১৮+ ওভারলে হোমপেজ/লেআউট থেকে সরানো', () => {
  test('head.ejs আর age-gate.js লোড করে না', () => {
    const head = fs.readFileSync(path.join(ROOT, 'views', 'partials', 'head.ejs'), 'utf8');
    expect(head).not.toMatch(/age-gate/);
  });
  test('কোনো ভিউ age-gate.js রেফার করে না', () => {
    const dir = path.join(ROOT, 'views');
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    const offenders = walk(dir).filter((f) => fs.readFileSync(f, 'utf8').includes('age-gate'));
    expect(offenders).toEqual([]);
  });
});
