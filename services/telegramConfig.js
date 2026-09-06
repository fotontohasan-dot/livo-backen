// services/telegramConfig.js
// ---------------------------------------------------------------------------
// Telegram ইন্টিগ্রেশনের কনফিগারেশন লেয়ার — Admin প্যানেল (routes/adminTelegram.js) থেকে
// সেট করা bot token / chat id / notification টগলগুলো এখানে রাখা ও পড়া হয়।
//
// ডিজাইন নীতি:
//  1) বিদ্যমান .env-ভিত্তিক কনফিগ (TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_CHAT_ID,
//     TELEGRAM_CHAT_ID) হুবহু আগের মতোই কাজ করতে থাকে। DB-তে কিছু সেভ করা না থাকলে
//     env-ই ব্যবহার হয় এবং notification আগের মতোই যায় (enabled-এর ডিফল্ট true)।
//  2) Bot token কখনো plaintext-এ DB-তে যায় না — AES-256-GCM দিয়ে এনক্রিপ্ট করে
//     রাখা হয় (services/backupManager.js-এর মতোই প্যাটার্ন), আর কখনো কোনো
//     view/API response/লগে ফেরত যায় না — শুধু masked hint (••••1234)।
//  3) db শুধু দরকারের সময় lazy-require করা হয়, যাতে pure helper গুলো (mask/validate/
//     shouldNotify) DB ছাড়াই ইউনিট-টেস্ট করা যায়।
// ---------------------------------------------------------------------------

const { fetchWithTimeout } = require('../utils/httpClient');
const crypto = require('crypto');

const CATEGORIES = ['deposit', 'withdraw', 'support', 'security', 'system'];

const CATEGORY_LABELS = {
  deposit: 'ডিপোজিট রিকোয়েস্ট',
  withdraw: 'উইথড্র রিকোয়েস্ট',
  support: 'সাপোর্ট মেসেজ',
  security: 'সিকিউরিটি অ্যালার্ট',
  system: 'সিস্টেম হেলথ অ্যালার্ট'
};

const DEFAULT_CATEGORIES = { deposit: true, withdraw: true, support: true, security: true, system: true };

const MEM_CACHE_MS = 15 * 1000;
let memCache = null;
let memLastFetch = 0;

// ==================== এনক্রিপশন ====================
// আলাদা কী না থাকলে ধাপে ধাপে ফলব্যাক — শেষ ফলব্যাক SESSION_SECRET, যা প্রোডাকশনে
// সবসময় সেট থাকে (services/envValidator.js এটা বাধ্যতামূলক করে)।
function rawEncryptionKey() {
  return (
    process.env.TELEGRAM_SETTINGS_KEY ||
    process.env.SETTINGS_ENCRYPTION_KEY ||
    process.env.BACKUP_ENCRYPTION_KEY ||
    process.env.SESSION_SECRET ||
    ''
  );
}

function getEncryptionKey() {
  const raw = rawEncryptionKey();
  if (!raw) return null;
  // যেকোনো দৈর্ঘ্যের কী থেকে ডিটার্মিনিস্টিক ৩২ বাইট
  return crypto.createHash('sha256').update(String(raw)).digest();
}

function isEncryptionAvailable() {
  return !!getEncryptionKey();
}

/** plaintext -> "v1:<iv>:<authTag>:<ciphertext>" (সবগুলো base64) */
function encryptSecret(plain) {
  const key = getEncryptionKey();
  if (!key) throw new Error('এনক্রিপশন কী পাওয়া যায়নি — TELEGRAM_SETTINGS_KEY (বা SESSION_SECRET) সেট করুন।');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}

/** encryptSecret()-এর বিপরীত। কী বদলে গেলে/ডেটা করাপ্ট হলে null (throw করে না)। */
function decryptSecret(packed) {
  if (!packed || typeof packed !== 'string') return null;
  const key = getEncryptionKey();
  if (!key) return null;
  const parts = packed.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  try {
    const iv = Buffer.from(parts[1], 'base64');
    const authTag = Buffer.from(parts[2], 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()]).toString('utf8');
  } catch (e) {
    console.error('telegramConfig: token ডিক্রিপ্ট করা যায়নি (কী পরিবর্তিত হয়েছে?)');
    return null;
  }
}

