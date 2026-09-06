const fs = require('fs');
const path = require('path');

// ==================== CSP ইনলাইন style র‍্যাচেট ====================
//
// script-src ধাপে ধাপে শক্ত করা গেছে (tests/security/cspInlineRatchet.test.js)
// — ইনলাইন হ্যান্ডলার ও <script> ব্লক দুটোই এখন ০, তাই scriptSrc থেকে
// 'unsafe-inline' সরানো গেছে।
//
// styleSrc-এ এখনো 'unsafe-inline' আছে, কারণ টেমপ্লেটে ১৮৩২টা ইনলাইন
// `style="..."` অ্যাট্রিবিউট বাকি (১০৬টা ফাইলে)। এতগুলো একসাথে সরানো যায়
// না — একবার ৩৮টা ফাইল একসাথে বদলে ৬টা সুট ভেঙেছিল।
//
// এই টেস্ট মাইগ্রেশনটা শুরু করার আগের শর্তটাই প্রতিষ্ঠা করে: বর্তমান
// সংখ্যাটাই সর্বোচ্চ সীমা। সংখ্যা কমলে পাস (আর সীমা নামিয়ে আনতে মনে করিয়ে
// দেয়), বাড়লে ফেল। অর্থাৎ ইনলাইন style surface একমুখী — শুধু ছোট হতে
// পারে। এটা না থাকলে যত দ্রুত সরানো হত, তত দ্রুত নতুন যোগ হয়ে কাজটা
// কখনো শেষ হত না।
//
// **স্পষ্ট করে বলা দরকার: এটা styleSrc শক্ত করে না।** CSP-তে এখনো
// 'unsafe-inline' আছে এবং style-ভিত্তিক আক্রমণ (যেমন CSS দিয়ে ডেটা
// exfiltration বা UI redress) এখনো ঠেকানো যায় না। সংখ্যা ০-তে নামলে
// তবেই app.js-এর styleSrc থেকে 'unsafe-inline' সরানো যাবে — সেটা এই
// কমিটে হয়নি, Phase ১৩(ক) তাই এখনো অসম্পূর্ণ।
//
// ---------------------------------------------------------------------------
// কেন মাইগ্রেশনটা মেকানিক্যালি করা যায়নি — পরের সেশনের জন্য (মেপে দেখা):
//
// ইনলাইন `style="..."` CSS ক্লাসের চেয়ে বেশি specificity রাখে এবং
// `!important` ছাড়া যেকোনো নিয়মকে হারায়। অর্থাৎ আজ যেসব জায়গায় ইনলাইন
// style কোনো stylesheet নিয়মকে চাপা দিচ্ছে, ক্লাসে সরালেই ওই নিয়মটা
// জিতে যাবে আর চেহারা বদলাবে।
//
// এই রেপোতে সেটা তাত্ত্বিক ঝুঁকি নয়, মাপা সংখ্যা:
//   public/css/style.css              — 36টা !important
//   public/css/reference-theme.css    — 120টা !important
//   public/css/tournament-showcase.css—  2টা !important
//   মোট 158টা !important, আর 54টা id-ভিত্তিক নিয়ম
//
// এগুলো এখন ইনলাইন style-এর কাছে হারছে। ক্লাসে সরালে এরা জিতবে —
// ক্লাসের specificity যতই বাড়ানো হোক (`.im-1.im-1` ইত্যাদি), !important
// আর id সবসময় উপরে থাকবে।
//
// সমাধান হিসেবে জেনারেট করা নিয়মে নিজেরাও `!important` বসানো যেত, কিন্তু
// তাতে JS-এর `element.style.display = 'block'` ধরনের কোড হেরে যেত —
// অর্থাৎ show/hide, মোডাল, ড্রপডাউন সব ভাঙত। ওটা আরও খারাপ।
//
// উপসংহার: মাইগ্রেশনটা ফাইল ধরে ধরে করতে হবে, আর প্রতিটার পরে পেজটা
// ব্রাউজারে দেখে মেলাতে হবে। কোনো স্বয়ংক্রিয় টেস্ট এই শ্রেণির রিগ্রেশন
// ধরতে পারে না — jsdom-ভিত্তিক render টেস্টও computed style মাপে না।
// Phase ১৯ (E2E, visual) খুললে তবেই এটা নিরাপদে করা যাবে।
// ---------------------------------------------------------------------------
//
// সীমা নামানোর ইতিহাস (প্রতিটা মাইগ্রেশনের পরে এখানে লাইন যোগ করুন):
// 1832/106 (053f9c2) → শুরুর বেসলাইন
const MAX_INLINE_STYLES = 1832;

