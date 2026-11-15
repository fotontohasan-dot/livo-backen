// K2 — holder_name: সব লেখার পথে সার্ভার-ভ্যালিডেটর (ইউজার রুট ×২, রিস্টোর/ইমপোর্ট), ফর্ম autocomplete, মান লগে/রেসপন্সে নয়।
const fs = require('fs');
const path = require('path');
const { pool } = require('../../db');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const backupManager = require('../../services/backupManager');

const ROUTES = [
  { path: '/profile/add-bank-card', back: '/profile/security/bank' },
  { path: '/profile/cards/add', back: '/profile/cards' },
];
const SECRET_LIKE = ['Sup3rS3cret!Pass', 'P@ssw0rd1234', '987654321'];

async function makeUser() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form').send({
    username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token
  });
  const u = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
  return { agent, token, userId: u.rows[0].id };
}
const post = (u, p, body) => u.agent.post(p).set('X-CSRF-Token', u.token).set('User-Agent', REALISTIC_UA).type('form').send({ bank_name: 'bKash', account_number: '01712345678', ...body });
const holders = async (id) => (await pool.query('SELECT holder_name FROM bank_cards WHERE user_id = $1 ORDER BY id', [id])).rows.map((r) => r.holder_name);

describe.each(ROUTES)('লেখার পথ $path', ({ path: route, back }) => {
  test.each([['রহিম উদ্দিন', 'রহিম উদ্দিন'], ['Rahim Uddin', 'Rahim Uddin'], ["  Mary-Jane   O'Neil ", "Mary-Jane O'Neil"]])('বৈধ %j → সংরক্ষিত %j', async (input, saved) => {
    const u = await makeUser();
    const r = await post(u, route, { holder_name: input });
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe(back);
    expect(await holders(u.userId)).toEqual([saved]);
  });

  test.each([...SECRET_LIKE, 'a', '<b>x</b>', 'name_1', 'Name!', ''])('অবৈধ %j → কিছু সংরক্ষিত হয় না; মান লগে/রেসপন্সে আসে না', async (bad) => {
    const u = await makeUser();
    const spies = ['log', 'warn', 'error', 'info', 'debug'].map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
    let r;
    try { r = await post(u, route, { holder_name: bad }); } finally { spies.forEach((s) => s.mockRestore()); }
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe(back);
    expect(await holders(u.userId)).toEqual([]);
    if (bad.length > 3) {
      const logged = spies.flatMap((s) => s.mock.calls).map((c) => c.map(String).join(' ')).join('\n');
      expect(logged).not.toContain(bad);
      expect(JSON.stringify(r.headers) + (r.text || '')).not.toContain(bad);
    }
  });

  test('holder_name অনুপস্থিত/অ্যারে/অবজেক্ট হলেও সংরক্ষিত হয় না', async () => {
    const u = await makeUser();
    await post(u, route, {});
    await u.agent.post(route).set('X-CSRF-Token', u.token).set('User-Agent', REALISTIC_UA).type('form').send('bank_name=bKash&account_number=01712345678&holder_name=Rahim&holder_name=Karim');
    expect(await holders(u.userId)).toEqual([]);
  });
});

