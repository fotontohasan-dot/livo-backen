// queues/deadLetter.js
// একটা job তার সব রিট্রাই (attempts) শেষ করে ফেললে, সেটাকে "Dead Letter"
// হিসেবে ধরে নিয়ে Postgres-এ স্থায়ীভাবে সেভ করা হয় — যাতে Redis থেকে জবটা
// মুছে গেলেও (TTL/cleanup) অ্যাডমিন প্যানেল থেকে দেখা ও ম্যানুয়ালি রিট্রাই করা যায়।

const { QueueEvents } = require('bullmq');
const { connection } = require('./connection');
const { pool } = require('../db');
const { QUEUE_NAMES, getQueue } = require('./definitions');

let queueEventsList = [];

function startDeadLetterListeners() {
  if (!connection) return;

  queueEventsList = Object.values(QUEUE_NAMES).map((name) => {
    const qe = new QueueEvents(name, { connection });

    qe.on('failed', async ({ jobId, failedReason }) => {
      try {
        const queue = getQueue(name);
        if (!queue) return;
        const job = await queue.getJob(jobId);
        if (!job) return;

        const maxAttempts = job.opts.attempts || 1;
        // সব রিট্রাই শেষ হয়ে গেলে তবেই এটা সত্যিকারের "Dead Letter"
        if (job.attemptsMade < maxAttempts) return;

        await pool.query(
          `INSERT INTO queue_dead_letter (queue_name, job_id, job_name, job_data, failed_reason, attempts_made, stacktrace)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (queue_name, job_id) DO NOTHING`,
          [
            name,
            String(jobId),
            job.name,
            JSON.stringify(job.data || {}),
            failedReason || null,
            job.attemptsMade,
            Array.isArray(job.stacktrace) ? job.stacktrace.join('\n') : null
          ]
        );
        console.warn(`💀 [DeadLetter] ${name}/${job.name} job #${jobId} সব রিট্রাই শেষে dead-letter-এ সরানো হয়েছে`);
      } catch (err) {
        console.error('⚠️ Dead-letter সেভ করতে সমস্যা হয়েছে:', err.message);
      }
    });

    return qe;
  });
}

async function stopDeadLetterListeners() {
  await Promise.all(queueEventsList.map((qe) => qe.close()));
}

// অ্যাডমিন প্যানেল থেকে একটা dead-letter জব আবার মূল Queue-তে পাঠানো (retry)
async function retryDeadLetterJob(id) {
  const res = await pool.query('SELECT * FROM queue_dead_letter WHERE id=$1', [id]);
  const row = res.rows[0];
  if (!row) throw new Error('Dead-letter job পাওয়া যায়নি');

  const queue = getQueue(row.queue_name);
  if (!queue) throw new Error('Queue System বর্তমানে বন্ধ (Redis সংযুক্ত নেই)');

  await queue.add(row.job_name, row.job_data, { attempts: 3, backoff: { type: 'exponential', delay: 3000 } });
  await pool.query(
    `UPDATE queue_dead_letter SET retried_at = NOW(), status = 'retried' WHERE id=$1`,
    [id]
  );
  return true;
}

async function deleteDeadLetterJob(id) {
  await pool.query('DELETE FROM queue_dead_letter WHERE id=$1', [id]);
  return true;
}

module.exports = {
  startDeadLetterListeners,
  stopDeadLetterListeners,
  retryDeadLetterJob,
  deleteDeadLetterJob
};
