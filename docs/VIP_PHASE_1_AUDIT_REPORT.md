# VIP Phase 1 — Repository Audit Report

- Repo: `fotontohasan-dot/livo-backen` (package name `bet420-backen`)
- Audited commit: `f0c857c0` (`main`, "Merge PR #297 profile-redesign-v2")
- Audit date: 2026-11-19
- Scope: **read-only audit.** No application code, migration, setting or data was changed. Only `docs/` files were added.

> Method note: everything below comes from reading the code in the repo at the commit above. Nothing was run against a live DB, staging or production, so "works" means "the code path exists and reads correctly", not "verified in production".

---

## 0. Executive summary

| # | Finding | Severity |
|---|---|---|
| F1 | **Admin VIP panel is broken.** `routes/admin.js` imports `listVipLevelsAdmin, upsertVipLevel, toggleVipLevelActive, getVipAnalytics, listAllRewardHistory, listAllUpgradeHistory` from `services/vip.js`, but that file only exports `addVipTurnover` and `getVipStatus`. The functions existed in commits `0d1cadf8`/`7dd4627d` and are absent from `916af290` onward. `/admin/vip`, `/admin/vip/save`, `/admin/vip/:level/toggle`, `/admin/vip/history` all fail (TypeError → caught → empty/"load error" page). | **High** |
| F2 | **Turnover multiplier mismatch (5x rule).** `services/turnover.js` `DEFAULTS.multiplier = 5`, but `migrations.js` (line ~845) seeds `turnover_multiplier = '3'` and `services/settings.js` default is `'3'`. Because `loadConfig` reads `site_settings` first, a DB seeded by migration runs at **3x**, not 5x. Actual production value is unknown (admin-editable). `docs/TURNOVER_V2_MIGRATION.md` also documents 3. No `5.5` found in code. | **High** |
| F3 | **VIP reward history is never written.** Tables `vip_reward_history` and `vip_upgrade_history` exist, but no code inserts into them. VIP upgrade bonus (`services/vip.js`) only writes `coin_transactions` (`type='vip_upgrade'`) + a notification. Admin history page would be empty even if F1 were fixed. | **High** |
| F4 | **Most VIP perks are schema-only.** `daily_bonus, weekly_bonus, monthly_bonus, cashback_percent, withdrawal_limit, deposit_bonus_percent, birthday_bonus, priority_support, exclusive_events` are stored in `vip_levels` but no service reads them (only the admin route that passes them to the missing `upsertVipLevel`). Deposit bonus uses a hard-coded 100/80/50% table, not `deposit_bonus_percent`. | Medium |
| F5 | **Admin "Bonuses" page writes the archived legacy `bonuses` table.** `POST /admin/bonuses/add` and `/cancel` use `bonuses`, which Turnover V2 no longer reads. A bonus added there creates no turnover lock and no wallet credit. | **High** (admin believes a bonus was given) |
| F6 | **Deposit "Friday" bonus uses server timezone.** `payment.js` `new Date().getDay() === 5` (lines ~135, ~836) uses the server's local zone (UTC on Render), not `Asia/Dhaka`. Between 00:00–06:00 Dhaka the day is wrong. A correct helper exists: `utils/businessTime.js` (`BUSINESS_TZ` default `Asia/Dhaka`). | Medium |
| F7 | **VIP progress is lifetime wagering, separate from turnover engine.** `users.total_turnover` is incremented by `addVipTurnover` with sports `risk` (at placement, `routes/matches.js:540`), acca stake, and casino amounts (`queueHandlers.js:144`). It is independent from `deposit_turnovers`. This is by design but must be a conscious Phase-2 decision. | Info |
| F8 | **Legacy `bonuses` rows may still be `active`** and, after Turnover V2, no longer lock withdrawals. Migration SQL is documented in `docs/TURNOVER_V2_MIGRATION.md` but was never approved/run (per that doc). | Medium |

What is solid: Turnover V2 engine (`services/turnover.js`) is deposit-based, FIFO, idempotent (`turnover_events UNIQUE(user_id, ref)`), row-locked, and withdrawal gate is fail-closed. VIP auto-upgrade is atomic and race-safe. Business timezone is already Asia/Dhaka in `utils/businessTime.js` and the withdrawal window.

