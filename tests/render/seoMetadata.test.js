// tests/render/seoMetadata.test.js
// ---------------------------------------------------------------------------
// পাবলিক পেজের SEO/মেটাডেটা রিগ্রেশন টেস্ট।
//
// এই অডিটে যে কনফার্মড ত্রুটিগুলো ধরা পড়েছিল এবং এখানে লক করা হলো:
//   • public/sitemap.xml-এর namespace ছিল `www.sitemap.org` (একবচন) — সঠিকটা
//     `www.sitemaps.org`। ভুল namespace-এ পুরো সাইটম্যাপ সার্চ ইঞ্জিনের কাছে অবৈধ।
//   • সাইটম্যাপে `/license` ছিল, কিন্তু app.js-এ ওই রুটটাই নেই — সাইটম্যাপ থেকে 404।
//   • /sports, /matches, /news, /tournaments, /rules — বড় পাবলিক পেজগুলো সাইটম্যাপে ছিল না।
//   • head.ejs-এ `<html lang="bn">` হার্ডকোড ছিল, যদিও /lang/en সাপোর্ট করা হয়।
//   • canonical URL কোথাও ছিল না, আর og:url সবসময় হোমপেজ দেখাত।
//
// অ্যাডমিন/অথেন্টিকেটেড পেজ এখানে ইচ্ছাকৃতভাবে বাদ — SEO শুধু পাবলিক পেজের বিষয়।
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const request = require('supertest');
// supertest-কে সরাসরি express অ্যাপ না দিয়ে helpers/app.js-এর শেয়ার্ড listening
// সার্ভার দেওয়া হচ্ছে — নাহলে supertest প্রতি রিকোয়েস্টে নিজে listen/close করে,
// যা সমান্তরাল রিকোয়েস্টে ECONNRESET তৈরি করত (helpers/app.js-এর ব্যাখ্যা দেখো)।
const { app } = require('../helpers/app');

const ROOT = path.join(__dirname, '..', '..');
const sitemap = fs.readFileSync(path.join(ROOT, 'public', 'sitemap.xml'), 'utf8');
const robots = fs.readFileSync(path.join(ROOT, 'public', 'robots.txt'), 'utf8');
const headPartial = fs.readFileSync(path.join(ROOT, 'views', 'partials', 'head.ejs'), 'utf8');
const appSource = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