// ==================== Pure helpers (UI + ভ্যালিডেশন) ====================

/** টোকেন কখনো পুরো দেখানো হয় না — শুধু bot-id প্রিফিক্স ও শেষ ৪ ক্যারেক্টার। */
function maskToken(token) {
  if (!token || typeof token !== 'string') return '';
  const t = token.trim();
  const sep = t.indexOf(':');
  const tail = t.slice(-4);
  if (sep > 0) return `${t.slice(0, sep)}:••••••••${tail}`;
  if (t.length <= 8) return '••••••••';
  return `••••••••${tail}`;
}

/** Telegram bot token ফরম্যাট: <bot_id>:<35 char secret> */
function isValidBotToken(token) {
  if (!token || typeof token !== 'string') return false;
  return /^\d{6,12}:[A-Za-z0-9_-]{30,50}$/.test(token.trim());
}

/** chat id: numeric (গ্রুপের ক্ষেত্রে negative, supergroup -100...) অথবা @channelusername */
function isValidChatId(chatId) {
  if (chatId === null || chatId === undefined) return false;
  const v = String(chatId).trim();
  if (!v) return false;
  if (/^-?\d{1,20}$/.test(v)) return true;
  return /^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(v);
}

/** req.body থেকে আসা categories কে নিরাপদ boolean map-এ নরমালাইজ করে (অজানা কী বাদ)। */
function normalizeCategories(input) {
  const out = { ...DEFAULT_CATEGORIES };
  if (!input || typeof input !== 'object') return out;
  for (const key of CATEGORIES) {
    if (!(key in input)) { out[key] = false; continue; }
    const raw = Array.isArray(input[key]) ? input[key][input[key].length - 1] : input[key];
    out[key] = raw === true || raw === 'true' || raw === 'on' || raw === '1' || raw === 1;
  }
  return out;
}

/**
 * একটা নোটিফিকেশন আসলে পাঠানো হবে কিনা — routes/services থেকে ব্যবহারযোগ্য pure সিদ্ধান্ত।
 * category না দিলে (legacy কল) শুধু enabled + credential চেক হয়।
 */
function shouldNotify(config, category) {
  if (!config) return false;
  if (!config.enabled) return false;
  if (!config.botToken || !config.chatId) return false;
  if (!category) return true;
  if (!CATEGORIES.includes(category)) return true; // অচেনা category ব্লক করা হয় না (backward compatible)
  const cats = config.categories || DEFAULT_CATEGORIES;
  return cats[category] !== false;
}

// ==================== DB লেয়ার ====================
function db() {
  return require('../db').pool;
}

function envConfig() {
  return {
    botToken: process.env.TELEGRAM_BOT_TOKEN || null,
    chatId: process.env.TELEGRAM_ADMIN_CHAT_ID || process.env.TELEGRAM_CHAT_ID || null
  };
}

async function readRow() {
  try {
    const r = await db().query('SELECT * FROM telegram_settings WHERE id = 1');
    return r.rows[0] || null;
  } catch (e) {
    // টেবিল না থাকলে (migration চলার আগে) env-ভিত্তিক আচরণে ফলব্যাক — কিছুই ভাঙে না
    console.error('telegramConfig: telegram_settings পড়া যায়নি:', e.message);
    return null;
  }
}

/**
 * পূর্ণ কনফিগ (botToken সহ) — শুধু সার্ভার-সাইড ব্যবহারের জন্য।
 * কখনো সরাসরি res.json()/render()-এ পাঠানো যাবে না; সেজন্য getStatus() আছে।
 */
