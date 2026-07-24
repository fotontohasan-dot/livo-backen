const crypto = require('crypto');
const { pool } = require('../db');
const { logAdminAction } = require('./fraudDetection');

// ==================== Bot Detection System ====================
// সন্দেহজনক Request Pattern, অস্বাভাবিক লগইন/রেজিস্ট্রেশন, অতিরিক্ত API Request ও
// Automation (headless browser/স্ক্রিপ্ট) শনাক্ত করে। কখনো নিজে থেকে হার্ড ব্লক করে না —
// ঝুঁকি বেশি হলে caller-কে বলে CAPTCHA/অতিরিক্ত ভেরিফিকেশন চাওয়ার জন্য।

const RATE_WINDOW_MS = 10 * 1000;   // ১০ সেকেন্ড উইন্ডো
const RATE_THRESHOLD = 20;          // ১০ সেকেন্ডে ২০+ রিকোয়েস্ট — অতিরিক্ত API Request/Automation সন্দেহ
const MIN_FORM_FILL_MS = 1200;      // পেজ লোড থেকে ফর্ম সাবমিটে ১.২ সেকেন্ডের কম হলে স্বয়ংক্রিয় স্ক্রিপ্ট সন্দেহ

const requestLog = new Map(); // ip -> [timestamps]

// ==================== Request Fingerprinting ====================
// TLS/JS ছাড়া, শুধু হেডার প্রোফাইল থেকে হালকা ফিঙ্গারপ্রিন্ট — একই "ব্রাউজার প্রোফাইল"
// অনেকগুলো ভিন্ন IP থেকে এলে (প্রক্সি/VPN রোটেশন ব্যবহার করা বট নেটওয়ার্কের সাধারণ লক্ষণ) ধরার জন্য।
const FINGERPRINT_WINDOW_MS = 60 * 60 * 1000; // ১ ঘণ্টা
const FINGERPRINT_IP_THRESHOLD = 5;           // ১ ঘণ্টায় ৫+ ভিন্ন IP থেকে একই ফিঙ্গারপ্রিন্ট
const fingerprintIpMap = new Map(); // fingerprint -> Map(ip -> lastSeen)

setInterval(() => {
  const cutoff = Date.now() - FINGERPRINT_WINDOW_MS;
  for (const [fp, ipMap] of fingerprintIpMap.entries()) {
    for (const [ip, ts] of ipMap.entries()) if (ts < cutoff) ipMap.delete(ip);
    if (ipMap.size === 0) fingerprintIpMap.delete(fp);
  }
}, 5 * 60 * 1000).unref();

function computeFingerprint(req) {
  const parts = [
    req.get('user-agent') || '',
    req.get('accept-language') || '',
    req.get('accept-encoding') || '',
    req.get('accept') || '',
    req.get('sec-ch-ua') || '',
    req.get('sec-ch-ua-platform') || ''
  ].join('|');
  return crypto.createHash('md5').update(parts).digest('hex').slice(0, 16);
}

function trackFingerprint(fingerprint, ip) {
  if (!fingerprint || !ip) return 0;
  let ipMap = fingerprintIpMap.get(fingerprint);
  if (!ipMap) { ipMap = new Map(); fingerprintIpMap.set(fingerprint, ipMap); }
  ipMap.set(ip, Date.now());
  return ipMap.size;
}

// পুরনো এন্ট্রি নিয়মিত পরিষ্কার করে মেমরি বাড়তে না দেওয়ার জন্য
setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [ip, timestamps] of requestLog.entries()) {
    const fresh = timestamps.filter(t => t > cutoff);
    if (fresh.length) requestLog.set(ip, fresh);
    else requestLog.delete(ip);
  }
}, 30 * 1000).unref();

function recordRequest(ip) {
  if (!ip) return 0;
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  const existing = (requestLog.get(ip) || []).filter(t => t > cutoff);
  existing.push(now);
  requestLog.set(ip, existing);
  return existing.length;
}