describe('sitemap.xml', () => {
  test('সঠিক sitemaps.org namespace ব্যবহার করে', () => {
    expect(sitemap).toContain('http://www.sitemaps.org/schemas/sitemap/0.9');
    expect(sitemap).not.toContain('www.sitemap.org/schemas');
  });

  test('বৈধ XML — প্রতিটা <url> ব্লকে একটা <loc> আছে', () => {
    const urlCount = (sitemap.match(/<url>/g) || []).length;
    const locCount = (sitemap.match(/<loc>/g) || []).length;
    expect(urlCount).toBeGreaterThan(0);
    expect(locCount).toBe(urlCount);
    expect((sitemap.match(/<\/url>/g) || []).length).toBe(urlCount);
  });

  test('বড় পাবলিক পেজগুলো তালিকাভুক্ত', () => {
    for (const p of ['/', '/sports', '/matches', '/news', '/tournaments', '/help-center', '/terms', '/privacy']) {
      expect(sitemap).toContain(`<loc>https://livo-backen.onrender.com${p}</loc>`);
    }
  });

  test('অস্তিত্বহীন রুট (/license) তালিকাভুক্ত নয়', () => {
    expect(sitemap).not.toContain('/license');
    // রুটটা সত্যিই নেই — ভবিষ্যতে যোগ করা হলে এই অ্যাসারশন মনে করিয়ে দেবে
    expect(appSource).not.toMatch(/app\.get\(['"]\/license['"]/);
  });

  test('অথেন্টিকেশন-প্রয়োজন পেজ সাইটম্যাপে নেই', () => {
    for (const p of ['/admin', '/profile', '/accumulator', '/coins', '/notifications']) {
      expect(sitemap).not.toContain(`<loc>https://livo-backen.onrender.com${p}</loc>`);
    }
  });
});

describe('robots.txt', () => {
  test('ব্যক্তিগত/অ্যাডমিন রুট ইনডেক্স করা বন্ধ', () => {
    for (const p of ['/admin', '/profile', '/api/', '/payment']) {
      expect(robots).toContain(`Disallow: ${p}`);
    }
  });

  test('সাইটম্যাপের দিকে নির্দেশ করে', () => {
    expect(robots).toMatch(/^Sitemap: https?:\/\/\S+\/sitemap\.xml$/m);
  });
});

describe('head.ejs মেটাডেটা', () => {
  test('<html lang> হার্ডকোড নয় — রিকোয়েস্টের লোকেল অনুসরণ করে', () => {
    expect(headPartial).not.toContain('<html lang="bn">');
    expect(headPartial).toMatch(/<html lang="<%=\s*locals\.lang/);
  });

  test('canonical লিংক আছে এবং app.js canonicalPath সেট করে', () => {
    expect(headPartial).toMatch(/rel="canonical"/);
    expect(appSource).toMatch(/res\.locals\.canonicalPath/);
  });

  test('og:url হোমপেজে আটকে নেই — বর্তমান পাথ ব্যবহার করে', () => {
    expect(headPartial).toMatch(/og:url"\s+content="<%=\s*\(locals\.baseUrl \|\| ''\) \+ \(locals\.canonicalPath/);
  });
});

describe('পাবলিক পেজ রেন্ডার হলে মেটাডেটা ঠিকঠাক বসে', () => {
  test('GET / — title, description, canonical, og:url সবই থাকে', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/<title>[^<]+<\/title>/);
    expect(res.text).toMatch(/<meta name="description" content="[^"]+"/);
    expect(res.text).toMatch(/<link rel="canonical" href="http[^"]+"/);
    expect(res.text).toMatch(/<meta property="og:url" content="http[^"]+"/);
  });

  test('canonical বর্তমান পেজের পাথ দেখায়, সবসময় হোমপেজ নয়', async () => {
    const res = await request(app).get('/terms');
    expect(res.status).toBe(200);
    const canonical = /<link rel="canonical" href="([^"]+)"/.exec(res.text);
    expect(canonical).not.toBeNull();
    expect(canonical[1]).toMatch(/\/terms$/);
  });

  test('canonical-এ query string বাদ যায় (ডুপ্লিকেট ইনডেক্সিং এড়াতে)', async () => {
    const res = await request(app).get('/terms?utm_source=fb&ref=123');
    expect(res.status).toBe(200);
    const canonical = /<link rel="canonical" href="([^"]+)"/.exec(res.text);
    expect(canonical[1]).not.toContain('utm_source');
    expect(canonical[1]).toMatch(/\/terms$/);
  });

  // দ্রষ্টব্য: <meta name="csrf-token"> ইচ্ছাকৃত (synchronizer token pattern) — এটা ফাঁস নয়।
  // এখানে দেখা হচ্ছে SEO মেটা ট্যাগগুলোতে যেন কোনো ব্যক্তিগত/সেশন তথ্য ঢুকে না যায়।
  test('SEO মেটা ট্যাগে কোনো ইউজার/সেশন তথ্য ফাঁস হয় না', async () => {
    const res = await request(app).get('/');
    const seoTags = res.text.match(/<meta (?:name|property)="(?:description|keywords|og:[^"]+|twitter:[^"]+)"[^>]*>/g) || [];
    expect(seoTags.length).toBeGreaterThan(0);
    const joined = seoTags.join('\n');
    for (const forbidden of ['connect.sid', 'session', 'csrf', 'user_id', '@']) {
      expect(joined.toLowerCase()).not.toContain(forbidden);
    }
  });
});
