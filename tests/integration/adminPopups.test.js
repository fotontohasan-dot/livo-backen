// tests/integration/adminPopups.test.js
// অ্যাডমিন-নিয়ন্ত্রিত হোমপেজ পপআপ: ভ্যালিডেশন (ইউনিট) + অ্যাডমিন রুট + পাবলিক হোমপেজে প্রতিফলন

const request = require('supertest');
const { pool } = require('../../db');
const promoPopup = require('../../services/promoPopup');
const {
  getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA, extractCsrfToken, expressApp
} = require('../helpers/app');

describe('promoPopup — ইনপুট ভ্যালিডেশন', () => {
  test('সেটিংস ক্ল্যাম্প হয় এবং অজানা মান ডিফল্টে ফেরে', () => {
    const s = promoPopup.normalizeSettings({
      slideSeconds: 9999, delaySeconds: -5, shape: 'hexagon', maxWidthPx: 5, radiusPx: 500,
      borderColor: 'red', frameBg: '#ABCDEF', overlayOpacity: 200, animation: 'spin', imageFit: 'stretch', position: 'left'
    });
    expect(s.slideSeconds).toBe(120);
    expect(s.delaySeconds).toBe(0);
    expect(s.shape).toBe('auto');
    expect(s.maxWidthPx).toBe(200);
    expect(s.radiusPx).toBe(48);
    expect(s.borderColor).toBe('#ffffff');
    expect(s.frameBg).toBe('#abcdef');
    expect(s.overlayOpacity).toBe(95);
    expect(s.animation).toBe('fade');
    expect(s.imageFit).toBe('cover');
    expect(s.position).toBe('center');
  });

  test('ছবির URL: শুধু সাইট-পাথ ও Cloudinary; javascript:/data:/অন্য হোস্ট/http বাদ', () => {
    expect(promoPopup.isSafeImageUrl('/images/popups/a.png')).toBe(true);
    expect(promoPopup.isSafeImageUrl('https://res.cloudinary.com/x/image/upload/a.png')).toBe(true);
    ['javascript:alert(1)', 'data:image/png;base64,AAAA', '//evil.com/a.png', 'http://res.cloudinary.com/a.png',
      'https://evil.com/a.png', '/a b.png', '/a"onerror="x', ''].forEach((u) => {
      expect(promoPopup.isSafeImageUrl(u)).toBe(false);
    });
  });

  test('ক্লিক-লিংক: /পাথ বা https; javascript: নয়', () => {
    expect(promoPopup.isSafeLink('/deposit')).toBe(true);
    expect(promoPopup.isSafeLink('https://example.com/x')).toBe(true);
    expect(promoPopup.isSafeLink('javascript:alert(1)')).toBe(false);
    expect(promoPopup.isSafeLink('//evil.com')).toBe(false);
    expect(promoPopup.isSafeLink('http://example.com')).toBe(false);
  });

  test('slideFromForm: ভুল ছবি/লিংকে error, ঠিক হলে ঢাকা-সময় থেকে UTC টাইমস্ট্যাম্প', () => {
    expect(promoPopup.slideFromForm({ image_url: 'javascript:1' }).error).toBe('admin_popup_err_image');
    expect(promoPopup.slideFromForm({ image_url: '/images/a.png', link_url: 'javascript:1' }).error).toBe('admin_popup_err_link');
    const ok = promoPopup.slideFromForm({ image_url: '/images/a.png', starts_at: '2026-01-01T12:00', duration_seconds: '500' });
    expect(ok.value.starts_at).toBe('2026-01-01T06:00:00.000Z'); // ঢাকা = UTC+6
    expect(ok.value.duration_seconds).toBe(120);
  });
});

let adminAgent, csrf;
const createdIds = [];

beforeAll(async () => {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form').send({
    username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token
  });
  await pool.query('UPDATE users SET role = $1 WHERE username = $2', ['admin', username]);
  adminAgent = agent;
  csrf = extractCsrfToken((await adminAgent.get('/admin/popups')).text);
  if (!csrf) throw new Error('CSRF token not found on /admin/popups');
});

afterAll(async () => {
  if (createdIds.length) await pool.query('DELETE FROM promo_popup_slides WHERE id = ANY($1)', [createdIds]).catch(() => {});
  await promoPopup.saveSettings(promoPopup.DEFAULTS).catch(() => {});
  await pool.end().catch(() => {});
});

const post = (url, body) => adminAgent.post(url).type('form').send({ _csrf: csrf, ...body });

