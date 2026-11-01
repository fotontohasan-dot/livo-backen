#!/usr/bin/env bash
# scripts/audit/audit-lint.sh — ফাইলের ভেতরের মৃত/ভাঙা কোড (অব্যবহৃত ভেরিয়েবল, undefined, অপ্রাপ্য কোড, ডুপ্লিকেট) খোঁজে।
# রিপো-রুট থেকে চালান:  bash scripts/audit/audit-lint.sh
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
if [ ! -d .audit-tools/node_modules/eslint ]; then
  echo "→ অডিট টুল ইনস্টল হচ্ছে (.audit-tools/, git-ignored)..."
  npm i --prefix .audit-tools --no-audit --no-fund --silent eslint@9 globals@15
fi
mkdir -p reports
.audit-tools/node_modules/.bin/eslint -c scripts/audit/eslint.config.js --no-warn-ignored -f json . > reports/eslint.json || true
node - <<'JS'
const d = require(process.cwd() + '/reports/eslint.json');
const rows = [];
for (const r of d) for (const m of r.messages) rows.push({ f: r.filePath.replace(process.cwd() + '/', ''), l: m.line, rule: m.ruleId, sev: m.severity, msg: m.message });
const errs = rows.filter((x) => x.sev === 2), warns = rows.filter((x) => x.sev === 1);
let out = `# ESLint অডিট\n\nerror: ${errs.length}, warning: ${warns.length}\n\n## Errors (undefined/অপ্রাপ্য/ডুপ্লিকেট)\n`;
out += '> ⚠️ `no-undef` সব সত্যিকারের বাগ নয়: ব্রাউজার স্ক্রিপ্টে অন্য <script> বা CDN থেকে আসা গ্লোবাল (যেমন Bet420Toast, showAdminToast, attachContentFilter) ফলস-পজিটিভ। প্রতিটা হাতে যাচাই করুন।\n\n';
for (const x of errs) out += `- ${x.f}:${x.l} [${x.rule}] ${x.msg}\n`;
out += '\n## Warnings (অব্যবহৃত ভ্যারিয়েবল ইত্যাদি)\n\n';
for (const x of warns) out += `- ${x.f}:${x.l} [${x.rule}] ${x.msg}\n`;
require('fs').writeFileSync('reports/eslint-summary.md', out);
console.log(out);
JS
