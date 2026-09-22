/*
  ⚠️ এটা সম্পূর্ণ ফাইল নয় — শুধু পরিবর্তিত/যোগ হওয়া অংশ (fragment)।
  bk666 প্যাকেজে যেমন পূর্ণাঙ্গ ফাইল ছিল, এখানে সেটা সম্ভব হয়নি কারণ
  আপনার আসল routes/extra.js ফাইলটা আমাকে কখনো পুরোপুরি দেওয়া হয়নি —
  শুধু diff দেওয়া হয়েছিল। তাই নিচের অংশটুকু আপনার আসল ফাইলের সঠিক
  জায়গায় বসিয়ে দিতে হবে।
*/

// ---- ফাইলের উপরের দিকে, বাকি require() গুলোর সাথে যোগ করুন ----
const { buildUrl } = require('../utils/publicUrl');


// ---- GET /invitation রুটের ভেতরে ----

// আগে ছিল:
/*
        const { id, referral_code } = userResult.rows[0] || {};
        const referralCode = referral_code || 'N/A';
        const referrals = await pool.query('SELECT COUNT(*) FROM users WHERE referred_by_id = $1', [id]);
        res.render('extra/invitation', { referralCode, referralCount: parseInt(referrals.rows[0].count) });
*/

// এখন হবে:
        const { id, referral_code } = userResult.rows[0] || {};
        const referralCode = referral_code || 'N/A';
        const referrals = await pool.query('SELECT COUNT(*) FROM users WHERE referred_by_id = $1', [id]);
        const referralLink = buildUrl(req, `/register?ref=${encodeURIComponent(referralCode)}`);
        res.render('extra/invitation', { referralCode, referralLink, referralCount: parseInt(referrals.rows[0].count) });
