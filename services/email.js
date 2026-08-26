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
  },
  // অনেক হোস্টিং প্রোভাইডার (Render ইত্যাদি) আউটবাউন্ড SMTP পোর্ট ব্লক করে দেয় —
  // timeout ছাড়া nodemailer তখন OS-লেভেল TCP timeout (৬০-১২০+ সেকেন্ড) পর্যন্ত ঝুলে থাকে।
  // এই তিনটা timeout সেট করা থাকলে ব্যর্থ হলে দ্রুত (কয়েক সেকেন্ডে) ব্যর্থ হবে, ঝুলে থাকবে না —
  // যেকোনো caller ভুলবশত এটাকে await করলেও (যেমন register route) পুরো রিকোয়েস্ট দীর্ঘক্ষণ আটকাবে না।
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 10000
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

/**
 * routes/auth.js (register/resend-verification/forgot-password/login-OTP) এই ফাংশনটা কল করে
 * ধরে নিয়ে যে এটা আছে — কিন্তু আগে এটা এই ফাইলে এক্সপোর্টই করা ছিল না (শুধু sendOTP/
 * sendPasswordReset/sendVerificationEmail/sendNewDeviceAlert ছিল), ফলে সব verification/
 * password-reset/OTP ইমেইল বাস্তবে কখনো পাঠানো হয়নি — কল করার সাথে সাথেই
 * "sendQueuedEmail is not a function" থ্রো হয়ে সাইলেন্টলি catch হয়ে যেত।
 *
 * services/queue.js-এ ইতিমধ্যে একটা সঠিক 'email' job handler আছে (services/queueHandlers.js,
 * payload.kind অনুযায়ী sendOTP/sendPasswordReset/sendVerificationEmail-এ dispatch করে) —
 * এই ফাংশন সেই queue-তে enqueue করে, যাতে আসল ইমেইল পাঠানো ব্যাকগ্রাউন্ড ওয়ার্কারে (রিট্রাই/
 * ব্যাকঅফসহ) হয়, কোনো HTTP রিকোয়েস্ট কখনো SMTP-এর জন্য অপেক্ষা না করে।
 */
async function sendQueuedEmail(kind, to, data = {}) {
  const { enqueue } = require('./queue');
  return enqueue('email', { kind, to, ...data });
}

module.exports = { sendOTP, sendPasswordReset, sendVerificationEmail, sendNewDeviceAlert, sendQueuedEmail };
