// services/backup.js
// পুরনো ব্যাকআপ সিস্টেম — GitHub গন্তব্য বন্ধ করা হয়েছে।
//
// আগে এই মডিউল প্রতিদিন **পুরো ডাটাবেস** JSON করে GitHub রিপোজিটরির
// `db-backups/backup-latest.json`-এ কমিট করত। ওই ডাম্পে থাকত users, payment
// requests, KYC ডকুমেন্ট রেফারেন্স, coin ledger, TOTP সিক্রেট — অর্থাৎ পুরো
// প্রোডাকশন ডেটা, প্লেইনটেক্সটে, এবং Git ইতিহাসে স্থায়ীভাবে। রিপো বা টোকেন
// একবার ফাঁস হলেই পূর্ণ ডেটা ব্রিচ।
//
// এখন গন্তব্য হিসেবে GitHub সম্পূর্ণ সরানো হলো। ব্যাকআপের দায়িত্ব
// `services/backupManager.js`-এর — সেটি এনক্রিপ্টেড ফাইল হিসেবে
// BACKUP_DIR-এ লেখে, রিপোজিটরিতে কিছু পাঠায় না।
//
// এই ফাইলটি রাখা হয়েছে শুধু API সামঞ্জস্যের জন্য (app.js ও টেস্ট এখনো
// scheduleDailyBackup ইমপোর্ট করে)। প্রতিটি ফাংশন এখন fail-closed —
// নিঃশব্দে কিছু করে না, স্পষ্ট বার্তা দিয়ে backupManager-এ পাঠায়।

const DEPRECATION = 'services/backup.js এর GitHub ব্যাকআপ বন্ধ করা হয়েছে (ডেটা এক্সপোজার ঝুঁকি)। services/backupManager.js ব্যবহার করুন।';

let lastBackupAt = null;
let lastBackupError = DEPRECATION;

/**
 * আগে পুরো DB ডাম্প করে GitHub-এ কমিট করত। এখন কিছুই পাঠায় না।
 * ডাটাবেসও পড়ে না — ডাম্প তৈরি না করাই সবচেয়ে নিরাপদ।
 */
async function runBackupNow() {
  console.warn('backup skipped:', DEPRECATION);
  lastBackupError = DEPRECATION;
  return { ok: false, error: DEPRECATION, deprecated: true };
}

// প্রতি ২৪ ঘণ্টার শিডিউল। GitHub আপলোড আর হয় না, কিন্তু গার্ড ও unref
// আচরণ অপরিবর্তিত রাখা হয়েছে — একাধিকবার কল করলেও একটাই টাইমার তৈরি হয়
// এবং টাইমার ইভেন্ট লুপ আটকে রাখে না।
let dailyBackupHandle = null;
function scheduleDailyBackup() {
  if (dailyBackupHandle) return; // দুবার শিডিউল হওয়া ঠেকানো
  console.warn(DEPRECATION);
  const DAY_MS = 24 * 60 * 60 * 1000;
  const firstRun = setTimeout(runBackupNow, 5 * 60 * 1000);
  if (firstRun.unref) firstRun.unref();
  dailyBackupHandle = setInterval(runBackupNow, DAY_MS);
  if (dailyBackupHandle.unref) dailyBackupHandle.unref();
}

function getBackupStatus() {
  return { lastBackupAt, lastBackupError, configured: false, deprecated: true };
}

/** GitHub থেকে ডাম্প নামানো — বন্ধ। */
async function fetchLatestBackup() {
  throw new Error(DEPRECATION);
}

/** GitHub ডাম্প থেকে রিস্টোর — বন্ধ। */
async function restoreFromBackup() {
  throw new Error(DEPRECATION);
}

module.exports = { runBackupNow, scheduleDailyBackup, getBackupStatus, restoreFromBackup, fetchLatestBackup };
