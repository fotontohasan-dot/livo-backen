const fs = require('fs');
const path = require('path');

// ==================== Phase 17: লগে সংবেদনশীল ডেটা ====================
//
// roadmap Phase 17: "Sensitive data কখনো logs-এ রাখবে না।"
//
// লগ একটা সহজে ভুলে যাওয়া ফাঁস-পথ: ডিবাগ করার সময় কেউ একটা
// console.log(req.body) বসিয়ে দেয়, তারপর সেটা কমিট হয়ে যায়। প্রোডাকশনে
// ওই লাইনটা পাসওয়ার্ড, OTP, withdraw PIN বা সেশন টোকেন সরাসরি লগে লিখতে
// থাকে — আর লগ সাধারণত অনেক বেশি মানুষের নাগালে থাকে, অনেক দিন থাকে,
// এবং তৃতীয় পক্ষের সিস্টেমে (Sentry, log aggregator) চলেও যায়।
//
// বর্তমান অবস্থা যাচাই করে দেখা গেছে: কোথাও আসল মান লগ হয় না। যেখানে
// "password"/"pin" শব্দটা আছে সেগুলো লগ *বার্তা*, মান নয় (err.message)।
//
// এই টেস্ট সেই অবস্থাটা ধরে রাখে।

const ROOT = path.join(__dirname, '..', '..');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const SOURCES = ['routes', 'services', 'middleware', 'queues', 'utils']
  .filter((d) => fs.existsSync(path.join(ROOT, d)))
  .flatMap((d) => walk(path.join(ROOT, d)))
  .concat(['app.js', 'server.js', 'telegram-bot.js']
    .map((f) => path.join(ROOT, f))
    .filter((f) => fs.existsSync(f)));

// পুরো request body লগ করা — সবচেয়ে সাধারণ ভুল
const BODY_DUMP = /console\.\w+\([^)]*(req\.body|JSON\.stringify\(\s*req\.body)/;

// সংবেদনশীল ভেরিয়েবল সরাসরি আর্গুমেন্ট হিসেবে
const RAW_SECRET = /console\.\w+\([^)]*\b(password|newPassword|token|accessToken|refreshToken|otp|pin|withdraw_pin|secret|apiKey|api_key)\b\s*[,)]/;

describe('Phase 17 — লগে সংবেদনশীল ডেটা যায় না', () => {
  test('সোর্স স্ক্যান কাজ করছে', () => {
    // তালিকা খালি হলে নিচের sweep অর্থহীনভাবে পাস করত।
    expect(SOURCES.length).toBeGreaterThan(20);
  });

  test('কোথাও পুরো req.body লগ হয় না', () => {
    const offenders = [];
    for (const file of SOURCES) {
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (BODY_DUMP.test(line)) {
          offenders.push(path.relative(ROOT, file) + ':' + (i + 1));
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  test('সংবেদনশীল ভেরিয়েবল সরাসরি লগ হয় না', () => {
    const offenders = [];
    for (const file of SOURCES) {
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (RAW_SECRET.test(line)) {
          offenders.push(path.relative(ROOT, file) + ':' + (i + 1) + ' ' + line.trim().slice(0, 80));
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  test('regex সত্যিই ধরতে পারে (self-check)', () => {
    // গার্ড টেস্টের নিজের regex ভেঙে গেলে উপরের দুটো চিরকাল সবুজ থাকত।
    expect(BODY_DUMP.test("console.log('debug', req.body);")).toBe(true);
    expect(BODY_DUMP.test('console.error(JSON.stringify(req.body));')).toBe(true);
    expect(RAW_SECRET.test('console.log(password);')).toBe(true);
    expect(RAW_SECRET.test("console.warn('otp sent', otp);")).toBe(true);

    // বৈধ ব্যবহার মিথ্যা সংকেত দেবে না — বার্তায় শব্দটা থাকলেও মান নয়
    expect(RAW_SECRET.test("console.error('withdraw pin verification error:', e.message);")).toBe(false);
    expect(BODY_DUMP.test("console.error('reset-password error:', err.message);")).toBe(false);
  });
});
