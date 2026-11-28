// services/supportReports.js
// লাইভ চ্যাট শুরুর আগের ক্যাটাগরি মেনু ও ডিপোজিট/উইথড্র সমস্যার ফর্ম।
// ফর্মের তথ্য support_reports টেবিলে জমা হয়, চ্যাটে ইউজারের মেসেজ হিসেবেও বসে
// (ইউজার ও অ্যাডমিন দুজনেই দেখে), এবং নির্দিষ্ট ফরম্যাটে অ্যাডমিনের Telegram-এ যায়।
const { pool } = require('../db');
const { tzOffsetMinutes } = require('../utils/businessTime');

// form: true হলে চ্যাটের আগে তথ্য-ফর্ম আসে; required-এর ফিল্ডগুলো ছাড়া জমা হয় না।
// উইথড্রয় টাকা না পৌঁছালে ইউজারের কাছে প্রেরকের নম্বর/TrxID থাকে না, তাই সেগুলো ঐচ্ছিক।
const CATEGORIES = {
  deposit: { labelKey: 'chat_deposit_issue', adminLabel: 'জমার সমস্যা', icon: '💳', form: true,
    required: ['senderNumber', 'receiverNumber', 'transactionId', 'occurredAt'], proofRequired: true },
  withdraw: { labelKey: 'chat_withdraw_issue', adminLabel: 'উত্তোলনের সমস্যা', icon: '💵', form: true,
    required: ['receiverNumber', 'occurredAt'], proofRequired: true },
  bonus: { labelKey: 'chat_bonus_issue', adminLabel: 'বোনাস সমস্যা', icon: '🎁' },
  login: { labelKey: 'chat_login_issue', adminLabel: 'লগইন সমস্যা', icon: '🔑' },
  kyc: { labelKey: 'chat_kyc_issue', adminLabel: 'KYC ভেরিফিকেশন', icon: '🪪' },
  ticket: { labelKey: 'chat_ticket_issue', adminLabel: 'টিকেট ইস্যু', icon: '🎫' },
  football: { labelKey: 'chat_football_issue', adminLabel: 'ফুটবল ইস্যু', icon: '⚽' },
  other: { labelKey: 'chat_other_issue', adminLabel: 'অন্যান্য সমস্যা', icon: '🎧' }
};

const FIELD_LABEL_KEYS = {
  senderNumber: 'chat_report_sender',
  receiverNumber: 'chat_report_receiver',
  transactionId: 'chat_report_trx',
  occurredAt: 'chat_report_time'
};

const NUMBER_RE = /^\+?\d{6,20}$/;
const TRX_RE = /^[A-Za-z0-9_-]{4,40}$/;
const TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const DUPLICATE_WINDOW_MIN = 10;

const getCategory = (key) =>
  (typeof key === 'string' && Object.prototype.hasOwnProperty.call(CATEGORIES, key)) ? CATEGORIES[key] : null;

/** বাংলা অঙ্ক → ইংরেজি অঙ্ক, দুই পাশের ফাঁকা বাদ। string ছাড়া সবকিছু খালি ধরা হয়। */
const toAscii = (v) => (typeof v === 'string'
  ? v.replace(/[০-৯]/g, (d) => String(d.charCodeAt(0) - 0x09E6)).trim()
  : '');

/** 'YYYY-MM-DDTHH:mm' (ব্যবসায়িক টাইমজোনের ঘড়ি) → 'YYYY-MM-DD HH:mm', অবৈধ হলে null। */
function parseOccurredAt(value, now = new Date()) {
  const m = TIME_RE.exec(value);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const asUtc = new Date(Date.UTC(y, mo - 1, d, h, mi));
  // 31 ফেব্রুয়ারির মতো তারিখ Date নিজে গড়িয়ে দেয় — তাই মিলিয়ে দেখা
  if (y < 2020 || asUtc.toISOString().slice(0, 16) !== value) return null;
  // ভবিষ্যতের সময় গ্রহণ করা হয় না (ঘড়ির সামান্য গরমিলের জন্য ১ ঘণ্টা ছাড়)
  const businessNow = now.getTime() + tzOffsetMinutes(now) * 60 * 1000;
  if (asUtc.getTime() > businessNow + 60 * 60 * 1000) return null;
  return value.replace('T', ' ');
}