async function getConfig({ force = false } = {}) {
  if (!force && memCache && Date.now() - memLastFetch < MEM_CACHE_MS) return memCache;

  const env = envConfig();
  const row = await readRow();

  const dbToken = row && row.bot_token_enc ? decryptSecret(row.bot_token_enc) : null;
  const botToken = dbToken || env.botToken || null;
  const chatId = (row && row.chat_id) || env.chatId || null;

  const config = {
    // row না থাকলে (নতুন ইনস্টল/আপগ্রেড) আগের আচরণ অক্ষুণ্ণ রাখতে ডিফল্ট enabled = true
    enabled: row ? row.enabled !== false : true,
    botToken,
    chatId,
    categories: row && row.categories ? { ...DEFAULT_CATEGORIES, ...row.categories } : { ...DEFAULT_CATEGORIES },
    tokenSource: dbToken ? 'database' : (env.botToken ? 'env' : 'none'),
    chatIdSource: row && row.chat_id ? 'database' : (env.chatId ? 'env' : 'none'),
    lastTestAt: row ? row.last_test_at : null,
    lastTestStatus: row ? row.last_test_status : null,
    lastTestError: row ? row.last_test_error : null,
    lastTestBot: row ? row.last_test_bot : null,
    updatedAt: row ? row.updated_at : null,
    updatedByUsername: row ? row.updated_by_username : null,
    configuredInDb: !!row
  };

  memCache = config;
  memLastFetch = Date.now();
  return config;
}

/** Admin UI/API-তে দেখানোর জন্য নিরাপদ অবজেক্ট — bot token কখনো এখানে থাকে না। */
async function getStatus() {
  const c = await getConfig();
  const { botToken, ...rest } = c;
  return {
    ...rest,
    tokenSet: !!botToken,
    tokenMasked: maskToken(botToken),
    encryptionAvailable: isEncryptionAvailable(),
    ready: !!(botToken && c.chatId),
    active: shouldNotify(c),
    webhookSecretSet: !!process.env.TELEGRAM_WEBHOOK_SECRET
  };
}

function invalidateCache() {
  memCache = null;
  memLastFetch = 0;
}

async function ensureRow() {
  await db().query(
    `INSERT INTO telegram_settings (id, enabled, categories) VALUES (1, true, $1::jsonb) ON CONFLICT (id) DO NOTHING`,
    [JSON.stringify(DEFAULT_CATEGORIES)]
  );
}

/**
 * সেটিংস সেভ। patch-এ botToken থাকলে সেটা এনক্রিপ্ট করে রাখা হয়;
 * botToken === null দিলে DB-র টোকেন মুছে env ফলব্যাকে ফিরে যায়।
 * রিটার্ন: কোন কোন ফিল্ড বদলেছে (audit log-এ ব্যবহারের জন্য — কোনো secret ভ্যালু থাকে না)।
 */
async function saveConfig(patch = {}, actor = {}) {
  await ensureRow();
  const before = await getConfig({ force: true });
  const sets = [];
  const values = [];
  const changed = [];
  let i = 1;

  if ('enabled' in patch) {
    sets.push(`enabled = $${i++}`); values.push(!!patch.enabled);
    if (!!patch.enabled !== before.enabled) changed.push('enabled');
  }
  if ('chatId' in patch) {
    const v = patch.chatId ? String(patch.chatId).trim() : null;
    sets.push(`chat_id = $${i++}`); values.push(v);
    if (v !== (before.configuredInDb ? before.chatId : null)) changed.push('chat_id');
  }
  if ('categories' in patch) {
    const cats = normalizeCategories(patch.categories);
    sets.push(`categories = $${i++}::jsonb`); values.push(JSON.stringify(cats));
    if (JSON.stringify(cats) !== JSON.stringify(before.categories)) changed.push('categories');
  }
  if ('botToken' in patch) {
    if (patch.botToken === null || patch.botToken === '') {
      sets.push(`bot_token_enc = NULL`);
      changed.push('bot_token_cleared');
    } else {
      sets.push(`bot_token_enc = $${i++}`); values.push(encryptSecret(String(patch.botToken).trim()));
      changed.push('bot_token_rotated');
    }
  }

  if (!sets.length) return { changed: [] };

  sets.push(`updated_at = NOW()`);
  sets.push(`updated_by = $${i++}`); values.push(actor.id || null);
  sets.push(`updated_by_username = $${i++}`); values.push(actor.username || null);

  await db().query(`UPDATE telegram_settings SET ${sets.join(', ')} WHERE id = 1`, values);
  invalidateCache();
  return { changed };
}

