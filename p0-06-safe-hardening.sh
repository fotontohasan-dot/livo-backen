#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# P0-06 SAFE CREDENTIAL HARDENING
# Rule: FIND -> FIX -> TEST -> VERIFY
# NEVER DELETE / REVOKE / PURGE
# ============================================================

echo "=== P0-06 SAFE HARDENING START ==="

# Safety guard
export GIT_TERMINAL_PROMPT=0

echo
echo "[1/5] Checking repository state..."

if [ ! -d ".git" ]; then
  echo "ERROR: Run this from the repository root."
  exit 1
fi

git status --short

echo
echo "[2/5] Creating a safety backup..."

BACKUP_DIR=".security-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"
BACKUP_BASE="$(basename "$BACKUP_DIR")"

cp -a package.json "$BACKUP_DIR/" 2>/dev/null || true
cp -a package-lock.json "$BACKUP_DIR/" 2>/dev/null || true

echo "Backup created: $BACKUP_DIR"

echo
echo "[3/5] Detecting credential usage..."

FOUND=0

PATTERN='DATABASE_URL|SESSION_SECRET|CLOUDINARY|SPORTS.*KEY|SPORTS.*SECRET|API.*KEY|API.*SECRET|TOKEN'

grep -RniE "$PATTERN" \
  --exclude-dir=node_modules \
  --exclude-dir=.git \
  --exclude-dir=.next \
  --exclude-dir=".security-backup-*" \
  --exclude-dir="$BACKUP_BASE" \
  . > "$BACKUP_DIR/credential-references.txt" 2>/dev/null || true

if [ -s "$BACKUP_DIR/credential-references.txt" ]; then
    FOUND=1
    echo "Credential references found."
    echo "Review: $BACKUP_DIR/credential-references.txt"
else
    echo "No credential references found."
fi

echo
echo "[4/5] Checking for accidentally hard-coded secrets..."

grep -RniE \
  '(password|secret|token|api[_-]?key)[[:space:]]*[:=][[:space:]]*["'\''][^"'\'']{12,}' \
  --exclude-dir=node_modules \
  --exclude-dir=.git \
  --exclude-dir=.next \
  --exclude-dir=".security-backup-*" \
  --exclude-dir="$BACKUP_BASE" \
  . > "$BACKUP_DIR/hardcoded-secrets.txt" 2>/dev/null || true

if [ -s "$BACKUP_DIR/hardcoded-secrets.txt" ]; then

    echo "WARNING: Possible hard-coded secret detected."
    echo "Report: $BACKUP_DIR/hardcoded-secrets.txt"

    # IMPORTANT:
    # Do NOT automatically replace unknown secrets.
    # Replacing them blindly can break production services.
    #
    # Instead, create a safe environment-template entry
    # where possible, while leaving the actual application
    # secret untouched.

else
    echo "No obvious hard-coded secrets detected."
fi

echo
echo "[5/5] Running verification..."

if [ -f package.json ]; then
    if [ ! -d node_modules ]; then
        echo "node_modules missing - installing dependencies (non-destructive)..."
        npm ci --no-audit --no-fund || npm install --no-audit --no-fund
    fi
    set +e
    npm test -- --runInBand
    TEST_RC=$?
    set -e

    # Exit 137 = SIGKILL (out-of-memory). The default test script runs jest
    # with --coverage, which can exhaust memory on small machines. Retry once
    # without coverage before declaring a real failure. This is non-destructive.
    if [ "$TEST_RC" -eq 137 ]; then
        echo "Test run was killed (likely OOM). Retrying without coverage..."
        set +e
        NODE_OPTIONS="--max-old-space-size=${P006_HEAP_MB:-1024}" \
          npx jest --runInBand --coverage=false --forceExit
        TEST_RC=$?
        set -e
    fi

    if [ "$TEST_RC" -eq 0 ]; then
        echo "TEST RESULT: PASS"
    else
        echo "TEST RESULT: FAIL"
        echo "The script will NOT delete or revert anything."
        echo "The failure must be investigated before continuing."
        exit 1
    fi
fi

echo
echo "============================================================"
echo "P0-06 SAFE HARDENING FINISHED"
echo "============================================================"
echo
echo "NO FILES WERE DELETED."
echo "NO CREDENTIALS WERE REVOKED."
echo "NO GIT HISTORY WAS PURGED."
echo "NO LIVE SECRET WAS AUTOMATICALLY REPLACED."
echo
echo "Review:"
echo "  $BACKUP_DIR/credential-references.txt"
echo "  $BACKUP_DIR/hardcoded-secrets.txt"
echo
echo "Next action: only verified, non-destructive fixes should be applied."
