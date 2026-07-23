// queues/processors/notification.js
const { sendPushToAdmins } = require('../../services/push');

async function processNotificationJob(job) {
  const { data } = job;
  return sendPushToAdmins(job.name, data.title, data.message);
}

module.exports = { processNotificationJob };
