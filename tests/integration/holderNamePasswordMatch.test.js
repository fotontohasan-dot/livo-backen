// K2 (task 2) — holder_name ইউজারের নিজের পাসওয়ার্ডের সমান হলে প্রত্যাখ্যান (bcrypt যাচাই); দুই লেখার পথেই।
// অন্য ইউজারের পাসওয়ার্ড/সাধারণ নাম আটকায় না। পাসওয়ার্ডের মান লগে যায় না।
const bcrypt = require('bcryptjs');
const { pool } = require('../../db');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');

const ROUTES = [
  { path: '/profile/add-bank-card', back: '/profile/security/bank' },
  { path: '/profile/cards/add', back: '/profile/cards' },
];
// পাসওয়ার্ড এমন যা নিজে holder_name-এর নিয়ম পাস করে (শুধু অক্ষর/স্পেস) — নইলে পুরনো ভ্যালিডেটরই আটকাত, নতুন চেক পরীক্ষা হতো না
const PW = 'Correct Horse Battery';

// রেজিস্ট্রেশনের পাসওয়ার্ড-পলিসি এই "শুধু অক্ষর" পাসওয়ার্ড নেয় না; তাই বৈধ পাসওয়ার্ডে রেজিস্টার করে সরাসরি bcrypt হ্যাশ বসানো হয়
// (সেশন বহাল থাকে; রুট প্রতি রিকোয়েস্টে DB-র হ্যাশ পড়ে)।
async function makeUser(password = PW) {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form').send({
    username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token
  });
  const u = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
  await pool.query('UPDATE users SET password = $1 WHERE id = $2', [await bcrypt.hash(password, 4), u.rows[0].id]);
  return { agent, token, userId: u.rows[0].id };
}
const post = (u, p, body) => u.agent.post(p).set('X-CSRF-Token', u.token).set('User-Agent', REALISTIC_UA).type('form')
  .send({ bank_name: 'bKash', account_number: '01712345678', ...body });
const holders = async (id) => (await pool.query('SELECT holder_name FROM bank_cards WHERE user_id = $1', [id])).rows.map((r) => r.holder_name);

describe.each(ROUTES)('$path', ({ path: route, back }) => {
  test('নিজের পাসওয়ার্ড = holder_name → প্রত্যাখ্যান, কিছু সংরক্ষিত হয় না, লগে মান নেই', async () => {
    const u = await makeUser();
    // প্রি-কন্ডিশন: ভ্যালিডেটর একা এই মান পাস করে; আর হ্যাশ সত্যিই মেলে
    expect(require('../../utils/holderName').validateHolderName(PW).valid).toBe(true);
    const h = (await pool.query('SELECT password FROM users WHERE id = $1', [u.userId])).rows[0].password;
    expect(await bcrypt.compare(PW, h)).toBe(true);

    const spies = ['log', 'warn', 'error', 'info', 'debug'].map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
    let r;
    try { r = await post(u, route, { holder_name: PW }); } finally { spies.forEach((s) => s.mockRestore()); }
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe(back);
    expect(await holders(u.userId)).toEqual([]);
    expect(JSON.stringify(spies.map((s) => s.mock.calls))).not.toContain(PW);
  });

  test('বাড়তি স্পেস/NFC-র পরও (নরমালাইজড মান = পাসওয়ার্ড) প্রত্যাখ্যান', async () => {
    const u = await makeUser();
    const r = await post(u, route, { holder_name: `  ${PW.replace(/ /g, '   ')}  ` });
    expect(r.status).toBe(302);
    expect(await holders(u.userId)).toEqual([]);
  });

  test('অন্য ইউজারের পাসওয়ার্ড আটকায় না; সাধারণ নামও সংরক্ষিত হয়', async () => {
    const u = await makeUser('Another Long Phrase');
    const r1 = await post(u, route, { holder_name: PW });
    expect(r1.status).toBe(302);
    const r2 = await post(u, route, { holder_name: 'রহিম উদ্দিন' });
    expect(r2.status).toBe(302);
    expect(await holders(u.userId)).toEqual([PW, 'রহিম উদ্দিন']);
  });
});