/**
 * @returns {{ ok: true, category: string, data: object } | { ok: false, field: string }}
 */
function validateReport(body = {}) {
  const category = getCategory(body.category);
  if (!category || !category.form) return { ok: false, field: 'category' };

  const raw = {
    senderNumber: toAscii(body.senderNumber).replace(/[\s-]/g, ''),
    receiverNumber: toAscii(body.receiverNumber).replace(/[\s-]/g, ''),
    transactionId: toAscii(body.transactionId),
    occurredAt: toAscii(body.occurredAt)
  };
  const data = {};
  for (const [field, value] of Object.entries(raw)) {
    if (!value) {
      if (category.required.includes(field)) return { ok: false, field };
      data[field] = null;
      continue;
    }
    if (field === 'occurredAt') data[field] = parseOccurredAt(value);
    else if (field === 'transactionId') data[field] = TRX_RE.test(value) ? value : null;
    else data[field] = NUMBER_RE.test(value) ? value : null;
    if (!data[field]) return { ok: false, field };
  }
  return { ok: true, category: body.category, data };
}

// প্রমাণ: কমপক্ষে ১টি স্ক্রিনশট (ছবি) ও ১টি ভিডিও বাধ্যতামূলক, সর্বোচ্চ MAX_PROOF_FILES টি ফাইল।
const MAX_PROOF_FILES = 4;

/** files: [{ fileType: 'image'|'video', ... }] → { ok } | { ok:false, field:'proofs', reason } */
function validateProofs(categoryKey, files) {
  const category = getCategory(categoryKey);
  if (!category || !category.proofRequired) return { ok: true };
  const list = Array.isArray(files) ? files : [];
  if (list.length > MAX_PROOF_FILES) return { ok: false, field: 'proofs', reason: 'too_many' };
  if (!list.some((f) => f.fileType === 'image')) return { ok: false, field: 'proofs', reason: 'screenshot_missing' };
  if (!list.some((f) => f.fileType === 'video')) return { ok: false, field: 'proofs', reason: 'video_missing' };
  return { ok: true };
}

/** চ্যাটে ইউজারের মেসেজ হিসেবে যে লেখাটা জমা হয়। */
function formatReportMessage(t, categoryKey, reportId, data, files = []) {
  const category = CATEGORIES[categoryKey];
  const lines = [`📋 ${t(category.labelKey)} (${t('chat_report_ref')} #R${reportId})`];
  for (const [field, labelKey] of Object.entries(FIELD_LABEL_KEYS)) {
    lines.push(`${t(labelKey)}: ${data[field] || '—'}`);
  }
  if (files.length) {
    const images = files.filter((f) => f.fileType === 'image').length;
    const videos = files.filter((f) => f.fileType === 'video').length;
    lines.push(`${t('chat_report_proof')}: 🖼 ${images} · 🎥 ${videos}`);
  }
  return lines.join('\n');
}

const nextStatus = (current) => (current === 'connected' ? 'connected' : 'waiting');

async function inTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** ইউজারের সারি লক করা হয়, যাতে একসাথে দুবার সাবমিটে দুটো রিপোর্ট না হয়। */
async function lockUser(client, userId) {
  const r = await client.query('SELECT support_status FROM users WHERE id = $1 FOR UPDATE', [userId]);
  if (!r.rows[0]) throw new Error('support user not found');
  return r.rows[0].support_status;
}

async function setStatus(client, userId, current) {
  const status = nextStatus(current);
  if (status !== current) {
    await client.query(
      'UPDATE users SET support_status = $2, support_status_updated_at = NOW() WHERE id = $1',
      [userId, status]
    );
  }
  return { status, statusChanged: status !== current };
}

