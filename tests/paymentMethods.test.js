// tests/paymentMethods.test.js
// ---------------------------------------------------------------------------
// অ্যাডমিন-নিয়ন্ত্রিত ডিপোজিট অ্যাকাউন্ট (payment_methods)।
//
// যে ঝুঁকিগুলো এখানে লক করা হচ্ছে:
//   • ইউজার যেন কখনো inactive/মুছে ফেলা নম্বর না দেখেন (ভুল নম্বরে টাকা যাওয়া);
//   • guest/সাধারণ ইউজার যেন অ্যাডমিন CRUD-এ পৌঁছাতে না পারেন;
//   • ক্লায়েন্ট যেন created_by/updated_by ইত্যাদি mass-assign করতে না পারে;
//   • এই ফিচারের কোনো পথ দিয়ে যেন ওয়ালেট ব্যালেন্স বা payment_requests
//     পরিবর্তন না হয় (আর্থিক নিরাপত্তা)।
// ---------------------------------------------------------------------------

const { getCsrfAgent, freshRequest, uniqueUsername, uniquePhone, REALISTIC_UA, extractCsrfToken } = require('./helpers/app');
const { cleanupUsers } = require('./helpers/cleanup');
const { pool } = require('../db');
const paymentMethods = require('../services/paymentMethods');

const createdUserIds = [];
const createdMethodIds = [];

// টেস্টের নম্বরগুলো বাস্তব সিড ডেটার সাথে না মেশে, তাই আলাদা রেঞ্জ।
let seq = 0;
function testNumber() {
  seq += 1;
  return '019' + String(10000000 + seq).slice(0, 8);
}

async function makeUser(prefix) {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername(prefix);
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form').send({
    username, phone: uniquePhone(), password: 'SecurePass123',
    confirmPassword: 'SecurePass123', _csrf: token
  });
  const r = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
  const id = r.rows[0] && r.rows[0].id;
  if (id) createdUserIds.push(id);
  return { agent, username, id };
}

async function makeAdmin() {
  const u = await makeUser('pmadm');
  await pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [u.id]);
  return u;
}

// অ্যাডমিন পেজ থেকে তাজা CSRF টোকেন — mutation-এর জন্য প্রতিবার নেওয়া হয়।
async function adminToken(agent) {
  const res = await agent.get('/payment/admin/payment-methods');
  return extractCsrfToken(res.text);
}

let admin;

beforeAll(async () => {
  admin = await makeAdmin();
});

afterAll(async () => {
  if (createdMethodIds.length) {
    await pool.query('DELETE FROM payment_methods WHERE id = ANY($1)', [createdMethodIds]);
  }
  await cleanupUsers(createdUserIds);
});

// ==================== ভ্যালিডেশন ও normalization (সার্ভিস স্তর) ====================
describe('অ্যাকাউন্ট নম্বর normalization ও validation', () => {
  test('আশপাশের whitespace ও ড্যাশ ছেঁটে canonical ফর্ম দেয়', () => {
    expect(paymentMethods.normalizeAccountNumber('bkash', '  01712-345678 ')).toBe('01712345678');
  });

  test('+880 উপসর্গ 0-এ রূপান্তরিত হয়, তাই একই নম্বর দুই ফর্মে duplicate হয় না', () => {
    expect(paymentMethods.normalizeAccountNumber('nagad', '+8801712345678')).toBe('01712345678');
  });

  test('অবৈধ দৈর্ঘ্য/অক্ষর প্রত্যাখ্যাত হয়', () => {
    expect(() => paymentMethods.normalizeAccountNumber('bkash', '12345')).toThrow();
    expect(() => paymentMethods.normalizeAccountNumber('bkash', '017abcd1234')).toThrow();
    expect(() => paymentMethods.normalizeAccountNumber('bkash', '')).toThrow();
  });

  test('মেথড allowlist-এর বাইরে কিছু গ্রহণ করা হয় না', async () => {
    expect(paymentMethods.isValidMethod('bkash')).toBe(true);
    expect(paymentMethods.isValidMethod('paypal')).toBe(false);
    await expect(paymentMethods.create(
      { method: 'paypal', accountNumber: testNumber() }, admin.id
    )).rejects.toThrow();
  });

  test('সার্ভিসের METHOD_KEYS ও routes/payment.js-এর VALID_METHODS অভিন্ন', () => {
    // দুটো তালিকা আলাদা হয়ে গেলে অ্যাডমিন এমন মেথডে অ্যাকাউন্ট যোগ করতে
    // পারতেন যেটা ডিপোজিট ফর্ম গ্রহণ করে না (বা উল্টোটা) — নীরব অসঙ্গতি।
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'payment.js'), 'utf8');
    const routeMethods = JSON.parse(
      src.match(/const VALID_METHODS = (\[[^\]]+\])/)[1].replace(/'/g, '"')
    );
    expect(routeMethods).toEqual(paymentMethods.METHOD_KEYS);
  });

  test('অডিটের জন্য নম্বর mask হয় — শুধু শেষ ৩ ডিজিট থাকে', () => {
    const masked = paymentMethods.maskAccountNumber('01712345678');
    expect(masked.endsWith('678')).toBe(true);
    expect(masked).not.toContain('01712345');
  });
});