---

## 1. Repository structure

Single Node 22 / Express monolith (EJS views, Postgres, Redis, BullMQ). No separate frontend repo.

```
app.js / server.js     web entry (HTTP + WebSocket)
worker.js              background process (queues, scheduler, backups, feed sync)
db.js, migrations.js   pg pool; ONE idempotent migrations file (2898 lines, additive CREATE/ALTER IF NOT EXISTS, runs at boot)
routes/                admin.js (5665 lines), payment.js, profile.js, matches.js, coins.js, ...
services/              vip.js, turnover.js, referral*.js, freebet.js, redpacket.js, settlement.js, accumulator.js,
                       wallet/ (seamless provider wallet), scheduler.js (cron), settings.js, queueHandlers.js, ...
queues/                BullMQ: email, notification, activity-log, api-log, fraud-scan (no reward/VIP queue)
middleware/, utils/    auth, rbac (services/rbac.js), businessTime.js, validate.js
views/, public/js      EJS + client JS (views/profile/vip.ejs, views/admin/vip*.ejs, public/js/views/profile-vip.js)
render.yaml            web (2 instances) + worker + 2 Redis + Postgres, region singapore, autoDeploy:false
tests/                 unit, integration, security, render, e2e
docs/                  existing audit/runbook docs
```

Render: `livo-web` (`node server.js`, `DISABLE_BACKGROUND_WORKER=true`), `livo-worker` (`node worker.js`), `livo-postgres`, `livo-redis` (noeviction), `livo-redis-cache`. `autoDeploy: false` for both (good — a merge does not auto-deploy).

Git state at audit: ~165 remote branches, default `main`. Latest merged PRs: #294 (referral rules), #295 (turnover-v2), #296/#297 (profile redesign). Branch `profile-redesign-vip-update-868824347495611778` exists (not reviewed in depth). *Open PR list could not be fetched via the GitHub API in this session (API access is gated); branches/commits were read from the git clone.*

---

## 2. System-by-system audit

### 2.1 VIP system / VIP levels
- **Tables:** `vip_levels` (level, name, min_turnover, upgrade_bonus, weekly_bonus + premium columns icon, cashback_percent, daily_bonus, monthly_bonus, withdrawal_limit, deposit_bonus_percent, birthday_bonus, priority_support, exclusive_events, is_active, updated_at; unique index on `level`), `users.vip_level`, `users.total_turnover` (`migrations.js` 450–533, 65, 733).
- **Seed:** Bronze 0 / Silver 50,000 / Gold 200,000 / Platinum 500,000 / Diamond 1,500,000 / Elite 5,000,000 (min_turnover); premium defaults set only where untouched.
- **Files:** `services/vip.js`, `routes/profile.js` (`GET` VIP page, 3 callers of `getVipStatus`), `views/profile/vip.ejs`, `public/js/views/profile-vip.js`, `views/admin/vip.ejs`, `views/admin/vip-history.ejs`, `routes/admin.js` 3319–3405, permission `vip_manage` (`services/rbac.js`).
- **Works:** user VIP page/status; level calc from `vip_levels`; progress/toNext.
- **Broken:** admin VIP CRUD + history (F1). `is_active` is stored/toggled in schema but `addVipTurnover` and `getVipStatus` ignore it, so deactivating a level has no effect.
- **Needed:** restore/re-implement admin service functions (Phase 2), honor `is_active`.

### 2.2 VIP upgrade logic
- `addVipTurnover(userId, amount)` (`services/vip.js`): atomic `UPDATE users SET total_turnover = total_turnover + $1 … RETURNING`, picks highest level with `min_turnover <= total`, then in one transaction does `UPDATE users SET vip_level=$new WHERE COALESCE(vip_level,0) < $new` (race guard) and credits `upgrade_bonus` into `users.coins` + `coin_transactions(type='vip_upgrade')`; notification afterwards.
- **Callers:** `routes/matches.js:540` (sports, at placement, `risk`), `services/accumulator.js:153` (acca stake), `services/queueHandlers.js:144` (casino).
- **Works:** no double bonus under concurrency; bonus and level in one tx.
- **Gaps:** (a) upgrade bonus is credited **without** a `deposit_turnovers`/turnover entry — it bypasses the "all bonuses link to the same turnover system" rule; (b) skipped levels pay only the final level's bonus, not intermediate ones (decision needed); (c) no downgrade; (d) no `vip_upgrade_history` / `vip_reward_history` row (F3); (e) `addVipTurnover` swallows errors (logs only) and runs fire-and-forget at several call sites, so a failure silently loses VIP progress; (f) no idempotency per bet (a retried queue job would double-count VIP progress, unlike turnover which has `ref`).

