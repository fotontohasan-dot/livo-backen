// utils/adminUi.js
// ---------------------------------------------------------------------------
// অ্যাডমিন UI-এর ভাগ করা উপাদান (Phase 8 — UI Consistency)।
//
// সমস্যাটা ছিল: একই অর্থের স্ট্যাটাস ব্যাজ বিভিন্ন পেজে বিভিন্ন শেডে লেখা ছিল —
// `bg-emerald-100 text-emerald-700` (৩২ বার), `bg-emerald-100 text-emerald-600`
// (৫ বার), `bg-red-100 text-red-700` (২৯ বার) বনাম `text-red-600` (৫ বার),
// `bg-amber-*` বনাম `bg-yellow-*` ইত্যাদি। ফলে দুটো পেজ পাশাপাশি রাখলে "approved"
// দুই রকম দেখাত।
//
// এখানে সেমান্টিক টোন (success/danger/warning/info/neutral) একবার সংজ্ঞায়িত করা
// হলো, আর স্ট্যাটাস স্ট্রিংগুলো সেই টোনে ম্যাপ করা হলো।
//
// গুরুত্বপূর্ণ: ব্যাজে সবসময় টেক্সট থাকে, শুধু রঙ নয় (Phase 9 — অবস্থা বোঝাতে
// শুধু রঙের উপর নির্ভর করা যাবে না)।
// ---------------------------------------------------------------------------

const TONES = {
  success: 'bg-emerald-100 text-emerald-700',
  danger:  'bg-red-100 text-red-700',
  warning: 'bg-amber-100 text-amber-700',
  info:    'bg-blue-100 text-blue-700',
  neutral: 'bg-slate-100 text-slate-600'
};

// স্ট্যাটাস → সেমান্টিক টোন। কোডবেসে সত্যিই ব্যবহৃত স্ট্যাটাস স্ট্রিংগুলো
// (payment_requests, kyc_requests, matches, cron, backup, health) থেকে নেওয়া।
const STATUS_TONE = {
  // সফল / সক্রিয়
  approved: 'success', completed: 'success', active: 'success', success: 'success',
  healthy: 'success', settled: 'success', won: 'success', verified: 'success',
  enabled: 'success', running: 'success', connected: 'success',
  // ব্যর্থ / ঝুঁকি
  rejected: 'danger', failed: 'danger', failure: 'danger', error: 'danger',
  banned: 'danger', critical: 'danger', lost: 'danger', cancelled: 'danger',
  disabled: 'danger', stopped: 'danger',
  // অপেক্ষমাণ / সতর্কতা
  pending: 'warning', processing: 'warning', warning: 'warning', review: 'warning',
  // তথ্য
  info: 'info', open: 'info', new: 'info',
  // নিরপেক্ষ
  dismissed: 'neutral', closed: 'neutral', unknown: 'neutral', inactive: 'neutral'
};

const BASE = 'inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold';

function toneFor(status) {
  if (!status) return 'neutral';
  return STATUS_TONE[String(status).toLowerCase().trim()] || 'neutral';
}

/** স্ট্যাটাসের জন্য শুধু ক্লাস স্ট্রিং (বিদ্যমান মার্কআপে বসানোর জন্য)। */
function badgeClass(status) {
  return BASE + ' ' + TONES[toneFor(status)];
}

/**
 * সম্পূর্ণ ব্যাজ HTML। label না দিলে status-ই দেখানো হয়।
 * escape() কলার-কে দিতে হয় না — এখানেই করা হয়, কারণ status DB থেকে আসে।
 */
function statusBadge(status, label) {
  const text = label != null ? label : (status || 'unknown');
  return '<span class="' + badgeClass(status) + '">' + escapeHtml(text) + '</span>';
}

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** খালি অবস্থার একটা সামঞ্জস্যপূর্ণ ব্লক (Phase 8 — empty states)। */
function emptyState(message, icon) {
  return '<div class="py-12 text-center">' +
    '<i class="fas ' + (icon || 'fa-inbox') + ' text-3xl text-slate-300 mb-3"></i>' +
    '<p class="text-sm text-slate-500">' + escapeHtml(message) + '</p></div>';
}

module.exports = { TONES, STATUS_TONE, BASE, toneFor, badgeClass, statusBadge, emptyState, escapeHtml };
