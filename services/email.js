const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  },
  tls: {
    rejectUnauthorized: false
  }
});

async function sendOTP(email, otp) {
  await transporter.sendMail({
    from: `"LIVO" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: 'LIVO - আপনার OTP কোড',
    html: `
      <div style="font-family:sans-serif;max-width:400px;margin:auto;padding:20px;border:1px solid #eee;border-radius:10px">
        <h2 style="color:#e53e3e">LIVO</h2>
        <p>আপনার OTP কোড:</p>
        <h1 style="color:#e53e3e;letter-spacing:10px">${otp}</h1>
        <p>এই কোড ৫ মিনিটের মধ্যে ব্যবহার করুন।</p>
      </div>
    `
  });
}

async function sendPasswordReset(email, resetUrl) {
  await transporter.sendMail({
    from: `"LIVO" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: 'LIVO - পাসওয়ার্ড রিসেট',
    html: `
      <div style="font-family:sans-serif;max-width:420px;margin:auto;padding:20px;border:1px solid #eee;border-radius:10px">
        <h2 style="color:#e53e3e">LIVO</h2>
        <p>আপনার অ্যাকাউন্টের পাসওয়ার্ড রিসেট করার অনুরোধ পাওয়া গেছে।</p>
        <p>নিচের বাটনে ক্লিক করে নতুন পাসওয়ার্ড সেট করুন:</p>
        <p style="text-align:center;margin:24px 0">
          <a href="${resetUrl}" style="background:#e53e3e;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:bold;display:inline-block">পাসওয়ার্ড রিসেট করুন</a>
        </p>
        <p style="font-size:13px;color:#666">এই লিঙ্কটি ১ ঘণ্টার জন্য কার্যকর থাকবে। আপনি যদি এই অনুরোধ না করে থাকেন, তাহলে এই ইমেইলটি উপেক্ষা করুন — আপনার পাসওয়ার্ড অপরিবর্তিত থাকবে।</p>
      </div>
    `
  });
}

async function sendVerificationEmail(email, verifyUrl) {
  await transporter.sendMail({
    from: `"LIVO" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: 'LIVO - আপনার ইমেইল ভেরিফাই করুন',
    html: `
      <div style="font-family:sans-serif;max-width:420px;margin:auto;padding:20px;border:1px solid #eee;border-radius:10px">
        <h2 style="color:#e53e3e">LIVO</h2>
        <p>আপনার অ্যাকাউন্টের ইমেইল ভেরিফাই করতে নিচের বাটনে ক্লিক করুন:</p>
        <p style="text-align:center;margin:24px 0">
          <a href="${verifyUrl}" style="background:#e53e3e;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:bold;display:inline-block">ইমেইল ভেরিফাই করুন</a>
        </p>
        <p style="font-size:13px;color:#666">এই লিঙ্কটি ২৪ ঘণ্টার জন্য কার্যকর থাকবে। আপনি যদি এই অ্যাকাউন্ট না খুলে থাকেন, তাহলে এই ইমেইলটি উপেক্ষা করুন।</p>
      </div>
    `
  });
}

async function sendNewDeviceAlert(email, { username, deviceName, ip, location, time }) {
  const timeStr = new Date(time).toLocaleString('bn-BD', { dateStyle: 'medium', timeStyle: 'short' });
  await transporter.sendMail({
    from: `"LIVO" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: 'LIVO - নতুন ডিভাইস থেকে লগইন শনাক্ত হয়েছে',
    html: `
      <div style="font-family:sans-serif;max-width:440px;margin:auto;padding:20px;border:1px solid #eee;border-radius:10px">
        <h2 style="color:#e53e3e">LIVO</h2>
        <p>প্রিয় ${username || ''},</p>
        <p>আপনার অ্যাকাউন্টে একটা নতুন ডিভাইস থেকে লগইন হয়েছে:</p>
        <table style="width:100%;font-size:14px;color:#333;margin:16px 0;border-collapse:collapse">
          <tr><td style="padding:4px 0;color:#888">ডিভাইস</td><td style="padding:4px 0;font-weight:bold">${deviceName || 'অজানা'}</td></tr>
          <tr><td style="padding:4px 0;color:#888">IP ঠিকানা</td><td style="padding:4px 0;font-weight:bold">${ip || 'অজানা'}</td></tr>
          <tr><td style="padding:4px 0;color:#888">আনুমানিক স্থান</td><td style="padding:4px 0;font-weight:bold">${location || 'অজানা'}</td></tr>
          <tr><td style="padding:4px 0;color:#888">সময়</td><td style="padding:4px 0;font-weight:bold">${timeStr}</td></tr>
        </table>
        <p style="font-size:13px;color:#666">এটা যদি আপনি না করে থাকেন, অবিলম্বে আপনার পাসওয়ার্ড পরিবর্তন করুন এবং 2FA চালু করুন।</p>
      </div>
    `
  });
}

