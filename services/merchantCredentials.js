// services/merchantCredentials.js
// ---------------------------------------------------------------------------
// মার্চেন্টের Merchant ID ও API Key তৈরি/যাচাই/সংরক্ষণ।
//
//  • Merchant ID  — "MID-" + ১০ অক্ষর (ভুল-পড়া অক্ষর 0/O/1/I/L বাদ)। crypto.randomInt দিয়ে তৈরি,
//                   তাই আন্দাজ করা যায় না। merchants.merchant_uid-এ UNIQUE।
//  • API Key      — "mk_" + ৩২ অক্ষর base64url (১৯২ বিট এনট্রপি)।
//
// সংরক্ষণ (দুটো আলাদা কলাম, দুটো আলাদা কাজে):
//  • api_key_hash — SHA-256। API রিকোয়েস্ট যাচাইয়ের জন্য (middleware/apiKeyAuth.js-এর মতোই),
//                   তাই লুকআপে ডিক্রিপশন লাগে না।
//  • api_key_enc  — AES-256-GCM (utils/secretBox.js)। শুধু মার্চেন্ট পোর্টালে "দেখানোর" জন্য —
//                   প্রয়োজনের চেয়ে বেশি জায়গায় ছড়ায় না। DB ফাঁস হলেও এনক্রিপশন-কী ছাড়া পড়া যায় না।
//
// রাউট ও টেস্ট একই হেল্পার ব্যবহার করে যাতে ফরম্যাট এক জায়গায় থাকে।
// ---------------------------------------------------------------------------

const crypto = require('crypto');
const secretBox = require('../utils/secretBox');

const UID_PREFIX = 'MID-';
const UID_LENGTH = 10;
// 0/O, 1/I/L বাদ — ফোনে/কাগজে দেখে লিখলে ভুল হয় না
const UID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const KEY_PREFIX = 'mk_';
const KEY_RE = /^mk_[A-Za-z0-9_-]{32}$/;
const UID_RE = /^MID-[A-HJKMNP-Z2-9]{10}$/;

function generateMerchantUid() {
  let s = '';
  for (let i = 0; i < UID_LENGTH; i++) s += UID_ALPHABET[crypto.randomInt(UID_ALPHABET.length)];
  return UID_PREFIX + s;
}

function generateApiKey() {
  // ২৪ বাইট = ৩২ base64url অক্ষর (প্যাডিং ছাড়া)
  return KEY_PREFIX + crypto.randomBytes(24).toString('base64url');
}

function hashApiKey(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

/** প্রদর্শনের জন্য কী-এর সামনের অংশ, যেমন "mk_AbCd…" — তালিকায় চেনার জন্য, গোপন নয় */
function keyPrefix(raw) {
  return String(raw).slice(0, 7);
}

/**
 * নতুন কী তৈরি করে DB-তে লেখার মতো ফিল্ডসহ ফেরত দেয়।
 * secretBox-এর এনক্রিপশন-কী না থাকলে encrypt() throw করে — তাই কী ছাড়া
 * "দেখানো যায় না এমন কী" চুপচাপ তৈরি হয় না; ত্রুটিটা কলারে পৌঁছায়।
 */
function newKeyFields() {
  const raw = generateApiKey();
  return {
    raw,
    api_key_hash: hashApiKey(raw),
    api_key_enc: secretBox.encrypt(raw),
    api_key_prefix: keyPrefix(raw)
  };
}

/** সংরক্ষিত এনক্রিপ্টেড কী ফেরত দেয়; কী বদলে গেলে/করাপ্ট হলে null */
function revealApiKey(apiKeyEnc) {
  if (!apiKeyEnc) return null;
  const raw = secretBox.decrypt(apiKeyEnc);
  return raw && KEY_RE.test(raw) ? raw : null;
}

/**
 * client-এর ট্রানজেকশনের ভেতরে একটা অব্যবহৃত Merchant ID বের করে।
 * UNIQUE constraint-ই চূড়ান্ত রক্ষা; এই লুপ শুধু অতি-বিরল সংঘর্ষে ত্রুটি এড়ায়।
 */
async function allocateMerchantUid(client) {
  for (let i = 0; i < 8; i++) {
    const uid = generateMerchantUid();
    const r = await client.query(
      'SELECT 1 FROM merchants WHERE merchant_uid = $1 OR code = $1', [uid]
    );
    if (!r.rows.length) return uid;
  }
  throw new Error('merchant_uid allocate failed after 8 attempts');
}

module.exports = {
  generateMerchantUid, generateApiKey, hashApiKey, keyPrefix,
  newKeyFields, revealApiKey, allocateMerchantUid,
  KEY_RE, UID_RE
};
