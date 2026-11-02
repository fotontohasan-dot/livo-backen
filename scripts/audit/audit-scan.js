#!/usr/bin/env node
/* eslint-disable */
// scripts/audit/audit-scan.js
// ---------------------------------------------------------------------------
// রিপোর "মৃত কোড / ভাঙা রেফারেন্স / অব্যবহৃত ডিপেন্ডেন্সি" স্ক্যানার।
// কোনো ফাইল বদলায় না — শুধু রিপোর্ট ছাপে এবং reports/ ফোল্ডারে সেভ করে।
// চালানো:  node scripts/audit/audit-scan.js     (রিপো-রুট থেকে)
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const sh = (c) => execSync(c, { encoding: 'utf8', maxBuffer: 1 << 28 });
const files = sh('git ls-files').split('\n').filter(Boolean).filter((f) => fs.existsSync(f));
const fileSet = new Set(files);
const isJs = (f) => /\.(js|cjs|mjs)$/.test(f);
const isTest = (f) => /^(tests|verification)\//.test(f) || /\.(test|spec)\.js$/.test(f);
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const out = [];
const log = (s = '') => { out.push(s); console.log(s); };
const H = (s) => log(`\n## ${s}\n`);

log('# অডিট স্ক্যান রিপোর্ট');
log(`তারিখ: ${new Date().toISOString()}  |  কমিট: ${sh('git rev-parse --short HEAD').trim()}  |  ট্র্যাকড ফাইল: ${files.length}`);

// ---------- 1. সিনট্যাক্স ----------
H('১. সিনট্যাক্স চেক (node --check)');
let bad = 0;
for (const f of files.filter(isJs)) {
  if (/^(sports-api\/|verify_all\.spec\.js)/.test(f)) continue; // ESM
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) { bad++; log(`- ❌ ${f}\n  ${(r.stderr || '').split('\n').slice(0, 3).join(' ')}`); }
}
for (const f of files.filter((x) => x.endsWith('.json') && !x.includes('package-lock'))) {
  try { JSON.parse(read(f)); } catch (e) { bad++; log(`- ❌ ${f}: ${e.message}`); }
}
log(bad ? `মোট ${bad}টি ব্যর্থ` : '✅ সব JS/JSON ঠিক আছে');

