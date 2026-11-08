// services/processRole.js
// ---------------------------------------------------------------------------
// PROCESS_ROLE — এই Node প্রসেসটা কোন দায়িত্ব পালন করবে।
//
//   all    (ডিফল্ট) → আগের মতোই: HTTP + Socket.IO + সব ব্যাকগ্রাউন্ড কাজ একই প্রসেসে।
//   web              → শুধু HTTP/Express/Socket.IO। কোনো ব্যাকগ্রাউন্ড consumer/timer নয়।
//   worker           → শুধু ব্যাকগ্রাউন্ড কাজ। কোনো HTTP listen বা Socket.IO সার্ভার নয়।
//
// ভুল মান দিলে নিঃশব্দে 'all'-এ নামা হয় না — স্পষ্ট এরর দিয়ে বুট বন্ধ হয়,
// যাতে টাইপো (যেমন "workers") থেকে ভুল টপোলজিতে ডিপ্লয় না হয়।
// ---------------------------------------------------------------------------

const VALID_ROLES = Object.freeze(['all', 'web', 'worker']);

function resolveProcessRole(env = process.env) {
  const raw = env.PROCESS_ROLE;
  const role = (raw === undefined || String(raw).trim() === '') ? 'all' : String(raw).trim().toLowerCase();
  if (!VALID_ROLES.includes(role)) {
    throw new Error(
      `Invalid PROCESS_ROLE "${raw}". Allowed values: ${VALID_ROLES.join(', ')} (default: all).`
    );
  }
  return {
    role,
    runsWeb: role === 'all' || role === 'web',
    runsWorker: role === 'all' || role === 'worker'
  };
}

module.exports = { resolveProcessRole, VALID_ROLES };
