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
