// tests/helpers/uniquePhoneIsolation.test.js
// ---------------------------------------------------------------------------
// রিগ্রেশন — tests/helpers/app.js-এর uniquePhone() একাধিক টেস্ট ফাইলের মধ্যেও
// অনন্য নাম্বার দেয় কি না।
//
// পুরনো বাস্তবায়ন কাউন্টার রাখত globalThis-এ, এই মন্তব্যসহ যে "globalThis পুরো Jest
// প্রসেসে শেয়ার্ড"। সেটা ভুল। পরীক্ষা করে দেখা গেছে, Jest প্রতিটা টেস্ট *ফাইলকে*
// আলাদা sandbox global দেয় (process.env-ও তাই): একই প্রসেসে (pid অভিন্ন) চলা দুটো
// ফাইল দুজনেই কাউন্টার ১ পড়ে, ২ নয়। ফলে দুটো ফাইল একই মিলিসেকেন্ডে কল করলে হুবহু
// একই নাম্বার তৈরি হতো, `phone TEXT UNIQUE` রেজিস্ট্রেশন ফিরিয়ে দিত, আর টেস্ট ভাঙত:
//     TypeError: Cannot read properties of undefined (reading 'id')
//
// এই টেস্ট বাগের দুটো পূর্বশর্তই নির্ধারিতভাবে তৈরি করে — (ক) ঘড়ি স্থির, অর্থাৎ দুটো
// "ফাইল" একই মিলিসেকেন্ডে, আর (খ) মডিউল রেজিস্ট্রি ও global নতুন, অর্থাৎ ঠিক যেমন
// Jest নতুন ফাইলকে দেয়। সত্যিকারের প্যারালাল প্রসেস দিয়ে দৌড় করানোর চেষ্টা করা
// হয়েছিল, কিন্তু setTimeout-এর jitter-এ প্রসেসগুলো কখনোই একই মিলিসেকেন্ডে পড়ে না —
// সেই টেস্ট ভাঙা কোডেও পাস করে যেত, তাই সেটা কোনো প্রমাণই দিত না।
// ---------------------------------------------------------------------------

const { uniquePhone } = require('./app');

// একটা "নতুন টেস্ট ফাইল" নকল করে। ফাইলে ফাইলে আসলে যা বদলায় তা হলো sandbox global —
// Jest প্রতিটা ফাইলকে নতুন global দেয়, তাই globalThis-এ রাখা কাউন্টার শূন্য থেকে শুরু হয়।
// (হেল্পারটা module load-এ beforeAll/afterAll রেজিস্টার করে, তাই jest.resetModules()
// দিয়ে টেস্টের ভেতরে re-require করা যায় না — Jest তখন "Hooks cannot be defined inside
// tests" বলে ব্যর্থ হয়।)
function simulateNewTestFile() {
  delete globalThis.__livoPhoneSeq;
}

describe('uniquePhone() — টেস্ট ফাইল জুড়ে অনন্যতা', () => {
  jest.setTimeout(60000);
  let realNow;

  beforeEach(() => { realNow = Date.now; });
  afterEach(() => { Date.now = realNow; });

  test('অ্যাপ্লিকেশনের প্রত্যাশিত ফরম্যাট অপরিবর্তিত (01 + ৯ ডিজিট)', () => {
    simulateNewTestFile();
    for (let i = 0; i < 200; i++) expect(uniquePhone()).toMatch(/^01\d{9}$/);
  });

  test('একই প্রসেসে বহু কলেও কলিশন নেই', () => {
    simulateNewTestFile();
    const seen = new Set();
    for (let i = 0; i < 5000; i++) seen.add(uniquePhone());
    expect(seen.size).toBe(5000);
  });

  test('একই মিলিসেকেন্ডে দুটো ভিন্ন "ফাইল" কখনো একই নাম্বার দেয় না', () => {
    const frozen = 1750000000000;
    Date.now = () => frozen;

    simulateNewTestFile();
    const batchA = Array.from({ length: 50 }, () => uniquePhone());

    simulateNewTestFile();
    const batchB = Array.from({ length: 50 }, () => uniquePhone());

    // পুরনো কোডে দুটো ব্যাচ হুবহু অভিন্ন হতো (দুটোতেই কাউন্টার ০০১ থেকে শুরু) —
    // এই assertion তখন ফেল করত।
    expect(batchB).not.toEqual(batchA);
    expect(batchA.filter((p) => batchB.includes(p))).toEqual([]);

    const all = [...batchA, ...batchB];
    expect(new Set(all).size).toBe(all.length);
    all.forEach((p) => expect(p).toMatch(/^01\d{9}$/));
  });

  test('একই মিলিসেকেন্ডে বহু "ফাইল" চললেও কলিশন নেই', () => {
    Date.now = () => 1750000001000;
    const all = [];
    for (let f = 0; f < 8; f++) {
      simulateNewTestFile();
      for (let i = 0; i < 40; i++) all.push(uniquePhone());
    }
    expect(new Set(all).size).toBe(all.length);
  });
});