const ROOT = path.join(__dirname, '..', '..');
const SCAN_DIRS = ['views', 'public'];
const EXTS = ['.ejs', '.html'];

// শুধু আসল HTML অ্যাট্রিবিউট — `style="` লেখা থাকলেই হবে না, আগে
// whitespace থাকতে হবে, নইলে CSS ফাইলের ভেতরের টেক্সটও গোনা যেত।
const STYLE_ATTR_RE = /\sstyle="/g;

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (EXTS.includes(path.extname(entry.name))) out.push(full);
  }
  return out;
}

const FILES = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)));

function countAll() {
  const perFile = [];
  let total = 0;
  for (const file of FILES) {
    const m = fs.readFileSync(file, 'utf8').match(STYLE_ATTR_RE);
    if (m) {
      perFile.push({ file: path.relative(ROOT, file), count: m.length });
      total += m.length;
    }
  }
  perFile.sort((a, b) => b.count - a.count);
  return { total, perFile };
}

describe('CSP — ইনলাইন style র‍্যাচেট (শুধু কমতে পারে)', () => {
  test('স্ক্যান কাজ করছে', () => {
    // ফাইল তালিকা খালি হলে নিচের গণনা ০ হত আর টেস্টটা নিরর্থকভাবে পাস
    // করত — ঠিক সেই ফাঁদ যা এই রেপোতে আগে ঘটেছে।
    expect(FILES.length).toBeGreaterThan(100);
  });

  test(`ইনলাইন style অ্যাট্রিবিউট ${MAX_INLINE_STYLES}-এর বেশি নয়`, () => {
    const { total, perFile } = countAll();
    if (total > MAX_INLINE_STYLES) {
      const worst = perFile.slice(0, 10).map((f) => `  ${f.file}: ${f.count}`).join('\n');
      throw new Error(
        `ইনলাইন style বেড়ে ${total} হয়েছে (সীমা ${MAX_INLINE_STYLES}).\n` +
        `নতুন style="..." যোগ করবেন না — CSS ক্লাস ব্যবহার করুন.\n` +
        `সবচেয়ে বেশি যেসব ফাইলে:\n${worst}`
      );
    }
    expect(total).toBeLessThanOrEqual(MAX_INLINE_STYLES);
  });

  test('সীমা বর্তমান সংখ্যার চেয়ে অনেক বেশি নয় (নামানো হয়েছে কি না)', () => {
    // কেউ কিছু সরালে সীমাটা নামানোও দরকার, নইলে র‍্যাচেট আলগা হয়ে যায়
    // আর ফাঁকটুকু দিয়ে নতুন style নীরবে ফিরে আসতে পারে।
    const { total } = countAll();
    expect(MAX_INLINE_STYLES - total).toBeLessThanOrEqual(20);
  });
});

describe('CSP — style surface দুই ভাগে', () => {
  const appSource = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const enforced = /const cspDirectives = \{[\s\S]*?\n\};/.exec(appSource)[0];

  test("style-src-elem কড়া: nonce আছে, 'unsafe-inline' নেই", () => {
    const elem = /styleSrcElem: \[[\s\S]*?\]/.exec(enforced);
    expect(elem).not.toBeNull();
    expect(elem[0]).not.toContain("'unsafe-inline'");
    // nonce না থাকলে 'self'-এর বাইরে কোনো <style> ব্লকই চলত না — অর্থাৎ
    // নীতিটা কড়া নয়, সাইটটাই ভাঙা হত। দুটো আলাদা জিনিস।
    expect(elem[0]).toContain('cspNonce');
  });

  test('প্রতিটা টেমপ্লেট <style> ব্লকে nonce বসেছে', () => {
    const bare = [];
    for (const file of FILES) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/<style(\s[^>]*)?>/g)) {
        if (!/nonce=/.test(m[0])) bare.push(path.relative(ROOT, file));
      }
    }
    // offline.html-এর ব্লকটা বাইরের ফাইলে সরানো হয়েছে — ওটা EJS দিয়ে
    // রেন্ডার হয় না, তাই nonce দেওয়ার উপায় নেই।
    expect(bare).toEqual([]);
  });

  test("style-src-attr এখনো শিথিল — এবং সেটা সংখ্যার সাথে বাঁধা", () => {
    const attr = /styleSrcAttr: \[[^\]]*\]/.exec(enforced);
    expect(attr).not.toBeNull();
    const { total } = countAll();
    // এই assertion উল্টো দিকে কাজ করে: সংখ্যা ০-তে নামলে এটা ফেল করবে
    // আর ডিরেক্টিভটা 'none' করতে বাধ্য করবে। ফলে নীতি আর টেমপ্লেটের
    // অবস্থা কখনো আলাদা হয়ে যেতে পারবে না।
    if (total === 0) expect(attr[0]).toContain("'none'");
    else expect(attr[0]).toContain("'unsafe-inline'");
  });

  test("report-only নীতিতে style-src-attr 'none' — অগ্রগতি মাপার উপায়", () => {
    expect(appSource).toMatch(/styleSrcAttr: \["'none'"\]/);
  });

  test('style-src fallback স্পষ্টভাবে লেখা, helmet-এর ডিফল্ট নয়', () => {
    // key-টা বাদ দিলে helmet `style-src 'self' https: 'unsafe-inline'`
    // বসায় — যেকোনো HTTPS origin থেকে stylesheet। যে ব্রাউজার
    // style-src-elem বোঝে না সেখানে ওটাই কার্যকর নীতি হত, অর্থাৎ উপরের
    // কড়াকড়িটা নীরবে অকেজো হয়ে যেত।
    const fallback = /\n  styleSrc: \[[^\]]*\]/.exec(enforced);
    expect(fallback).not.toBeNull();
    expect(fallback[0]).not.toMatch(/"https:"/);
    expect(fallback[0]).toContain("'self'");
  });
});

