const { scriptOrder, readScript } = require('../helpers/viewScripts');
const fs = require('fs');
const path = require('path');

// docs/CSP.md ধাপ ২ — সাতটা ফাইল। এর মধ্যে withdrawals ও deposits টাকা
// সংক্রান্ত, তাই ওদের জন্য আলাদা ও কড়া যাচাই।

const ROOT = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const HANDLER_RE = /\son(?:click|change|submit|input|load|error|focus|blur|keyup|keydown|mouseover)=/g;

function scriptBlocks(src) {
  return [...src.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}
// docs/CSP.md ধাপ ৩-এ অনেক টেমপ্লেটের কোড public/js/views/-এ সরানো হয়েছে।
// তাই "বাঁধার কোড আর ফাংশনের সংজ্ঞা একই স্কোপে আছে কি না" প্রশ্নটার উত্তর
// এখন ইনলাইন ব্লক আর বাইরের স্ক্রিপ্ট — দুই জায়গাতেই খুঁজতে হয়।
// একটা ফাইল = একটা স্কোপ, তাই সম্পত্তিটা অপরিবর্তিত।
function bindingBlock(src, marker) {
  const candidates = scriptBlocks(src)
    .concat(scriptOrder(src).map(readScript))
    .filter((b) => b.includes(marker));
  expect(candidates.length).toBe(1);
  return candidates[0];
}

const FILES = {
  'accumulator': ['views', 'accumulator.ejs'],
  'profile/referral': ['views', 'profile', 'referral.ejs'],
  'profile': ['views', 'profile.ejs'],
  'admin/queues': ['views', 'admin', 'queues.ejs'],
  'admin/audit-logs': ['views', 'admin', 'audit-logs.ejs'],
  'admin/withdrawals': ['views', 'admin', 'withdrawals.ejs'],
  'admin/deposits': ['views', 'admin', 'deposits.ejs']
};

describe.each(Object.entries(FILES))('%s — ইনলাইন হ্যান্ডলার সরানো হয়েছে', (_name, p) => {
  test('কোনো ইনলাইন হ্যান্ডলার নেই', () => {
    expect(read(...p)).not.toMatch(HANDLER_RE);
  });
});

// ==================== টাকা সংক্রান্ত ====================

describe.each([
  ['withdrawals', ['views', 'admin', 'withdrawals.ejs'], 'withdrawal', 'approveWithdrawal', 'rejectWithdrawal'],
  ['deposits', ['views', 'admin', 'deposits.ejs'], 'deposit', 'approveDeposit', 'rejectDeposit']
])('admin/%s.ejs — approve/reject', (_n, p, prefix, approveFn, rejectFn) => {
  const src = read(...p);
  const block = bindingBlock(src, 'data-' + prefix + '-approve');

  test('approve ও reject আলাদা অ্যাট্রিবিউট', () => {
    // একটাই data-action="approve|reject" হলে মানের একটা টাইপো নীরবে
    // ভুল দিকে নিয়ে যেত। এখানে ভুল মানে টাকা, তাই দুটো আলাদা নাম।
    expect(src).toContain('data-' + prefix + '-approve=');
    expect(src).toContain('data-' + prefix + '-reject=');
  });

  test('id সংখ্যা হিসেবেই ফাংশনে যায়', () => {
    // id সরাসরি API URL-এ বসে; স্ট্রিং গেলে বা NaN হলে ভুল/ব্যর্থ কল হত।
    expect(block).toMatch(new RegExp(approveFn + '\\(Number\\('));
    expect(block).toMatch(new RegExp(rejectFn + '\\(Number\\('));
  });

  test('approve-এর পরে return আছে — একই ক্লিকে দুটো চলে না', () => {
    // ডেলিগেশনে return না থাকলে একটা এলিমেন্টে দুটো অ্যাট্রিবিউট বসে
    // গেলে approve আর reject পরপর চলে যেত।
    expect(block).toMatch(new RegExp(approveFn + '\\(Number\\([\\s\\S]{0,80}?\\); return;'));
  });

  test('ফাংশনগুলোর নিজস্ব নিশ্চিতকরণ অক্ষত', () => {
    expect(block).toMatch(new RegExp('async function ' + approveFn));
    expect(block).toMatch(new RegExp('async function ' + rejectFn));
    // withdrawals prompt() দিয়ে TXN রেফারেন্স চায়, deposits confirm() করে
    expect(/prompt\(|confirm\(/.test(block)).toBe(true);
  });

  test('সারি রানটাইমে বানানো হয় বলে ডেলিগেশন ব্যবহার হয়েছে', () => {
    expect(block).toMatch(/document\.addEventListener\('click'/);
    expect(block).not.toMatch(new RegExp("querySelectorAll\\('\\[data-" + prefix + "-approve\\]'\\)"));
  });
});

// ==================== বাকিগুলো ====================

describe('accumulator.ejs — বেট স্লিপ', () => {
  const src = read('views', 'accumulator.ejs');
  const block = bindingBlock(src, 'data-acca-action');

  test('removePick ডেলিগেশনে, সূচক সংখ্যা হিসেবে', () => {
    // স্লিপের সারি রানটাইমে বানানো হয়; সূচক স্ট্রিং হলে splice ভুল করত।
    expect(block).toMatch(/removePick\(Number\(rm\.getAttribute\('data-remove-pick'\)\)\)/);
  });

  test('clear ও place দুটো আলাদা শাখায়', () => {
    expect(src).toContain('data-acca-action="clear"');
    expect(src).toContain('data-acca-action="place"');
    expect(block).toMatch(/clearSlip\(\)/);
    expect(block).toMatch(/placeAcca\(\)/);
  });
});

describe('admin/queues.ejs — DLQ', () => {
  const src = read('views', 'admin', 'queues.ejs');
  const block = bindingBlock(src, 'data-dlq-retry');

  test('retry ও delete আলাদা অ্যাট্রিবিউট, id সংখ্যা', () => {
    // delete অপরিবর্তনীয়, তাই retry-র সাথে মিশে যাওয়া চলবে না।
    expect(src).toContain('data-dlq-retry="<%= j.id %>"');
    expect(src).toContain('data-dlq-delete="<%= j.id %>"');
    expect(block).toMatch(/retryDlq\(Number\(/);
    expect(block).toMatch(/deleteDlq\(Number\(/);
  });
});

describe('admin/audit-logs.ejs', () => {
  const src = read('views', 'admin', 'audit-logs.ejs');
  const block = bindingBlock(src, 'data-log-detail');

  test('লগ সারি ডেলিগেশনে, id সংখ্যা হিসেবে', () => {
    expect(block).toMatch(/openLogDetail\(Number\(/);
    expect(block).toMatch(/document\.addEventListener\('click'/);
  });
});

describe('কপি/শেয়ার বাটন', () => {
  test.each([
    ['views/profile/referral.ejs', ['views', 'profile', 'referral.ejs'], 'data-referral-action', ['copyCode', 'shareLink']],
    ['views/profile.ejs', ['views', 'profile.ejs'], 'data-ref-action', ['copyRef', 'shareRef']]
  ])('%s — দুটো অ্যাকশনই ম্যাপ করা', (_n, p, marker, fns) => {
    const src = read(...p);
    const block = bindingBlock(src, marker);
    expect(src).toContain(marker + '="copy"');
    expect(src).toContain(marker + '="share"');
    fns.forEach((fn) => expect(block).toMatch(new RegExp('function\\s+' + fn + '\\s*\\(')));
  });
});
