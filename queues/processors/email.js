// queues/processors/email.js
const { sendOTP, sendPasswordReset, sendVerificationEmail } = require('../../services/email');

async function processEmailJob(job) {
  const { name, data } = job;
  const to = data.to || data.email; // ব্যাকওয়ার্ড কম্প্যাটিবিলিটি — দুটো ফিল্ড নেমই সাপোর্ট করে
  switch (name) {
    case 'otp':
      return sendOTP(to, data.otp);
    case 'password_reset':
      return sendPasswordReset(to, data.resetUrl);
    case 'verification':
      return sendVerificationEmail(to, data.verifyUrl);
    default:
      throw new Error(`Unknown email job type: ${name}`);
  }
}

module.exports = { processEmailJob };