const BOT_UA_PATTERNS = /curl|wget|python-requests|python-urllib|scrapy|headlesschrome|phantomjs|selenium|puppeteer|playwright|libwww|httpclient|okhttp|axios\/|node-fetch|go-http-client|java\/|ruby|perl|bot|spider|crawler/i;

function isSuspiciousUserAgent(ua) {
  if (!ua || !ua.trim()) return { suspicious: true, reason: 'ইউজার-এজেন্ট হেডার নেই' };
  if (BOT_UA_PATTERNS.test(ua)) return { suspicious: true, reason: `বট/স্ক্রিপ্ট-সদৃশ ইউজার-এজেন্ট: ${ua.slice(0, 80)}` };
  return { suspicious: false, reason: null };
}

// ==================== Headless Browser Detection (client hints) ====================
// UA regex ছাড়াও, আসল ব্রাউজার সাধারণত sec-ch-ua/accept-language/accept-encoding হেডার
// পাঠায়। "Mozilla/5.0" জাতীয় সাধারণ UA থাকা সত্ত্বেও এই হেডারগুলো অনুপস্থিত হলে সেটা
// headless/scripted ক্লায়েন্টের লক্ষণ (Puppeteer/Playwright default profile প্রায়ই এমন)।
function detectHeadlessSignals(req) {
  const ua = req.get('user-agent') || '';
  const looksLikeBrowser = /mozilla|chrome|safari|firefox|edg/i.test(ua);
  if (!looksLikeBrowser) return null; // UA regex আলাদাভাবে ধরবে
  const missing = [];
  if (!req.get('accept-language')) missing.push('accept-language');
  if (!req.get('accept-encoding')) missing.push('accept-encoding');
  if (req.get('sec-ch-ua') === undefined && /chrome|edg/i.test(ua) && !/mobile/i.test(ua)) {
    // আধুনিক Chromium ব্রাউজার সাধারণত sec-ch-ua পাঠায়; না থাকলে headless হতে পারে
    missing.push('sec-ch-ua');
  }
  if (missing.length >= 2) {
    return `ব্রাউজার-সদৃশ UA কিন্তু সাধারণ হেডার অনুপস্থিত (${missing.join(', ')}) — headless/automated ক্লায়েন্ট সন্দেহ`;
  }
  return null;
}

function generateCaptcha() {
  const a = Math.floor(Math.random() * 8) + 1;
  const b = Math.floor(Math.random() * 8) + 1;
  const ops = [
    { symbol: '+', fn: (x, y) => x + y },
    { symbol: '-', fn: (x, y) => Math.max(x, y) - Math.min(x, y) }
  ];
  const op = ops[Math.floor(Math.random() * ops.length)];
  const question = op.symbol === '+' ? `${a} + ${b}` : `${Math.max(a, b)} - ${Math.min(a, b)}`;
  return { question: `${question} = ?`, answer: String(op.fn(a, b)) };
}

function verifyCaptcha(session, submittedAnswer) {
  if (!session || !session.botCaptcha) return false;
  const ok = String(submittedAnswer || '').trim() === String(session.botCaptcha.answer);
  session.botCaptcha = null; // এক-বার ব্যবহারযোগ্য
  return ok;
}

