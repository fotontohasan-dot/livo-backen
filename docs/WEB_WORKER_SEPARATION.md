# Web / Worker Process Separation (Task 2)

`server.js` is still the single entrypoint (`npm start`, `Dockerfile` CMD unchanged).
The new env var **`PROCESS_ROLE`** decides what the process does.

| Role | HTTP + Express + Socket.IO | Migrations | Background work | BullMQ |
|---|---|---|---|---|
| `all` (default, unset = all) | yes | yes | yes | producers + consumers |
| `web` | yes | yes | **no** | producers only (Redis connect so `add()` works) |
| `worker` | **no port, no Socket.IO, `app.js` not loaded** | **no** (waits for schema) | yes | consumers + dead-letter listeners |

An invalid value (e.g. `workers`) exits with code 1 **before** connecting to DB/Redis or starting any timer.

## Background task classification

| Task | Role | Notes |
|---|---|---|
| Match sync (`matchUpdater`) | worker/all | interval handle now stoppable (`stopSync`) |
| Casino boot sync | worker/all | one-shot, 3s after boot |
| PG queue consumer (`queue.js`) | worker/all | `FOR UPDATE SKIP LOCKED` untouched; `drainWorker()` waits for the in-flight batch |
| BullMQ workers + dead-letter listeners | worker/all | `initQueueSystem()`; web uses `initQueueProducers()` |
| Cron scheduler (11 jobs) | worker/all | advisory lock untouched |
| `backup.js` daily + `backupManager.js` auto backup | worker/all | both now stoppable |
| Enqueue (PG `enqueue()`, BullMQ `add()`) | web (+worker) | producers stay in web |
| Bet placement, wallet, settlement, payment callbacks | **web** | unchanged |
| `botDetection` in-memory cleanup timer | web (process-local) | unchanged |

## Worker startup
1. `connectDB()` → `waitForSchema()` (read-only `to_regclass` check of core tables; env `WORKER_SCHEMA_WAIT_ATTEMPTS` default 24, `WORKER_SCHEMA_WAIT_MS` default 5000). Exits 1 if never ready.
2. `assertConfigured()` for public URL, keep-alive timer, `startBackgroundWork()`.

## Shutdown (SIGTERM/SIGINT, once only)
1. stop scheduler + PG-queue intake
2. close idle HTTP connections, `io.close()` (also closes the HTTP server and waits for in-flight requests, so running bet/wallet transactions finish)
3. clear boot/match-sync/backup timers, drain in-flight PG-queue batch
4. stop BullMQ workers/QueueEvents/Queues, quit queue Redis connection
5. quit cache Redis, `pool.end()`
`SHUTDOWN_TIMEOUT_MS` (default 10000) is the hard backstop. Render sends SIGKILL after its own grace period; an uncommitted transaction is rolled back by PostgreSQL.

## Known limitations (NOT solved in Task 2)
1. **Real-time events from the worker are dropped.** The worker has no Socket.IO server. `notify.js`/`socket.js` guard `if (!io) return`, so nothing crashes, but any socket emit triggered by worker code never reaches browsers. Needs `@socket.io/redis-adapter` + emitter (Task 3).
2. **Web instances also don't share Socket.IO rooms** (no adapter) — unchanged from audit.
3. **Duplicate execution across several worker instances**: match sync and both backup schedulers still have no distributed lock. Run **exactly one** worker instance until this is fixed. (`PROCESS_ROLE=all` on 2+ instances has the same problem as before.)
4. `backup.js` (deprecated) and `backupManager.js` both still run; backups still write to local disk (ephemeral on Render).
5. Scheduler advisory locks are session-level: incompatible with PgBouncer *transaction* pooling. Use a direct connection for the worker.
6. Admin "run job now" (`scheduler.runJob`) executes inside the **web** process. Cron-schedule execution is worker-only.
7. Worker has no external health endpoint. Proposal: Render *Background Worker* type (no health check; auto-restart on exit) plus a DB heartbeat row in Task 3.
8. On first deploy the worker may start before web finished migrating; it waits (up to ~2 min by default) then exits 1 and Render restarts it.

## Rollback
Unset `PROCESS_ROLE` (or set `all`) — behaviour is identical to the previous deployment. Code rollback: `git revert` the Task 2 commits.