async function insertUserMessage(client, userId, message) {
  const r = await client.query(
    `INSERT INTO chat_messages (sender_id, receiver_id, message, is_admin, created_at)
     VALUES ($1, NULL, $2, false, $3) RETURNING id, created_at`,
    [userId, message, new Date()]
  );
  return { id: r.rows[0].id, message, createdAt: r.rows[0].created_at };
}

/** ফর্মের রিপোর্ট জমা। একই তথ্য ১০ মিনিটের মধ্যে আবার এলে duplicate: true। */
async function createReport({ userId, category, data, t, files = [] }) {
  return inTransaction(async (client) => {
    const current = await lockUser(client, userId);
    const same = await client.query(
      `SELECT id FROM support_reports
        WHERE user_id = $1 AND category = $2
          AND sender_number IS NOT DISTINCT FROM $3 AND receiver_number IS NOT DISTINCT FROM $4
          AND transaction_id IS NOT DISTINCT FROM $5 AND occurred_at IS NOT DISTINCT FROM $6
          AND created_at > NOW() - ($7 || ' minutes')::interval
        LIMIT 1`,
      [userId, category, data.senderNumber, data.receiverNumber, data.transactionId, data.occurredAt,
        String(DUPLICATE_WINDOW_MIN)]
    );
    if (same.rows[0]) return { duplicate: true, reportId: same.rows[0].id, status: nextStatus(current) };

    const report = await client.query(
      `INSERT INTO support_reports (user_id, category, sender_number, receiver_number, transaction_id, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [userId, category, data.senderNumber, data.receiverNumber, data.transactionId, data.occurredAt]
    );
    const reportId = report.rows[0].id;
    for (const f of files) {
      await client.query(
        `INSERT INTO support_report_files (report_id, file_url, file_type, public_id, original_name, size_bytes)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [reportId, f.url, f.fileType, f.publicId || null, (f.originalName || '').slice(0, 255) || null, f.size || null]
      );
    }
    const chat = await insertUserMessage(client, userId, formatReportMessage(t, category, reportId, data, files));
    await client.query('UPDATE support_reports SET chat_message_id = $2 WHERE id = $1', [reportId, chat.id]);
    return { duplicate: false, reportId, chat, ...(await setStatus(client, userId, current)) };
  });
}

/** ফর্ম ছাড়া ক্যাটাগরি বেছে লাইভ এজেন্ট চাওয়া — বিষয়টা চ্যাটে বসে। */
async function startCategoryChat({ userId, category, t }) {
  const message = `📌 ${t('chat_report_topic')}: ${t(CATEGORIES[category].labelKey)}`;
  return inTransaction(async (client) => {
    const current = await lockUser(client, userId);
    const same = await client.query(
      `SELECT id FROM chat_messages
        WHERE sender_id = $1 AND is_admin = false AND message = $2 AND created_at > $3 LIMIT 1`,
      [userId, message, new Date(Date.now() - DUPLICATE_WINDOW_MIN * 60 * 1000)]
    );
    if (same.rows[0]) return { duplicate: true, ...(await setStatus(client, userId, current)) };
    const chat = await insertUserMessage(client, userId, message);
    return { duplicate: false, chat, ...(await setStatus(client, userId, current)) };
  });
}

/** এজেন্টের যাচাইয়ের জন্য: একটি রিপোর্টের সব প্রমাণ-ফাইল। */
async function getReportFiles(reportId) {
  const r = await pool.query(
    `SELECT id, file_url, file_type, original_name, size_bytes, created_at
       FROM support_report_files WHERE report_id = $1 ORDER BY id`, [reportId]);
  return r.rows;
}

module.exports = {
  CATEGORIES, MAX_PROOF_FILES, getCategory, validateReport, validateProofs, parseOccurredAt,
  formatReportMessage, createReport, startCategoryChat, getReportFiles
};
