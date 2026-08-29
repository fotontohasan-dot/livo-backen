const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const ISSUER = 'Livo Admin';

// ==================== নতুন TOTP সিক্রেট + QR কোড তৈরি ====================
async function generateTotpSetup(username) {
  const secret = speakeasy.generateSecret({
    length: 20,
    name: `${ISSUER} (${username})`,
    issuer: ISSUER
  });
  const qrDataUrl = await QRCode.toDataURL(secret.otpauth_url);
  return {
    base32: secret.base32,
    otpauthUrl: secret.otpauth_url,
    qrDataUrl
  };
}

// ==================== ৬-ডিজিট TOTP কোড ভেরিফাই ====================
function verifyTotpToken(base32Secret, token) {
  if (!base32Secret || !token) return false;
  return speakeasy.totp.verify({
    secret: base32Secret,
    encoding: 'base32',
    token: String(token).replace(/\s+/g, ''),
    window: 1 // ৩০ সেকেন্ড আগে/পরের কোডও গ্রহণযোগ্য (ঘড়ির সামান্য পার্থক্যের জন্য)
  });
}

// ==================== ব্যাকআপ কোড তৈরি (একবারই দেখানো হবে) ====================
// ==================== TOTP replay prevention helper (MEDIUM-1) ====================
// valid/invalid ছাড়াও কোন time-step-এ code টি valid হয়েছে সেটি জানা দরকার,
// যাতে একই step-এর code দ্বিতীয়বার ব্যবহার করা না যায়।
// verifyTotpToken()-এর আচরণ অপরিবর্তিত (zero-regression)।
const TOTP_STEP_SECONDS = 30;

function verifyTotpTokenWithStep(base32Secret, token) {
  if (!base32Secret || !token) return { valid: false, step: null };
  const cleaned = String(token).replace(/\s+/g, '');
  const delta = speakeasy.totp.verifyDelta({
    secret: base32Secret,
    encoding: 'base32',
    token: cleaned,
    window: 1
  });
  if (!delta || typeof delta.delta !== 'number') return { valid: false, step: null };
  const currentStep = Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS);
  return { valid: true, step: currentStep + delta.delta };
}

function generateBackupCodes(count = 8) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase(); // 10 hex chars
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5, 10)}`);
  }
  return codes;
}

async function hashBackupCodes(codes) {
  const hashed = [];
  for (const c of codes) {
    hashed.push(await bcrypt.hash(c, 10));
  }
  return JSON.stringify(hashed);
}

// ইনপুট ব্যাকআপ কোড মিলছে কিনা চেক করে; মিললে বাকি (অব্যবহৃত) হ্যাশগুলোর নতুন JSON স্ট্রিং রিটার্ন করে
async function verifyAndConsumeBackupCode(storedJson, inputCode) {
  if (!storedJson || !inputCode) return { valid: false };
  let hashes;
  try { hashes = JSON.parse(storedJson); } catch { return { valid: false }; }
  if (!Array.isArray(hashes)) return { valid: false };

  const clean = String(inputCode).trim().toUpperCase();

  for (let i = 0; i < hashes.length; i++) {
    const match = await bcrypt.compare(clean, hashes[i]);
    if (match) {
      const remaining = hashes.filter((_, idx) => idx !== i);
      return { valid: true, remainingJson: JSON.stringify(remaining) };
    }
  }
  return { valid: false };
}

async function qrFromSecret(base32Secret, username) {
  const otpauthUrl = speakeasy.otpauthURL({
    secret: base32Secret,
    encoding: 'base32',
    label: `${ISSUER} (${username})`,
    issuer: ISSUER
  });
  return QRCode.toDataURL(otpauthUrl);
}

module.exports = {
  generateTotpSetup,
  verifyTotpToken,
  verifyTotpTokenWithStep,
  generateBackupCodes,
  hashBackupCodes,
  verifyAndConsumeBackupCode,
  qrFromSecret
};
