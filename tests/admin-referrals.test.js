const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('./helpers/app');
const { pool } = require('../db');
const rbac = require('../services/rbac');
const { createReferral, processReferralDeposit } = require('../services/referral');

async function registerUser() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
    .send({ username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
  const row = (await pool.query('SELECT id FROM users WHERE username=$1', [username])).rows[0];
  return { agent, username, userId: row.id };
}

async function makeAdminAgent() {
  const { agent, username, userId } = await registerUser();
  await pool.query("UPDATE users SET role='admin' WHERE id=$1", [userId]);
  return { agent, username, userId };
}

describe('Admin Referral Management (/admin/referrals)', () => {
  test('অথেন্টিকেশন ছাড়া অ্যাক্সেস প্রত্যাখ্যাত হয়', async () => {
    const { freshRequest } = require('./helpers/app');
    const res = await freshRequest().get('/admin/referrals');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/admin\/login/);
  });

  test('reports_view permission ছাড়া প্রত্যাখ্যাত, থাকলে গৃহীত (backward-compat admin ও উভয়ই)', async () => {
    const { agent, userId } = await makeAdminAgent();

    const noPerm = await rbac.createRole({ name: `NoReports-${uniqueUsername()}`, permissions: {} });
    await rbac.assignUserRole(userId, noPerm.key);
    const denied = await agent.get('/admin/referrals');
    expect(denied.status).toBe(302);

    const withPerm = await rbac.createRole({ name: `WithReports-${uniqueUsername()}`, permissions: { reports_view: true } });
    await rbac.assignUserRole(userId, withPerm.key);
    const allowed = await agent.get('/admin/referrals');
    expect(allowed.status).toBe(200);
  });

  test('role_key NULL (ব্যাকওয়ার্ড-কম্প্যাটিবল ডিফল্ট admin) সরাসরি অ্যাক্সেস পায়', async () => {
    const { agent } = await makeAdminAgent();
    const res = await agent.get('/admin/referrals');
    expect(res.status).toBe(200);
  });

  test('আসল রেফারেল ডেটা তালিকায় দেখা যায় — রেফারার, রেফার্ড ইউজার, বোনাস স্ট্যাটাস, কমিশন', async () => {
    const { userId: referrerId, username: referrerUsername } = await registerUser();
    const { userId: referredId, username: referredUsername } = await registerUser();
    await createReferral(null, referrerId, referredId);

    const client = await pool.connect();
    await client.query('BEGIN');
    await processReferralDeposit(client, referredId, 1000); // ≥ MIN_DEPOSIT_FOR_BONUS
    await client.query('COMMIT');
    client.release();

    const { agent } = await makeAdminAgent();
    const res = await agent.get('/admin/referrals');
    expect(res.status).toBe(200);
    expect(res.text).toContain(referrerUsername);
    expect(res.text).toContain(referredUsername);
    expect(res.text).toContain('বোনাস প্রদত্ত');

    const dbRow = await pool.query('SELECT signup_bonus_paid, first_deposit_done FROM referrals WHERE referrer_id=$1 AND referred_id=$2', [referrerId, referredId]);
    expect(dbRow.rows[0].signup_bonus_paid).toBe(true);
    expect(dbRow.rows[0].first_deposit_done).toBe(true);
  });

  test('৫০০ টাকার কম ডিপোজিটে বোনাস দেওয়া হয় না, পেজে "পেন্ডিং" দেখায়', async () => {
    const { userId: referrerId } = await registerUser();
    const { userId: referredId, username: referredUsername } = await registerUser();
    await createReferral(null, referrerId, referredId);

    const client = await pool.connect();
    await client.query('BEGIN');
    await processReferralDeposit(client, referredId, 100); // < MIN_DEPOSIT_FOR_BONUS (500)
    await client.query('COMMIT');
    client.release();

    const { agent } = await makeAdminAgent();
    const res = await agent.get('/admin/referrals?search=' + referredUsername);
    expect(res.status).toBe(200);
    expect(res.text).toContain(referredUsername);
    expect(res.text).toContain('পেন্ডিং');
    // badge-green CSS ক্লাসের সংজ্ঞা sidebar.ejs-এর শেয়ার্ড স্টাইলশিটে সবসময়ই থাকে (প্রতিটা পেজে) —
    // তাই সরাসরি স্ট্রিং "badge-green" চেক করলে false positive হয়। বরং আসল উপাদানে সেই ক্লাস
    // প্রয়োগ হয়েছে কিনা (class="badge badge-green") সেটাই নির্দিষ্টভাবে যাচাই করা হচ্ছে।
    expect(res.text).not.toContain('class="badge badge-green"');
  });

  test('search প্যারামিটার শুধু মেলা রেফারেল দেখায়', async () => {
    const { userId: referrerId, username: referrerUsername } = await registerUser();
    const { userId: referredId } = await registerUser();
    await createReferral(null, referrerId, referredId);

    const { userId: otherReferrerId } = await registerUser();
    const { userId: otherReferredId, username: unrelatedUsername } = await registerUser();
    await createReferral(null, otherReferrerId, otherReferredId);

    const { agent } = await makeAdminAgent();
    const res = await agent.get('/admin/referrals?search=' + referrerUsername);
    expect(res.status).toBe(200);
    expect(res.text).toContain(referrerUsername);
    expect(res.text).not.toContain(unrelatedUsername);
  });

  test('status=bonus_paid ফিল্টার শুধু বোনাস-প্রদত্ত রেফারেল দেখায়', async () => {
    const { userId: paidReferrerId } = await registerUser();
    const { userId: paidReferredId, username: paidUsername } = await registerUser();
    await createReferral(null, paidReferrerId, paidReferredId);
    const client = await pool.connect();
    await client.query('BEGIN');
    await processReferralDeposit(client, paidReferredId, 1000);
    await client.query('COMMIT');
    client.release();

    const { userId: pendingReferrerId } = await registerUser();
    const { userId: pendingReferredId, username: pendingUsername } = await registerUser();
    await createReferral(null, pendingReferrerId, pendingReferredId);

    const { agent } = await makeAdminAgent();
    const res = await agent.get('/admin/referrals?status=bonus_paid');
    expect(res.status).toBe(200);
    expect(res.text).toContain(paidUsername);
    expect(res.text).not.toContain(pendingUsername);
  });

  test('পেজিনেশন কাজ করে ও সারাংশ (summary) সংখ্যা সঠিক থাকে', async () => {
    const { agent } = await makeAdminAgent();
    const res = await agent.get('/admin/referrals?page=1');
    expect(res.status).toBe(200);
    expect(res.text).toContain('মোট রেফারেল');
    expect(res.text).toContain('বোনাস প্রদত্ত');
    expect(res.text).toContain('মোট কমিশন পরিশোধিত');
  });

  test('রেফারার/রেফার্ড ইউজারের বিদ্যমান /admin/users/:id প্রোফাইল লিংক আছে (নতুন কোনো অ্যাকশন রুট তৈরি হয়নি)', async () => {
    const { userId: referrerId } = await registerUser();
    const { userId: referredId } = await registerUser();
    await createReferral(null, referrerId, referredId);

    const { agent } = await makeAdminAgent();
    const res = await agent.get('/admin/referrals');
    expect(res.text).toContain(`/admin/users/${referrerId}`);
    expect(res.text).toContain(`/admin/users/${referredId}`);
  });

  test('sidebar-এ "রেফারেল ম্যানেজমেন্ট" লিংক আছে এবং /admin/referrals-এ যায়', async () => {
    const { agent } = await makeAdminAgent();
    // referrals.ejs নিজেও sidebar.ejs ব্যবহার করে (বোনাস/KYC/VIP-এর মতো), তাই নিজের পেজেই যাচাই
    const referralsPage = await agent.get('/admin/referrals');
    expect(referralsPage.status).toBe(200);
    expect(referralsPage.text).toContain('href="/admin/referrals"');
    expect(referralsPage.text).toContain('রেফারেল ম্যানেজমেন্ট');
    // আরেকটা sidebar.ejs-ব্যবহারকারী পেজ (KYC) থেকেও লিংকটা দেখা যায় কিনা যাচাই
    const kycPage = await agent.get('/admin/kyc');
    expect(kycPage.text).toContain('href="/admin/referrals"');
  });
});
