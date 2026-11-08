// services/processRole.js
// ---------------------------------------------------------------------------
// PROCESS_ROLE রেজল্ভার। এই ফাইলটা কোনো I/O করে না, কোনো service require করে না।
//
//   all    → (ডিফল্ট) পুরোনো ডিপ্লয়মেন্টের মতোই: web + background একই প্রসেসে
//   web    → HTTP + Socket.IO + user-facing; কোনো background consumer/timer নয়
//   worker → শুধু background কাজ; কোনো HTTP listener / Socket.IO নয়
//
// PROCESS_ROLE সেট না থাকলে `all`। সেট থাকলে (খালি স্ট্রিং সহ) অবশ্যই বৈধ হতে হবে;
// ভুল মান নীরবে `all`-এ ধরা হয় না, কারণ তাতে ভুল প্রসেসে scheduler চালু হয়ে যেতে পারে।
// ---------------------------------------------------------------------------

const VALID_ROLES = Object.freeze(['all', 'web', 'worker']);

function resolveProcessRole(env = process.env) {
  const raw = env.PROCESS_ROLE;
  if (raw === undefined) return 'all';
  const role = String(raw).trim().toLowerCase();
  if (!VALID_ROLES.includes(role)) {
    throw new Error(
      `অবৈধ PROCESS_ROLE="${raw}" — অনুমোদিত মান: ${VALID_ROLES.join(', ')} (সেট না থাকলে "all")`
    );
  }
  return role;
}

const runsWeb = (role) => role === 'all' || role === 'web';
const runsWorker = (role) => role === 'all' || role === 'worker';

module.exports = { VALID_ROLES, resolveProcessRole, runsWeb, runsWorker };