### 2.3 VIP reward history
- Tables exist (`vip_reward_history`, `vip_upgrade_history`), admin view exists, **nothing writes them** (F3). Only `coin_transactions` rows with `type='vip_upgrade'` record upgrades; `routes/profile.js:364` includes `vip_upgrade` in the user's reward feed.

### 2.4 Bonus system (overview)
Bonus credits go to `users.coins` with a `coin_transactions` row. Types seen: `deposit_bonus`, `vip_upgrade`, `daily_bonus`, `bonus_forfeit`, plus freebet, redpacket, referral, mission, badge, loyalty, cashback, lucky_wheel, win_streak, social_share.
Linked to turnover through `createBonus`/`createDepositTurnover` (`services/turnover.js`): deposit bonus (`routes/payment.js:848`), referral (`referral.js:178`, `referralRewards.js:299`), freebet (`freebet.js:69`), redpacket (`redpacket.js:80,119`). **Not linked:** VIP upgrade bonus, and (not verified in detail) cashback, mission, badge, wheel, daily-reward (`dailyReward.js`, `periodicReward.js`, `cashback.js`, `missions.js`, `badges.js`, `loyalty.js`). `services/missions.js`, `dailyReward.js`, `badges.js` and `accumulator.js` mention turnover/VIP; a per-service check of whether each credit calls `createBonus` is a Phase-2 task.

### 2.5 Deposit bonus
- `routes/payment.js` `creditApprovedDeposit` (≈822): if `payment_requests.want_bonus`, percent from hard-coded `bonusPercentFor`: 1st deposit 100%, Friday (after 1st) 80%, otherwise 50%; cap `MAX_BONUS = 15000`; bonus credited with `coin_transactions('deposit_bonus')`; then `createDepositTurnover(depositAmount, bonusAmount)` → required `(deposit+bonus) × multiplier`.
- Also shown on deposit page (`GET /deposit`, line ~134).
- **Gaps:** hard-coded rules not admin-controlled; ignores `vip_levels.deposit_bonus_percent`; Friday uses server tz (F6); `want_bonus` is user-selected at request time.

### 2.6 Referral bonus
- `services/referralRewards.js` (V2): referrer bonus by referred user's first qualifying deposit (100–199→20, 200–499→50, 500+→75, admin-configurable bands), once per referred user (`referral_rewards UNIQUE(referred_user_id)`), fraud checks → `pending_review`, plus 0.8% deposit-loss commission (`referral_deposit_cycles`). Credits via `createBonus('referral')` → same turnover engine. Older `services/referral.js` still exists and calls `createBonus` too. Tables: `referrals`, `referral_commissions`, `referral_rewards`, `referral_reward_adjustments`, `referral_deposit_cycles`, `referral_contest_payouts`. Docs: `docs/REFERRAL_V2_DESIGN.md`, `REFERRAL_CURRENT_STATE.md`. Admin routes in `routes/admin.js` (+ `tests/admin-referrals.test.js`). Having both `referral.js` and `referralRewards.js` active should be checked for double payout in Phase 2.

### 2.7 Wallet system
- Balance column `users.coins` (displayed as Taka/BDT; the project recently renamed "coin" wording — commit `a2124e3e`). Ledger: `coin_transactions`. Seamless provider wallet: `services/wallet/index.js` (+ `idempotency.js`, `signature.js`) with `SELECT … FOR UPDATE`, UNIQUE `(provider, provider_tx_id)` idempotency, ledger rows `casino_bet/game_play/casino_rollback`; routes `routes/providerWallet.js`, `walletCallback.js`. Provider tables: `provider_transactions`, `game_sessions`, `game_rounds`.
- Works as designed per code comments/tests. Not load- or runtime-verified here.

