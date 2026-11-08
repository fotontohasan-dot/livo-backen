# Task 1 — Repository & Infrastructure Audit

Audited commit: `a20f67e68d475b31290c105da778f7c362e40e67` (before the Task 2 web/worker split landed in `main`).
Method: static read of the repo plus the full Jest suite run locally (213/213 suites, 3369/3369 tests passed; e2e not run).
Render Dashboard was **not** accessible; everything about live Render/DB/Redis state is **Unknown**.
Line numbers refer to the audited commit and may have shifted.

## Executive summary
The project is "Bet420": sports betting plus casino, tickets and deposit/withdrawal flows (bKash/Nagad/SSLCommerz, KYC, merchants). That is broader than the "virtual coins" description given; real-money flows carry separate legal risk that should be reviewed. Code quality is good: atomic bets, DB-level double-settlement protection, existing hardening. Main blockers for 1,000+ users on several instances were Socket.IO fan-out, unlocked match sync/backups and local-disk backups.

## Verified findings
**Critical / High**
1. No Socket.IO Redis adapter (`services/socket.js:145-171`): events reach only users on the same instance.
2. Match sync has no distributed lock (`services/matchUpdater.js:147-155`).
3. Backups have no lock and write to local disk (`services/backup.js:41-43`, `services/backupManager.js:170,616-622`).
4. `bank_cards.holder_name` may contain legacy plaintext passwords (`REMAINING_WORK.md:62-80`, `routes/profile.js:96,676`). Production data not inspected.
5. `SECURITY_INCIDENT.md` reports leaked credentials in git history, rotated 2026-08-29. Reported by the owner; not verified.

**Medium**
6. Pool `max` not set (`db.js:53-61`, default 10), shared by sessions, scheduler locks and requests.
7. Session-level advisory locks (`services/scheduler.js:326-353`) are incompatible with PgBouncer transaction pooling.
8. Post-commit side effects in the bet handler (commission, cashback, VIP, missions) are fire-and-forget (`routes/matches.js`).
9. Rate limiter silently falls back to in-memory when Redis is down (`middleware/redisRateLimitStore.js`, `services/redisRateLimitStore.js:15,39-40`).
10. No `render.yaml` at audit time.
11. `npm audit`: no high/critical in production dependencies (5 moderate); 23 including dev.

**Low**
12. Sync fs in admin locale handling (`routes/admin.js:5085-5090`, `app.js:580`).
13. 27 `SELECT *` in `routes/admin.js`.

## Financial safety (verified)
Bet debit, bet row and ledger entry are one transaction; `UPDATE ... WHERE coins >= $1` prevents overdraw races; settle/void guard on `status='pending'`; unique ledger index `(ref_bet_id,type)` plus update-block trigger (`migrations.js:919-954`); idempotency key unique index (`migrations.js:942`); admin settle and payment callbacks use `FOR UPDATE`. Residual risk: items 4 and 8, and `client_ref` is optional so a client that omits it is not protected against double-tap.

## Multi-instance readiness
- Safe: DB sessions, PG queue (`SKIP LOCKED`), 11 scheduler jobs (advisory lock), bet/settle, idempotency.
- Unsafe: Socket.IO fan-out, match sync, two backup schedulers, in-memory rate-limit fallback, local uploads/backups.
- Unknown: BullMQ coordination (Redis presence), cache fallback behaviour, Render instance count.

## Performance
Default pool of 10, one held connection per scheduler job, per-request session query, ~6 async side-effect queries per bet, `FOR SHARE` on hot markets. 149 indexes exist; slow queries cannot be assessed without production data.
