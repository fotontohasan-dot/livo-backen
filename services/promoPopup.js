// হোমপেজ পপআপ (স্লাইডশো) — অ্যাডমিন প্যানেল থেকে নিয়ন্ত্রিত।
//  - স্লাইড: ছবি + (ঐচ্ছিক) টাইটেল/টেক্সট/লিংক, আলাদা সময়, সিডিউল, ক্রম
//  - সেটিংস: ফ্রেমের আকৃতি (লম্বা/চ্যাপ্টা/…), বর্ডার, কোণ, রং, ওভারলে, অ্যানিমেশন, সময়, বারবার দেখানো
// সব ইনপুট এখানে যাচাই/ক্ল্যাম্প করা হয়; ক্লায়েন্টে শুধু যাচাই-করা মান যায়।

const { pool } = require('../db');

const SHAPES = {
  // ratio = প্রস্থ ÷ উচ্চতা (null = ছবির নিজস্ব অনুপাত)
  auto: null,
  portrait: 3 / 4,
  tall: 9 / 16,
  square: 1,
  landscape: 4 / 3,
  wide: 16 / 9
};
const FITS = ['cover', 'contain'];
const POSITIONS = ['center', 'top', 'bottom'];
const ANIMATIONS = ['fade', 'zoom', 'slide', 'none'];

const DEFAULTS = Object.freeze({
  enabled: true,
  delaySeconds: 1.2,
  slideSeconds: 6,
  autoAdvance: true,
  autoClose: false,
  showIntervalHours: 24,
  resetVersion: 0,
  shape: 'auto',
  maxWidthPx: 480,
  radiusPx: 18,
  borderWidthPx: 0,
  borderColor: '#ffffff',
  frameBg: '#ffffff',
  overlayOpacity: 55,
  blurPx: 8,
  imageFit: 'cover',
  position: 'center',
  animation: 'fade',
  showCaption: true,
  showDots: true,
  showNav: true
});

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function clampNum(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
function clampInt(v, min, max, fallback) {
  return Math.round(clampNum(v, min, max, fallback));
}
function pick(v, allowed, fallback) {
  return allowed.includes(v) ? v : fallback;
}
function hex(v, fallback) {
  return typeof v === 'string' && HEX_RE.test(v.trim()) ? v.trim().toLowerCase() : fallback;
}
function bool(v, fallback) {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 'on' || v === '1' || v === 1) return true;
  if (v === 'false' || v === 'off' || v === '0' || v === 0) return false;
  return fallback;
}

// DB-তে থাকা বা ফর্মে আসা যেকোনো অবজেক্টকে নিরাপদ, সম্পূর্ণ সেটিংসে রূপান্তর
function normalizeSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const d = DEFAULTS;
  return {
    enabled: bool(r.enabled, d.enabled),
    delaySeconds: clampNum(r.delaySeconds, 0, 60, d.delaySeconds),
    slideSeconds: clampNum(r.slideSeconds, 1, 120, d.slideSeconds),
    autoAdvance: bool(r.autoAdvance, d.autoAdvance),
    autoClose: bool(r.autoClose, d.autoClose),
    showIntervalHours: clampInt(r.showIntervalHours, 0, 720, d.showIntervalHours),
    resetVersion: clampInt(r.resetVersion, 0, 1e9, d.resetVersion),
    shape: pick(r.shape, Object.keys(SHAPES), d.shape),
    maxWidthPx: clampInt(r.maxWidthPx, 200, 900, d.maxWidthPx),
    radiusPx: clampInt(r.radiusPx, 0, 48, d.radiusPx),
    borderWidthPx: clampInt(r.borderWidthPx, 0, 16, d.borderWidthPx),
    borderColor: hex(r.borderColor, d.borderColor),
    frameBg: hex(r.frameBg, d.frameBg),
    overlayOpacity: clampInt(r.overlayOpacity, 0, 95, d.overlayOpacity),
    blurPx: clampInt(r.blurPx, 0, 20, d.blurPx),
    imageFit: pick(r.imageFit, FITS, d.imageFit),
    position: pick(r.position, POSITIONS, d.position),
    animation: pick(r.animation, ANIMATIONS, d.animation),
    showCaption: bool(r.showCaption, d.showCaption),
    showDots: bool(r.showDots, d.showDots),
    showNav: bool(r.showNav, d.showNav)
  };
}

// HTML ফর্ম: আনচেক করা চেকবক্স ফিল্ডই পাঠায় না, তাই বুলিয়ান ফিল্ড আলাদাভাবে ধরা
const BOOL_FIELDS = ['enabled', 'autoAdvance', 'autoClose', 'showCaption', 'showDots', 'showNav'];
function settingsFromForm(body, current) {
  const b = body || {};
  const merged = Object.assign({}, current || DEFAULTS, b);
  BOOL_FIELDS.forEach((k) => { merged[k] = Object.prototype.hasOwnProperty.call(b, k) ? bool(b[k], false) : false; });
  // resetVersion ফর্ম থেকে বদলানো যাবে না (শুধু "সবাইকে আবার দেখাও" বাটনে)
  merged.resetVersion = (current || DEFAULTS).resetVersion;
  return normalizeSettings(merged);
}