// ==================== অ্যাডমিন CRUD ====================
describe('অ্যাডমিন CRUD', () => {
  test('অ্যাডমিন নতুন পেমেন্ট মেথড তৈরি করতে পারেন', async () => {
    const num = testNumber();
    const token = await adminToken(admin.agent);
    const res = await admin.agent.post('/payment/admin/payment-methods').type('form')
      .send({ method: 'bkash', account_number: num, status: 'active', _csrf: token });
    expect(res.status).toBe(302);

    const row = await pool.query('SELECT * FROM payment_methods WHERE account_number = $1', [num]);
    expect(row.rows.length).toBe(1);
    expect(row.rows[0].method).toBe('bkash');
    expect(row.rows[0].status).toBe('active');
    expect(row.rows[0].created_by).toBe(admin.id);
    createdMethodIds.push(row.rows[0].id);
  });

  test('একই মেথডে একই নম্বর দ্বিতীয়বার ঢোকে না (DB-স্তরের uniqueness)', async () => {
    const num = testNumber();
    const created = await paymentMethods.create({ method: 'nagad', accountNumber: num }, admin.id);
    createdMethodIds.push(created.id);
    await expect(paymentMethods.create({ method: 'nagad', accountNumber: num }, admin.id))
      .rejects.toThrow();
    const count = await pool.query(
      "SELECT COUNT(*)::int AS c FROM payment_methods WHERE method='nagad' AND account_number=$1 AND deleted_at IS NULL",
      [num]
    );
    expect(count.rows[0].c).toBe(1);
  });

  test('অ্যাডমিন নম্বর আপডেট করতে পারেন এবং updated_by বসে', async () => {
    const created = await paymentMethods.create({ method: 'rocket', accountNumber: testNumber() }, admin.id);
    createdMethodIds.push(created.id);
    const newNum = testNumber();
    const token = await adminToken(admin.agent);
    const res = await admin.agent.post(`/payment/admin/payment-methods/${created.id}/update`).type('form')
      .send({ method: 'rocket', account_number: newNum, status: 'active', _csrf: token });
    expect(res.status).toBe(302);
    const row = await pool.query('SELECT * FROM payment_methods WHERE id = $1', [created.id]);
    expect(row.rows[0].account_number).toBe(newNum);
    expect(row.rows[0].updated_by).toBe(admin.id);
  });

  test('activate/deactivate ডিলিট ছাড়াই কাজ করে', async () => {
    const created = await paymentMethods.create({ method: 'bkash', accountNumber: testNumber() }, admin.id);
    createdMethodIds.push(created.id);

    let token = await adminToken(admin.agent);
    await admin.agent.post(`/payment/admin/payment-methods/${created.id}/status`).type('form')
      .send({ status: 'inactive', _csrf: token });
    let row = await pool.query('SELECT status, deleted_at FROM payment_methods WHERE id = $1', [created.id]);
    expect(row.rows[0].status).toBe('inactive');
    expect(row.rows[0].deleted_at).toBeNull(); // সারিটা রয়ে গেছে

    token = await adminToken(admin.agent);
    await admin.agent.post(`/payment/admin/payment-methods/${created.id}/status`).type('form')
      .send({ status: 'active', _csrf: token });
    row = await pool.query('SELECT status FROM payment_methods WHERE id = $1', [created.id]);
    expect(row.rows[0].status).toBe('active');
  });

  test('ডিলিট soft — সারি থাকে কিন্তু আর দেখা যায় না', async () => {
    const created = await paymentMethods.create({ method: 'upay', accountNumber: testNumber() }, admin.id);
    createdMethodIds.push(created.id);
    const token = await adminToken(admin.agent);
    await admin.agent.post(`/payment/admin/payment-methods/${created.id}/delete`).type('form')
      .send({ _csrf: token });

    const row = await pool.query('SELECT status, deleted_at FROM payment_methods WHERE id = $1', [created.id]);
    expect(row.rows[0].deleted_at).not.toBeNull();
    expect(row.rows[0].status).toBe('inactive');
    expect(await paymentMethods.getById(created.id)).toBeNull();
  });

  test('প্রতিটা mutation audit log তৈরি করে (নম্বর masked অবস্থায়)', async () => {
    const num = testNumber();
    const token = await adminToken(admin.agent);
    await admin.agent.post('/payment/admin/payment-methods').type('form')
      .send({ method: 'bkash', account_number: num, status: 'active', _csrf: token });
    const row = await pool.query('SELECT id FROM payment_methods WHERE account_number = $1', [num]);
    createdMethodIds.push(row.rows[0].id);

    const log = await pool.query(
      `SELECT details FROM audit_logs
       WHERE action = 'PAYMENT_METHOD_CREATED' AND actor_id = $1
       ORDER BY id DESC LIMIT 1`,
      [admin.id]
    );
    expect(log.rows.length).toBe(1);
    const details = typeof log.rows[0].details === 'string'
      ? JSON.parse(log.rows[0].details) : log.rows[0].details;
    expect(details.recordId).toBe(row.rows[0].id);
    // পুরো নম্বর কখনো অডিটে যায় না
    expect(JSON.stringify(details)).not.toContain(num);
  });
});