describe('ফর্ম: পাসওয়ার্ড autofill বন্ধ, নাম-ইনপুট', () => {
  test('cards.ejs ও security.ejs-এ holder_name ইনপুট type=text + autocomplete=name; কোনো password-টাইপ নয়', () => {
    for (const f of ['views/profile/cards.ejs', 'views/profile/security.ejs']) {
      const src = fs.readFileSync(path.join(__dirname, '../..', f), 'utf8');
      const inputs = src.match(/<input[^>]*name="holder_name"[^>]*>/g) || [];
      expect(inputs.length).toBeGreaterThan(0);
      for (const tag of inputs) {
        expect(tag).toMatch(/type="text"/);
        expect(tag).not.toMatch(/type="password"/);
        expect(tag).toMatch(/autocomplete="name"/);
        expect(tag).toMatch(/maxlength="60"/);
        expect(tag).toMatch(/data-invalid-msg=/);
      }
      expect(src).toMatch(/\/js\/holder-name-validate\.js/);
    }
  });

  test('রেন্ডার করা /profile/cards পাতায় একই (রিয়েল রেন্ডার)', async () => {
    const u = await makeUser();
    const r = await u.agent.get('/profile/cards').set('User-Agent', REALISTIC_UA);
    expect(r.status).toBe(200);
    const tag = (r.text.match(/<input[^>]*name="holder_name"[^>]*>/) || [''])[0];
    expect(tag).toMatch(/type="text"/);
    expect(tag).toMatch(/autocomplete="name"/);
    expect(r.text).toContain('holder-name-validate.js');
  });

  test('বার্তা bn ও en দুটোতেই আছে, সাধারণ (কোনো মান নেই)', () => {
    for (const l of ['bn', 'en']) {
      const j = JSON.parse(fs.readFileSync(path.join(__dirname, '../../locales', `${l}.json`), 'utf8'));
      expect(j.holder_name_invalid).toBeTruthy();
      expect(j.cw_holder_name_label).toBeTruthy();
      expect(j.holder_name_invalid).not.toMatch(/\{/);
    }
  });
});

describe('লেখার পথের তালিকা বাঁধা (নতুন অরক্ষিত পথ এলে এই টেস্ট ফেল করবে)', () => {
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'tests', '.git', 'public', 'docs', 'views', 'locales'].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.js')) out.push(p);
    }
    return out;
  };
  test('bank_cards-এ INSERT/UPDATE শুধু routes/profile.js (ভ্যালিডেটরসহ) ও migrations/ক্লিনআপ স্ক্রিপ্টে', () => {
    const root = path.join(__dirname, '../..');
    const hits = walk(root).filter((f) => /(INSERT\s+INTO|UPDATE)\s+bank_cards/i.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(root, f)).sort();
    expect(hits).toEqual(['migrations.js', 'routes/profile.js', 'scripts/cleanupBankCardHolderName.js'].filter((f) => hits.includes(f)));
    const prof = fs.readFileSync(path.join(root, 'routes/profile.js'), 'utf8');
    expect((prof.match(/INSERT INTO bank_cards/g) || []).length).toBe(2);
    expect((prof.match(/validateHolderName\(holder_name\)/g) || []).length).toBe(2);
  });
  test('রিস্টোর পথে sanitizeImportedRows আছে', () => {
    expect(fs.readFileSync(path.join(__dirname, '../../services/backupManager.js'), 'utf8')).toMatch(/table === 'bank_cards'[\s\S]{0,200}sanitizeImportedRows/);
  });
});

describe('রিস্টোর (ইমপোর্ট) পথ', () => {
  test('পুরনো ব্যাকআপে থাকা পাসওয়ার্ড-সদৃশ holder_name ফেরে না (NULL), বৈধ নাম ফেরে, কার্ড সারি হারায় না', async () => {
    const u = await makeUser();
    const ins = async (acct, holder) => (await pool.query(
      `INSERT INTO bank_cards (user_id, bank_name, account_number, holder_name) VALUES ($1,'bKash',$2,$3) RETURNING id`, [u.userId, acct, holder])).rows[0].id;
    const dirty = await ins('01800000001', SECRET_LIKE[0]);   // পুরনো ডেটা (গার্ড এড়িয়ে সরাসরি SQL)
    const good = await ins('01800000002', 'রহিম উদ্দিন');
    const record = await backupManager.createDatabaseBackup({ source: 'manual' });
    expect(record.status).toBe('completed');
    await pool.query('DELETE FROM bank_cards WHERE id = ANY($1)', [[dirty, good]]);
    await backupManager.restoreBackup(record);
    const rows = (await pool.query('SELECT id, holder_name FROM bank_cards WHERE id = ANY($1) ORDER BY id', [[dirty, good]])).rows;
    expect(rows).toEqual([{ id: dirty, holder_name: null }, { id: good, holder_name: 'রহিম উদ্দিন' }]);
  });
});

afterAll(async () => { await pool.query("DELETE FROM bank_cards WHERE account_number IN ('01712345678','01800000001','01800000002')"); });
