// ---------------------------------------------------------------------------
// কেন globalThis কাউন্টার যথেষ্ট নয়:
//
// Jest প্রতিটা টেস্ট ফাইলকে নিজস্ব module registry *এবং* নিজস্ব global object
// দিয়ে চালায়। তাই `globalThis.__livoPhoneSeq` প্রতি ফাইলে আবার 0 থেকে শুরু হয়।
// দুইটা ভিন্ন ফাইল একই মিলিসেকেন্ডে (Date.now() % 1e6 একই) প্রথম কল করলে
// দুইজনেই seq = 001 পেত → হুবহু একই ফোন নাম্বার। `phone TEXT UNIQUE` দ্বিতীয়
// রেজিস্ট্রেশন প্রত্যাখ্যান করত, রেজিস্ট্রেশন নিঃশব্দে ব্যর্থ হতো এবং টেস্ট
// `TypeError: Cannot read properties of undefined (reading 'id')` বা টাইমআউট
// দিয়ে ফেল করত — সম্পূর্ণ টেস্ট-অর্ডার নির্ভরভাবে।
//
// এখানকার সমাধান: কাউন্টারটা ফাইলসিস্টেমে রাখা হয়েছে (os.tmpdir()), একটা
// atomic mkdir-ভিত্তিক mutex দিয়ে সুরক্ষিত। ফলে সিকোয়েন্স —
//   • একই প্রসেসের সব টেস্ট ফাইল জুড়ে শেয়ার্ড (global reset আর প্রভাব ফেলে না),
//   • একাধিক Jest worker প্রসেস জুড়েও শেয়ার্ড (mutex cross-process),
//   • পরপর দুইটা রানের মধ্যেও monotonic — কারণ কাউন্টার ফাইল টিকে থাকে, আর
//     টেস্ট DB রানের মধ্যে truncate হয় না (আগের রানের ফোন নাম্বার এখনো টেবিলে
//     থাকে, তাই রান-জুড়ে ইউনিকনেসও দরকার)।
//
// কাউন্টার প্রথমবার তৈরি হওয়ার সময় সময়-ভিত্তিক মান থেকে seed করা হয়, যাতে
// tmpdir মুছে গেলেও (CI-তে নতুন রানার) নতুন রান পুরনো রেঞ্জে ফিরে না যায়।
//
// ফরম্যাট অপরিবর্তিত: `01` + ৯ ডিজিট = ১১ ডিজিট, ঠিক আগের মতোই।
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const nodePath = require('path');

const PHONE_SEQ_DIR = nodePath.join(os.tmpdir(), 'livo-test-phone-seq');
const PHONE_SEQ_FILE = nodePath.join(PHONE_SEQ_DIR, 'counter');
const PHONE_SEQ_LOCK = nodePath.join(PHONE_SEQ_DIR, 'lock.d');
const PHONE_SPACE = 1e9; // ৯ ডিজিট
const LOCK_STALE_MS = 5000;
const LOCK_MAX_WAIT_MS = 5000;

// ব্যস্ত-অপেক্ষা নয় — Atomics.wait দিয়ে সত্যিকারের ব্লকিং, কিন্তু মাইক্রো-স্কেলে।
// এটা কোনো ফ্লেক ঢাকার জন্য sleep নয়; mutex contention-এর সময় CPU ছেড়ে দেওয়া।
const parkBuffer = new Int32Array(new SharedArrayBuffer(4));
function park(ms) {
  Atomics.wait(parkBuffer, 0, 0, ms);
}

function acquirePhoneLock() {
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(PHONE_SEQ_LOCK); // atomic — একজনই জেতে
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // কোনো প্রসেস lock ধরে রেখে মারা গেলে যাতে চিরতরে আটকে না থাকে
      try {
        const age = Date.now() - fs.statSync(PHONE_SEQ_LOCK).mtimeMs;
        if (age > LOCK_STALE_MS) { fs.rmdirSync(PHONE_SEQ_LOCK); continue; }
      } catch (_) { continue; }
      if (Date.now() > deadline) {
        throw new Error('uniquePhone: sequence lock acquire timed out');
      }
      park(1);
    }
  }
}

function releasePhoneLock() {
  try { fs.rmdirSync(PHONE_SEQ_LOCK); } catch (_) { /* already released */ }
}

function nextPhoneSequence() {
  fs.mkdirSync(PHONE_SEQ_DIR, { recursive: true });
  acquirePhoneLock();
  try {
    let current;
    try {
      current = Number.parseInt(fs.readFileSync(PHONE_SEQ_FILE, 'utf8'), 10);
    } catch (_) {
      current = NaN;
    }
    if (!Number.isFinite(current) || current < 0) {
      // প্রথমবার (বা ফাইল নষ্ট) — সময় থেকে seed, যাতে নতুন মেশিন/মোছা tmpdir-এও
      // পুরনো রানের নাম্বারের সাথে সংঘর্ষ না হয়।
      current = Date.now() % PHONE_SPACE;
    }
    const next = (current + 1) % PHONE_SPACE;
    fs.writeFileSync(PHONE_SEQ_FILE, String(next));
    return next;
  } finally {
    releasePhoneLock();
  }
}

function uniquePhone() {
  return `01${String(nextPhoneSequence()).padStart(9, '0')}`;
}

module.exports = { uniquePhone, nextPhoneSequence, PHONE_SEQ_DIR, PHONE_SEQ_FILE, PHONE_SEQ_LOCK };
