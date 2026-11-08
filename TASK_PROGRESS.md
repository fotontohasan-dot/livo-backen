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

### Task 2.4 — Migration concurrency protection
Branch: `task-2.4-migration-lock`, stacked on `task-2.3-worker-entry-audit` @ `e4a53bf` -> `task-2.2-finalize-web-worker` @ `f2f5ae3`
(PR #251 not assumed merged). No merge/PR/deploy; production never touched; worker/server entry-point behavior, betting, wallet,
settlement and queue logic unchanged. Task 2.5 / Task 3 not started.

Change (`migrations.js` only, plus a new test file):
- `runMigrations()` now takes a dedicated client from the pool (`appPool.connect()`), acquires a SESSION advisory lock
  (`pg_try_advisory_lock(4200420420420::bigint)`, polled every 250 ms; key is outside the 32-bit range used by scheduler cron locks),
  and runs the unchanged migration body on that SAME connection. The old body is now `applyMigrations(pool)` and receives a
  single-connection adapter: `query` -> `client.query`, `connect()` -> the same client with a no-op `release` (the merchants backfill
  `BEGIN/COMMIT` therefore also runs on the lock-holding connection). No migration SQL was edited.
- `finally`: `pg_advisory_unlock`, then `client.release()`. If unlock fails or returns false, the connection is destroyed
  (`release(err)`), which makes the server drop the session lock. Lock/connection failures are recorded via
  `startupState.markMigrationsFailed` and rethrown (fail-closed as before).
- Wait limit: `MIGRATION_LOCK_TIMEOUT_MS` (default 120000). On timeout it throws and the instance exits via the existing fail-closed path.
- Exports unchanged for callers (`module.exports = runMigrations`); `runMigrations.MIGRATION_LOCK_KEY` added for tests.
- Limitation (unchanged from 2.3): a session lock is only valid on direct/session-mode connections, NOT PgBouncer transaction mode.

Tests (`tests/integration/migrationLock.test.js`, scratch databases created/dropped by the test, shared test DB untouched):
1. 3 simultaneous `runMigrations()` on an empty DB -> 3/3 fulfilled; sampled `pg_locks` shows max 1 holder; no holder at end; pool fully released.
   (Before the fix the same scenario gave 2 of 3 rejected with `pg_type_typname_nsp_index`, see 2.3.)
2. Lock held externally -> migration stays pending (no DDL run) until the lock is released, then completes.
3. Lock wait timeout (`MIGRATION_LOCK_TIMEOUT_MS=700`) -> rejects with "migration lock", pool released, external lock untouched.
4. Mid-run failure (a VIEW named `users` makes a later ALTER fail) -> rejects, lock free afterwards, pool released, re-run succeeds.
Mutation check: with `acquireMigrationLock` stubbed out, test 1 FAILED (as intended); restored afterwards.

Actual results (local Postgres 16, `NODE_ENV=test`, `--runInBand --coverage=false`):
`migrationLock`, `appLifecycle`, `databaseIntegrity`, `userDeletionIntegrity`, `performanceIntegrity`, `workerRuntime`,
`workerEntryShutdown`, `bootTimerShutdown`, `backupStop`, `processRole`: 10/10 suites passed, 90/90 tests passed.
Not run: full suite, lint, e2e, any PgBouncer-mode test, any test against a real multi-process deploy.

Remaining risks: PgBouncer transaction mode (see above); a very long migration makes other instances wait up to the timeout and
then fail-closed; web instances still do not `ensureCriticalTables` under the lock (it runs after `runMigrations()` returns, idempotent as before);
`render.yaml`/entry points deliberately unchanged (worker.js still self-migrates, now serialized).

### Task 2.5 — Migration ownership & connection-pool compatibility (audit only; no code/config changed)
Branch: `task-2.5-migration-ownership`, stacked on `task-2.4-migration-lock` @ `e2b47a6` -> `task-2.3-worker-entry-audit` @ `e4a53bf`
-> `task-2.2-finalize-web-worker` @ `f2f5ae3` (PR #251 not assumed merged). Only `TASK_PROGRESS.md` changed. No merge/PR/deploy,
no production access or config change. No credentials/connection strings were printed (host/port/user/password omitted below).
Task 2.6 / Task 3 not started.

#### Sanitized configuration facts (from the repo only)
- `render.yaml`: `livo-web` (numInstances 2, `node server.js`, `DISABLE_BACKGROUND_WORKER=true`, `DB_POOL_MAX=10`) and `livo-worker`
  (`node worker.js`, `DB_POOL_MAX=5`). Both take `DATABASE_URL` via `fromDatabase: livo-postgres` (Render-managed Postgres 16, `connectionString`).
  No `preDeployCommand`, no migrate job, no PgBouncer/pooler service, no `PROCESS_ROLE`. `autoDeploy: false`.
- Search for `pgbouncer|pooler|pool_mode|6432` across the repo (excluding node_modules): matches only in `docs/AUDIT_TASK1.md`
  (a generic warning that scheduler session locks would break under transaction pooling) and my own comments/notes. No config defines a pooler.
- `docker-compose.yml`: app connects to `db:5432` (postgres:15-alpine) directly; app runs `node server.js` (role `all`). No pooler.
- `Dockerfile` CMD `node server.js`; `package.json` `start` = `node server.js`; CI boot smoke test runs `node server.js` against a plain Postgres.
- `db.js`: plain `pg.Pool` (max from `DB_POOL_MAX`), default unnamed statements (no named prepared statements found), no `SET`/`LISTEN`/temp-table usage found
  outside migrations.
- Session-state features in use: `services/scheduler.js:326-348` session advisory locks on a dedicated client; `app.js:417` `connect-pg-simple`
  session store on the pool (transaction-pooling-safe); Task 2.4 migration lock.
- Migrations have NO ledger table (`schema_migrations`-style): the full ~2.5k-line idempotent script runs on every boot of web/all and `worker.js`.
  Re-run on an already-migrated scratch DB took ~0.2 s (local, not a production number).

#### Production connection mode: **UNKNOWN / UNVERIFIED**
Repo evidence points to a direct connection (Render-managed DB URL, no pooler defined anywhere), but the live `DATABASE_URL` and the Render
dashboard overrides cannot be seen from the repo, and `render.yaml` may not be the blueprint actually deployed. Not claiming direct,
session-mode or transaction-mode. Owner check (without sharing the string): in the Render dashboard confirm the DB URL used by web+worker is the
database's own host on port 5432 and not a separate PgBouncer service/port 6432. Optional read-only probe from a one-off shell: open ONE client,
`SELECT pg_try_advisory_lock(1)`, then in a second statement on the same client `SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()`;
1 = session semantics hold, 0 = a transaction pooler is in front. (Not run; unlock afterwards.)

#### Task 2.4 lock vs topology
- Direct or PgBouncer SESSION mode: correct. Lock, all migration statements and unlock share one server session (verified only on a local scratch Postgres).
- PgBouncer TRANSACTION mode: NOT safe. Each statement outside a transaction may land on a different server connection, so the lock could be taken on
  one backend and the DDL run on another (no protection), and `pg_advisory_unlock` could hit a backend that does not hold it (returns false -> client destroyed,
  but the real holder keeps the lock until its server connection is recycled -> other instances stall until `MIGRATION_LOCK_TIMEOUT_MS`).
  The scheduler's cron locks have the same limitation (pre-existing).
- Gap found in 2.4 report wording: `ensureCriticalTables()` (called after `runMigrations()` in web/all AND in `worker.js`) issues `CREATE TABLE/INDEX IF NOT EXISTS`
  via plain `pool.query` outside the lock. All five of its tables are already created by `migrations.js`, so after a successful migration it is a no-op
  and the earlier `pg_type` race cannot occur through it; it is a safety net only. Not changed.
- No migration-ledger means a lock only serializes, it does not make migrations run-once; that is acceptable because the script is idempotent.

#### Ownership options
| Option | Pros | Cons / deploy implications |
|---|---|---|
| Web instances run migrations (today, role web/all) | no infra change | 2 instances race -> needs the lock; slow/failed migration delays or crash-loops the serving tier; web boot depends on DDL |
| Worker runs migrations (today, `worker.js`) | single instance | worker is not guaranteed to start before web; web would then serve on an old schema; worker dies/restarts on every deploy |
| Dedicated one-off process | explicit, serial, can use a direct DB URL | needs someone/something to trigger it each deploy; easy to forget -> web boots on stale schema unless boot also verifies |
| Deployment pre-deploy/release step (Render `preDeployCommand: node scripts/migrate.js`, to be confirmed against current Render docs) | runs once per deploy, before new instances start; failure aborts the deploy (old version keeps serving); web/worker boot stops running DDL; can be given a direct (non-pooled) DB URL even if runtime later uses a pooler | needs a small `scripts/migrate.js` wrapper (reuses `runMigrations()` + lock) and a render.yaml change (owner-approved, not done here); migrations must stay backward-compatible with the old code still serving during the deploy (they already are additive/idempotent, but this must be a rule); runtime processes need a schema-ready check (`waitForWorkerSchema`/critical-table verify already exist) |

#### Recommendation: deployment pre-deploy (release) migration step, keep the 2.4 lock as defense-in-depth
Reasons: exactly-once-per-deploy serialization independent of instance count and start order; a failed migration blocks the rollout instead of
crash-looping live instances; the migration connection can be forced to a direct/session-mode URL, removing the PgBouncer dependency for DDL;
runtime roles then only verify schema (web already fails closed via `ensureCriticalTables`, `server.js` worker role via `waitForWorkerSchema`).
Keep the advisory lock (cheap, protects manual/local runs and the interim period). Do NOT remove boot-time migrations until the release step is proven.
Prerequisite unknown: Render's pre-deploy command availability/behavior for this plan and for `type: worker` services must be checked by the owner.

#### Tests
No new tests: the audit found no code defect that needs a test. No test was run against, or can attest to, the production database or pooler.
Only the local scratch re-run timing above was measured. (Task 2.4's 10-suite/90-test result stands, unchanged; scratch DB only.)

#### Next microtask (2.6, awaiting owner approval; NOT started)
Owner first confirms the production DB URL mode (see check above) and Render pre-deploy support. Then add `scripts/migrate.js` (calls `runMigrations()`,
exits non-zero on failure, honors a `MIGRATION_DATABASE_URL` override for a direct connection) plus a test, WITHOUT changing render.yaml or
boot-time migration behavior; the render.yaml/`PROCESS_ROLE` switch comes as a separate, owner-approved step afterwards.

### Task 2.6 — Standalone migration runner (not wired into any deploy config)
Branch: `task-2.6-standalone-migration-runner`, stacked on `task-2.5-migration-ownership` @ `89c473d` -> `task-2.4-migration-lock` @ `e2b47a6`
-> `task-2.3-worker-entry-audit` @ `e4a53bf` -> `task-2.2-finalize-web-worker` @ `f2f5ae3` (PR #251 not assumed merged).
No merge/push/PR/deploy. `render.yaml`, `migrations.js`, `db.js`, `server.js`, `worker.js` are UNCHANGED (verified with `git diff`);
boot-time `runMigrations()` calls untouched. No betting/wallet/settlement/queue logic touched. Task 2.7 / Task 3 not started.

Files added (3, all new):
- `scripts/migrate.js` — runner
- `tests/unit/migrateScript.test.js` — mocked unit tests (11)
- `tests/integration/migrateScript.test.js` — real child-process runs against scratch PostgreSQL databases (6)

Runner behavior (`node scripts/migrate.js`):
- Calls the existing `runMigrations()` from `migrations.js` (no SQL duplicated; Task 2.4 advisory lock applies). Exit 0 on success, exit 1 on
  migration failure, missing URL, or load failure.
- DB URL: `MIGRATION_DATABASE_URL` if set and non-blank, else `DATABASE_URL` (loaded via dotenv `.env` if present; real env wins). The override only
  rewrites `process.env.DATABASE_URL` inside this process BEFORE `db.js` is first required (db.js reads env at require time), so the shared pool
  module and web/worker processes are not modified. No shared-behavior blocker found.
- Process-local default `DB_POOL_MAX=2` (only if unset; explicit value respected) — the runner needs one connection.
- Always `pool.end()` in `finally`; a `pool.end()` failure is logged as a warning and does not change the exit code. Exit via `process.exitCode`
  plus an unref'd 5 s `process.exit` failsafe (cannot delay normal exit; prevents a hang from a stray handle).
- Logging: only names which variable was used. Error text is redacted: both URLs (captured BEFORE the override), their passwords
  (raw + URL-decoded) and any `postgres(ql)://...` substring become `<redacted>`.
  Caveat: redaction covers the runner's own logs; `migrations.js` still prints its own `err.message` (pg messages contain host/port at most).

Tests actually run (local PostgreSQL 16 from apt, `NODE_ENV=test`, `--runInBand --coverage=false`):
- `migrateScript` unit + integration: 2/2 suites, 17/17 tests passed. (A first run had 1 failure: after the override the ORIGINAL `DATABASE_URL`
  password was no longer known to the redactor, so a synthetic leaky error exposed it. Fixed by snapshotting both URLs before the override; rerun green.)
- Regression group (`migrateScript` x2, `migrationLock`, `appLifecycle`, `databaseIntegrity`, `workerRuntime`, `workerEntryShutdown`,
  `bootTimerShutdown`, `processRole`): 9/9 suites, 77/77 tests passed.
- Covered: success exit 0 and prompt exit (no SIGKILL needed), failure -> non-zero with advisory lock free afterwards, pool.end called on success/failure/end-failure,
  override selection (DATABASE_URL pointed at a non-existent DB, MIGRATION_DATABASE_URL at a scratch DB -> migrated there), no-override path, unreachable
  host with a fake password -> non-zero and password/URL/user absent from output, no-URL -> exit 1.
- NOT run: full suite, lint, e2e, any test with PgBouncer, any run against production or a Render environment.

Limitations:
- Not connected to deployment; nothing calls it yet. Ownership recommendation from 2.5 (pre-deploy/release step) is still PENDING owner confirmation of:
  (a) production DB connection mode (direct / PgBouncer session / transaction) — UNKNOWN; (b) Render pre-deploy command support for this plan and for `type: worker` — UNVERIFIED.
- No connect retry (unlike `connectDB`): a DB that is not yet reachable fails the run immediately (non-zero), which is the desired fail-fast behavior for a release step.
- SIGTERM/SIGINT during a run are not handled specially: the session lock is released by the server when the connection drops.
- If `MIGRATION_DATABASE_URL` is a transaction-mode pooler URL the Task 2.4 lock is still unsafe; the override is meant for a direct/session-mode URL.
- Still no migration ledger: every run executes the full idempotent script.

Next microtask (2.7, awaiting owner approval; NOT started): owner confirms (a) and (b) above; then, only if confirmed, a separate approved step adds the
pre-deploy command to `render.yaml` (web first) while boot-time migrations stay in place as a fallback; otherwise document a manual `node scripts/migrate.js` procedure.
