// tests/render/adminUiConsistency.test.js
// ---------------------------------------------------------------------------
// Phase 8 (UI সামঞ্জস্য) ও Phase 9 (অ্যাক্সেসিবিলিটি) — রিগ্রেশন গার্ড।
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const ui = require('../../utils/adminUi');

const ROOT = path.join(__dirname, '..', '..');
const LAYOUT = fs.readFileSync(path.join(ROOT, 'views/admin/partials/admin-layout.ejs'), 'utf8');

describe('adminUi — স্ট্যাটাস ব্যাজ কেন্দ্রীভূত', () => {
  test('একই অর্থের স্ট্যাটাস একই টোন পায়', () => {
    for (const s of ['approved', 'completed', 'active', 'success', 'healthy']) {
      expect(ui.toneFor(s)).toBe('success');
    }
    for (const s of ['rejected', 'failed', 'error', 'banned', 'cancelled']) {
      expect(ui.toneFor(s)).toBe('danger');
    }
    for (const s of ['pending', 'processing', 'review']) {
      expect(ui.toneFor(s)).toBe('warning');
    }
  });

  test('বড়/ছোট হাতের অক্ষর ও স্পেস উপেক্ষা করে', () => {
    expect(ui.toneFor('  APPROVED ')).toBe('success');
    expect(ui.toneFor('Pending')).toBe('warning');
  });

  test('অজানা স্ট্যাটাস নিরাপদভাবে neutral হয়, ক্র্যাশ করে না', () => {
    expect(ui.toneFor('some_unknown_state')).toBe('neutral');
    expect(ui.toneFor(null)).toBe('neutral');
    expect(ui.toneFor(undefined)).toBe('neutral');
  });

  test('ব্যাজে সবসময় টেক্সট থাকে — শুধু রঙ দিয়ে অর্থ বোঝানো হয় না (a11y)', () => {
    const html = ui.statusBadge('approved');
    expect(html).toContain('approved');
    expect(html).toMatch(/<span class="[^"]*">approved<\/span>/);
  });

  test('স্ট্যাটাস টেক্সট escape হয় — DB থেকে আসা মান দিয়ে XSS হয় না', () => {
    const html = ui.statusBadge('x', '<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('প্রতিটা টোনের ক্লাস সংজ্ঞায়িত ও ইউনিক', () => {
    const vals = Object.values(ui.TONES);
    expect(new Set(vals).size).toBe(vals.length);
    for (const t of Object.values(ui.STATUS_TONE)) {
      expect(Object.keys(ui.TONES)).toContain(t);
    }
  });
});

describe('ভাগ করা UI উপাদান লেআউটে আছে', () => {
  test.each(['ui-card', 'ui-btn', 'ui-badge', 'ui-table', 'ui-empty', 'ui-spinner'])(
    '.%s সংজ্ঞায়িত', (cls) => { expect(LAYOUT).toContain('.' + cls); });

  test('ফোকাস স্টেট সংজ্ঞায়িত — কীবোর্ড ব্যবহারকারী কোথায় আছেন বোঝা যায়', () => {
    expect(LAYOUT).toContain(':focus-visible');
    expect(LAYOUT).toMatch(/outline:\s*2px solid/);
  });

  test('মোবাইলে টাচ টার্গেট অন্তত 44px', () => {
    expect(LAYOUT).toMatch(/min-height:\s*44px/);
  });

  test('prefers-reduced-motion সম্মান করা হয়', () => {
    expect(LAYOUT).toContain('prefers-reduced-motion');
  });

  test('.sr-only সংজ্ঞায়িত — আইকনের অর্থ স্ক্রিন রিডারে যায়', () => {
    expect(LAYOUT).toContain('.sr-only');
  });
});

describe('অ্যাক্সেসিবিলিটি — আইকন-অনলি বাটনের নাম আছে', () => {
  // যেসব ভিউ ঠিক করা হয়েছে, সেগুলোতে যেন আবার নামহীন আইকন-বাটন না ফেরে
  const FIXED = [
    'views/admin/partials/admin-layout.ejs',
    'views/admin/kyc.ejs',
    'views/admin/news.ejs',
    'views/admin/games.ejs',
    'views/admin/chat.ejs',
    'views/admin/matches.ejs'
  ];

  test.each(FIXED)('%s — প্রতিটা আইকন-অনলি বাটনের aria-label/title আছে', (rel) => {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const offenders = [];
    const re = /<button\b([^>]*)>([\s\S]*?)<\/button>/g;
    let m;
    while ((m = re.exec(src))) {
      const attrs = m[1];
      const inner = m[2];
      // EJS আউটপুট ট্যাগ (<%= %> / <%- %>) রেন্ডারের সময় আসল টেক্সট তৈরি করে,
      // তাই সেটাকে "নাম আছে" হিসেবে গণনা করতে হয়। আগে নিচের `<[^>]+>` স্ট্রিপার
      // <%= t('...') %>-কেও একটা HTML ট্যাগ ধরে মুছে ফেলত, ফলে অনুবাদিত লেবেলওয়ালা
      // বাটনগুলো ভুল করে "নামহীন আইকন বাটন" হিসেবে ধরা পড়ত। কন্ট্রোল ট্যাগ
      // (<% if %>) কোনো টেক্সট ছাপে না, তাই সেটা আগের মতোই বাদ যায়।
      const text = inner
        .replace(/<%[=-][\s\S]*?%>/g, 'X')
        .replace(/<%[\s\S]*?%>/g, '')
        .replace(/<[^>]+>/g, '')
        .replace(/\$\{[^}]*\}/g, '')
        .trim();
      const named = /aria-label|title=/.test(attrs);
      if (!text && !named && /<i\s/.test(inner)) {
        offenders.push((inner.match(/fa-[a-z0-9-]+/) || ['?'])[0]);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('মোবাইল হ্যামবার্গার বাটনে aria-controls/expanded আছে', () => {
    expect(LAYOUT).toMatch(/aria-controls="adminSidebar"/);
    expect(LAYOUT).toMatch(/aria-expanded/);
  });
});

describe('অ্যাক্সেসিবিলিটি — ছবিতে alt আছে', () => {
  test.each([
    'views/admin/2fa-setup.ejs',
    'views/admin/news.ejs',
    'views/admin/promotions.ejs',
    'views/admin/kyc.ejs'
  ])('%s — প্রতিটা <img> এ alt আছে', (rel) => {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const missing = (src.match(/<img\b[^>]*>/g) || []).filter(t => !/\balt=/.test(t));
    expect(missing).toEqual([]);
  });
});

describe('স্ট্যাটাস ব্যাজের রঙ পেজে পেজে সামঞ্জস্যপূর্ণ (Phase 8)', () => {
  const views = fs.readdirSync(path.join(ROOT, 'views/admin'))
    .filter(f => f.endsWith('.ejs'))
    .map(f => path.join(ROOT, 'views/admin', f));

  test('pending/open অবস্থা সব পেজে একই টোন — হলুদ vs অ্যাম্বার মেশানো নেই', () => {
    // আগে deposits/withdrawals/transactions/support-এ pending হলুদ ছিল, অথচ
    // বাকি সব জায়গায় অ্যাম্বার — একই অর্থ, দুই রকম চেহারা।
    const offenders = views.filter(f =>
      /bg-yellow-\d+\s+text-yellow-\d+/.test(fs.readFileSync(f, 'utf8')));
    expect(offenders.map(f => path.basename(f))).toEqual([]);
  });

  test('ব্যাজের canonical টোন adminUi-এর সংজ্ঞার সাথে মেলে', () => {
    expect(ui.TONES.warning).toBe('bg-amber-100 text-amber-700');
    expect(ui.TONES.success).toBe('bg-emerald-100 text-emerald-700');
    expect(ui.TONES.danger).toBe('bg-red-100 text-red-700');
  });
});
