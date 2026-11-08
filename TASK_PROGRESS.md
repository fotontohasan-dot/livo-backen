# TASK_PROGRESS

## Task 2 — Web / Worker separation

### Task 2.1 — Competing PR comparison (PR #246 vs existing implementation)
Status: comparison complete. Nothing merged, closed, force-pushed or deployed.

- Existing implementation = already on `main` via PR #244 (`feature/task-2-web-worker-separation`)
  plus PR #247 (`fix/task-2-shutdown-gaps`, stopDailyBackup + closeIdleConnections).
- PR #246 (`feature/task-2-web-worker-separation-v2`) re-implements the same feature on top of an
  older base and is NOT safe to merge:
  - `server.js` references `bootTimer` (never declared), `cleanupPartialStartup` (never defined)
    and `workerRuntime.trackTimer` (does not exist; `workerRuntime` is `null` outside worker role).
    `node --check` passes, but web/all boot throws `ReferenceError: bootTimer is not defined`.
  - Removes the #247 fixes (`stopDailyBackup` wiring, `closeIdleConnections`, `tests/unit/backupStop.test.js`,
    `docs/AUDIT_TASK1.md`) when compared to current `main`.
  - Adds a second tick-overlap mechanism (`state.inFlight`) that duplicates `inflightTicks` already in `main`.
- Identical in both (no conflict): `services/processRole.js`, `worker.js`, `render.yaml`,
  `services/socket.js`, `queues/index.js`.
