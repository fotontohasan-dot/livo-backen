#!/usr/bin/env bash
# scripts/audit/safe-delete.sh — ফাইল মোছার নিরাপদ নিয়ম (টেস্ট-গেটেড)
#
# প্রতিটা ফাইলের জন্য:
#   ১) কোথাও রেফারেন্স আছে কিনা খোঁজে (কোড/ভিউ/কনফিগ)। থাকলে মোছে না, ব্লক করে।
#   ২) স্মোক টেস্ট চালায় (বেসলাইন)। আগে থেকেই ফেইল করলে থামে — যাতে মোছার দোষ না পড়ে।
#   ৩) ফাইলটা মোছে (git rm), আবার স্মোক টেস্ট চালায়।
#   ৪) টেস্ট ফেইল করলে সাথে সাথে ফাইল ফেরত আনে (RESTORED)। পাস করলে আলাদা কমিটে সেভ করে।
#
# ব্যবহার:
#   bash scripts/audit/safe-delete.sh [--dry-run] [--no-commit] <path> [<path> ...]
#   # যে ফাইলের রেফারেন্স শুধু টেস্ট ফাইলে আছে, সেই টেস্ট ফাইলটাও একই কমান্ডে দিন:
#   bash scripts/audit/safe-delete.sh services/liveApi.js tests/liveApi.test.js
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

DRY=0; COMMIT=1; PATHS=()
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1;; --no-commit) COMMIT=0;;
    -h|--help) sed -n 2,20p "$0"; exit 0;;
    *) PATHS+=("$a");;
  esac
done
[ ${#PATHS[@]} -gt 0 ] || { echo "কোনো পাথ দেননি। --help দেখুন।"; exit 2; }

PROTECTED='^(app\.js|server\.js|db\.js|migrations\.js|package\.json|package-lock\.json|Dockerfile|jest\.config\.js|\.gitignore|\.dockerignore|locales/.*|middleware/.*|.*\.sql)$'
mkdir -p reports
LOG=reports/deleted.log

in_args() { local x; for x in "${PATHS[@]}"; do [ "$x" = "$1" ] && return 0; done; return 1; }

re_esc() { printf '%s' "$1" | sed 's/[][\.*^$(){}+?|/]/\\&/g'; }

find_refs() { # $1=path → হিটের তালিকা (file:line:text), নিজের ফাইল/ডক/লকফাইল/reports বাদে
  local p="$1" base noext name pats=() B='(^|[^[:alnum:]_-])' E='([^[:alnum:]_-]|$)'
  base=$(basename "$p"); noext="${p%.*}"
  case "$p" in
    views/*.ejs) name="${p#views/}"; name="${name%.ejs}"
      pats+=(-e "['\"\`]$(re_esc "$name")['\"\`]");;
    *) case "$base" in index.js|_template.js|*.config.js) ;; *) pats+=(-e "${B}$(re_esc "$base")${E}");; esac
       pats+=(-e "${B}$(re_esc "$noext")${E}");;
  esac
  [ ${#pats[@]} -gt 0 ] || return 0
  git grep -n -I -E "${pats[@]}" -- . ":(exclude)$p" ':(exclude)*.md' ':(exclude)package-lock.json' ':(exclude)reports/*' ':(exclude)scripts/audit/*' 2>/dev/null || true
}

run_smoke() { bash scripts/audit/run-smoke.sh; }

echo "════ নিরাপদ মোছা: ${#PATHS[@]}টি পাথ ════"
BASELINE_OK=0
for P in "${PATHS[@]}"; do
  echo; echo "──── $P"
  git ls-files --error-unmatch "$P" >/dev/null 2>&1 || { echo "  ⏭  git-এ ট্র্যাকড নয় / আগেই মোছা — বাদ"; continue; }
  if [[ "$P" =~ $PROTECTED ]]; then echo "  🛑 সুরক্ষিত ফাইল — এই স্ক্রিপ্ট দিয়ে মোছা যাবে না (হাতে, আলাদা রিভিউয়ে করুন)"; continue; fi

  REFS=$(find_refs "$P")
  BLOCK=""; NOTES=""
  if [ -n "$REFS" ]; then
    while IFS= read -r line; do
      f="${line%%:*}"; rest="${line#*:}"; text="${rest#*:}"
      if in_args "$f"; then continue; fi          # যে ফাইলও একসাথে মোছা হচ্ছে তার রেফারেন্স বাধা নয়
      if [[ "$text" =~ ^[[:space:]]*(//|\*|/\*|#|\<!--|--) ]]; then NOTES+="$line"$'\n'; continue; fi  # শুধু কমেন্টে উল্লেখ — বাধা নয়
      BLOCK+="$line"$'\n'
    done <<< "$REFS"
  fi
  if [ -n "$BLOCK" ]; then
    echo "  🛑 ব্লক — এখনো রেফারেন্স আছে (এটা সত্যিই ব্যবহৃত হতে পারে):"
    echo "$BLOCK" | head -8 | cut -c1-170 | sed 's/^/     /'
    echo "  → রেফারেন্সগুলো দেখুন। ডেড হলে রেফারেন্সসহ একসাথে মুছুন, নইলে ফাইলটা রাখুন।"
    echo "BLOCKED $P" >> "$LOG"; continue
  fi
  echo "  ✓ কোড/ভিউ/কনফিগে কোনো রেফারেন্স নেই"
  if [ -n "$NOTES" ]; then echo "  ℹ️  শুধু কমেন্টে উল্লেখ আছে (মোছার পর কমেন্ট আপডেট করবেন):"; echo "$NOTES" | head -4 | cut -c1-150 | sed 's/^/     /'; fi
  [ $DRY -eq 1 ] && { echo "  (dry-run — মোছা হলো না)"; continue; }

  if [ $BASELINE_OK -eq 0 ]; then
    echo "  → বেসলাইন স্মোক টেস্ট..."
    run_smoke || { echo "🛑 মোছার আগেই স্মোক ফেইল করছে — আগে সেটা ঠিক করুন। কিছু মোছা হয়নি।"; exit 1; }
    BASELINE_OK=1
  fi

  git rm -q -- "$P" || { echo "  ❌ git rm ব্যর্থ"; continue; }
  echo "  → মুছে স্মোক টেস্ট..."
  if run_smoke; then
    echo "  ✅ মোছা হয়েছে — টেস্ট পাস"
    echo "DELETED $P" >> "$LOG"
    if [ $COMMIT -eq 1 ]; then git commit -q -m "chore(dead-code): remove $P" -m "রেফারেন্স নেই (git grep), মোছার আগে-পরে স্মোক টেস্ট পাস। scripts/audit/safe-delete.sh" -- "$P" && echo "  📝 কমিট হয়েছে (ভুল হলে: git revert HEAD)"; fi
  else
    git reset -q HEAD -- "$P"; git checkout -q -- "$P"
    echo "  ♻️  RESTORED — মোছার পর টেস্ট ফেইল করেছে, ফাইল ফেরত আনা হয়েছে। এটা ব্যবহৃত! মুছবেন না।"
    echo "RESTORED $P" >> "$LOG"
  fi
done
echo; echo "════ শেষ। লগ: $LOG ════"
echo "⚠️  সব মোছা শেষে অবশ্যই পূর্ণ টেস্ট চালান:  npm test"