async function recordTestResult({ status, error = null, botUsername = null }) {
  try {
    await ensureRow();
    await db().query(
      `UPDATE telegram_settings SET last_test_at = NOW(), last_test_status = $1, last_test_error = $2, last_test_bot = $3 WHERE id = 1`,
      [status, error ? String(error).slice(0, 500) : null, botUsername]
    );
    invalidateCache();
  } catch (e) {
    console.error('telegramConfig: টেস্ট রেজাল্ট সেভ করা যায়নি:', e.message);
  }
}

// ==================== Telegram API কল ====================
async function callTelegram(method, botToken, body) {
  const res = await fetchWithTimeout(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  let json = null;
  try { json = await res.json(); } catch (e) { json = null; }
  return { ok: res.ok && json && json.ok === true, status: res.status, json };
}

/**
 * কানেকশন টেস্ট: getMe (টোকেন ঠিক আছে কিনা) + ঐচ্ছিকভাবে chat-এ একটা টেস্ট মেসেজ।
 * override দিয়ে এখনো সেভ না করা টোকেন/chat id দিয়েও যাচাই করা যায়।
 * এরর মেসেজে কখনো টোকেন থাকে না (Telegram-এর description-ই ফেরত যায়)।
 */
async function testConnection({ botToken, chatId, sendMessage = false } = {}) {
  const config = await getConfig();
  const token = botToken || config.botToken;
  const chat = chatId || config.chatId;

  if (!token) return { success: false, error: 'Bot token সেট করা নেই।' };
  if (!isValidBotToken(token)) return { success: false, error: 'Bot token-এর ফরম্যাট সঠিক নয় (<bot_id>:<secret> হওয়া উচিত)।' };

  try {
    const me = await callTelegram('getMe', token, {});
    if (!me.ok) {
      const desc = (me.json && me.json.description) || `HTTP ${me.status}`;
      return { success: false, error: `Telegram getMe ব্যর্থ: ${desc}` };
    }
    const botUsername = me.json.result && me.json.result.username ? '@' + me.json.result.username : null;

    if (sendMessage) {
      if (!chat) return { success: false, error: 'Chat ID সেট করা নেই — টেস্ট মেসেজ পাঠানো যায়নি।', botUsername };
      const sent = await callTelegram('sendMessage', token, {
        chat_id: chat,
        text: '✅ <b>Livo Admin</b> — Telegram ইন্টিগ্রেশন টেস্ট মেসেজ। কানেকশন ঠিক আছে।',
        parse_mode: 'HTML'
      });
      if (!sent.ok) {
        const desc = (sent.json && sent.json.description) || `HTTP ${sent.status}`;
        return { success: false, error: `টেস্ট মেসেজ পাঠানো যায়নি: ${desc}`, botUsername };
      }
    }

    return { success: true, botUsername, messageSent: !!sendMessage };
  } catch (err) {
    return { success: false, error: `Telegram API-তে পৌঁছানো যায়নি: ${err.message}` };
  }
}

module.exports = {
  CATEGORIES,
  CATEGORY_LABELS,
  DEFAULT_CATEGORIES,
  // pure helpers
  maskToken,
  isValidBotToken,
  isValidChatId,
  normalizeCategories,
  shouldNotify,
  encryptSecret,
  decryptSecret,
  isEncryptionAvailable,
  // config
  getConfig,
  getStatus,
  saveConfig,
  invalidateCache,
  recordTestResult,
  testConnection
};
