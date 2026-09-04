// services/withdrawalWindow.js
// ---------------------------------------------------------------------------
// উইথড্র সময়সূচি — প্রতি রাতে নির্দিষ্ট সময়ে নিজে থেকেই বন্ধ, সকালে চালু।
//
// অ্যাডমিনকে প্রতিদিন হাতে করে বন্ধ/চালু করতে হয় না। কোনো cron বা scheduler
// job-ও নেই: প্রতিটা রিকোয়েস্টে বর্তমান সময় দেখে সিদ্ধান্ত নেওয়া হয়। ফলে
// সার্ভার রিস্টার্ট, ডিপ্লয় বা ক্র্যাশে সময়সূচি এলোমেলো হয় না, আর "job
// চলেনি বলে সারারাত খোলা থেকে গেল" ধরনের ব্যর্থতাও অসম্ভব।
//
// তিনটা মোড:
//   auto   — সময়সূচি অনুযায়ী (ডিফল্ট)
//   open   — জোর করে খোলা (সময়সূচি উপেক্ষা)
//   closed — জোর করে বন্ধ (সময়সূচি উপেক্ষা)
//
// গুরুত্বপূর্ণ: এটা বিদ্যমান `withdrawal` ফিচার ফ্ল্যাগের *বিকল্প নয়*,
// অতিরিক্ত একটা স্তর। ফ্ল্যাগ বন্ধ থাকলে সময়সূচি যাই হোক উইথড্র বন্ধই থাকে।
//
// এই মডিউল কোনো ব্যালেন্স, লেজার বা বিদ্যমান উইথড্র রিকোয়েস্ট স্পর্শ করে না —
// শুধু নতুন রিকোয়েস্ট গ্রহণ করা হবে কিনা সেটুকু ঠিক করে। ইতিমধ্যে জমা পড়া
// রিকোয়েস্ট বন্ধ সময়েও অ্যাডমিন স্বাভাবিকভাবে অনুমোদন/বাতিল করতে পারবেন।
// ---------------------------------------------------------------------------

const { pool } = require('../db');

const KEYS = {
  mode: 'withdrawal_window_mode',
  start: 'withdrawal_window_start',
  end: 'withdrawal_window_end',
  timezone: 'withdrawal_window_timezone'
};

const DEFAULTS = {
  mode: 'auto',
  start: '23:00',      // এই সময়ে বন্ধ হয়
  end: '07:00',        // এই সময়ে আবার খোলে
  timezone: 'Asia/Dhaka'
};

const MODES = ['auto', 'open', 'closed'];

// সার্ভার UTC-তে চলে (Render), ব্যবহারকারীরা বাংলাদেশে। তাই তুলনা সবসময়
// একটা স্পষ্ট টাইমজোনে করা হয় — সার্ভারের লোকাল সময়ে কখনো নয়, নইলে হোস্ট
// বদলালেই সময়সূচি নীরবে ৬ ঘণ্টা সরে যেত।
function isValidTimeZone(tz) {
  // খালি/undefined আলাদা করে বাদ দিতেই হয়: Intl সেটাকে "সিস্টেমের টাইমজোন
  // ব্যবহার করো" ধরে নেয়, throw করে না। তখন সেটিংস না থাকলে হিসাব নীরবে
  // সার্ভারের UTC-তে চলে যেত এবং সময়সূচি ৬ ঘণ্টা সরে যেত।
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz.trim() });
    return true;
  } catch (e) {
    return false;
  }
}

function parseHhMm(value, fallback) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(value || '').trim());
  if (!m) return parseHhMm(fallback, '00:00');
  return { hours: Number(m[1]), minutes: Number(m[2]), text: `${String(m[1]).padStart(2, '0')}:${m[2]}` };
}

/** নির্দিষ্ট টাইমজোনে `at`-এর মধ্যরাত থেকে গোনা মিনিট। */
function minutesOfDayInTz(at, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(at);
  const hh = Number(parts.find(p => p.type === 'hour').value);
  const mm = Number(parts.find(p => p.type === 'minute').value);
  // কিছু লোকেলে মধ্যরাত '24' হিসেবে আসে — 0-এ স্বাভাবিক করা হচ্ছে।
  return ((hh % 24) * 60) + mm;
}

async function readConfig() {
  const res = await pool.query(
    'SELECT key, value FROM site_settings WHERE key = ANY($1)',
    [Object.values(KEYS)]
  );
  const raw = {};
  res.rows.forEach(r => { raw[r.key] = r.value; });

  const mode = MODES.includes(raw[KEYS.mode]) ? raw[KEYS.mode] : DEFAULTS.mode;
  const timezone = isValidTimeZone(raw[KEYS.timezone]) ? raw[KEYS.timezone] : DEFAULTS.timezone;
  return {
    mode,
    timezone,
    start: parseHhMm(raw[KEYS.start], DEFAULTS.start),
    end: parseHhMm(raw[KEYS.end], DEFAULTS.end)
  };
}

