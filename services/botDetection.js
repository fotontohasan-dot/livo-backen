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

async function logBotEvent({ ip, userId = null, endpoint, signals, riskLevel, userAgent, blocked }) {
  try {
    const signalTypes = signals.map(s => s.type);
    const reason = signals.map(s => s.description).join('; ');
    await pool.query(
      `INSERT INTO bot_activity_logs (ip, user_id, endpoint, signal_types, risk_level, reason, user_agent, blocked)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [ip, userId, endpoint, signalTypes, riskLevel, reason, userAgent, !!blocked]
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
 */
function evaluateRequest({ ip, userAgent, endpoint, honeypotTriggered = false, formRenderedAt = null }) {
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

  let riskLevel = null;
  if (signals.some(s => s.type === 'honeypot_triggered')) riskLevel = 'high';
  else if (signals.length >= 2) riskLevel = 'high';
  else if (signals.length === 1) riskLevel = 'medium';

  return { signals, riskLevel, requiresCaptcha: !!riskLevel };
}

module.exports = {
  evaluateRequest,
  generateCaptcha,
  verifyCaptcha,
  logBotEvent,
  isSuspiciousUserAgent
};
