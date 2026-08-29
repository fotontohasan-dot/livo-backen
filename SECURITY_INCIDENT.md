# SECURITY INCIDENT — Credentials exposed in git history

**Status:** ROTATED — the exposed values are dead. Remaining items are
follow-up, not exposure.

**Rotation completed 2026-08-29**, reported by the repository owner: the Neon
password, the Render credential and `SESSION_SECRET` have all been rotated.
The values still present in git history therefore no longer grant access.
This was the one item that could not be fixed by a code change.
**Severity:** CRITICAL
**Found:** during the A–Z security hardening pass, Phase 10 (secrets), after
`git fetch --unshallow` made the full history readable. A shallow clone hides
this entirely, which is why earlier passes reported the history as clean.

> This document deliberately contains **no secret values**. Only the account
> names, host prefixes and lengths needed to identify what to rotate.

---

## 1. What is exposed

Three sets of credentials were committed to `.env` and `db.js` and remain
reachable from `origin/main` history. They are **not** in the current working
tree — deleting the file in a later commit does not remove it from history.

| # | Credential | Where | Still reachable from `main` |
|---|---|---|---|
| 1 | Neon PostgreSQL connection string — user `neondb_owner`, host prefix `ep-bitter-truth-…`, db `neondb`, password 16 chars | `.env` added in `b30e398`, deleted in `c5a54a0` | **YES** |
| 2 | Render PostgreSQL connection string — user `livo_db_opct_user`, host prefix `dpg-d8ghl7rbc2fs73ej8k70-a.orego…`, db `livo_db_opct`, password 32 chars | `.env` added in `8fb3db6`, deleted in `27cfce8`; also hardcoded in `db.js` until `4ed6f3b` | **YES** |
| 3 | `SESSION_SECRET` — 55 characters, high entropy | `.env` added in `8fb3db6` | **YES** |

The Render credential additionally appears across roughly a dozen commits
between `2026-06-04` and `2026-06-09` because it was hardcoded in `db.js` and
carried through `routes/payment.js` edits.

**The repository is public.** It was cloned during this audit with no
credentials at all. Assume every value above is known to third parties and
has been since the commit date — the earliest is `2026-06-04`.

### Not a finding

`-----BEGIN RSA PRIVATE KEY-----` also matches in history, but only inside
`node_modules/` test fixtures from a dependency that was committed and later
removed. That is a library's own test key, not a Livo key.

---

## 2. Why deleting the file was not enough

Commits `c5a54a0` and `27cfce8` ("Delete .env") remove the file from the
working tree only. The blobs stay in history and are served by GitHub to
anyone who clones, and remain in every existing fork, clone and CI cache.

---

## 3. Required actions, in order

Rotation comes first. History rewriting is secondary and does **not**
substitute for rotation, because the values are already public.

### Step 1 — Rotate now (do not wait for anything else) — DONE 2026-08-29

1. **Neon database** — reset the `neondb_owner` password in the Neon console,
   or delete the role and create a new one. Update `DATABASE_URL` in the
   deployment environment.
2. **Render database** — rotate the `livo_db_opct` credentials in the Render
   dashboard and update `DATABASE_URL` there.
3. **SESSION_SECRET** — generate a new one:
   `openssl rand -hex 32`. Note this invalidates every active session and
   logs all users out, including admins. Admin accounts, passwords, TOTP
   secrets and backup codes are unaffected, so admins can log back in
   normally. Schedule it, but do not skip it: with the old secret a third
   party can forge session cookies.

> Confirm the deployment environment now carries the new `DATABASE_URL` and
> `SESSION_SECRET`, and that the app came back up after the change. Rotating
> `SESSION_SECRET` logs everyone out; admin accounts, passwords, TOTP secrets
> and backup codes are untouched, so admins log back in normally.

### Step 2 — Check for prior abuse (still worth doing)

- Neon and Render both expose connection logs. Review connections from
  unrecognised IPs since `2026-06-04`.
- Review `audit_logs` and `admin_logs` for admin actions that no admin
  recognises.
- Reconcile `coin_transactions` against `payment_requests` for the same
  window. The audit found no evidence of abuse, but no evidence is not
  evidence of absence, and only the account owner can see the provider logs.

### Step 3 — Decide about history (now optional)

With the credentials rotated, the strings in history are worthless. Rewriting
is now a tidiness decision rather than a security one, and it carries real
cost (every commit hash changes, collaborators re-clone, open PRs recreated).
Leaving history as-is is a defensible choice.

Once rotated, the exposed values are worthless and rewriting becomes
optional.

**Do not delete paths.** The credentials are not only in `.env` — they were
also committed into `db.js`, `routes/payment.js` and `dist/bundle.js`. Those
are real source files with legitimate history, so `--path .env
--invert-paths` would both miss the leak and, if extended to those paths,
destroy history you want to keep.

The correct approach replaces the secret *strings* while leaving every file
and commit in place:

```bash
# 1. Write the replacement rules to a file OUTSIDE the repo, so it is never
#    committed. One line per leaked value:
#       <literal-secret>==>***REMOVED***
#    Take the values from your Neon and Render dashboards, or from
#    `git show 8fb3db6` and `git show b30e398` locally. Never commit this file.
cat > ~/livo-replacements.txt <<'EOF'
<neon-connection-string>==>***REMOVED***
<render-connection-string>==>***REMOVED***
<old-session-secret>==>***REMOVED***
EOF

# 2. Work on a fresh mirror clone, never on your working repo
git clone --mirror https://github.com/fotontohasan-dot/livo-backen.git livo-mirror
cd livo-mirror

# 3. Rewrite
git filter-repo --replace-text ~/livo-replacements.txt

# 4. Verify before publishing anything
git log --all -p | grep -c 'neondb_owner:npg_'   # expect 0
git log --all -p | grep -c 'livo_db_opct_user:O' # expect 0

# 5. Only then publish, and delete the replacements file
rm ~/livo-replacements.txt
```

Publishing the rewrite requires a force push, which this audit deliberately
did not perform. It rewrites every commit hash, so all collaborators must
re-clone and open pull requests must be recreated. It also does not reach
forks, existing clones or third-party mirrors — which is exactly why rotation
is step 1 and this is step 3.

### Step 4 — Prevent recurrence

- `.gitignore` already lists `.env`. Confirm it is not overridden by
  `git add -f` habits.
- `.env.example` should hold placeholder values only. It currently does.
- Run `npm run scan:secrets` (added alongside this document) before releases,
  and consider enabling GitHub secret scanning with push protection on the
  repository.

---

## 4. Verification performed during this audit

- Current working tree: **no live credentials** — the only matches are
  placeholder values in tests and views.
- Full history (1,596 commits, ~35 MB of diff): the three items above are the
  only real credentials found. No AWS keys, no GitHub tokens, no Anthropic or
  OpenAI keys, no Slack tokens, no JWTs, no Livo private keys.
- Telegram bot tokens found in history are the fake fixtures used by tests.
