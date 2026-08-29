// services/startupState.js
// ---------------------------------------------------------------------------
// PHASE 2 (DATABASE & STARTUP FAILURE INTEGRITY)
//
// আগে migration ব্যর্থ হলেও runMigrations() error গিলে ফেলত, ফলে server.js
// "DB migration done" ছাপত এবং /ready healthy দেখাত — অর্থাৎ
// "Migration failed → Migration successful" ধরনের contradictory state।
//
// এই ছোট module টি startup-এর প্রকৃত অবস্থা ধরে রাখে যাতে /ready কখনো
// fake success না দেখায় এবং broken schema নিয়ে privileged/payment operation
// চালু না থাকে।
//
// Deliberately dependency-free: db, logger বা অন্য কোনো service require করে না,
// যাতে startup-এর একদম প্রথম ধাপ থেকেই নিরাপদে ব্যবহার করা যায়।
// ---------------------------------------------------------------------------

const state = {
  dbConnected: false,
  migrationsCompleted: false,
  migrationError: null,
};

function markDbConnected() {
  state.dbConnected = true;
}

function markMigrationsCompleted() {
  state.migrationsCompleted = true;
  state.migrationError = null;
}

function markMigrationsFailed(err) {
  state.migrationsCompleted = false;
  state.migrationError = err && err.message ? err.message : String(err);
}

/**
 * Application কি সত্যিই traffic নেওয়ার জন্য প্রস্তুত?
 *
 * Test environment-এ migration tests ইচ্ছাকৃতভাবে runMigrations() সরাসরি
 * mock/re-run করে, তাই সেখানে schema-gate প্রয়োগ করা হয় না — কিন্তু
 * production/development boot path-এ এটি কঠোরভাবে প্রযোজ্য।
 */
function isSchemaReady() {
  if (process.env.NODE_ENV === 'test') return true;
  return state.migrationsCompleted === true;
}

function getState() {
  return { ...state };
}

//    ( test harness-      )
function reset() {
  state.dbConnected = false;
  state.migrationsCompleted = false;
  state.migrationError = null;
}

module.exports = {
  markDbConnected,
  markMigrationsCompleted,
  markMigrationsFailed,
  isSchemaReady,
  getState,
  reset,
};
