// অ্যাডমিন মেনুতে /admin/integrations লিংক — পেজের নিজস্ব permission-এর সাথেই গেটেড।
const fs = require('fs');
const path = require('path');
const adminNav = require('../../utils/adminNav');

const flat = (nav) => nav.reduce((a, g) => a.concat(g.items), []);

describe('admin nav: /admin/integrations', () => {
  test('লিংক আছে এবং permission পেজের রুটের permission-এর সমান', () => {
    const routeSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'routes', 'adminHealthFix.js'), 'utf8');
    const m = /router\.get\('\/integrations',[^\n]*requirePermission\('([a-z_]+)'\)/.exec(routeSrc);
    expect(m).not.toBeNull();
    const item = flat(adminNav.NAV).find((i) => i.href === '/admin/integrations');
    expect(item).toBeDefined();
    expect(item.permission).toBe(m[1]);
    expect(item.active).toBe('integrations');
  });

  test('শুধু ওই permission থাকলে দেখা যায়, না থাকলে লুকানো', () => {
    const withPerm = flat(adminNav.navFor(false, { system_diagnostics_view: true })).map((i) => i.href);
    const without = flat(adminNav.navFor(false, { settings_view: true })).map((i) => i.href);
    expect(withPerm).toContain('/admin/integrations');
    expect(without).not.toContain('/admin/integrations');
  });

  test('en/bn লেবেল আছে', () => {
    for (const l of ['en', 'bn']) {
      const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'locales', `${l}.json`), 'utf8'));
      expect(j.admin_nav_item_integrations).toBeTruthy();
    }
  });
});
