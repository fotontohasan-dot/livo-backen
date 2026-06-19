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

module.exports = { sendOTP };