async function sendDeviceTrustedAlert(email, { username, deviceName, ip, location, time }) {
  const timeStr = new Date(time).toLocaleString('bn-BD', { dateStyle: 'medium', timeStyle: 'short' });
  await transporter.sendMail({
    from: `"LIVO" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: 'LIVO - একটি ডিভাইস Trusted করা হয়েছে',
    html: `
      <div style="font-family:sans-serif;max-width:440px;margin:auto;padding:20px;border:1px solid #eee;border-radius:10px">
        <h2 style="color:#10b981">LIVO</h2>
        <p>প্রিয় ${username || ''},</p>
        <p>আপনার অ্যাকাউন্টে একটা ডিভাইসকে "Trusted" হিসেবে চিহ্নিত করা হয়েছে:</p>
        <table style="width:100%;font-size:14px;color:#333;margin:16px 0;border-collapse:collapse">
          <tr><td style="padding:4px 0;color:#888">ডিভাইস</td><td style="padding:4px 0;font-weight:bold">${deviceName || 'অজানা'}</td></tr>
          <tr><td style="padding:4px 0;color:#888">IP ঠিকানা</td><td style="padding:4px 0;font-weight:bold">${ip || 'অজানা'}</td></tr>
          <tr><td style="padding:4px 0;color:#888">আনুমানিক স্থান</td><td style="padding:4px 0;font-weight:bold">${location || 'অজানা'}</td></tr>
          <tr><td style="padding:4px 0;color:#888">সময়</td><td style="padding:4px 0;font-weight:bold">${timeStr}</td></tr>
        </table>
        <p style="font-size:13px;color:#666">এটা যদি আপনি না করে থাকেন, অবিলম্বে আপনার পাসওয়ার্ড পরিবর্তন করুন এবং Trusted Devices তালিকা চেক করুন।</p>
      </div>
    `
  });
}

async function sendDeviceRemovedAlert(email, { username, deviceName, ip, location, time }) {
  const timeStr = new Date(time).toLocaleString('bn-BD', { dateStyle: 'medium', timeStyle: 'short' });
  await transporter.sendMail({
    from: `"LIVO" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: 'LIVO - একটি Trusted ডিভাইস সরানো হয়েছে',
    html: `
      <div style="font-family:sans-serif;max-width:440px;margin:auto;padding:20px;border:1px solid #eee;border-radius:10px">
        <h2 style="color:#e53e3e">LIVO</h2>
        <p>প্রিয় ${username || ''},</p>
        <p>আপনার অ্যাকাউন্টের Trusted Devices তালিকা থেকে একটি ডিভাইস সরিয়ে ফেলা হয়েছে (লগ-আউট করা হয়েছে):</p>
        <table style="width:100%;font-size:14px;color:#333;margin:16px 0;border-collapse:collapse">
          <tr><td style="padding:4px 0;color:#888">ডিভাইস</td><td style="padding:4px 0;font-weight:bold">${deviceName || 'অজানা'}</td></tr>
          <tr><td style="padding:4px 0;color:#888">IP ঠিকানা</td><td style="padding:4px 0;font-weight:bold">${ip || 'অজানা'}</td></tr>
          <tr><td style="padding:4px 0;color:#888">আনুমানিক স্থান</td><td style="padding:4px 0;font-weight:bold">${location || 'অজানা'}</td></tr>
          <tr><td style="padding:4px 0;color:#888">সময়</td><td style="padding:4px 0;font-weight:bold">${timeStr}</td></tr>
        </table>
        <p style="font-size:13px;color:#666">এটা যদি আপনি না করে থাকেন, অবিলম্বে আপনার পাসওয়ার্ড পরিবর্তন করুন।</p>
      </div>
    `
  });
}

async function verifyConnection() {
  await transporter.verify();
  return true;
}

module.exports = { sendOTP, sendPasswordReset, sendVerificationEmail, sendNewDeviceAlert, sendDeviceTrustedAlert, sendDeviceRemovedAlert, sendQueuedEmail, verifyConnection };

/**
 * ইমেইল কিউতে জমা দেয় (BullMQ Email Queue — ব্যাকগ্রাউন্ড ওয়ার্কার পাঠাবে, ব্যর্থ হলে অটো-রিট্রাই সহ)।
 * Redis/Queue বন্ধ থাকলে queues/producers.js নিজে থেকেই সরাসরি পাঠিয়ে দেয় — কখনো ইমেইল হারায় না।
 * kind: 'otp' | 'password_reset' | 'verification'
 */
async function sendQueuedEmail(kind, to, data = {}) {
  try {
    const result = await require('../queues').enqueueEmail(kind, { to, ...data });
    return result;
  } catch (err) {
    console.error('sendQueuedEmail error:', err.message);
    try {
      if (kind === 'otp') await sendOTP(to, data.otp);
      else if (kind === 'password_reset') await sendPasswordReset(to, data.resetUrl);
      else if (kind === 'verification') await sendVerificationEmail(to, data.verifyUrl);
      else throw new Error(`অজানা email kind: ${kind}`);
      return { queued: false, sentDirectly: true };
    } catch (err2) {
      console.error('sendQueuedEmail direct-send fallback error:', err2.message);
      return { queued: false, sentDirectly: false, error: err2.message };
    }
  }
}