// ==================== অথরাইজেশন ====================
describe('অথরাইজেশন', () => {
  test('guest অ্যাডমিন পেজে পৌঁছাতে পারে না', async () => {
    const res = await freshRequest().get('/payment/admin/payment-methods');
    expect([302, 403]).toContain(res.status);
    expect(res.status).not.toBe(200);
  });

  test('সাধারণ ইউজার অ্যাডমিন পেজ দেখতে পারে না', async () => {
    const user = await makeUser('pmusr');
    const res = await user.agent.get('/payment/admin/payment-methods');
    expect(res.status).not.toBe(200);
  });

  test('সাধারণ ইউজারের mutation প্রত্যাখ্যাত হয় এবং কিছুই তৈরি হয় না', async () => {
    const user = await makeUser('pmmut');
    const num = testNumber();
    const page = await user.agent.get('/payment/deposit');
    const token = extractCsrfToken(page.text);
    const res = await user.agent.post('/payment/admin/payment-methods').type('form')
      .send({ method: 'bkash', account_number: num, status: 'active', _csrf: token });
    expect(res.status).not.toBe(200);
    const row = await pool.query('SELECT 1 FROM payment_methods WHERE account_number = $1', [num]);
    expect(row.rows.length).toBe(0);
  });

  test('CSRF টোকেন ছাড়া অ্যাডমিন mutation আটকায়', async () => {
    const num = testNumber();
    const res = await admin.agent.post('/payment/admin/payment-methods').type('form')
      .send({ method: 'bkash', account_number: num, status: 'active' });
    expect(res.status).toBe(403);
    const row = await pool.query('SELECT 1 FROM payment_methods WHERE account_number = $1', [num]);
    expect(row.rows.length).toBe(0);
  });

  test('অস্তিত্বহীন ID-তে update/delete নীরবে কিছু বদলায় না (IDOR)', async () => {
    const before = await pool.query('SELECT COUNT(*)::int AS c FROM payment_methods');
    let token = await adminToken(admin.agent);
    await admin.agent.post('/payment/admin/payment-methods/99999999/update').type('form')
      .send({ method: 'bkash', account_number: testNumber(), _csrf: token });
    token = await adminToken(admin.agent);
    await admin.agent.post('/payment/admin/payment-methods/99999999/delete').type('form')
      .send({ _csrf: token });
    const after = await pool.query('SELECT COUNT(*)::int AS c FROM payment_methods');
    expect(after.rows[0].c).toBe(before.rows[0].c);
  });

  test('mass-assignment: ক্লায়েন্ট created_by/deleted_at override করতে পারে না', async () => {
    const num = testNumber();
    const token = await adminToken(admin.agent);
    await admin.agent.post('/payment/admin/payment-methods').type('form').send({
      method: 'bkash', account_number: num, status: 'active',
      created_by: 999999, updated_by: 999999, deleted_at: '2020-01-01', id: 123456,
      _csrf: token
    });
    const row = await pool.query('SELECT * FROM payment_methods WHERE account_number = $1', [num]);
    expect(row.rows.length).toBe(1);
    createdMethodIds.push(row.rows[0].id);
    expect(row.rows[0].created_by).toBe(admin.id); // ক্লায়েন্টের 999999 নয়
    expect(row.rows[0].deleted_at).toBeNull();
    expect(row.rows[0].id).not.toBe(123456);
  });
});