### 2.8 Withdrawal system
- `routes/payment.js`: `GET /withdraw`, `GET /withdraw/turnover-status`, `POST /withdraw` (guards: feature flag `withdrawal`, withdrawal time window `services/withdrawalWindow.js` (Asia/Dhaka), verified email, approved KYC, rate limiter, password, withdraw PIN, `canWithdraw` turnover gate fail-closed). Admin approve/reject in same file; bank cards in `bank_cards`; `withdraw_pin_logs`. Settings `max_withdraw_per_request`, `max_withdraw_per_day` in `site_settings`.
- **Gap:** `vip_levels.withdrawal_limit` is not enforced anywhere (F4).

### 2.9 Existing Turnover system (core of the business rule)
- **File:** `services/turnover.js` (Turnover V2, only active engine). Legacy `bonuses` table kept as archive, not read.
- **Tables:** `deposit_turnovers` (per deposit/bonus row: deposit_amount, bonus_amount, multiplier, required, sports_done, casino_done, status active/completed/expired/forfeited, expires_at), `turnover_events` (dedupe by `(user_id, ref)`), `site_settings` keys `turnover_multiplier`, `turnover_no_bonus_multiplier` (1), `turnover_min_odds` (1.5), `turnover_expiry_hours` (0), `turnover_cashout_counts` (0).
- **Calculation basis:** with bonus → `required = (deposit + bonus) × multiplier`; no bonus → `deposit × no_bonus_multiplier`. Bonus-only entries (referral, freebet, redpacket) use `deposit = 0`, so `required = bonus × multiplier`.
- **Counting:** sports counted at **settlement** (`settlement.js:69`, acca `accumulator.js:266/281`) with stake (`refundAmount(bet)` helper) and only if `odds ≥ turnover_min_odds` (unknown odds → not counted, fail-closed); casino counted at bet time via `queueHandlers.js:142` with ref `casino:<provider>:<txId>`; void/cancelled/refund/cashout excluded.
- **Lock/unlock:** `canWithdraw` → any `active` row ⇒ withdrawal blocked (whole user, not per-deposit). A row becomes `completed` in the same `UPDATE` that reaches 100% ⇒ auto-unlock. Expiry (if >0 hours) forfeits the bonus portion still in balance. `forfeitBonuses` lets the user cancel bonus and unlock.
- **Known limitations** (from `docs/TURNOVER_V2_MIGRATION.md`, confirmed in code): casino rollbacks do not reverse counted turnover; lock is user-wide.
- **Config risk:** F2 (3 vs 5). Also `loadConfig` falls back to default 5 only when the setting is absent/invalid/≤0; since migration seeds `'3'`, a fresh or existing DB without admin override is 3x.
- **Not changed.** Any change (value 3→5, legacy migration, VIP-bonus linkage) requires your approval.

### 2.10 Admin panel
- `routes/admin.js` (5665 lines), RBAC via `services/rbac.js` (`vip_manage`, `users_edit`, `settings_edit`, `payments_view`, `withdrawal_window_manage`). Settings whitelist at `routes/admin.js:1071` includes all five turnover keys, so the multiplier can be set from Admin → Settings (needs a guard so it cannot be set to anything but 5 if the rule is final — decision needed). Admin actions logged via `logAdminAction` and `logAuditEvent`.
- Admin VIP: broken (F1). Admin Bonuses: legacy table (F5). No admin UI for `deposit_turnovers` (documented gap).

### 2.11 User profile
- `routes/profile.js` (1109 lines): VIP page, rewards feed, security, loyalty; redesigned pages merged in PRs #296/#297 (`views/profile/*`, `public/js/views/profile-vip.js`, `profile-rewards.js`). Withdraw popup shows turnover status from `/payment/withdraw/turnover-status`.

