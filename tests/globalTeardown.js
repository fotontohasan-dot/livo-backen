// tests/globalTeardown.js
const fs = require('fs');
const { PID_FILE } = require('./helpers/testServerConfig');

module.exports = async function globalTeardown() {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8'), 10);
    if (pid) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch (e) {
        // প্রসেস আগে থেকেই বন্ধ থাকলে সমস্যা নেই
      }
    }
  } catch (e) {
    // pid ফাইল না থাকলে (globalSetup ব্যর্থ হয়ে থাকলে) সমস্যা নেই
  } finally {
    try { fs.unlinkSync(PID_FILE); } catch (e) {}
  }
};