// ---------- 2. require গ্রাফ ----------
H('২. ভাঙা relative require ও এন্ট্রিপয়েন্ট থেকে অপ্রাপ্য সার্ভার ফাইল');
function resolveReq(from, req) {
  if (!req.startsWith('.')) return null;
  const base = path.normalize(path.join(path.dirname(from), req));
  for (const c of [base, base + '.js', base + '.json', base + '/index.js']) if (fileSet.has(c)) return c;
  return null;
}
const edges = {}; const broken = [];
for (const f of files.filter(isJs)) {
  edges[f] = [];
  const re = /(?:require\(\s*|from\s+|import\(\s*)['"]([^'"]+)['"]/g; let m; const src = read(f);
  while ((m = re.exec(src))) {
    if (!m[1].startsWith('.')) continue;
    const r = resolveReq(f, m[1]);
    if (r) edges[f].push(r); else broken.push([f, m[1]]);
  }
}
// require() লাইনের বাইরে (কমেন্টে) থাকা ভুয়া রেফারেন্স বাদ দিতে: শুধু যেগুলো লাইনের শুরুতে // নেই
const realBroken = broken.filter(([f, r]) => read(f).split('\n').some((l) => (l.includes("'" + r + "'") || l.includes('"' + r + '"') || l.includes('`' + r + '`')) && !/^\s*(\/\/|\*)/.test(l) && !/expect\(|toContain\(|toMatch\(/.test(l)));
log(realBroken.length ? realBroken.map(([f, r]) => `- ❌ ${f} → ${r}`).join('\n') : '✅ কোনো ভাঙা relative require নেই');
const seen = new Set(); const q = ['server.js', 'app.js'];
while (q.length) { const f = q.pop(); if (seen.has(f)) continue; seen.add(f); (edges[f] || []).forEach((x) => q.push(x)); }
const serverFiles = files.filter((f) => isJs(f) && !isTest(f) && !/^(public|assets|sports-api|src|docs|android)\//.test(f));
const entry = new Set(['server.js', 'app.js', 'verify_all.js', 'verify_all.spec.js', 'jest.config.js', 'playwright.config.js', 'postcss.config.js', 'next.config.js', 'webpack.config.js']);
log('\nঅপ্রাপ্য (কেউ require করে না) — মুছার প্রার্থী, নিচের "কে রেফারেন্স করছে" দেখে সিদ্ধান্ত নিন:\n');
log('| ফাইল | লাইন | রেফারেন্স করে (টেস্ট/স্ক্রিপ্ট) |');
log('|---|---|---|');
for (const f of serverFiles.filter((x) => !seen.has(x))) {
  if (/^(scripts|tools)\//.test(f) || entry.has(f)) continue; // CLI টুল — আলাদা তালিকায়
  const by = files.filter((g) => isJs(g) && (edges[g] || []).includes(f)).slice(0, 3).join(', ') || '—';
  log(`| ${f} | ${read(f).split('\n').length} | ${by} |`);
}
log('\nCLI/স্ক্রিপ্ট ফাইল যেগুলো package.json scripts বা অন্য কোথাও থেকে চলে না (যাচাই করে সিদ্ধান্ত):\n');
const pkgScripts = JSON.stringify(JSON.parse(read('package.json')).scripts || {});
const nonJs = files.filter((f) => !f.endsWith('.js')).map(read).join('\n');
for (const f of serverFiles.filter((x) => /^(scripts|tools)\//.test(x) || entry.has(x))) {
  if (seen.has(f)) continue;
  const b = path.basename(f);
  const refs = files.filter((g) => g !== f && !g.endsWith('.md') && !g.includes('package-lock') && read(g).includes(b));
  if (!pkgScripts.includes(b) && refs.length === 0) log(`- ${f}`);
}

// ---------- 3. ভিউ ----------
H('৩. অব্যবহৃত EJS ভিউ ও ভিউয়ের ভাঙা স্ট্যাটিক লিংক');
const views = files.filter((f) => f.startsWith('views/') && f.endsWith('.ejs'));
const codeSrc = files.filter((f) => isJs(f) && !isTest(f) && !f.startsWith('public/')).map(read).join('\n');
const ejsSrc = views.map(read).join('\n');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
for (const v of views) {
  const name = v.replace(/^views\//, '').replace(/\.ejs$/, '');
  const re = new RegExp('[\'"`/]' + esc(name) + '[\'"`]');
  const incl = new RegExp('include\\(\\s*[\'"][^\'"]*' + esc(path.basename(name)) + '[\'"]');
  if (!re.test(codeSrc) && !re.test(ejsSrc) && !incl.test(ejsSrc)) log(`- ${v}`);
}
log('\nভাঙা /public রেফারেন্স:');
let vb = 0;
for (const v of views) {
  const re = /(?:src|href)=["'](\/[^"'?#<%]+\.(?:js|css|png|jpg|jpeg|svg|webp|ico|json|webmanifest))/g; let m;
  const s = read(v);
  while ((m = re.exec(s))) {
    const p = m[1].slice(1);
    if (!fileSet.has('public/' + p) && !fileSet.has(p) && !/^(socket\.io|manifest|admin-manifest)/.test(p)) { vb++; log(`- ${v} → ${m[1]}`); }
  }
}
if (!vb) log('✅ নেই');

// ---------- 4. public অ্যাসেট ----------
H('৪. কোনো ফাইলে নাম ধরে রেফারেন্স নেই এমন public/assets ফাইল');
log('(ডায়নামিক পাথ — DB/স্ক্রিপ্ট থেকে লোড — থাকতে পারে; তাই মোছার আগে safe-delete.sh চালান)\n');
const hay = files.filter((f) => /\.(js|ejs|json|html|css|yml|yaml|sh|ts|tsx|webmanifest)$/.test(f) && !f.includes('package-lock')).map((f) => [f, read(f)]);
for (const f of files.filter((x) => /^(public|assets)\//.test(x) && !/\.gitkeep$/.test(x))) {
  const b = path.basename(f);
  if (hay.some(([g, s]) => g !== f && s.includes(b))) continue;
  let kb = 0; try { kb = Math.round(fs.statSync(f).size / 1024); } catch {}
  log(`- ${f} (${kb}KB)`);
}

// ---------- 5. ডিপেন্ডেন্সি ----------
H('৫. ডিপেন্ডেন্সি');
const pkg = JSON.parse(read('package.json'));
const deps = Object.keys(pkg.dependencies || {}); const dev = Object.keys(pkg.devDependencies || {});
const used = {};
const addU = (n, f) => (used[n] = used[n] || new Set()).add(f);
for (const f of files) {
  if (f === 'package.json' || f.includes('package-lock') || f.startsWith('sports-api/') || f.endsWith('.md')) continue;
  const s = read(f);
  if (/\.(js|cjs|mjs|ts|tsx|jsx|ejs|css)$/.test(f)) {
    const re = /(?:require\(|from\s+|import\(|import\s+|@import\s+|@plugin\s+)\s*['"]((?:@[\w.-]+\/)?[\w.-]+)/g; let m;
    while ((m = re.exec(s))) if (!m[1].startsWith('.')) addU(m[1], f);
  }
  if (/\.(yml|yaml|sh)$/.test(f) || f === 'Dockerfile') for (const d of deps.concat(dev)) if (s.includes(d)) addU(d, f);
}
for (const v of Object.values(pkg.scripts || {})) for (const d of deps.concat(dev)) if (v.includes(d)) addU(d, 'package.json#scripts');
log('ঘোষিত কিন্তু কোথাও ব্যবহৃত নয়:');
const KNOWN_TOOLING = {
  autoprefixer: 'postcss.config.js-এ plugin হিসেবে ব্যবহৃত (কী হিসেবে লেখা, require নয়) — রাখুন',
  '@sentry/cli': 'scripts/sentry-sourcemaps.js `npx @sentry/cli` দিয়ে চালায় — রাখুন',
  typescript: 'শুধু src/ (Next.js) এর জন্য — src/ সরালে এটাও সরবে',
  'react-dom': 'শুধু src/ (Next.js) এর জন্য — src/ সরালে এটাও সরবে',
  '@types/node': 'শুধু src/ (TypeScript) এর জন্য', '@types/react': 'শুধু src/ এর জন্য', '@types/react-dom': 'শুধু src/ এর জন্য'
};
const unusedDeps = deps.concat(dev).filter((d) => !used[d]);
log(unusedDeps.length ? unusedDeps.map((d) => `- ${d} ${deps.includes(d) ? '(dependencies)' : '(devDependencies)'}${KNOWN_TOOLING[d] ? ' → ℹ️ ' + KNOWN_TOOLING[d] : ''}`).join('\n') : '✅ নেই');
const core = new Set(require('module').builtinModules);
log('\nব্যবহৃত কিন্তু package.json-এ ঘোষিত নয়:');
const undeclared = Object.keys(used).filter((u) => !deps.includes(u) && !dev.includes(u) && !core.has(u) && !u.startsWith('node:') && !['node', 'ws', 'next'].includes(u));
log(undeclared.length ? undeclared.map((u) => `- ${u} ← ${[...used[u]].slice(0, 3).join(', ')}`).join('\n') : '✅ নেই');
log('\n`next` ডিপেন্ডেন্সি ঘোষিত? ' + (deps.concat(dev).includes('next') ? 'হ্যাঁ' : '❌ না (অথচ src/ ও next.config.js আছে)'));

// ---------- 6. জঞ্জাল প্যাটার্ন ----------
H('৬. জঞ্জাল ফাইলের প্যাটার্ন');
const junk = files.filter((f) => /(^|\/)(IMG_\d+\.(png|jpe?g)|.*\.js\.txt|image_name|\.last-run\.json)$/.test(f) || /^(test-results|verification)\//.test(f) || /\s/.test(f));
log(junk.length ? junk.map((f) => `- ${f}`).join('\n') : '✅ নেই');

fs.mkdirSync('reports', { recursive: true });
const outFile = `reports/audit-scan-${new Date().toISOString().slice(0, 10)}.md`;
fs.writeFileSync(outFile, out.join('\n') + '\n');
console.log(`\n(সেভ হয়েছে: ${outFile})`);
