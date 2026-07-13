/**
 * services/totp.js
 * ---------------------------------------------------------------------------
 * অ্যাডমিন 2FA (TOTP — Google Authenticator/Authy স্টাইল) এর জন্য হেল্পার।
 * ---------------------------------------------------------------------------
 */

const { authenticator } = require('otplib');
const QRCode = require('qrcode');

// ৩০ সেকেন্ডের কোড উইন্ডো, ঘড়ির সামান্য পার্থক্য সহ্য করতে ১ ধাপ (৩০ সেকেন্ড) আগে-পরে গ্রহণযোগ্য
authenticator.options = { window: 1 };

/** নতুন র‍্যান্ডম সিক্রেট বানায় (Base32) */
function generateSecret() {
  return authenticator.generateSecret();
}

/**
 * Google Authenticator/Authy-এর মতো অ্যাপে স্ক্যান করার জন্য QR কোড (data URL) বানায়
 * @param {string} secret
 * @param {string} accountLabel - সাধারণত অ্যাডমিনের ইউজারনেম/ইমেইল
 * @returns {Promise<string>} data:image/png;base64,... URL
 */
async function generateQrCodeDataUrl(secret, accountLabel) {
  const otpauthUrl = authenticator.keyuri(accountLabel, 'Livo Admin', secret);
  return QRCode.toDataURL(otpauthUrl);
}

/**
 * ইউজারের দেওয়া ৬ সংখ্যার কোড সিক্রেটের বিপরীতে যাচাই করে
 * @param {string} token
 * @param {string} secret
 * @returns {boolean}
 */
function verifyToken(token, secret) {
  if (!token || !secret) return false;
  try {
    return authenticator.verify({ token: String(token).trim(), secret });
  } catch (e) {
    return false;
  }
}

module.exports = { generateSecret, generateQrCodeDataUrl, verifyToken };
