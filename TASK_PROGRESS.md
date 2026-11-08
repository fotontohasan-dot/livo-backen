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
