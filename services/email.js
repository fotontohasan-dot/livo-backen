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

module.exports = { sendOTP, sendPasswordReset };
