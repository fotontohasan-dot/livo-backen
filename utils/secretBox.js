// utils/secretBox.js
// সংবেদনশীল মান at-rest এনক্রিপ্ট করার সাধারণ হেল্পার (AES-256-GCM)।
//
// `services/telegramConfig.js`-এ ঠিক এই কাজটার একটা কপি ছিল, শুধু বট টোকেনের
// জন্য। TOTP সিক্রেটেও একই সুরক্ষা দরকার, তাই লজিকটা এখানে তুলে আনা হলো —
// একই ফরম্যাট, একই কী-ফলব্যাক, যাতে দুই জায়গায় দুরকম আচরণ না হয়।
//
// কেন দরকার: `users.totp_secret` প্লেইনটেক্সটে থাকলে ডাটাবেস পড়তে পারা যেকোনো
// পথ — SQL ইনজেকশন, ফাঁস হওয়া ব্যাকআপ, রিড-অ্যাক্সেসওয়ালা অভ্যন্তরীণ
// অ্যাকাউন্ট — সরাসরি অ্যাডমিনের 2FA কোড তৈরি করতে পারত। তখন দ্বিতীয় ফ্যাক্টর
// আর দ্বিতীয় থাকে না, পাসওয়ার্ডের মতো একই জায়গায় বসে থাকে।
//
// ফরম্যাট: "v1:<iv>:<authTag>:<ciphertext>" (সবগুলো base64)। GCM ব্যবহার করায়
// ডিক্রিপশনের সময় টেম্পারিং ধরা পড়ে।

const crypto = require('crypto');

const PREFIX = 'v1';

function rawEncryptionKey() {
  return (
    process.env.SETTINGS_ENCRYPTION_KEY ||
    process.env.TELEGRAM_SETTINGS_KEY ||
    process.env.BACKUP_ENCRYPTION_KEY ||
    process.env.SESSION_SECRET ||
    ''
  );
}

function getKey() {
  const raw = rawEncryptionKey();
  if (!raw) return null;
  return crypto.createHash('sha256').update(String(raw)).digest();
}

function isAvailable() {
  return !!getKey();
}

/** মানটি ইতিমধ্যে এনক্রিপ্ট করা কি না — মাইগ্রেশনে পুরনো প্লেইনটেক্সট চেনার জন্য। */
function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX + ':') && value.split(':').length === 4;
}

function encrypt(plain) {
  const key = getKey();
  if (!key) {
    throw new Error('এনক্রিপশন কী পাওয়া যায়নি — SETTINGS_ENCRYPTION_KEY (বা SESSION_SECRET) সেট করুন।');
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [PREFIX, iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}

/**
 * encrypt()-এর বিপরীত।
 *
 * পুরনো প্লেইনটেক্সট মান (এনক্রিপশন চালুর আগে সেভ হওয়া) হুবহু ফেরত দেওয়া হয়,
 * যাতে ইতিমধ্যে 2FA সেট করা অ্যাডমিনরা রিলিজের সাথে সাথে লক-আউট না হন।
 * কী বদলে গেলে বা ডেটা করাপ্ট হলে null — throw করে না, কারণ কলাররা সাধারণত
 * লগইন পথে থাকে আর সেখানে ক্র্যাশ করার চেয়ে "ভুল কোড" বলা নিরাপদ।
 */
function decrypt(packed) {
  if (!packed || typeof packed !== 'string') return null;
  if (!isEncrypted(packed)) return packed; // পুরনো প্লেইনটেক্সট — ব্যাকওয়ার্ড কম্প্যাটিবল
  const key = getKey();
  if (!key) return null;
  const parts = packed.split(':');
  try {
    const iv = Buffer.from(parts[1], 'base64');
    const authTag = Buffer.from(parts[2], 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()]).toString('utf8');
  } catch (e) {
    console.error('secretBox: ডিক্রিপ্ট করা যায়নি (এনক্রিপশন কী পরিবর্তিত হয়েছে?)');
    return null;
  }
}

module.exports = { encrypt, decrypt, isEncrypted, isAvailable };
