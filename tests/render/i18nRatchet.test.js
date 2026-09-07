// ---------------------------------------------------------------------------
// tests/render/i18nRatchet.test.js
//
// locales/bn.json ও en.json — দুটোতেই একই সংখ্যক কী, কোনো missing key নেই।
// কিন্তু ভিউতে এখনো প্রচুর হার্ডকোডেড বাংলা রয়ে গেছে, অর্থাৎ ইংরেজি বেছে
// নেওয়া ব্যবহারকারীও ওই অংশগুলো বাংলায় দেখেন। দ্বিভাষিক সমর্থনটা তাই
// আংশিক — locales ফাইল সম্পূর্ণ, ভিউ নয়।
//
// পুরো মাইগ্রেশন একটা বড় কাজ (১১৬টা ফাইল, ~১২০০ লাইন)। সেটা শেষ হওয়ার
// আগ পর্যন্ত অন্তত সংখ্যাটা যেন *বাড়তে* না পারে — cspInlineRatchet.test.js
// ঠিক এই কৌশলেই CSP-র অগ্রগতি লক করেছে।
//
// নিয়ম: নিচের সংখ্যা কমানো যাবে (সেটাই লক্ষ্য), বাড়ানো যাবে না।
// নতুন ভিউ লিখলে t() ব্যবহার করুন; হার্ডকোডেড বাংলা যোগ করলে এই টেস্ট লাল হবে।
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const VIEWS = path.join(__dirname, '..', '..', 'views');

// বাংলা ইউনিকোড রেঞ্জ
const BENGALI = /[\u0980-\u09FF]/;

// বর্তমান পরিমাপ (২০২৬-০৯-০৭)। কমলে নিচের সংখ্যা কমিয়ে দিন — সেটাই ratchet.
const BASELINE_USER_LINES = 345;
const BASELINE_ADMIN_LINES = 673;

/** কমেন্ট বাদ দেওয়া হয়: ডেভেলপারদের জন্য লেখা বাংলা কমেন্ট ব্যবহারকারী দেখেন না,
 *  আর কোডবেসে সেগুলো ইচ্ছাকৃত ও উপকারী। শুধু রেন্ডার হওয়া টেক্সটই গোনা হয়। */
function stripComments(source) {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')   // HTML/EJS কমেন্ট
    .replace(/\/\*[\s\S]*?\*\//g, '')  // CSS/JS ব্লক কমেন্ট
    .replace(/^\s*\/\/.*$/gm, '');     // JS লাইন কমেন্ট
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ejs')) out.push(full);
  }
  return out;
}

function countBengaliLines(files) {
  let total = 0;
  const perFile = [];
  for (const file of files) {
    const lines = stripComments(fs.readFileSync(file, 'utf8')).split('\n');
    const n = lines.filter((l) => BENGALI.test(l)).length;
    if (n > 0) {
      total += n;
      perFile.push([path.relative(VIEWS, file), n]);
    }
  }
  perFile.sort((a, b) => b[1] - a[1]);
  return { total, perFile };
}

describe('i18n ratchet — হার্ডকোডেড বাংলা বাড়তে পারবে না', () => {
  const allViews = walk(VIEWS);
  const adminViews = allViews.filter((f) => f.includes(`${path.sep}admin${path.sep}`));
  const userViews = allViews.filter((f) => !f.includes(`${path.sep}admin${path.sep}`));

  test(`ইউজার-ফেসিং ভিউ: ≤ ${BASELINE_USER_LINES} লাইন`, () => {
    const { total, perFile } = countBengaliLines(userViews);
    if (total > BASELINE_USER_LINES) {
      console.error('সবচেয়ে বেশি হার্ডকোডেড বাংলা:', perFile.slice(0, 10));
    }
    expect(total).toBeLessThanOrEqual(BASELINE_USER_LINES);
  });

  test(`অ্যাডমিন ভিউ: ≤ ${BASELINE_ADMIN_LINES} লাইন`, () => {
    const { total, perFile } = countBengaliLines(adminViews);
    if (total > BASELINE_ADMIN_LINES) {
      console.error('সবচেয়ে বেশি হার্ডকোডেড বাংলা:', perFile.slice(0, 10));
    }
    expect(total).toBeLessThanOrEqual(BASELINE_ADMIN_LINES);
  });

  // মাইগ্রেশন এগোলে যেন কেউ baseline কমাতে ভুলে না যায়।
  test('baseline অপ্রয়োজনীয়ভাবে ঢিলা হয়ে পড়ে থাকেনি', () => {
    const user = countBengaliLines(userViews).total;
    const admin = countBengaliLines(adminViews).total;
    // ৫০ লাইনের বেশি ব্যবধান তৈরি হলে baseline হালনাগাদ করার সময় হয়েছে।
    expect(BASELINE_USER_LINES - user).toBeLessThanOrEqual(50);
    expect(BASELINE_ADMIN_LINES - admin).toBeLessThanOrEqual(50);
  });
});

describe('locales ফাইল দুটো সিঙ্ক্রনাইজড', () => {
  const bn = require('../../locales/bn.json');
  const en = require('../../locales/en.json');

  test('bn ও en-এ একই কী সেট', () => {
    const bnKeys = Object.keys(bn).sort();
    const enKeys = Object.keys(en).sort();
    const onlyBn = bnKeys.filter((k) => !(k in en));
    const onlyEn = enKeys.filter((k) => !(k in bn));
    expect({ onlyBn, onlyEn }).toEqual({ onlyBn: [], onlyEn: [] });
  });

  test('কোনো কী-র মান খালি নয়', () => {
    const emptyBn = Object.entries(bn).filter(([, v]) => typeof v === 'string' && !v.trim());
    const emptyEn = Object.entries(en).filter(([, v]) => typeof v === 'string' && !v.trim());
    expect(emptyBn).toEqual([]);
    expect(emptyEn).toEqual([]);
  });
});
