const { scriptOrder, readScript } = require('../helpers/viewScripts');
const fs = require('fs');
const path = require('path');

// docs/CSP.md ধাপ ২ — তিনটে ফাইল যেখানে হ্যান্ডলারগুলো রানটাইমে HTML স্ট্রিং
// জোড়া দিয়ে তৈরি হত, অথবা অ্যাট্রিবিউটের ভেতরে হাতে করে কোট-এস্কেপ করতে হত।
// এই দুটোই ভঙ্গুর প্যাটার্ন, আর data-* অ্যাট্রিবিউটে গেলে দুটোই অদরকারি হয়ে যায়।

const ROOT = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const count = (src, re) => (src.match(re) || []).length;
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

const payouts = read('views', 'admin', 'contest-payouts.ejs');
const support = read('views', 'admin', 'support.ejs');
const telegram = read('views', 'admin', 'telegram.ejs');

describe('admin/contest-payouts.ejs — হাতে-লেখা কোট এস্কেপিং সরানো হয়েছে', () => {
  test('কোনো ইনলাইন হ্যান্ডলার নেই', () => {
    expect(payouts).not.toMatch(HANDLER_RE);
  });

  test('ইউজারনেম আর JS আর্গুমেন্ট নয়, data-* মান', () => {
    // আগে ছিল: openMarkPaid(<%= p.id %>, '<%= (p.username||'').replace(/'/g,"\\'") %>')
    // অর্থাৎ EJS-এর HTML এস্কেপিং-এর উপরে আরেক স্তর JS কোট-এস্কেপিং হাতে
    // লেখা ছিল। দুই স্তর এস্কেপিং একসাথে ঠিক রাখা কঠিন, আর একটা ভুল মানে
    // ভাঙা অ্যাট্রিবিউট। data-* মান হলে ব্রাউজারই পার্স করে।
    expect(payouts).not.toMatch(/replace\(\/'\/g/);
    expect(payouts).toContain('data-markpaid-id="<%= p.id %>"');
    expect(payouts).toContain("data-markpaid-name=\"<%= p.username || '' %>\"");
  });

  test('id ও নাম দুটোই ফাংশনে যায়, ফাংশন একই ব্লকে', () => {
    const block = bindingBlock(payouts, 'data-markpaid-id');
    expect(block).toMatch(/getAttribute\('data-markpaid-id'\), btn\.getAttribute\('data-markpaid-name'\)/);
    expect(block).toMatch(/function\s+openMarkPaid\s*\(/);
  });

  test('মডাল বন্ধ ও ফিল্টার শেয়ার করা hook ব্যবহার করে', () => {
    expect(count(payouts, /data-modal-close="markPaidModal"/g)).toBe(2);
    expect(payouts).toMatch(/data-auto-submit/);
    // partials/head ব্যবহার করে, তাই ui-hooks.js পায়
    expect(payouts).toMatch(/partials\/head/);
  });
});

describe('admin/support.ejs — রানটাইমে বানানো টিকিট তালিকা', () => {
  test('কোনো ইনলাইন হ্যান্ডলার নেই', () => {
    expect(support).not.toMatch(HANDLER_RE);
  });

  test('টিকিট আইটেম ডেলিগেশনে ধরা হয়', () => {
    // ticketListItem() স্ট্রিং জোড়া দিয়ে সারি বানায়, তাই আইটেমগুলো
    // init-এর সময় DOM-এ নেই — querySelectorAll কিছুই পেত না।
    expect(support).toContain('data-ticket-id=');
    const block = bindingBlock(support, 'data-ticket-id');
    expect(block).toMatch(/document\.addEventListener\('click'/);
    expect(block).toMatch(/closest\('\[data-ticket-id\]'\)/);
    expect(block).not.toMatch(/querySelectorAll\('\[data-ticket-id\]'\)/);
  });

  test('userId সংখ্যা হিসেবেই পাঠানো হয়', () => {
    // আগের কল ছিল openTicket(Number(t.userId))।
    const block = bindingBlock(support, 'data-ticket-id');
    expect(block).toMatch(/openTicket\(Number\(item\.getAttribute\('data-ticket-id'\)\)\)/);
  });

  test('স্থির বাটন দুটোও যুক্ত, ফাংশন একই ব্লকে', () => {
    expect(support).toContain('data-support-action="resolve"');
    expect(support).toContain('data-support-action="reply"');
    const block = bindingBlock(support, 'data-ticket-id');
    ['openTicket', 'resolveTicket', 'sendReply'].forEach((fn) => {
      expect(block).toMatch(new RegExp('function\\s+' + fn + '\\s*\\('));
    });
  });
});

describe('admin/telegram.ejs — ক্যাটাগরির টেস্ট বাটন', () => {
  test('কোনো ইনলাইন হ্যান্ডলার নেই', () => {
    expect(telegram).not.toMatch(HANDLER_RE);
  });

  test('key এখন এস্কেপ করা অ্যাট্রিবিউট মান', () => {
    // আগে key সরাসরি onclick-এর স্ট্রিং-এর ভেতরে বসত, কোনো এস্কেপিং ছাড়াই।
    expect(telegram).toContain("data-send-test=\"' + escapeHtml(key) + '\"");
    expect(telegram).toMatch(/function\s+escapeHtml\s*\(/);
  });

  test('বাটনগুলো ডেলিগেশনে ধরা হয়', () => {
    const block = bindingBlock(telegram, 'data-send-test');
    expect(block).toMatch(/document\.addEventListener\('click'/);
    expect(block).toMatch(/closest\('\[data-send-test\]'\)/);
  });

  test('runTest-এর boolean আর্গুমেন্ট ধরে রাখা হয়েছে', () => {
    // আগের কল ছিল runTest(false) / runTest(true)। অ্যাট্রিবিউট মান স্ট্রিং,
    // তাই তুলনা না করলে "false"-ও truthy হয়ে দুটো বাটন একই কাজ করত।
    expect(telegram).toContain('data-run-test="false"');
    expect(telegram).toContain('data-run-test="true"');
    const block = bindingBlock(telegram, 'data-send-test');
    expect(block).toMatch(/runTest\(run\.getAttribute\('data-run-test'\) === 'true'\)/);
    ['sendTest', 'runTest'].forEach((fn) => {
      expect(block).toMatch(new RegExp('function\\s+' + fn + '\\s*\\('));
    });
  });
});
