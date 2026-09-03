// tests/integration/userJourney.test.js
const { pool } = require('../../db');
const { getCsrfAgent, uniqueUsername, uniquePhone, extractCsrfToken, REALISTIC_UA } = require('../helpers/app');

async function csrfFor(agent, getPath) {
  const res = await agent.get(getPath);
  return extractCsrfToken(res.text);
}

describe('A-Z User Journey', () => {
  let agent, username, email, phone, password, userId, verifyToken;
  let refAgent, refUsername, refUserId;

  test('1. Register', async () => {
    const g = await getCsrfAgent('/register');
    agent = g.agent;
    username = uniqueUsername();
    email = `${username}@example.com`;
    phone = uniquePhone();
    password = 'SecurePass123';
    const res = await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form').send({
      username, email, phone, password, confirmPassword: password, _csrf: g.token
    });
    expect(res.status).toBe(302);
    const u = await pool.query('SELECT id, email_verified FROM users WHERE username=$1', [username]);
    expect(u.rows.length).toBe(1);
    userId = u.rows[0].id;
    expect(u.rows[0].email_verified).toBe(false);
  });

  test('2. Verify (email)', async () => {
    // DB-তে টোকেনের SHA-256 হ্যাশ থাকে, কাঁচা টোকেন নয় (utils/tokens.js) — তাই
    // সেটা পড়ে লিংকে বসানো যায় না। ইউজার যেভাবে পায় সেভাবেই নেওয়া হচ্ছে:
    // পাঠানো ভেরিফিকেশন ইমেইলের payload থেকে।
    const stored = await pool.query('SELECT verification_token FROM users WHERE id=$1', [userId]);
    expect(stored.rows[0].verification_token).toBeTruthy();

    const jobs = await pool.query(
      `SELECT payload FROM job_queue
        WHERE type = 'email' AND payload->>'kind' = 'verification'
        ORDER BY id DESC LIMIT 1`
    );
    const payload = typeof jobs.rows[0].payload === 'string'
      ? JSON.parse(jobs.rows[0].payload) : jobs.rows[0].payload;
    verifyToken = String(payload.verifyUrl || '').match(/\/verify-email\/([a-f0-9]+)/i)[1];
    expect(verifyToken).toBeTruthy();
    const res = await agent.get(`/verify-email/${verifyToken}`);
    expect(res.status).toBe(302);
    const u = await pool.query('SELECT email_verified FROM users WHERE id=$1', [userId]);
    expect(u.rows[0].email_verified).toBe(true);
  });

  test('3. Logout then Login', async () => {
    await agent.get('/logout');
    const g = await getCsrfAgent('/login');
    const res = await g.agent.post('/login').set('User-Agent', REALISTIC_UA).type('form')
      .send({ identifier: phone, password, _csrf: g.token });
    expect(res.status).toBe(302);
    agent = g.agent;
  });

  test('4. Profile', async () => {
    const res = await agent.get('/profile');
    expect(res.status).toBe(200);
    const bal = await agent.get('/profile/api/balance');
    expect(bal.status).toBe(200);
  });

  test('5. Wallet', async () => {
    const res = await agent.get('/payment/wallet');
    expect(res.status).toBe(200);
  });

  test('6. Deposit', async () => {
    const csrf = await csrfFor(agent, '/payment/deposit');
    const res = await agent.post('/payment/deposit').type('form').send({
      method: 'bkash', account_number: '01700000000', transaction_id: `TX${Date.now()}`,
      amount: '1000', want_bonus: 'no', _csrf: csrf
    });
    expect(res.status).toBe(302);
    const r = await pool.query(`SELECT * FROM payment_requests WHERE user_id=$1 AND type='deposit' ORDER BY id DESC LIMIT 1`, [userId]);
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].status).toBe('pending');

    // admin অনুমোদন — coins ক্রেডিট + notification যাচাই করার জন্য
    const admin = await getCsrfAgent('/register');
    const adminUsername = uniqueUsername();
    await admin.agent.post('/register').set('User-Agent', REALISTIC_UA).type('form').send({
      username: adminUsername, phone: uniquePhone(), password, confirmPassword: password, _csrf: admin.token
    });
    await pool.query('UPDATE users SET role=$1 WHERE username=$2', ['admin', adminUsername]);
    const approveRes = await admin.agent.post(`/payment/admin/approve/${r.rows[0].id}`).type('form').send({ _csrf: admin.token });
    expect(approveRes.status).toBe(302);

    const coinsRow = await pool.query('SELECT coins FROM users WHERE id=$1', [userId]);
    expect(Number(coinsRow.rows[0].coins)).toBeGreaterThanOrEqual(1000);
  });

  test('6b. Transaction (history reflects the deposit)', async () => {
    const res = await agent.get('/profile/transactions');
    expect(res.status).toBe(200);
    const tx = await pool.query(`SELECT * FROM coin_transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 5`, [userId]);
    expect(tx.rows.length).toBeGreaterThan(0);
  });

  test('7. Rewards', async () => {
    const res = await agent.get('/profile/rewards');
    expect(res.status).toBe(200);
    const status = await agent.get('/profile/daily-rewards/status');
    expect(status.status).toBe(200);
  });

  test('7b. Lucky Wheel', async () => {
    const page = await agent.get('/profile/wheel');
    expect(page.status).toBe(200);
    const csrf = await csrfFor(agent, '/profile/wheel');
    const spin = await agent.post('/profile/wheel/spin').type('form').send({ _csrf: csrf });
    expect(spin.status).toBe(200);
    expect(typeof spin.body.success).toBe('boolean');
  });

  test('8. VIP', async () => {
    const res = await agent.get('/profile/vip');
    expect(res.status).toBe(200);
    const progress = await agent.get('/profile/api/vip-progress');
    expect(progress.status).toBe(200);
  });

  test('9. Referral', async () => {
    const res = await agent.get('/profile/referral');
    expect(res.status).toBe(200);
    const codeRow = await pool.query('SELECT referral_code FROM users WHERE id=$1', [userId]);
    const code = codeRow.rows[0].referral_code;
    expect(code).toBeTruthy();

    const g = await getCsrfAgent('/register');
    refAgent = g.agent;
    refUsername = uniqueUsername();
    const rres = await refAgent.post('/register').set('User-Agent', REALISTIC_UA).type('form').send({
      username: refUsername, phone: uniquePhone(), password, confirmPassword: password,
      referralCode: code, _csrf: g.token
    });
    expect(rres.status).toBe(302);
    const ru = await pool.query('SELECT id, referred_by_id FROM users WHERE username=$1', [refUsername]);
    refUserId = ru.rows[0].id;
    expect(ru.rows[0].referred_by_id).toBe(userId);
  });

  test('10. KYC', async () => {
    const csrf = await csrfFor(agent, '/extra/kyc');
    const res = await agent.post('/extra/kyc').type('form').send({
      full_name: 'Journey Test User', document_type: 'nid', document_number: `NID-${Date.now()}`,
      document_url: `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload/v1/livo/chat/nid.jpg`, _csrf: csrf
    });
    expect(res.status).toBe(302);
    const k = await pool.query('SELECT status FROM kyc_requests WHERE user_id=$1', [userId]);
    expect(k.rows.length).toBe(1);
    expect(k.rows[0].status).toBe('pending');
  });

  test('11. Security (password change + withdraw PIN)', async () => {
    const secPage = await agent.get('/profile/security');
    expect(secPage.status).toBe(200);

    let csrf = await csrfFor(agent, '/profile/security');
    const pinRes = await agent.post('/profile/withdraw-pin/create').type('form')
      .send({ pin: '135790', confirmPin: '135790', _csrf: csrf });
    expect(pinRes.status).toBe(302);

    csrf = await csrfFor(agent, '/profile/security');
    const newPassword = 'NewSecurePass456';
    const pwRes = await agent.post('/profile/change-password').type('form').send({
      currentPassword: password, newPassword, confirmNewPassword: newPassword, _csrf: csrf
    });
    expect(pwRes.status).toBe(302);
    password = newPassword;
  });

  test('12. Notifications', async () => {
    const res = await agent.get('/notifications');
    expect(res.status).toBe(200);
    const count = await agent.get('/notifications/count');
    expect(count.status).toBe(200);
    // ধাপ ৬-এ ডিপোজিট অনুমোদনের সময় notifications টেবিলে একটা এন্ট্রি তৈরি হওয়ার কথা
    const n = await pool.query('SELECT * FROM notifications WHERE user_id=$1', [userId]);
    expect(n.rows.length).toBeGreaterThan(0);
  });

  test('12b. Games/Sports', async () => {
    const gamesPage = await agent.get('/games/play?game=slots');
    expect(gamesPage.status).toBe(200);
    const before = await pool.query('SELECT coins FROM users WHERE id=$1', [userId]);
    const csrf = await csrfFor(agent, '/games/play?game=slots');
    const play = await agent.post('/games/play').type('form').send({
      gameSlug: 'slots', amount: '50', _csrf: csrf
    });
    expect(play.status).toBe(200);
    expect(play.body.success).toBe(true);
    const after = await pool.query('SELECT coins FROM users WHERE id=$1', [userId]);
    expect(Number(after.rows[0].coins)).not.toBe(Number(before.rows[0].coins));

    const matchIns = await pool.query(`INSERT INTO matches (title, team_a, team_b, sport, status) VALUES ('Journey Test Match','X','Y','cricket','live') RETURNING id`);
    // মার্কেটে রানারের অডস অবশ্যই থাকতে হবে। আগে খালি `'{}'` দিয়েও বাজি বসত,
    // কারণ অচেনা রানারের জন্য সার্ভার একটা ফলব্যাক অডস ধরে নিত — ফলে বানানো
    // রানার নামেও বাজি হয়ে যেত, আর সেটেলমেন্টে সেটা কোনো ফলাফলের সাথে মিলত না।
    // এখন অচেনা রানার প্রত্যাখ্যাত, তাই টেস্টেও বাস্তব মার্কেটের মতো অডস দেওয়া হলো।
    const marketIns = await pool.query(`INSERT INTO markets (match_id, type, name, odds, status) VALUES ($1,'match_winner','Match Winner','{"X":1.80,"Y":2.10}','open') RETURNING id`, [matchIns.rows[0].id]);
    const matchPage = await agent.get(`/matches/${matchIns.rows[0].id}`);
    expect(matchPage.status).toBe(200);
    const betCsrf = await csrfFor(agent, `/matches/${matchIns.rows[0].id}`);
    const bet = await agent.post(`/matches/${matchIns.rows[0].id}/bet`).type('form').send({
      market_id: marketIns.rows[0].id, runner: 'X', odd: '1.80', stake: '50', _csrf: betCsrf
    });
    expect(bet.status).toBe(200);
    expect(bet.body.success).toBe(true);
    const betRow = await pool.query(`SELECT * FROM bets WHERE user_id=$1 AND match_id=$2`, [userId, matchIns.rows[0].id]);
    expect(betRow.rows.length).toBe(1);
  });

  test('13. Withdraw', async () => {
    // আগে এখানে `coins < 1000` নামে একটা ধ্রুব থ্রেশহোল্ড যাচাই করা হতো। কিন্তু
    // এই জার্নির ৭b (লাকি হুইল স্পিন) ও ১২b (স্লট গেম) ধাপ দুটোর ফলাফল এলোমেলো —
    // ভালো স্পিন/জিত হলে ব্যালেন্স ৫০০ কাটার পরেও ১০০০ ছাড়িয়ে যেত, ফলে টেস্টটা
    // একই কোডে কখনো পাস কখনো ফেল করত (flaky)।
    //
    // আসল যাচাইয়ের বিষয় থ্রেশহোল্ড নয় — উইথড্র রিকোয়েস্টে ব্যালেন্স থেকে ঠিক
    // ততটাই কাটা হয়েছে কিনা। তাই before/after তুলনা করা হচ্ছে, যেটা এলোমেলো
    // ফলাফল থেকে স্বাধীন এবং আগের চেয়ে কড়া (সঠিক অঙ্কও যাচাই করে)।
    // উইথড্র সময়সূচি (services/withdrawalWindow.js) রাত ১১টা–সকাল ৭টা উইথড্র
    // বন্ধ রাখে। সেটা ছেড়ে দিলে এই টেস্ট দিনের কোন সময়ে চলছে তার উপর নির্ভর
    // করত — রাতে CI চালালে ফেল, দিনে পাস। তাই এখানে জানালাটা স্পষ্টভাবে খোলা
    // ধরা হচ্ছে; সময়সূচির নিজস্ব আচরণ tests/withdrawalWindow.test.js-এ যাচাই হয়।
    await pool.query(
      `INSERT INTO site_settings (key, value) VALUES ('withdrawal_window_mode', 'open')
       ON CONFLICT (key) DO UPDATE SET value = 'open'`
    );

    const before = Number((await pool.query('SELECT coins FROM users WHERE id=$1', [userId])).rows[0].coins);
    const csrf = await csrfFor(agent, '/payment/withdraw');
    const res = await agent.post('/payment/withdraw').type('form').send({
      method: 'bkash', account_number: '01700000000', amount: '500', withdraw_pin: '135790', _csrf: csrf
    });
    expect(res.status).toBe(302);
    const w = await pool.query(`SELECT * FROM payment_requests WHERE user_id=$1 AND type='withdraw' ORDER BY id DESC LIMIT 1`, [userId]);
    expect(w.rows.length).toBe(1);
    expect(Number(w.rows[0].amount)).toBe(500);
    const after = Number((await pool.query('SELECT coins FROM users WHERE id=$1', [userId])).rows[0].coins);
    expect(after).toBe(before - 500);

    // ওভাররাইডটা এই টেস্টের বাইরে যেন না ছড়ায়
    await pool.query("DELETE FROM site_settings WHERE key = 'withdrawal_window_mode'");
  });

  test('14. Support', async () => {
    const res = await agent.get('/profile/support');
    expect(res.status).toBe(200);
    const chatPage = await agent.get('/chat');
    expect(chatPage.status).toBe(200);
    const history = await agent.get('/chat/history');
    expect(history.status).toBe(200);
  });

  test('15. Logout', async () => {
    const res = await agent.get('/logout');
    expect(res.status).toBe(302);
    const profileAfter = await agent.get('/profile');
    expect(profileAfter.status).toBe(302); // সেশন শেষ, লগইনে রিডাইরেক্ট
  });

  describe('ভুল/এজ কেস (negative paths)', () => {
    test('ভুল পাসওয়ার্ডে লগইন ব্যর্থ হয়', async () => {
      const g = await getCsrfAgent('/login');
      const res = await g.agent.post('/login').set('User-Agent', REALISTIC_UA).type('form')
        .send({ identifier: phone, password: 'wrongpassword', _csrf: g.token });
      expect(res.status).toBe(302);
      const profileCheck = await g.agent.get('/profile');
      expect(profileCheck.status).toBe(302); // লগইন ব্যর্থ, এখনো সেশন নেই
    });

    test('সর্বনিম্ন ডিপোজিট (১০০ টাকার কম) প্রত্যাখ্যাত হয়', async () => {
      const g = await getCsrfAgent('/login');
      await g.agent.post('/login').set('User-Agent', REALISTIC_UA).type('form')
        .send({ identifier: phone, password, _csrf: g.token });
      const csrf = await csrfFor(g.agent, '/payment/deposit');
      const before = await pool.query(`SELECT COUNT(*) FROM payment_requests WHERE user_id=$1`, [userId]);
      const res = await g.agent.post('/payment/deposit').type('form').send({
        method: 'bkash', account_number: '01700000000', transaction_id: `LOW${Date.now()}`,
        amount: '50', _csrf: csrf
      });
      expect(res.status).toBe(302);
      const after = await pool.query(`SELECT COUNT(*) FROM payment_requests WHERE user_id=$1`, [userId]);
      expect(after.rows[0].count).toBe(before.rows[0].count); // নতুন কোনো রিকোয়েস্ট তৈরি হয়নি
    });

    test('ভুল withdraw PIN দিয়ে উইথড্র ব্যর্থ হয়, কয়েন কাটা হয় না', async () => {
      const g = await getCsrfAgent('/login');
      await g.agent.post('/login').set('User-Agent', REALISTIC_UA).type('form')
        .send({ identifier: phone, password, _csrf: g.token });
      const before = await pool.query('SELECT coins FROM users WHERE id=$1', [userId]);
      const csrf = await csrfFor(g.agent, '/payment/withdraw');
      await g.agent.post('/payment/withdraw').type('form').send({
        method: 'bkash', account_number: '01700000000', amount: '100', withdraw_pin: '000000', _csrf: csrf
      });
      const after = await pool.query('SELECT coins FROM users WHERE id=$1', [userId]);
      expect(after.rows[0].coins).toBe(before.rows[0].coins);
    });
  });
});
