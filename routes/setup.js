// routes/setup.js
// ফোন থেকে শুধু ব্রাউজারে লিংক ভিজিট করে অ্যাডমিন বানানো ও ব্যাকআপ রিস্টোর করার জন্য
// SETUP_KEY env var দিয়ে সুরক্ষিত — এটা ছাড়া কেউ এই রুট ব্যবহার করতে পারবে না

const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { restoreFromBackup } = require('../services/backup');

function checkKey(req, res) {
  const key = process.env.SETUP_KEY;
  if (!key) {
    res.send('❌ SETUP_KEY env var সেট করা নেই। Render Environment-এ SETUP_KEY=একটা_গোপন_শব্দ যোগ করো।');
    return false;
  }
  if (req.query.key !== key) {
    res.send('❌ ভুল key। ?key=তোমার_SETUP_KEY যোগ করে আবার চেষ্টা করো।');
    return false;
  }
  return true;
}

// ব্রাউজারে ভিজিট করো: /setup/promote-admin?key=SETUP_KEY&username=তোমার_ইউজারনেম
router.get('/promote-admin', async (req, res) => {
  if (!checkKey(req, res)) return;
  const { username } = req.query;
  if (!username) return res.send('❌ ইউজারনেম দাও: ?username=xxx যোগ করো।');

  try {
    const result = await pool.query(
      `UPDATE users SET role='admin' WHERE username=$1 RETURNING id, username, role`,
      [username]
    );
    if (result.rowCount === 0) {
      return res.send(`❌ "${username}" নামে কোনো ইউজার পাওয়া যায়নি। আগে /register দিয়ে অ্যাকাউন্ট বানাও।`);
    }
    res.send(`✅ "${username}" এখন অ্যাডমিন! এখন লগইন করো — অ্যাডমিন প্যানেল অ্যাক্সেস পাবে।`);
  } catch (err) {
    res.send(`❌ সমস্যা হয়েছে: ${err.message}`);
  }
});

// ব্রাউজারে ভিজিট করো: /setup/restore-backup?key=SETUP_KEY
router.get('/restore-backup', async (req, res) => {
  if (!checkKey(req, res)) return;
  try {
    const results = await restoreFromBackup();
    const total = Object.values(results).reduce((a, b) => a + b, 0);
    res.send(`✅ রিস্টোর সম্পন্ন! মোট ${total} সারি ফিরে এসেছে।<br><pre>${JSON.stringify(results, null, 2)}</pre>`);
  } catch (err) {
    res.send(`❌ রিস্টোর ব্যর্থ: ${err.message}`);
  }
});

// ব্রাউজারে ভিজিট করো: /setup/backup-status?key=SETUP_KEY
router.get('/backup-status', async (req, res) => {
  if (!checkKey(req, res)) return;
  const { getBackupStatus } = require('../services/backup');
  res.json(getBackupStatus());
});

module.exports = router;
