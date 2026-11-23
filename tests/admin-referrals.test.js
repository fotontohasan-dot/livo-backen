const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('./helpers/app');
const { pool } = require('../db');
const rbac = require('../services/rbac');
const { createReferral } = require('../services/referral');
const { runEngine, makeDeposit } = require('./helpers/referralDeposit');
const engine = require('../services/referralRewards');

async function registerUser() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
    .send({ username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
  const row = (await pool.query('SELECT id FROM users WHERE username=$1', [username])).rows[0];
  return { agent, username, userId: row.id };
}

// registerUser() সব ইউজারকে একই টেস্ট-IP/ডিভাইসে বানায়। নতুন নিয়মে রেফারার ও রেফার-করা ইউজার একই IP/ডিভাইসে হলে
// বোনাস আটকে যায় (সেটার টেস্ট referralFirstDeposit.test.js-এ)। বোনাস-দেওয়ার পথ যাচাইয়ের টেস্টে বাস্তব দুই ইউজারের মতো
// আলাদা নেটওয়ার্ক দেখাতে রেফার-করা ইউজারের লগইন-IP/ডিভাইস আলাদা করা হয়।
async function separateNetwork(userId) {
  const tag = 'sep-' + userId;
  await pool.query('UPDATE login_logs SET ip = $2, device_fingerprint = $3 WHERE user_id = $1', [userId, '198.51.100.' + ((userId % 250) + 1), tag]);
  await pool.query('UPDATE device_sessions SET device_signature = $2 WHERE user_id = $1', [userId, tag]);
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
    await separateNetwork(referredId);
    await createReferral(null, referrerId, referredId);

    await runEngine(referredId, 1000); // ≥ ন্যূনতম ডিপোজিট (৫০০)

    const { agent } = await makeAdminAgent();
    const res = await agent.get('/admin/referrals');
    expect(res.status).toBe(200);
    expect(res.text).toContain(referrerUsername);
    expect(res.text).toContain(referredUsername);
    expect(res.text).toContain('বোনাস প্রদত্ত');

    const dbRow = await pool.query('SELECT first_deposit_done FROM referrals WHERE referrer_id=$1 AND referred_id=$2', [referrerId, referredId]);
    expect(dbRow.rows[0].first_deposit_done).toBe(true);
    const rwRow = await pool.query('SELECT status FROM referral_rewards WHERE referred_user_id=$1', [referredId]);
    expect(rwRow.rows[0].status).toBe('paid');
  });

  test('ন্যূনতম (১০০)-র কম ডিপোজিটে বোনাস দেওয়া হয় না, পেজে "পেন্ডিং" দেখায়', async () => {
    const { userId: referrerId } = await registerUser();
    const { userId: referredId, username: referredUsername } = await registerUser();
    await createReferral(null, referrerId, referredId);

    await runEngine(referredId, 99); // < ন্যূনতম ডিপোজিট (১০০)

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
    await separateNetwork(paidReferredId);
    await createReferral(null, paidReferrerId, paidReferredId);
    await runEngine(paidReferredId, 1000);

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

  test('একই রেফার্ড ইউজারের দুইটা সমসাময়িক (concurrent) qualifying ডিপোজিট রেফারারকে মাত্র একবারই signup বোনাস দেয়', async () => {
    const { userId: referrerId } = await registerUser();
    const { userId: referredId } = await registerUser();
    await separateNetwork(referredId);
    await createReferral(null, referrerId, referredId);

    const before = await pool.query('SELECT coins FROM users WHERE id=$1', [referrerId]);
    const coinsBefore = Number(before.rows[0].coins);

    // দুইটা আলাদা connection, প্রতিটা নিজের সম্পূর্ণ BEGIN..COMMIT transaction-এ — যেমন
    // admin bulk-approve, SSLCommerz success-redirect ও IPN callback প্রতিটা নিজের সম্পূর্ণ
    // transaction-এ processReferralDeposit ডাকে (creditApprovedDeposit-এর মতো)
    // V2: প্রতিটা ডিপোজিটের জন্য আলাদা ইঞ্জিন-ট্রানজ্যাকশন (আলাদা connection)
    const dep1 = await makeDeposit(referredId, 1000, { status: 'approved' });
    const dep2 = await makeDeposit(referredId, 1500, { status: 'approved' });
    await Promise.all([
      engine.processReferralReward(referredId, dep1),
      engine.processReferralReward(referredId, dep2)
    ]);

    const after = await pool.query('SELECT coins FROM users WHERE id=$1', [referrerId]);
    const coinsAfter = Number(after.rows[0].coins);
    // দুটো ডিপোজিটই ৫০০+ ধাপে (বোনাস ৭৫) — বোনাস একবারই; দুইবার দিলে ১৫০ হতো
    expect(coinsAfter - coinsBefore).toBe(75);

    const refRow = await pool.query('SELECT status FROM referral_rewards WHERE referrer_id=$1 AND referred_user_id=$2', [referrerId, referredId]);
    expect(refRow.rows).toHaveLength(1);
    expect(refRow.rows[0].status).toBe('paid');

    const commissionCount = await pool.query(
      `SELECT COUNT(*) FROM referral_commissions WHERE earner_id=$1 AND from_user_id=$2 AND reason='first_deposit'`,
      [referrerId, referredId]
    );
    expect(parseInt(commissionCount.rows[0].count)).toBe(1);
  });
});