### 2.12 Background workers
- `worker.js` starts: Postgres `job_queue` worker (`services/queue.js`, handlers in `services/queueHandlers.js`), BullMQ (`queues/`: email, notification, activity-log, api-log, fraud-scan), cron `services/scheduler.js` (jobs in `cron_jobs`/`cron_job_logs`, advisory-lock protected, admin-manageable), backups, feed sync.
- **No VIP/bonus/reward cron exists.** Daily/weekly/monthly/birthday VIP bonuses (schema-only) have no scheduler job. Cron schedule is interval-based (`interval_ms`); a calendar-aware Dhaka schedule would need `utils/businessTime.js`.

### 2.13 Payment & transaction system
- `routes/payment.js` (1277 lines): manual deposit requests (`payment_requests`), SSLCommerz gateway (`/sslcommerz/init`, callbacks), merchants/payment methods/channels (`merchants`, `payment_methods`, `payment_channels`), reconciliation (`services/gatewayReconcile.js`). Approval paths all funnel into `creditApprovedDeposit` under `FOR UPDATE`. Ledger `coin_transactions`; admin audit in `admin_logs`/`audit_logs`.

---

## 3. Business-rule compliance check

| Rule | Status |
|---|---|
| Final turnover multiplier 5x | ⚠ Code default 5, **migration/settings default 3** → effective value depends on DB (F2). Not changed. |
| 5.5x must not be used | ✅ No `5.5` multiplier found in code, settings, views or locales. |
| Existing Turnover Engine intact | ✅ Untouched in this phase. |
| No new Turnover Engine | ✅ None created. |
| All bonuses use the same turnover system | ⚠ Deposit, referral, freebet, redpacket do. VIP upgrade bonus does not; other reward types need per-service verification. |
| Business timezone Asia/Dhaka | ⚠ Helper and withdrawal window OK; Friday deposit bonus and any other raw `new Date()` / DB `CURRENT_DATE` usage must be reviewed (F6). |
| Admin full VIP & bonus control | ❌ VIP admin broken (F1), bonus admin hits legacy table (F5), deposit bonus rules hard-coded. |

---

## 4. Recommended changes by phase (nothing implemented now)

**Phase 2 — VIP foundation (needs your approval first)**
1. Restore admin VIP service functions in `services/vip.js` (reference implementation in git history: commit `7dd4627d`, file `services/vip.js`) and re-test `/admin/vip*`.
2. Write `vip_upgrade_history` + `vip_reward_history` inside the upgrade transaction; honor `is_active`; decide behavior for skipped levels.
3. Decide how the VIP upgrade bonus links to turnover (via `createBonus`, multiplier 5).
4. Resolve the 3 vs 5 multiplier (Admin Settings change vs migration default) — approval required; take a DB snapshot of current `site_settings` first.
5. Replace Friday check with `utils/businessTime.js` (`businessWeekday`).

**Phase 3+**
- Admin Bonuses page → Turnover V2 (`createBonus`) instead of legacy `bonuses`; decision on migrating still-active legacy rows (SQL already drafted in `docs/TURNOVER_V2_MIGRATION.md`).
- Make deposit bonus tiers admin-controlled (and optionally use `deposit_bonus_percent`).
- Implement daily/weekly/monthly/birthday VIP rewards via the existing scheduler with Dhaka-day idempotency keys; enforce `withdrawal_limit`, `cashback_percent`.
- Per-service check of mission/badge/cashback/wheel/daily rewards for turnover linkage; check `referral.js` vs `referralRewards.js` for double payout.
- Idempotency (`ref`) for `addVipTurnover`; admin UI for `deposit_turnovers`.

---

## 5. Items requiring your decision
1. Is the production `turnover_multiplier` currently 3 or 5? (Needs a read-only DB query by you or a DB-read credential; not available here.) Should 5 be enforced by code/migration, or only by Admin setting?
2. Should VIP upgrade bonuses require turnover (5x)?
3. Skipped levels: pay all intermediate bonuses or only the reached level?
4. Migrate still-active legacy `bonuses` rows into `deposit_turnovers`?
5. Should VIP progress keep using lifetime wagering (`users.total_turnover`) or switch to the turnover engine's data?

## 6. What this phase did **not** do
No code, migration, setting, DB, deploy or merge. No tests were run (no `node_modules` / Postgres / Redis in this environment). Live data, Render env/settings, and open PRs on GitHub were not inspected.
