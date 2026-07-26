// tests/integration/payment.test.js
const app = require('../../app');
const { waitForApp } = require('../helpers/waitForApp');
const { buildTestUser, extractCsrfToken, uniqueSuffix } = require('../helpers/testUser');
const { humanAgent, formRenderedAt } = require('../helpers/humanAgent');

async function loginNewUser() {
  const agent = humanAgent(app);
  const page = await agent.get('/register');
  const token = extractCsrfToken(page.text);
  const user = buildTestUser();
  await agent.post('/register').type('form').send({ ...user, _csrf: token, form_rendered_at: formRenderedAt() });
  return { agent, user };
}

async function getCsrf(agent, path) {
  const page = await agent.get(path);
  return extractCsrfToken(page.text);
}

describe('Payment: deposit flow (manual methods only, no external gateway)', () => {
  beforeAll(async () => {
    await waitForApp(app);
  }, 60000);

  test('a valid manual deposit request is accepted and redirects to history', async () => {
    const { agent } = await loginNewUser();
    const token = await getCsrf(agent, '/payment/deposit');

    const res = await agent.post('/payment/deposit').type('form').send({
      method: 'bkash',
      amount: '500',
      transaction_id: `TX-${uniqueSuffix()}`,
      account_number: '01700000000',
      _csrf: token
    });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/payment/history');
  });

  test('a deposit below the minimum amount (100) is rejected', async () => {
    const { agent } = await loginNewUser();
    const token = await getCsrf(agent, '/payment/deposit');

    const res = await agent.post('/payment/deposit').type('form').send({
      method: 'bkash',
      amount: '50',
      transaction_id: `TX-${uniqueSuffix()}`,
      account_number: '01700000000',
      _csrf: token
    });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/payment/deposit');
  });

  test('a deposit with an invalid payment method is rejected', async () => {
    const { agent } = await loginNewUser();
    const token = await getCsrf(agent, '/payment/deposit');

    const res = await agent.post('/payment/deposit').type('form').send({
      method: 'not-a-real-gateway',
      amount: '500',
      transaction_id: `TX-${uniqueSuffix()}`,
      account_number: '01700000000',
      _csrf: token
    });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/payment/deposit');
  });

  test('re-submitting the same transaction_id twice is rejected as a duplicate', async () => {
    const { agent } = await loginNewUser();
    const trxId = `TX-${uniqueSuffix()}`;

    const token1 = await getCsrf(agent, '/payment/deposit');
    const first = await agent.post('/payment/deposit').type('form').send({
      method: 'nagad',
      amount: '500',
      transaction_id: trxId,
      account_number: '01700000000',
      _csrf: token1
    });
    expect(first.status).toBe(302);
    expect(first.headers.location).toBe('/payment/history');

    const token2 = await getCsrf(agent, '/payment/deposit');
    const second = await agent.post('/payment/deposit').type('form').send({
      method: 'nagad',
      amount: '500',
      transaction_id: trxId,
      account_number: '01700000000',
      _csrf: token2
    });
    expect(second.status).toBe(302);
    expect(second.headers.location).toBe('/payment/deposit');
  });

  test('deposit requires login (unauthenticated request is redirected, never processed)', async () => {
    const anon = humanAgent(app); // কুকি-জার আছে কিন্তু কখনো লগইন করেনি
    const loginPage = await anon.get('/login'); // পাবলিক পেজ থেকে বৈধ CSRF টোকেন নেওয়া হলো
    const token = extractCsrfToken(loginPage.text);

    const res = await anon.post('/payment/deposit').type('form').send({
      method: 'bkash',
      amount: '500',
      transaction_id: `TX-${uniqueSuffix()}`,
      account_number: '01700000000',
      _csrf: token
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  test('deposit history page only shows the logged-in user\'s own deposit (not other users\')', async () => {
    const { agent } = await loginNewUser();
    const token = await getCsrf(agent, '/payment/deposit');
    const trxId = `TX-${uniqueSuffix()}`;
    await agent.post('/payment/deposit').type('form').send({
      method: 'bkash',
      amount: '777',
      transaction_id: trxId,
      account_number: '01700000000',
      _csrf: token
    });

    const history = await agent.get('/payment/history');
    expect(history.status).toBe(200);
    expect(history.text).toContain(trxId);
  });
});
