// tests/unit/rateLimitIpv6Keys.test.js
// ---------------------------------------------------------------------------
// express-rate-limit v8: কাস্টম keyGenerator-এ কাঁচা req.ip ধরলে একজন IPv6 ইউজার নিজের
// সাবনেটের অসংখ্য ঠিকানা ঘুরিয়ে রেট-লিমিট এড়াতে পারে। সব keyGenerator তাই
// ipKeyGenerator(req.ip) ব্যবহার করে — এই টেস্ট সেটা ধরে রাখে।
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const { ipKeyGenerator } = require('../../middleware/rateLimitFactory');

const ROOT = path.join(__dirname, '..', '..');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'tests', 'public', 'src', 'android', 'docs'].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith('.js')) out.push(full);
  }
  return out;
}

describe('রেট-লিমিট keyGenerator — IPv6-নিরাপদ', () => {
  test('একই IPv6 সাবনেটের ভিন্ন ঠিকানা একই কী পায়; IPv4 অপরিবর্তিত', () => {
    expect(ipKeyGenerator('2001:db8:abcd:12::1')).toBe(ipKeyGenerator('2001:db8:abcd:12:ffff:ffff:ffff:ffff'));
    expect(ipKeyGenerator('2001:db8:abcd:12::1')).not.toBe(ipKeyGenerator('2001:db8:ffff:12::1'));
    expect(ipKeyGenerator('203.0.113.7')).toBe('203.0.113.7');
  });

  test('কোনো keyGenerator কাঁচা req.ip ব্যবহার করে না', () => {
    const offenders = [];
    for (const f of walk(ROOT)) {
      const lines = fs.readFileSync(f, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!/keyGenerator\s*:/.test(line) || /^\s*(\/\/|\*)/.test(line)) return;
        if (/\breq\.ip\b/.test(line) && !/ipKeyGenerator\(\s*req\.ip\s*\)/.test(line.replace(/ipKeyGenerator\(\s*req\.ip\s*\)/g, 'ipKeyGenerator(req.ip)')) ) offenders.push(`${path.relative(ROOT, f)}:${i + 1}`);
        else if (/\breq\.ip\b/.test(line) && line.replace(/ipKeyGenerator\(\s*req\.ip\s*\)/g, '').includes('req.ip')) offenders.push(`${path.relative(ROOT, f)}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