// ছবির URL: শুধু নিজের সাইটের পাথ অথবা Cloudinary (CSP img-src এই দুটোই অনুমোদন করে)
function isSafeImageUrl(u) {
  if (typeof u !== 'string') return false;
  const s = u.trim();
  if (!s || s.length > 1000) return false;
  if (s.startsWith('/') && !s.startsWith('//') && !/[\s"'<>\\]/.test(s)) return true;
  try {
    const p = new URL(s);
    return p.protocol === 'https:' && p.hostname === 'res.cloudinary.com' && !/[\s"'<>\\]/.test(s);
  } catch (_) { return false; }
}
// ক্লিক-লিংক: নিজের সাইটের পাথ অথবা যেকোনো https (javascript:/data: কখনো নয়)
function isSafeLink(u) {
  if (typeof u !== 'string') return false;
  const s = u.trim();
  if (!s || s.length > 1000) return false;
  if (s.startsWith('/') && !s.startsWith('//') && !/[\s"'<>\\]/.test(s)) return true;
  try {
    const p = new URL(s);
    return p.protocol === 'https:' && !/[\s"'<>\\]/.test(s);
  } catch (_) { return false; }
}

function cleanText(v, max) {
  if (v === undefined || v === null) return null;
  const s = String(v).replace(/\u0000/g, '').trim();
  return s ? s.slice(0, max) : null;
}
// অ্যাডমিন datetime-local-এ ঢাকা সময় (UTC+6) লেখেন; সার্ভার টাইমজোন যা-ই হোক, সেটাকে সঠিক মুহূর্তে বদলানো
function toTs(v) {
  if (!v) return null;
  const str = String(v).trim();
  const d = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(str) ? new Date(str + ':00+06:00') : new Date(str);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ফর্ম থেকে স্লাইড ডেটা যাচাই। ভুল হলে { error: '<কী>' }
function slideFromForm(body) {
  const b = body || {};
  const image = cleanText(b.image_url, 1000);
  if (!image || !isSafeImageUrl(image)) return { error: 'admin_popup_err_image' };
  const link = cleanText(b.link_url, 1000);
  if (link && !isSafeLink(link)) return { error: 'admin_popup_err_link' };
  let duration = null;
  if (b.duration_seconds !== undefined && String(b.duration_seconds).trim() !== '') {
    duration = clampInt(b.duration_seconds, 1, 120, null);
  }
  return {
    value: {
      image_url: image,
      title_bn: cleanText(b.title_bn, 200),
      title_en: cleanText(b.title_en, 200),
      text_bn: cleanText(b.text_bn, 600),
      text_en: cleanText(b.text_en, 600),
      link_url: link,
      duration_seconds: duration,
      starts_at: toTs(b.starts_at),
      expires_at: toTs(b.expires_at)
    }
  };
}

// ছোট ক্যাশ — হোমপেজ হিট প্রতিবার DB ধরে না; অ্যাডমিন বদলালে সঙ্গে সঙ্গে মুছে যায়
let cache = null;
let cacheAt = 0;
const CACHE_MS = 10 * 1000;
function invalidate() { cache = null; cacheAt = 0; }

async function getSettings() {
  const r = await pool.query('SELECT settings FROM promo_popup_settings WHERE id = 1');
  return normalizeSettings(r.rows[0] && r.rows[0].settings);
}
async function saveSettings(settings) {
  const clean = normalizeSettings(settings);
  await pool.query(
    `INSERT INTO promo_popup_settings (id, settings, updated_at) VALUES (1, $1::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET settings = EXCLUDED.settings, updated_at = NOW()`,
    [JSON.stringify(clean)]
  );
  invalidate();
  return clean;
}
async function bumpResetVersion() {
  const cur = await getSettings();
  return saveSettings(Object.assign({}, cur, { resetVersion: cur.resetVersion + 1 }));
}

async function listSlides() {
  const r = await pool.query('SELECT * FROM promo_popup_slides ORDER BY sort_order ASC, id ASC');
  return r.rows;
}

// পাবলিক কনফিগ: শুধু সক্রিয় + সময়সীমার ভেতরের স্লাইড
async function getPublicConfig(lang) {
  const now = Date.now();
  if (!cache || now - cacheAt > CACHE_MS) {
    const [settings, slidesRes] = await Promise.all([
      getSettings(),
      pool.query(
        `SELECT id, image_url, title_bn, title_en, text_bn, text_en, link_url, duration_seconds
           FROM promo_popup_slides
          WHERE active = true
            AND (starts_at IS NULL OR starts_at <= NOW())
            AND (expires_at IS NULL OR expires_at > NOW())
          ORDER BY sort_order ASC, id ASC
          LIMIT 20`
      )
    ]);
    cache = { settings, rows: slidesRes.rows };
    cacheAt = now;
  }
  const en = lang === 'en';
  const slides = cache.rows
    .filter((s) => isSafeImageUrl(s.image_url))
    .map((s) => ({
      id: s.id,
      image: s.image_url,
      title: (en && s.title_en) || s.title_bn || s.title_en || '',
      text: (en && s.text_en) || s.text_bn || s.text_en || '',
      link: s.link_url && isSafeLink(s.link_url) ? s.link_url : '',
      duration: s.duration_seconds || 0
    }));
  return { settings: cache.settings, ratio: SHAPES[cache.settings.shape] || 0, slides };
}

module.exports = {
  DEFAULTS, SHAPES, FITS, POSITIONS, ANIMATIONS,
  normalizeSettings, settingsFromForm, slideFromForm,
  isSafeImageUrl, isSafeLink,
  getSettings, saveSettings, bumpResetVersion, listSlides, getPublicConfig, invalidate
};
