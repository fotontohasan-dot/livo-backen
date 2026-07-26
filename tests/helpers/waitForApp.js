// tests/helpers/waitForApp.js
// ---------------------------------------------------------------------------
// app.js require হওয়ার সাথে সাথে startServer() async ভাবে চলা শুরু করে
// (DB connect → migration → ensureCriticalTables → queue init → listen)।
// প্রোডাকশন কোড পরিবর্তন না করেই টেস্ট থেকে "কখন অ্যাপ সম্পূর্ণ প্রস্তুত হলো"
// জানার জন্য এই হেল্পার দুই ধাপে যাচাই করে:
//
//   ১) /ready এন্ডপয়েন্ট — শুধু DB connectivity নিশ্চিত করে (দ্রুত, কিন্তু
//      migrations.js/ensureCriticalTables.js তখনো ব্যাকগ্রাউন্ডে চলতে থাকতে পারে)।
//   ২) migrations.js-এর একদম শেষে তৈরি হওয়া টেবিল ('roles') এবং
//      ensureCriticalTables.js-এর একদম শেষে তৈরি হওয়া টেবিল
//      ('notification_templates') — দুটোই DB-তে আছে কিনা পোল করে, যা
//      নিশ্চিত করে পুরো migration/bootstrap সিকোয়েন্স সম্পূর্ণ শেষ হয়েছে।
// ---------------------------------------------------------------------------

const request = require('supertest');
const { pool } = require('../../db');

async function waitForDbReady(app, { retries = 20, delayMs = 500 } = {}) {
  let lastError = null;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await request(app).get('/ready');
      if (res.status === 200 && res.body && res.body.ready === true) return true;
      lastError = new Error(`/ready responded with status ${res.status}: ${JSON.stringify(res.body)}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`App DB did not become reachable in time: ${lastError && lastError.message}`);
}

async function waitForMigrationsComplete({ retries = 40, delayMs = 500 } = {}) {
  let lastError = null;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await pool.query(
        `SELECT to_regclass('public.roles') AS roles, to_regclass('public.notification_templates') AS templates`
      );
      const row = res.rows[0];
      if (row && row.roles && row.templates) return true;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`Database migrations did not finish in time: ${lastError && lastError.message}`);
}

async function waitForApp(app, opts = {}) {
  await waitForDbReady(app, opts);
  await waitForMigrationsComplete(opts);
  return true;
}

module.exports = { waitForApp };
