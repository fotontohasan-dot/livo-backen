# VIP Phase 1 — Handover (for the next chat)

## Status
- Phase 1 (audit) is **done**. Nothing was merged or deployed. Waiting for the owner's approval before Phase 2.
- Repo: https://github.com/fotontohasan-dot/livo-backen (`main`, audited at `f0c857c0`)
- Branch: `feature/vip-phase-1-foundation`
- PR-1: https://github.com/fotontohasan-dot/livo-backen/pull/298 (target `main`, **not merged**)
- Audit report commit: `8046efa932e0e09510789c432af9e320e10794c6` (the handover file is in the next commit on the same branch; run `git log -2` for the branch head)
- Full details: `docs/VIP_PHASE_1_AUDIT_REPORT.md`

## Repository structure (short)
Node 22 / Express monolith, EJS views, Postgres, Redis, BullMQ. Entry: `server.js`/`app.js` (web), `worker.js` (background). All schema in one additive file `migrations.js` (runs at boot). Money: `users.coins` + ledger `coin_transactions`. Render: `livo-web`, `livo-worker`, Postgres, 2 Redis; `autoDeploy:false`.

Key files:
- VIP: `services/vip.js`, `routes/admin.js` (3319–3405), `routes/profile.js`, `views/admin/vip*.ejs`, `views/profile/vip.ejs`
- Turnover (ONLY engine): `services/turnover.js`; callers `routes/payment.js:848`, `services/settlement.js:69`, `accumulator.js`, `queueHandlers.js:142`, `referral*.js`, `freebet.js`, `redpacket.js`
- Deposit bonus: `routes/payment.js` (`bonusPercentFor`, `creditApprovedDeposit`)
- Time helper: `utils/businessTime.js` (Asia/Dhaka)
- Tables: `vip_levels`, `vip_reward_history`, `vip_upgrade_history`, `users.vip_level/total_turnover`, `deposit_turnovers`, `turnover_events`, `site_settings`, `bonuses` (legacy archive), `coin_transactions`

## Audit results (summary)
1. Admin VIP panel broken — missing exports in `services/vip.js` (good reference version: commit `7dd4627d`).
2. Turnover multiplier: code default 5, migration/settings seed 3 → real value must be checked in the DB.
3. VIP history tables never written.
4. Most VIP perks schema-only; deposit bonus hard-coded 100/80/50%, cap 15000.
5. Admin Bonuses page uses legacy `bonuses` table.
6. Friday bonus uses server timezone.
7. VIP upgrade bonus bypasses the turnover system.
8. No `5.5` anywhere. Turnover engine untouched.

## Rules to keep
Multiplier 5x only (never 5.5). Do not create a new turnover engine; link all bonuses to `services/turnover.js`. Timezone Asia/Dhaka. Admin must control VIP and bonuses. Never delete/overwrite old work; no secrets in repo; no merge/deploy without approval.

## Open decisions (owner)
1. Current production `turnover_multiplier` (3 or 5)? Enforce 5 via code/migration or Admin only?
2. VIP upgrade bonus subject to 5x turnover?
3. Skipped levels: pay all intermediate bonuses or only reached level?
4. Migrate still-active legacy `bonuses` rows (SQL in `docs/TURNOVER_V2_MIGRATION.md`, not run)?
5. VIP progress: keep lifetime wagering (`users.total_turnover`) or change?

## Next steps (Phase 2, after approval)
Restore admin VIP service functions; write history rows in the upgrade transaction; honor `is_active`; link VIP bonus to turnover; fix multiplier source of truth; Dhaka-time Friday check; add tests. Branch from `main` (or from this branch once PR-1 is merged).

## Security note
A GitHub token was pasted into chat during Phase 1. It was used only via environment variables and is not stored in the repo, commits or this file. **Revoke it and issue a fine-grained token (Contents + Pull requests only, this repo only).**