async function logBotEvent({ ip, userId = null, endpoint, signals, riskLevel, userAgent, blocked, fingerprint = null }) {
  try {
    const signalTypes = signals.map(s => s.type);
    const reason = signals.map(s => s.description).join('; ');
    await pool.query(
      `INSERT INTO bot_activity_logs (ip, user_id, endpoint, signal_types, risk_level, reason, user_agent, blocked, fingerprint)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [ip, userId, endpoint, signalTypes, riskLevel, reason, userAgent, !!blocked, fingerprint]
    );
    await logAdminAction(
      null, 'SYSTEM', 'BOT_ACTIVITY_DETECTED',
      `[${endpoint}] IP: ${ip} — ঝুঁকি: ${riskLevel.toUpperCase()} — ${reason}${blocked ? ' (CAPTCHA আটকানো হয়েছে)' : ''}`,
      ip
    );
  } catch (e) {
    console.error('logBotEvent error (non-blocking):', e.message);
  }
}

/**
 * একটি রিকোয়েস্ট মূল্যায়ন করে বট সিগন্যাল খুঁজে বের করে। কখনো নিজে থেকে ব্লক করে না —
 * শুধু সিগন্যাল ও ঝুঁকি রিটার্ন করে; caller ঠিক করে CAPTCHA চাইবে কিনা।
 * options.honeypotTriggered — হানিপট ফিল্ড পূরণ হয়েছে কিনা (ফর্ম-ভিত্তিক রুটে)
 * options.formRenderedAt — ফর্ম কতক্ষণ আগে রেন্ডার হয়েছিল (ms epoch), খুব দ্রুত সাবমিট হলে সন্দেহজনক
 * options.req — (ঐচ্ছিক) মূল Express request object, দেওয়া হলে Request Fingerprinting +
 *               headless-browser client-hint চেক চালু হয়। না দিলে আগের আচরণ অপরিবর্তিত থাকে।
 */
function evaluateRequest({ ip, userAgent, endpoint, honeypotTriggered = false, formRenderedAt = null, req = null }) {
  const signals = [];
  const rate = recordRequest(ip);

  if (honeypotTriggered) {
    signals.push({ type: 'honeypot_triggered', description: `হানিপট ফিল্ড পূরণ করা হয়েছে (${endpoint}) — নিশ্চিতভাবে স্বয়ংক্রিয় স্ক্রিপ্ট` });
  }

  const uaCheck = isSuspiciousUserAgent(userAgent);
  if (uaCheck.suspicious) {
    signals.push({ type: 'suspicious_user_agent', description: uaCheck.reason });
  }

  if (rate >= RATE_THRESHOLD) {
    signals.push({ type: 'rate_limit_exceeded', description: `${Math.round(RATE_WINDOW_MS / 1000)} সেকেন্ডে ${rate}+ রিকোয়েস্ট — অতিরিক্ত API Request/Automation সন্দেহ` });
  }

  if (formRenderedAt) {
    const elapsed = Date.now() - Number(formRenderedAt);
    if (elapsed >= 0 && elapsed < MIN_FORM_FILL_MS) {
      signals.push({ type: 'too_fast_submission', description: `ফর্ম রেন্ডারের ${elapsed}ms পরেই সাবমিট হয়েছে — মানুষের পক্ষে অস্বাভাবিক দ্রুত` });
    }
  }

  let fingerprint = null;
  if (req) {
    fingerprint = computeFingerprint(req);
    const distinctIps = trackFingerprint(fingerprint, ip);
    if (distinctIps >= FINGERPRINT_IP_THRESHOLD) {
      signals.push({ type: 'fingerprint_ip_rotation', description: `একই ব্রাউজার-ফিঙ্গারপ্রিন্ট ${distinctIps}টি ভিন্ন IP থেকে ব্যবহৃত হয়েছে (১ ঘণ্টায়) — প্রক্সি/বট-নেটওয়ার্ক সন্দেহ` });
    }
    const headlessReason = detectHeadlessSignals(req);
    if (headlessReason) {
      signals.push({ type: 'headless_client_hints', description: headlessReason });
    }
  }

  let riskLevel = null;
  if (signals.some(s => s.type === 'honeypot_triggered')) riskLevel = 'high';
  else if (signals.some(s => s.type === 'fingerprint_ip_rotation')) riskLevel = 'high';
  else if (signals.length >= 2) riskLevel = 'high';
  else if (signals.length === 1) riskLevel = 'medium';

  return { signals, riskLevel, requiresCaptcha: !!riskLevel, fingerprint };
}

module.exports = {
  evaluateRequest,
  generateCaptcha,
  verifyCaptcha,
  logBotEvent,
  isSuspiciousUserAgent,
  computeFingerprint
};
