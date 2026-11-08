# TASK 2 — Web/Worker Separation — Progress

PR #244 (`feature/task-2-web-worker-separation` → `main`): OPEN, NOT MERGED. Do not merge until owner approves.

## Baseline (PR #244 head, local PostgreSQL 16 + Redis)
- Full suite: 218/218 suites passed (2 tests skipped: Redis/BullMQ role-split, need TEST_REDIS_URL).
- Task 2 unit: processRole, workerRuntime, queueDrain, queueHealthRole = 34 passed.
- processRoleProcess integration: 7 passed, 2 skipped.

## Checklist
| Item | Status |
|---|---|
| PROCESS_ROLE resolver + invalid handling | COMPLETE (tests) |
| web: no background services | COMPLETE (integration) |
| worker: no HTTP, no migrations, schema fail-closed | COMPLETE (integration) |
| all/unset: legacy behavior | COMPLETE (integration) |
| Worker lifecycle (once-only start, idempotent stop) | COMPLETE (unit + integration) |
| PG queue SKIP LOCKED | PARTIAL — code verified, no 2-worker test yet |
| Match sync concurrency | PARTIAL — idempotent upsert; no cross-process lock/test |
| Backup duplicate execution | Task 2.1 — implemented, tested (see below) |
| Scheduler advisory lock vs PgBouncer | BLOCKED — needs owner decision (session-level lock on pooled conn) |
| Concurrent market creation | NOT INSPECTED |
| Redis/BullMQ role-split tests | NOT RUN |
| Docs / deployment instructions | NOT DONE |

## Micro-tasks
### Task 2.1 — scheduled backup duplicate guard — DONE (pending owner review)
- `services/backupManager.js`: new `runScheduledBackupsOnce()` — `pg_try_advisory_xact_lock` inside a
  transaction (PgBouncer-safe, auto-released on crash) + recent-completed-backup check in `backup_history`.
  `scheduleAutoBackup` timer now calls it. No schema change; no financial tables touched.
- `tests/integration/backupAlerting.test.js`: source-regex updated to accept `runScheduledBackupsOnce(...).catch(` (same unhandled-rejection rule).
- `tests/integration/scheduledBackupGuard.test.js`: 6 tests pass; mutation check (lock disabled) fails as expected.
- Known limitation: backup files are written to each instance's local disk (BACKUP_DIR). A guard prevents
  duplicate runs, but backups live only on the instance that ran them — needs shared storage decision.
- Note: legacy `services/backup.js scheduleDailyBackup` is a deprecated no-op (no duplicate risk).

## Next
- Task 2.2: two-worker PG queue test (SKIP LOCKED) with real DB.
- Task 2.3: match sync concurrency review/test.
- Task 2.4: concurrent market creation inspection.
- Task 2.5: run Redis/BullMQ role tests with TEST_REDIS_URL; docs/deployment notes (PROCESS_ROLE in README/render.yaml/RUNBOOK).
- Scheduler lock (PgBouncer) — document as BLOCKED.
