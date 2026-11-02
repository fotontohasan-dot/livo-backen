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
: > reports/smoke-last.log
# প্রতিটা স্যুট ফাইল আলাদা করে তালিকাভুক্ত করে ছোট ব্যাচে ভাগ করি (প্রতি ব্যাচ আলাদা jest প্রসেস)।
# কারণ: এক প্রসেসে অনেক স্যুট চালালে মেমরি জমে (৩-৪GB) এবং OS প্রসেস kill করে (OOM)।
# কম RAM-এর মেশিনে: SMOKE_BATCH=5 SMOKE_WORKERS=1 bash scripts/audit/run-smoke.sh
NODE_ENV=test npx jest "${existing[@]}" --listTests 2>/dev/null | sed "s|^$PWD/||" | sort > /tmp/smoke-files.txt
total=$(wc -l < /tmp/smoke-files.txt)
[ "$total" -gt 0 ] || { echo "❌ কোনো স্মোক টেস্ট ফাইল পাওয়া যায়নি"; exit 1; }
BATCH="${SMOKE_BATCH:-10}"
rc=0; n=0; b=0
mapfile -t ALL < /tmp/smoke-files.txt
while [ $n -lt "$total" ]; do
  b=$((b+1)); chunk=("${ALL[@]:$n:$BATCH}"); n=$((n+BATCH))
  echo "   ব্যাচ $b: ${#chunk[@]}টি ফাইল"
  NODE_ENV=test npx jest "${chunk[@]}" --maxWorkers="${SMOKE_WORKERS:-2}" --coverage=false --silent --testTimeout=40000 >> reports/smoke-last.log 2>&1
  crc=$?; [ $crc -ne 0 ] && rc=$crc
done
echo "Test Files: $total, ব্যাচ: $b"
grep -E "^Tests:" reports/smoke-last.log | sed 's/^/   /'
if [ "$rc" -eq 0 ]; then echo "✅ স্মোক পাস"; exit 0; fi
echo "❌ স্মোক ফেইল — কারণ (পূর্ণ লগ: reports/smoke-last.log):"
grep -E "^FAIL|●.*›" reports/smoke-last.log | sort -u | head -12 | sed 's/^/   /'
if grep -q "SIGKILL\|^Killed\|ENOMEM" reports/smoke-last.log; then
  echo "   ⚠️  প্রসেস kill হয়েছে — মেমরি কম। SMOKE_BATCH=5 SMOKE_WORKERS=1 দিয়ে আবার চালান।"
fi
if grep -qi "ECONNREFUSED\|password authentication\|does not exist" reports/smoke-last.log; then
  echo "   ⚠️  ডাটাবেস সমস্যা — PostgreSQL চালু আছে? DATABASE_URL ঠিক আছে? (README_START_HERE.md পর্ব-০)"
fi
exit "$rc"
