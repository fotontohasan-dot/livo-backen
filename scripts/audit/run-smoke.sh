#!/usr/bin/env bash
# scripts/audit/run-smoke.sh — দ্রুত "কিছু ভাঙেনি তো?" পরীক্ষা (সিনট্যাক্স + স্মোক টেস্ট)।
# আগে DB চালু থাকতে হবে (README_START_HERE.md দেখুন)। exit code 0 = ঠিক আছে।
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

echo "→ [১/২] সব JS ফাইলের সিনট্যাক্স"
fail=0
while IFS= read -r f; do
  case "$f" in sports-api/*|verify_all.spec.js) continue;; esac
  [ -f "$f" ] || continue
  node --check "$f" 2>/tmp/smoke-syntax.err || { echo "  ❌ $f"; head -3 /tmp/smoke-syntax.err; fail=1; }
done < <(git ls-files '*.js' '*.cjs' '*.mjs'; git ls-files --others --exclude-standard '*.js')
[ $fail -eq 0 ] || { echo "সিনট্যাক্স এরর"; exit 1; }

echo "→ [২/২] স্মোক টেস্ট (scripts/audit/smoke-tests.txt)"
mapfile -t T < <(grep -v '^\s*#' scripts/audit/smoke-tests.txt | sed '/^\s*$/d')
existing=(); for t in "${T[@]}"; do [ -e "$t" ] && existing+=("$t"); done
mkdir -p reports
NODE_ENV=test npx jest "${existing[@]}" --runInBand --coverage=false --silent --testTimeout=40000 > reports/smoke-last.log 2>&1
rc=$?
grep -E "^(Tests|Test Suites):" reports/smoke-last.log
if [ "$rc" -eq 0 ]; then echo "✅ স্মোক পাস"; exit 0; fi
echo "❌ স্মোক ফেইল — কারণ (পূর্ণ লগ: reports/smoke-last.log):"
grep -E "^FAIL|●.*›" reports/smoke-last.log | sort -u | head -12 | sed 's/^/   /'
if grep -q "^Killed\|SIGKILL\|ENOMEM" reports/smoke-last.log || [ "$rc" -eq 137 ]; then
  echo "   ⚠️  প্রসেস kill হয়েছে — সম্ভবত মেমরি কম। অন্য ভারী প্রসেস (অন্য jest রান) বন্ধ করে আবার চালান।"
fi
if grep -qi "ECONNREFUSED\|password authentication\|does not exist" reports/smoke-last.log; then
  echo "   ⚠️  ডাটাবেস সমস্যা — PostgreSQL চালু আছে? DATABASE_URL ঠিক আছে? (README_START_HERE.md §২)"
fi
exit "$rc"
