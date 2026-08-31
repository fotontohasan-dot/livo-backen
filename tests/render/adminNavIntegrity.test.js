// tests/render/adminNavIntegrity.test.js
// ---------------------------------------------------------------------------
// অ্যাডমিন নেভিগেশন পুনর্গঠনের রিগ্রেশন গার্ড।
//
// পুনর্গঠনের সবচেয়ে বড় ঝুঁকি হলো নীরবে কোনো গন্তব্য হারিয়ে ফেলা — একটা ফিচার
// কোড-এ থেকেই যায় কিন্তু আর কোনো লিংক থেকে পৌঁছানো যায় না। git-এর আগের
// ভার্সনে সাইডবারে যে ৫১টা গন্তব্য ছিল, সেগুলোর প্রতিটা এখনো আছে কিনা এই
// টেস্ট সেটাই যাচাই করে।
// ---------------------------------------------------------------------------

const adminNav = require('../../utils/adminNav');

// পুনর্গঠনের আগে admin-layout.ejs-এ যত গন্তব্য ছিল (git HEAD থেকে নেওয়া)।
// এই তালিকা ইচ্ছাকৃতভাবে হার্ডকোড — এটাই "আগে কী ছিল"-র রেকর্ড।
const LEGACY_DESTINATIONS = [
  '/admin', '/admin/activity', '/admin/announcements', '/admin/api-keys', '/admin/api-logs',
  '/admin/audit-logs', '/admin/backups', '/admin/bets', '/admin/bonuses', '/admin/bot-logs',
  '/admin/bot-monitoring', '/admin/bot-monitoring/ip-rules', '/admin/cache', '/admin/cron-jobs',
  '/admin/diagnostics', '/admin/duplicate-accounts', '/admin/fraud-logs', '/admin/fraud-monitoring',
  '/admin/games', '/admin/kyc', '/admin/leaderboard', '/admin/localization', '/admin/login-history',
  '/admin/matches', '/admin/news', '/admin/notification-templates', '/admin/notifications',
  '/admin/promotions', '/admin/queues', '/admin/referrals', '/admin/reports', '/admin/roles',
  '/admin/roles/matrix', '/admin/security-overview', '/admin/sentry-status', '/admin/settings',
  '/admin/support', '/admin/system-diagnostics', '/admin/system-settings', '/admin/telegram',
  '/admin/tournaments', '/admin/transactions', '/admin/user-roles', '/admin/users', '/admin/vip',
  '/admin/vip/history', '/chat/admin', '/payment/admin/deposits', '/payment/admin/payments',
  '/payment/admin/summary'
];

describe('অ্যাডমিন নেভিগেশন — কোনো গন্তব্য হারায়নি', () => {
  const hrefs = adminNav.allHrefs();

  test.each(LEGACY_DESTINATIONS)('%s এখনো নেভিগেশনে আছে', (dest) => {
    expect(hrefs).toContain(dest);
  });

  test('পুরনো /admin/feature-flags-এর জায়গায় /admin/features আছে (রুট দুটোই কাজ করে)', () => {
    // পাথটা ইচ্ছাকৃতভাবে বদলানো হয়েছে; পুরনোটা routes/admin.js-এ অ্যালিয়াস
    // হিসেবে রয়ে গেছে, তাই পুরনো বুকমার্ক ভাঙে না।
    expect(hrefs).toContain('/admin/features');
    const src = require('fs').readFileSync(require('path').join(__dirname, '../../routes/admin.js'), 'utf8');
    expect(src).toMatch(/router\.get\('\/feature-flags'/);
  });

  test('কোনো লিংক দুইবার আসেনি', () => {
    const dupes = hrefs.filter((h, i) => hrefs.indexOf(h) !== i);
    expect(dupes).toEqual([]);
  });

  test('প্রতিটা আইটেমের href, label, icon ও active key আছে', () => {
    for (const item of adminNav.allItems()) {
      expect(typeof item.href).toBe('string');
      expect(item.href.startsWith('/')).toBe(true);
      expect(item.label).toBeTruthy();
      expect(item.icon).toBeTruthy();
      expect(item.active).toBeTruthy();
    }
  });

  test('কোনো গ্রুপ খালি নয়, এবং গ্রুপ আইডি ইউনিক', () => {
    const ids = adminNav.NAV.map(g => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const g of adminNav.NAV) expect(g.items.length).toBeGreaterThan(0);
  });

  test('নেস্টিং দুই স্তরের বেশি নয় (গ্রুপ → আইটেম)', () => {
    for (const g of adminNav.NAV) {
      for (const item of g.items) expect(item.items).toBeUndefined();
    }
  });
});

describe('permission-ভিত্তিক ফিল্টার', () => {
  test('super admin সব গন্তব্য দেখেন', () => {
    expect(adminNav.navFor(true, {}).length).toBe(adminNav.NAV.length);
  });

  test('permission ছাড়া অ্যাডমিনের নেভ খালি হয়ে যায় (লিংক লুকানো হয়)', () => {
    expect(adminNav.navFor(false, {}).length).toBe(0);
  });

  test('আংশিক permission — শুধু অনুমোদিত আইটেমই থাকে, খালি গ্রুপ বাদ পড়ে', () => {
    const nav = adminNav.navFor(false, { users_view: true, kyc_view: true });
    const hrefs = nav.reduce((a, g) => a.concat(g.items.map(i => i.href)), []);
    expect(hrefs).toContain('/admin/users');
    expect(hrefs).toContain('/admin/kyc');
    expect(hrefs).not.toContain('/admin/backups');
    for (const g of nav) expect(g.items.length).toBeGreaterThan(0);
  });

  test('প্রতিটা permission key services/rbac.js-এর ক্যাটালগে সত্যিই আছে', () => {
    const rbac = require('../../services/rbac');
    const known = Object.keys(rbac.PERMISSIONS || {});
    expect(known.length).toBeGreaterThan(0);
    for (const item of adminNav.allItems()) {
      if (item.permission) expect(known).toContain(item.permission);
    }
  });
});