// ==================== ইউজার ডিপোজিট পেজ ====================
describe('ইউজার ডিপোজিট পেজ', () => {
  test('শুধু active মেথড API-তে আসে; inactive ও deleted বাদ', async () => {
    const activeNum = testNumber();
    const inactiveNum = testNumber();
    const deletedNum = testNumber();

    const a = await paymentMethods.create({ method: 'bkash', accountNumber: activeNum, status: 'active' }, admin.id);
    const i = await paymentMethods.create({ method: 'nagad', accountNumber: inactiveNum, status: 'inactive' }, admin.id);
    const d = await paymentMethods.create({ method: 'rocket', accountNumber: deletedNum, status: 'active' }, admin.id);
    createdMethodIds.push(a.id, i.id, d.id);
    await paymentMethods.remove(d.id, admin.id);

    const user = await makeUser('pmview');
    const res = await user.agent.get('/payment/deposit/methods');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const numbers = res.body.methods.map(m => m.accountNumber);
    expect(numbers).toContain(activeNum);
    expect(numbers).not.toContain(inactiveNum);
    expect(numbers).not.toContain(deletedNum);
  });

  test('পাবলিক পে-লোডে কোনো অ্যাডমিন/internal ফিল্ড যায় না', async () => {
    const user = await makeUser('pmpayload');
    const res = await user.agent.get('/payment/deposit/methods');
    for (const m of res.body.methods) {
      expect(Object.keys(m).sort()).toEqual(['accountName', 'accountNumber', 'id', 'method']);
    }
  });

  test('guest ডিপোজিট মেথড API পড়তে পারে না', async () => {
    const res = await freshRequest().get('/payment/deposit/methods');
    expect(res.status).not.toBe(200);
  });

  test('অ্যাডমিন নিষ্ক্রিয় করলে নম্বরটি সঙ্গে সঙ্গে ইউজারের তালিকা থেকে চলে যায়', async () => {
    const num = testNumber();
    const created = await paymentMethods.create({ method: 'bkash', accountNumber: num }, admin.id);
    createdMethodIds.push(created.id);

    const user = await makeUser('pmlive');
    let res = await user.agent.get('/payment/deposit/methods');
    expect(res.body.methods.map(m => m.accountNumber)).toContain(num);

    const token = await adminToken(admin.agent);
    await admin.agent.post(`/payment/admin/payment-methods/${created.id}/status`).type('form')
      .send({ status: 'inactive', _csrf: token });

    res = await user.agent.get('/payment/deposit/methods');
    expect(res.body.methods.map(m => m.accountNumber)).not.toContain(num);
  });

  test('ডিপোজিট পেজ রেন্ডার হয় এবং কোনো হার্ডকোড করা লিগ্যাসি নম্বর থাকে না', async () => {
    const user = await makeUser('pmpage');
    const res = await user.agent.get('/payment/deposit');
    expect(res.status).toBe(200);
    // আগে ভিউতে রোটেট হওয়া নম্বরগুলো সরাসরি বসানো হতো; এখন সব DB থেকে আসে।
    expect(res.text).not.toContain('depositRotation');
  });
});

// ==================== আর্থিক নিরাপত্তা ====================
describe('আর্থিক নিরাপত্তা — এই ফিচার টাকায় হাত দেয় না', () => {
  test('পেমেন্ট মেথড CRUD কোনো ইউজারের ব্যালেন্স বা payment_requests বদলায় না', async () => {
    const user = await makeUser('pmfin');
    await pool.query('UPDATE users SET coins = 500 WHERE id = $1', [user.id]);
    const beforeReq = await pool.query('SELECT COUNT(*)::int AS c FROM payment_requests');

    const created = await paymentMethods.create({ method: 'bkash', accountNumber: testNumber() }, admin.id);
    createdMethodIds.push(created.id);
    await paymentMethods.update(created.id, { accountNumber: testNumber(), status: 'inactive' }, admin.id);
    await paymentMethods.remove(created.id, admin.id);

    const coins = await pool.query('SELECT coins FROM users WHERE id = $1', [user.id]);
    expect(Number(coins.rows[0].coins)).toBe(500);
    const afterReq = await pool.query('SELECT COUNT(*)::int AS c FROM payment_requests');
    expect(afterReq.rows[0].c).toBe(beforeReq.rows[0].c);
  });

  test('মেথড মুছে ফেললেও ঐতিহাসিক ডিপোজিট তার নিজের method/account ধরে রাখে', async () => {
    const user = await makeUser('pmhist');
    const num = testNumber();
    const created = await paymentMethods.create({ method: 'bkash', accountNumber: num }, admin.id);
    createdMethodIds.push(created.id);

    const trx = 'PMTEST' + Date.now();
    const ins = await pool.query(
      `INSERT INTO payment_requests (user_id, type, method, amount, transaction_id, account_number, status)
       VALUES ($1,'deposit','bkash',500,$2,$3,'pending') RETURNING id`,
      [user.id, trx, num]
    );
    await paymentMethods.remove(created.id, admin.id);

    const row = await pool.query('SELECT method, account_number FROM payment_requests WHERE id = $1', [ins.rows[0].id]);
    expect(row.rows[0].method).toBe('bkash');
    expect(row.rows[0].account_number).toBe(num);
    await pool.query('DELETE FROM payment_requests WHERE id = $1', [ins.rows[0].id]);
  });
});