// ---------------------------------------------------------------------------
// রানটাইম যাচাই। উপরের সোর্স-স্ক্যান শুধু দেখে "nonce= লেখা আছে" — কিন্তু
// দুটো টেমপ্লেটে (`admin/feature-flags.ejs`, `admin/user-detail.ejs`)
// `<style>` ব্লকটা একটা JS template literal-এর ভেতরে, তাই সেখানে
// `<%= cspNonce %>` কাজ করে না, `${cspNonce}` লাগে। সোর্স-স্ক্যান দুটোকেই
// সমানভাবে সবুজ দেখাত — অথচ একটা রেন্ডার হলে আক্ষরিক "${cspNonce}"
// বসত আর ব্রাউজার ব্লকটা ব্লক করত।
//
// তাই এখানে আসল রেসপন্স পড়ে দেখা হয়: প্রতিটা <style> ব্লকের nonce ওই
// রেসপন্সের CSP হেডারে থাকা nonce-এর সাথে হুবহু মেলে কি না।
// ---------------------------------------------------------------------------
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const { pool } = require('../../db');

describe('CSP — রেন্ডার করা পেজে nonce সত্যিই বসেছে', () => {
  jest.setTimeout(60000);
  let agent;

  beforeAll(async () => {
    const r = await getCsrfAgent('/register');
    agent = r.agent;
    const username = uniqueUsername();
    await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form').send({
      username, phone: uniquePhone(), password: 'SecurePass123',
      confirmPassword: 'SecurePass123', _csrf: r.token
    });
    await pool.query("UPDATE users SET role='admin', role_key='super_admin' WHERE username=$1", [username]);
  });

  const check = async (url) => {
    const res = await agent.get(url);
    expect(res.status).toBe(200);

    const csp = res.headers['content-security-policy'];
    const elem = csp.split(';').find((d) => d.trim().startsWith('style-src-elem'));
    const headerNonce = /'nonce-([^']+)'/.exec(elem);
    expect(headerNonce).not.toBeNull();

    const tags = [...res.text.matchAll(/<style(\s[^>]*)?>/g)];
    // "কাজটা সত্যিই ঘটেছে": ব্লকই না থাকলে নিচের লুপ খালি চলত আর টেস্টটা
    // নিরর্থকভাবে পাস করত।
    expect(tags.length).toBeGreaterThanOrEqual(1);

    for (const tag of tags) {
      const m = /nonce="([^"]*)"/.exec(tag[0]);
      expect(m).not.toBeNull();
      // আক্ষরিক "${cspNonce}" বা "<%= cspNonce %>" এখানেই ধরা পড়বে
      expect(m[1]).toBe(headerNonce[1]);
    }
  };

  test('/ — সব <style> ব্লকের nonce হেডারের সাথে মেলে', () => check('/'));
  test('/admin/features — JS template literal-এর ভেতরের ব্লকেও মেলে', () => check('/admin/features'));
  test('/admin/users — user-detail-এর প্যাটার্নের পেজেও মেলে', () => check('/admin/users'));
});
