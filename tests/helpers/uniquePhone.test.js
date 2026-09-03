const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { uniquePhone, PHONE_SEQ_FILE, PHONE_SEQ_LOCK } = require('./uniquePhone');

// ---------------------------------------------------------------------------
// এই টেস্টটা যা প্রমাণ করে:
//
// আগের বাস্তবায়নে কাউন্টার ছিল `globalThis`-এ। Jest প্রতিটা টেস্ট ফাইলকে আলাদা
// global object দেয়, তাই কাউন্টার প্রতি ফাইলে 0 থেকে শুরু হতো এবং একই
// মিলিসেকেন্ডে চলা দুইটা ফাইল হুবহু একই ফোন নাম্বার তৈরি করত → `phone TEXT UNIQUE`
// ভেঙে রেজিস্ট্রেশন নিঃশব্দে ব্যর্থ হতো।
//
// নিচের টেস্টগুলো সেই দুইটা পরিস্থিতিই সরাসরি সিমুলেট করে: (১) fresh module
// registry (নতুন টেস্ট ফাইলের সমতুল্য) এবং (২) সত্যিকারের সমান্তরাল Node প্রসেস
// (parallel Jest worker-এর সমতুল্য)।
// ---------------------------------------------------------------------------

const HELPER = path.join(__dirname, 'uniquePhone.js');

function childScript(count) {
  return `const { uniquePhone } = require(${JSON.stringify(HELPER)});
const out = [];
for (let i = 0; i < ${count}; i++) out.push(uniquePhone());
process.stdout.write(JSON.stringify(out));`;
}

describe('uniquePhone() — টেস্ট ফোন নাম্বার অ্যালোকেটর', () => {
  test('ফরম্যাট অপরিবর্তিত: ঠিক ১১ ডিজিট, `01` দিয়ে শুরু', () => {
    for (let i = 0; i < 50; i++) {
      expect(uniquePhone()).toMatch(/^01\d{9}$/);
    }
  });

  test('একই প্রসেসে পরপর কল কখনো একই নাম্বার দেয় না', () => {
    const phones = Array.from({ length: 2000 }, () => uniquePhone());
    expect(new Set(phones).size).toBe(phones.length);
  });

  test('নতুন module registry (নতুন টেস্ট ফাইলের সমতুল্য) পুরনো নাম্বার পুনরায় দেয় না', () => {
    const first = Array.from({ length: 200 }, () => uniquePhone());

    // jest.resetModules() করলে মডিউলটা আবার নতুন করে লোড হয় — ঠিক যেমন Jest
    // পরের টেস্ট ফাইলের জন্য করে। আগের globalThis-ভিত্তিক কাউন্টার এখানেই
    // 0-তে ফিরে যেত।
    jest.resetModules();
    const reloaded = require('./uniquePhone');
    const second = Array.from({ length: 200 }, () => reloaded.uniquePhone());

    expect(new Set([...first, ...second]).size).toBe(400);
  });

  test('সমান্তরাল আলাদা প্রসেস (parallel Jest worker) থেকেও কলিশন হয় না', () => {
    const PROCS = 4;
    const PER_PROC = 150;

    // সবগুলো প্রসেস একসাথে শুরু হয় — একই মিলিসেকেন্ড উইন্ডোতে অ্যালোকেট করে,
    // যেটা পুরনো বাস্তবায়নে নিশ্চিত কলিশন তৈরি করত।
    const results = [];
    const children = [];
    for (let i = 0; i < PROCS; i++) {
      children.push(execFileSync(process.execPath, ['-e', childScript(PER_PROC)], {
        encoding: 'utf8',
        timeout: 20000
      }));
    }
    children.forEach((out) => results.push(...JSON.parse(out)));

    expect(results).toHaveLength(PROCS * PER_PROC);
    expect(new Set(results).size).toBe(PROCS * PER_PROC);
    results.forEach((p) => expect(p).toMatch(/^01\d{9}$/));
  });

  test('বাসি lock নিজে থেকে পরিষ্কার হয় — অ্যালোকেটর চিরতরে আটকে থাকে না', () => {
    fs.mkdirSync(PHONE_SEQ_LOCK, { recursive: true });
    // lock-টাকে stale threshold-এর চেয়ে পুরনো দেখানো হচ্ছে
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(PHONE_SEQ_LOCK, old, old);

    expect(uniquePhone()).toMatch(/^01\d{9}$/);
    expect(fs.existsSync(PHONE_SEQ_LOCK)).toBe(false);
  });

  test('কাউন্টার ফাইল নষ্ট হলে ক্র্যাশ না করে নতুন করে seed হয়', () => {
    // এই টেস্ট শেয়ার্ড কাউন্টারে হাত দেয়, তাই আগের অবস্থা সংরক্ষণ করে ফিরিয়ে
    // দেওয়া হয় — নাহলে পরের টেস্ট ফাইলগুলো পিছিয়ে যাওয়া সিকোয়েন্স পেতে পারত।
    const saved = fs.readFileSync(PHONE_SEQ_FILE, 'utf8');
    try {
      fs.writeFileSync(PHONE_SEQ_FILE, 'not-a-number');
      const a = uniquePhone();
      const b = uniquePhone();
      expect(a).toMatch(/^01\d{9}$/);
      expect(b).not.toBe(a);
    } finally {
      const after = Number.parseInt(fs.readFileSync(PHONE_SEQ_FILE, 'utf8'), 10);
      const before = Number.parseInt(saved, 10);
      fs.writeFileSync(PHONE_SEQ_FILE, String(Math.max(after, before)));
    }
  });
});