describe('অ্যাডমিন পপআপ রুট', () => {
  test('GET /admin/popups: পেজ খোলে এবং আগের ৪টা ডিফল্ট স্লাইড দেখায়', async () => {
    const res = await adminAgent.get('/admin/popups');
    expect(res.status).toBe(200);
    expect(res.text).toContain('popup_01_500cr_mystery_modal.png');
    expect(res.text).toContain('/js/views/admin-popups.js');
  });

  test('অ্যাডমিন না হলে /admin/popups ও POST ব্লক', async () => {
    const anon = request(expressApp);
    const g = await anon.get('/admin/popups');
    expect([301, 302, 401, 403]).toContain(g.status);
    const p = await anon.post('/admin/popups/settings').type('form').send({ shape: 'tall' });
    expect([301, 302, 401, 403]).toContain(p.status);
  });

  test('সেটিংস সেভ হয় (আকৃতি, সময়, অটো-ক্লোজ) এবং হোমপেজ কনফিগে প্রতিফলিত', async () => {
    const r = await post('/admin/popups/settings', {
      shape: 'tall', slideSeconds: '9', delaySeconds: '3', showIntervalHours: '0',
      autoAdvance: 'on', autoClose: 'on', showCaption: 'on', showDots: 'on', showNav: 'on', enabled: 'on',
      maxWidthPx: '360', radiusPx: '24', borderWidthPx: '4', borderColor: '#ff0000', frameBg: '#000000',
      overlayOpacity: '70', blurPx: '4', imageFit: 'contain', position: 'top', animation: 'zoom'
    });
    expect(r.status).toBe(302);
    const s = await promoPopup.getSettings();
    expect(s).toMatchObject({ shape: 'tall', slideSeconds: 9, autoClose: true, maxWidthPx: 360, imageFit: 'contain', position: 'top', animation: 'zoom', showIntervalHours: 0 });

    const home = await request(expressApp).get('/');
    const m = home.text.match(/<script type="application\/json" id="partials-floating-promoConfig">([\s\S]*?)<\/script>/);
    expect(m).not.toBeNull();
    const cfg = JSON.parse(m[1]);
    expect(cfg.popup.settings.shape).toBe('tall');
    expect(cfg.popup.ratio).toBeCloseTo(9 / 16, 5);
    expect(cfg.popup.slides.length).toBeGreaterThanOrEqual(4);
  });

  test('চেকবক্স আনচেক করলে (ফিল্ড না এলে) false হয়', async () => {
    await post('/admin/popups/settings', { shape: 'auto', slideSeconds: '6' }); // কোনো চেকবক্স নেই
    const s = await promoPopup.getSettings();
    expect(s.enabled).toBe(false);
    expect(s.autoAdvance).toBe(false);
    expect(s.showCaption).toBe(false);
    await post('/admin/popups/settings', { enabled: 'on', autoAdvance: 'on', showCaption: 'on', showDots: 'on', showNav: 'on' });
  });

  test('স্লাইড যোগ/ক্রম/বন্ধ/মোছা — এবং ভুল URL প্রত্যাখ্যান', async () => {
    const bad = await post('/admin/popups/slides/create', { image_url: 'https://evil.com/x.png' });
    expect(bad.status).toBe(302);
    expect(bad.headers.location).toContain('error=');

    const ok = await post('/admin/popups/slides/create', {
      image_url: '/images/popups/popup_02_800cr_member_day_modal.png', title_bn: 'টেস্ট স্লাইড', link_url: '/deposit', duration_seconds: '4'
    });
    expect(ok.status).toBe(302);
    expect(ok.headers.location).not.toContain('error=');
    const row = (await pool.query("SELECT * FROM promo_popup_slides WHERE title_bn = 'টেস্ট স্লাইড'")).rows[0];
    expect(row).toBeDefined();
    createdIds.push(row.id);
    expect(row.link_url).toBe('/deposit');
    expect(row.duration_seconds).toBe(4);

    // ক্রম: উপরে নিলে sort_order কমে
    const before = row.sort_order;
    await post(`/admin/popups/slides/${row.id}/move`, { dir: 'up' });
    const after = (await pool.query('SELECT sort_order FROM promo_popup_slides WHERE id=$1', [row.id])).rows[0].sort_order;
    expect(after).toBeLessThan(before);

    // বন্ধ করলে পাবলিক কনফিগে আসে না
    await post(`/admin/popups/slides/${row.id}/toggle`, {});
    let pub = await promoPopup.getPublicConfig('bn');
    promoPopup.invalidate();
    pub = await promoPopup.getPublicConfig('bn');
    expect(pub.slides.find((s) => s.id === row.id)).toBeUndefined();

    // মুছলে DB থেকে চলে যায়
    await post(`/admin/popups/slides/${row.id}/delete`, {});
    const gone = await pool.query('SELECT 1 FROM promo_popup_slides WHERE id=$1', [row.id]);
    expect(gone.rowCount).toBe(0);
  });

  test('মেয়াদোত্তীর্ণ স্লাইড পাবলিক কনফিগে আসে না', async () => {
    const r = await pool.query(
      `INSERT INTO promo_popup_slides (image_url, title_bn, sort_order, expires_at)
       VALUES ('/images/a.png', 'expired-slide', 999, NOW() - INTERVAL '1 hour') RETURNING id`
    );
    createdIds.push(r.rows[0].id);
    promoPopup.invalidate();
    const pub = await promoPopup.getPublicConfig('bn');
    expect(pub.slides.find((s) => s.id === r.rows[0].id)).toBeUndefined();
  });

  test('"সবাইকে আবার দেখাও" resetVersion বাড়ায়', async () => {
    const before = (await promoPopup.getSettings()).resetVersion;
    await post('/admin/popups/reset-views', {});
    expect((await promoPopup.getSettings()).resetVersion).toBe(before + 1);
  });

  test('ছবি আপলোড: ছবি নয় এমন ফাইল প্রত্যাখ্যান (400), ফাইল ছাড়া 400', async () => {
    const noFile = await adminAgent.post('/admin/popups/upload').set('x-csrf-token', csrf);
    expect(noFile.status).toBe(400);
    const notImg = await adminAgent.post('/admin/popups/upload').set('x-csrf-token', csrf)
      .attach('image', Buffer.from('<?php echo 1; ?> not an image at all'), { filename: 'x.png', contentType: 'image/png' });
    expect(notImg.status).toBe(400);
  });
});