- Recommendation: keep `main` implementation. Do not merge #246. Owner decides whether to close it.
- Change made on this branch (`task-2.1-pr-comparison`, from `main`): `TASK_PROGRESS.md` and
  comment-only `PROCESS_ROLE` documentation in `.env.example` (text taken from #246).

### Test results (Postgres 16, `NODE_ENV=test`, relevant suites only)
- `main`: 7/7 suites passed (46 passed, 2 skipped).
- PR #246: boot-path suites FAIL (`bootTimer is not defined`, `cleanupPartialStartup is not defined`).
- Full test suite, lint and e2e: not run.

### Remaining Task 2 work (not started; waiting for owner review)
- Owner decision on closing/archiving #246.
- Optional: port unique tests/docs from #246 only after rewriting against `main`.
- Task 2.2 not started.

### Task 2.2 — Finalize main Web/Worker implementation
Branch: `task-2.2-finalize-web-worker` (stacked on `task-2.1-pr-comparison` / PR #250; base = `main` #244 + #247).
No PR merged/closed, PR #246 untouched, no deploy, Task 2.3/3 not started.

Verified on real processes (local Postgres 16, REDIS_ENABLED=false):
| Entry | HTTP/health | Queue consumer | Clean SIGTERM |
|---|---|---|---|
| `server.js` `PROCESS_ROLE=web` | listens, /health 200 | not started | exit 0 |
| `server.js` `PROCESS_ROLE=all` and unset | listens, /health 200 | started | exit 0 |
| `server.js` `PROCESS_ROLE=worker` | no listener | started | exit 0 |
| `node worker.js` (render.yaml worker) | no listener | started | exit 0 |
| `PROCESS_ROLE=bogus` | - | - | exit 1 before any service starts |

Bugs fixed (small, no financial logic touched):
1. `worker.js` (the production Render worker entry) shutdown only called `queue.stopWorker()`, so claimed
   queue batches were not drained, and match-sync / daily-backup / auto-backup timers were not stopped.
   Now mirrors the `PROCESS_ROLE=worker` path: stop timers, `stopWorkerAndDrain()`, then BullMQ, Redis, DB pool.
   Force-exit timeout 10s -> 25s (`WORKER_SHUTDOWN_TIMEOUT_MS`), because drain allows up to 20s.
   `gracefulShutdown` is now exported for tests.
2. `server.js` role `all`: the 3s boot `setTimeout` was untracked, so shutdown (e.g. waiting on `server.close()`)
   could be followed by the timer starting the queue worker/BullMQ. Handle is now tracked, cleared on shutdown
   (`stopBackgroundBoot`) and guarded by `shuttingDown`.

Preserved from #247: `stopDailyBackup` (server.js, workerRuntime, worker.js), `closeIdleConnections`,
`tests/unit/backupStop.test.js`. No second queue overlap guard added (`inflightTicks` in main is the only one).

Tests added: `tests/unit/workerEntryShutdown.test.js`, `tests/unit/bootTimerShutdown.test.js`
(verified RED on unfixed main code: 3 failed; GREEN with the fix).
Relevant suites: 10/10 suites passed, 57 tests passed, 2 skipped. Full suite, lint, e2e: not run.

Remaining lifecycle issues (not changed, need owner decision):
- Role `all`/`web` force-exit is 10s but `stopWorkerAndDrain` may wait up to 20s -> drain can be cut off
  (stalled-recovery covers it). Fix = raise `all` timeout; changes web shutdown timing, so left for review.
- `render.yaml` runs `node worker.js` and web `node server.js` with `DISABLE_BACKGROUND_WORKER=true`, not `PROCESS_ROLE`.
  Both paths work, but `worker.js` still runs `runMigrations()` while web instances also do; no advisory lock found.
- `worker.js` does not use `waitForWorkerSchema` / `workerRuntime` (two worker code paths exist).
- `scheduler.start()` in role `all` is async; a shutdown during its start is not awaited.

Next micro-task (2.3, awaiting owner review): decide on single worker path - make `worker.js` a thin wrapper that
runs `startServer({role:'worker'})` (or keep both) and add a migration advisory lock check; no behavior change until approved.

### Task 2.3 — Worker entry-point consolidation audit (audit only, no code changed)
Branch: `task-2.3-worker-entry-audit`, stacked on `task-2.2-finalize-web-worker` @ `f2f5ae3` (PR #251 — not assumed merged;
base = `main` @ `68bcdfd`, i.e. #244 + #247 + #248). Only `TASK_PROGRESS.md` changed. No merge/close/PR/deploy. PR #246 untouched.
Task 2.4 / Task 3 not started.

#### Startup comparison
| Aspect | `node worker.js` (render.yaml worker) | `server.js` `PROCESS_ROLE=worker` |
|---|---|---|
| Role/env validation | none | `PROCESS_ROLE` validated; invalid -> exit(1) before any service |
| `runMigrations()` | RUNS (`worker.js:85`) + `ensureCriticalTables()` | NOT run; `waitForWorkerSchema` polls 5 tables, 60s, fail-closed |
| `assertPublicUrlOrExit()` | not called | called |
| Service start | inline sequence, non-strict: pg queue / BullMQ start errors are logged, process keeps running | `createWorkerRuntime({strict:true})`: a failed service rolls back started ones in reverse, then exit(1) |
| Start order | matchSync, casino sync, pg queue, BullMQ, backups, scheduler | pg queue, BullMQ, scheduler, matchSync, casino sync, dailyBackup, autoBackup |
| Heartbeat log | none | `WORKER_HEARTBEAT_MS` (60s) |
| Startup failure | `process.exit(1)` directly, pool not closed | runtime.stop() then exit(1) |

#### Shutdown comparison
Both: SIGTERM+SIGINT share one handler, idempotent (`shuttingDown`), force-exit timer 25s (`WORKER_SHUTDOWN_TIMEOUT_MS`), then
cache quit -> `pool.end()` -> exit(0). Differences: `worker.js` stops timers/scheduler first (autoBackup, dailyBackup, matchSync,
scheduler), then `stopWorkerAndDrain()`, then `shutdownQueueSystem()`; runtime stops in strict reverse start order
(autoBackup, dailyBackup, matchSync, scheduler, BullMQ consumers, pg queue drain), then `server.js` calls `shutdownQueueSystem()`.
Net effect is equivalent (same services stopped, drain before DB close); order differs only in when scheduler stops relative to BullMQ.
`worker.js` has no "SIGTERM during startup" handling beyond the force timer; the runtime path stops cleanly because `stopping`
short-circuits `start()` and clears delay timers.

#### runMigrations() / advisory-lock findings
- Callers (non-test): `server.js:202` (roles `web` and `all`) and `worker.js:85`. Production (`render.yaml`): 2 web instances
  (`node server.js`, no PROCESS_ROLE -> `all`) + 1 worker (`node worker.js`) => up to 3 concurrent `runMigrations()` on every deploy.
- `migrations.js` uses NO advisory lock (no `pg_advisory_*` anywhere in it). ~2.5k lines of DDL through `pool.query` (each statement
  may use a different pooled connection); only the merchants backfill uses a dedicated client (`BEGIN/COMMIT`, `FOR UPDATE`).
- Existing advisory locks elsewhere: `services/scheduler.js:326-348` uses SESSION-scoped `pg_try_advisory_lock` on a dedicated
  `pool.connect()` client (correct on direct/session-mode connections; unsafe behind PgBouncer transaction pooling — already
  noted in `docs/AUDIT_TASK1.md`). `services/transactionId.js:60` uses transaction-scoped `pg_advisory_xact_lock` (PgBouncer-safe).
- PgBouncer: no PgBouncer/6432 config found in repo. `render.yaml` uses `DATABASE_URL` from the Render Postgres (direct). So
  today a session lock on a dedicated client would work; it would break if a transaction-mode pooler is introduced.
- Reproduced a real race (scratch DB, local PG 16): 3 concurrent `runMigrations()` on an empty DB -> 1 fulfilled, 2 rejected with
  `duplicate key value violates unique constraint "pg_type_typname_nsp_index"` (CREATE TABLE IF NOT EXISTS race). A sequential
  re-run on the same DB succeeds (idempotent). With existing prod schema most statements are no-ops, but any new DDL
  (CREATE TRIGGER/INDEX, CREATE OR REPLACE FUNCTION, backfills) can hit the same race on a multi-instance deploy.
  Failure is fail-closed (exit 1 -> platform restarts), so impact is a crash-loop/delayed boot, not silent corruption.

#### Would consolidation change behavior?
- Migration timing: YES. Making `worker.js` call `startServer({role:'worker'})` removes `runMigrations()` from the worker and replaces
  it with up-to-60s schema polling. If the worker deploys before/without web, it exits 1 on a fresh/older DB. Today it self-migrates.
- Queue startup: order changes (pg queue + BullMQ before scheduler/matchSync instead of after); non-strict -> strict (a queue start
  failure becomes a hard exit instead of a log line).
- Scheduler startup: moves earlier relative to matchSync/casino; cron advisory-lock/overlap guards unchanged.
- Redis/DB cleanup: equivalent. Signals: equivalent handler semantics; consolidated path adds `assertPublicUrlOrExit()`
  (worker would now exit 1 if public URL env is missing — render.yaml worker does not set it).
- Env: consolidated worker needs `PROCESS_ROLE=worker` or `startServer({role:'worker'})`; render.yaml does not set either.

#### Tests actually run (local Postgres 16 via apt, `NODE_ENV=test`, `--runInBand --coverage=false`)
`workerRuntime`, `processRole`, `queueHealthRole`, `workerEntryShutdown`, `bootTimerShutdown`, `backupStop`, `appLifecycle`:
7/7 suites passed, 43/43 tests passed. (A first run with coverage on showed 4/4 suites, 13 tests passing but jest global coverage
thresholds failed because only a subset was run — not a test failure.) Full suite, lint, e2e: NOT run. Race probe above is a
manual script against a scratch DB, not part of the repo.

#### Risks / unresolved questions
1. No migration mutual exclusion across web x2 + worker (reproduced). Smallest fix proposal (NOT implemented, needs owner OK):
   in `migrations.js` take `pg_advisory_lock(<const>)` on one dedicated `pool.connect()` client for the whole run and release in
   `finally`; blocks other runners instead of racing. Valid only on direct/session-mode connections. If PgBouncer transaction
   mode is planned, use a different approach (single-transaction migration with `pg_advisory_xact_lock`, which is a larger change).
2. Is the Render Postgres connection direct (no PgBouncer) in production? Not verifiable from the repo.
3. Should the production worker keep self-migrating (current `worker.js`) or wait for web (server.js worker role)?
4. Does the owner want render.yaml to switch to `PROCESS_ROLE`? Not changed.
5. Role `all`/`web` 10s force-exit vs 20s drain (carried over from 2.2) and un-awaited scheduler start in `all` remain open.

#### Recommendation
Do NOT consolidate yet. Next microtask (2.4, awaiting approval): add the advisory lock around `runMigrations()` (smallest fix, with a
test running two `runMigrations()` concurrently), then reconsider making `worker.js` a thin wrapper around the runtime path.
