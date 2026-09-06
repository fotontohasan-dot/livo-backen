const fs = require('fs');
const path = require('path');

// ==================== বাইরে আনা স্ক্রিপ্টের অখণ্ডতা ====================
//
// docs/CSP.md ধাপ ৩-এ টেমপ্লেটের ইনলাইন ব্লকগুলো public/js/-এ সরানো হচ্ছে।
// এই প্রক্রিয়ায় দুটো নীরব ভুল ঘটতে পারে, আর দুটোই একবার ঘটেছে:
//
//   ১. একই টেমপ্লেটে একাধিক ব্লক থাকলে দ্বিতীয় মাইগ্রেশন প্রথমটার ফাইল
//      ওভাররাইট করে দেয় — কোড নীরবে হারিয়ে যায়। partials/head.ejs-এ ঠিক
//      এটাই হয়েছিল: থিম (light-mode) কোডটা টোস্ট কোড দিয়ে চাপা পড়ে যায়।
//
//   ২. একই স্ক্রিপ্ট দুবার লোড হলে কোড দুবার চলে। ফ্ল্যাশ টোস্টের ক্ষেত্রে
//      এর মানে প্রতিটা বার্তা দুবার দেখানো।
//
// দুটোই টেস্ট ছাড়া ধরা পড়ে না, কারণ পেইজ ঠিকই রেন্ডার হয়।

const ROOT = path.join(__dirname, '..', '..');

function walk(dir, exts, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, exts, out);
    else if (exts.some((x) => e.name.endsWith(x))) out.push(full);
  }
  return out;
}

const templates = walk(path.join(ROOT, 'views'), ['.ejs'])
  .concat(walk(path.join(ROOT, 'public'), ['.html']));

describe('বাইরে আনা স্ক্রিপ্ট — একই ফাইল দুবার লোড হয় না', () => {
  test.each(templates.map((f) => [path.relative(ROOT, f), f]))('%s', (_name, file) => {
    const src = fs.readFileSync(file, 'utf8');
    const tags = [...src.matchAll(/<script src="(\/js\/[^"]+)"/g)].map((m) => m[1]);
    const dupes = tags.filter((t, i) => tags.indexOf(t) !== i);
    expect(dupes).toEqual([]);
  });
});

describe('বাইরে আনা স্ক্রিপ্ট — যা লোড করা হয় তা আসলে আছে', () => {
  test('প্রতিটা <script src="/js/..."> ফাইল ডিস্কে আছে', () => {
    const missing = [];
    for (const file of templates) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/<script src="(\/js\/[^"]+)"/g)) {
        const target = path.join(ROOT, 'public', m[1].replace(/^\//, ''));
        if (!fs.existsSync(target)) missing.push(path.relative(ROOT, file) + ' -> ' + m[1]);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('বাইরে আনা স্ক্রিপ্ট — সবগুলো বৈধ ও সার্ভার-মান-মুক্ত', () => {
  const jsFiles = walk(path.join(ROOT, 'public', 'js'), ['.js']);

  test('অন্তত কিছু ফাইল আছে', () => {
    expect(jsFiles.length).toBeGreaterThan(20);
  });

  test.each(jsFiles.map((f) => [path.relative(ROOT, f), f]))('%s — পার্স হয়', (_name, file) => {
    // eslint-disable-next-line no-new-func
    expect(() => new Function(fs.readFileSync(file, 'utf8'))).not.toThrow();
  });

  test.each(jsFiles.map((f) => [path.relative(ROOT, f), f]))(
    '%s — কোনো সার্ভার-সাইড ইন্টারপোলেশন নেই', (_name, file) => {
      // কমেন্ট বাদ — ব্যাখ্যায় ট্যাগের কথা লেখা থাকতে পারে।
      const code = fs.readFileSync(file, 'utf8')
        .replace(/\/\/[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      expect(code).not.toMatch(/<%/);
      // `${` শুধু তখনই সমস্যা যখন ফাইলটা টেমপ্লেট লিটারেলের ভেতরে ছিল;
      // JS-এর নিজের template literal বৈধ, তাই এখানে শুধু EJS ট্যাগ দেখা হয়।
    }
  );
});

describe('partials/head — দুটো ব্লকই টিকে আছে', () => {
  const js = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'partials-head.js'), 'utf8');

  test('থিম কোড হারায়নি', () => {
    // এটাই সেই কোড যা একবার ওভাররাইটে হারিয়ে গিয়েছিল।
    expect(js).toMatch(/livo-theme/);
    expect(js).toMatch(/light-mode/);
  });

  test('টোস্ট সিস্টেম ও ফ্ল্যাশ বার্তা আছে', () => {
    expect(js).toMatch(/window\.LivoToast\s*=/);
    expect(js).toMatch(/cfg\.success/);
    expect(js).toMatch(/cfg\.error/);
  });

  test('থিম কোড টোস্ট কোডের আগে চলে', () => {
    // থিম কোড body-তে class বসায়, তাই আগে চলা দরকার।
    expect(js.indexOf('livo-theme')).toBeLessThan(js.indexOf('window.LivoToast'));
  });
});
