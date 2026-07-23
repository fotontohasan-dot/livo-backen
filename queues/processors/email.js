// queues/processors/email.js
const { sendOTP, sendPasswordReset } = require('../../services/email');

async function processEmailJob(job) {
  const { name, data } = job;
  switch (name) {
    case 'otp':
      return sendOTP(data.email, data.otp);
    case 'password_reset':
      return sendPasswordReset(data.email, data.resetUrl);
    default:
      throw new Error(`Unknown email job type: ${name}`);
  }
}

module.exports = { processEmailJob };