/**
 * এখন উইথড্র নেওয়া যাবে কিনা।
 *
 * @returns {{open:boolean, mode:string, reason:string, start:string, end:string,
 *            timezone:string, nowText:string, reopensAtText:string|null}}
 */
async function getState(at = new Date()) {
  let cfg;
  try {
    cfg = await readConfig();
  } catch (err) {
    // সেটিংস পড়া না গেলে fail-open: সময়সূচি একটা সুবিধা, নিরাপত্তা নিয়ন্ত্রণ
    // নয়। DB হেঁচকি খেলে ইউজারের টাকা তোলা আটকে দেওয়া অন্যায্য হতো — আসল
    // সুরক্ষা (ফিচার ফ্ল্যাগ, ব্যালেন্স যাচাই, অ্যাডমিন অনুমোদন) অক্ষত থাকে।
    console.error('withdrawalWindow config read error:', err.message);
    return {
      open: true, mode: 'auto', reason: 'config_unavailable',
      start: DEFAULTS.start, end: DEFAULTS.end, timezone: DEFAULTS.timezone,
      nowText: null, reopensAtText: null
    };
  }

  const base = {
    mode: cfg.mode,
    start: cfg.start.text,
    end: cfg.end.text,
    timezone: cfg.timezone,
    nowText: new Intl.DateTimeFormat('en-GB', {
      timeZone: cfg.timezone, hour: '2-digit', minute: '2-digit', hour12: false
    }).format(at)
  };

  if (cfg.mode === 'open') {
    return { ...base, open: true, reason: 'forced_open', reopensAtText: null };
  }
  if (cfg.mode === 'closed') {
    // ম্যানুয়ালি বন্ধ — কখন খুলবে সেটা অ্যাডমিনের সিদ্ধান্ত, তাই সময় বলা হয় না।
    return { ...base, open: false, reason: 'forced_closed', reopensAtText: null };
  }

  const now = minutesOfDayInTz(at, cfg.timezone);
  const startM = cfg.start.hours * 60 + cfg.start.minutes;
  const endM = cfg.end.hours * 60 + cfg.end.minutes;

  let closed;
  if (startM === endM) {
    // শুরু ও শেষ এক হলে কোনো বন্ধ সময় নেই — সারাদিন খোলা।
    closed = false;
  } else if (startM > endM) {
    // মধ্যরাত পেরোনো জানালা, যেমন ২৩:০০ → ০৭:০০
    closed = now >= startM || now < endM;
  } else {
    // একই দিনের ভেতরের জানালা, যেমন ০১:০০ → ০৫:০০
    closed = now >= startM && now < endM;
  }

  return {
    ...base,
    open: !closed,
    reason: closed ? 'scheduled_closed' : 'scheduled_open',
    reopensAtText: closed ? cfg.end.text : null
  };
}

/**
 * অ্যাডমিন সেভ — শুধু বৈধ মান লেখা হয়, অবৈধ ইনপুট নীরবে গ্রহণ করা হয় না।
 * ইচ্ছাকৃতভাবে explicit allowlist; req.body সরাসরি পাস করা হয় না।
 */
async function saveConfig({ mode, start, end, timezone }) {
  const errors = [];
  const rows = [];

  if (mode !== undefined) {
    if (!MODES.includes(mode)) errors.push('invalid_mode');
    else rows.push([KEYS.mode, mode]);
  }
  if (start !== undefined) {
    if (!/^([01]?\d|2[0-3]):([0-5]\d)$/.test(String(start).trim())) errors.push('invalid_start');
    else rows.push([KEYS.start, parseHhMm(start, DEFAULTS.start).text]);
  }
  if (end !== undefined) {
    if (!/^([01]?\d|2[0-3]):([0-5]\d)$/.test(String(end).trim())) errors.push('invalid_end');
    else rows.push([KEYS.end, parseHhMm(end, DEFAULTS.end).text]);
  }
  if (timezone !== undefined) {
    if (!isValidTimeZone(timezone)) errors.push('invalid_timezone');
    else rows.push([KEYS.timezone, String(timezone).trim()]);
  }

  if (errors.length) return { ok: false, errors };

  for (const [key, value] of rows) {
    await pool.query(
      `INSERT INTO site_settings (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, value]
    );
  }
  return { ok: true, errors: [] };
}

module.exports = { KEYS, DEFAULTS, MODES, getState, saveConfig, readConfig, minutesOfDayInTz };
