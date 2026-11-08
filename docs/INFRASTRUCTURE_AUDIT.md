# Livo Sports Platform — Infrastructure & Architecture Audit Report

**Date:** 2026-11-08
**Role:** Senior DevOps Engineer & Backend Architect
**Repository:** `fotontohasan-dot/livo-backen`
**Current Commit:** `a20f67e`
**Target Goal:** 1,000+ Concurrent Users, Multi-Instance Horizontal Scaling, High Availability, Low Budget (~$35/month).

---

## 1. Repository & Deployment Inspection

| Component | Current State | Audit Findings |
|---|---|---|
| **Node.js Engine** | `node: >=22.0.0 <23` | Runtime verified: Node v22.22.1, npm 11.11.0. |
| **Framework** | Express 5.3.0 | Modern Express 5 with EJS templating. |
| **Web Server Entrypoint** | `server.js` & `app.js` | `server.js` boots DB (`connectDB`), migrations (`runMigrations`), critical table checks (`ensureCriticalTables`), listens on `PORT`, then starts background timers and workers via `startBackgroundWork()`. |
| **Database Setup** | `pg` (v8.23.1) in `db.js` | Uses single `Pool` with default max 10 connections. No explicit `max`, `idleTimeoutMillis`, or connection pool controls configurable via env. |
| **Session Management** | `connect-pg-simple` in `app.js` | Session store uses PostgreSQL table `user_sessions`. Under high concurrency (>500 req/s), every HTTP request performs DB queries for session read/touch, creating DB contention. No Redis session store option (`connect-redis`). |
| **Socket.IO Real-time** | `socket.io` (v4.8.4) in `services/socket.js` | **CRITICAL BOTTLENECK:** Uses default in-memory adapter (`new Server(...)`). If deployed across multiple web instances, clients on Instance A cannot receive room broadcasts (odds updates, score updates, chat) emitted on Instance B. `@socket.io/redis-adapter` is not installed or configured. |
| **Worker Separation** | In-process within `server.js` | **HIGH RISK:** `startBackgroundWork()` runs inside the web server process after 3-second delay. Spawning multiple web instances causes multiple instances to poll sports APIs (`syncMatches`), run cron schedules, and process queues concurrently. |
| **Advisory Locks** | PostgreSQL Advisory Lock in `services/scheduler.js` | Scheduler protects cron jobs across instances using `pg_try_advisory_lock`, but feed polling and general background jobs lack dedicated worker separation. |
| **Settlement & Ledger** | `services/settlement.js`, `routes/matches.js` | Strict `status='pending'` guard, `FOR UPDATE` locking, and unique constraints `(ref_bet_id, type)` prevent duplicate payouts. Payouts update `users.coins` within transactions. PostgreSQL is correctly authoritative. |
| **Caching Layer** | `services/cache.js` | Uses `ioredis` with graceful in-memory fallback. Fallback handles outages without crashing. |
| **Health Checks** | `/health` (liveness), `/ready` (readiness) in `app.js` | Implemented and returns JSON status. Readiness tests DB ping and migration status. |
| **Deployment Spec** | Dockerfile present, `render.yaml` missing | Render currently configured manually via dashboard or lacks Blueprint (`render.yaml`). |

---

## 2. Architecture Comparison

### Current Architecture (Single Instance Bottleneck)
```text
Users / Mobile / Browsers
          │
          ▼
Render Web Service (1 Instance)
  ├── Express Web Server (Port 3000)
  ├── In-Memory Socket.IO Adapter (isolated)
  ├── Session Store (PostgreSQL user_sessions)
  └── Embedded Background Work (Sports Feed Polling, BullMQ, Cron, DB Backup)
          │
          ▼
Render PostgreSQL (Shared for sessions, application data, queues, and locks)
```

### Target Architecture (Multi-Instance Scalable & Cost Controlled)
```text
Users / Mobile / Browsers
          │
          ▼
Cloudflare CDN / WAF (DDoS protection, static caching)
          │
          ▼
Render Managed Load Balancer
          ├─────────────────────────┬─────────────────────────┐
          ▼                         ▼                         │
Livo Web Instance A       Livo Web Instance B       (Sticky Session / WebSocket)
   (Express / EJS)           (Express / EJS)                  │
          │                         │                         │
          ├─────────────────────────┴─────────────────────────┤
          │                                                   │
          ▼                                                   ▼
Redis Key-Value Service (Shared)                 Render PostgreSQL
  ├── Socket.IO Redis Adapter (Pub/Sub)            ├── Authoritative Data (Balances, Bets, Matches)
  ├── Shared Session Store (connect-redis)         ├── Controlled Connection Pool (max 10/inst)
  └── Distributed Locks & Cache                    └── Row Locks & Idempotent Transactions
          ▲
          │
Render Background Worker (Separate Process)
  ├── Sports Feed Ingestion (Single Poll)
  ├── Match Settlement & Acca Resolution
  ├── Scheduled Cron Tasks & Daily Bonus
  └── Queue Workers (BullMQ & Postgres queue)
```

---

## 3. Risk Audit & Severity Classification

| Issue ID | Risk | Severity | Root Cause & Impact |
|---|---|---|---|
| **RISK-01** | Socket.IO In-Memory Adapter | **CRITICAL** | If scaled to 2+ web instances, WebSocket/Polling clients connected to Instance A miss live score updates, match suspension, odds changes, and chat alerts emitted from Instance B. |
| **RISK-02** | Missing Render Infrastructure Blueprint (`render.yaml`) | **HIGH** | No declarative configuration for web instances, worker service, Redis, and PostgreSQL with proper resource allocation and health checks. |
| **RISK-03** | Lack of Dedicated Worker Process | **HIGH** | Background jobs run inside the web server process. In a multi-instance web setup, each instance triggers background intervals, causing redundant sports API requests and extra load. |
| **RISK-04** | Session DB Contention on PostgreSQL | **MEDIUM-HIGH** | Sessions currently reside exclusively in `user_sessions` via `connect-pg-simple`. At 1,000 concurrent users, session read/write overhead puts heavy read/write lock pressure on PostgreSQL. Redis session store should be available as primary with PG fallback. |
| **RISK-05** | Uncontrolled DB Connection Pool | **HIGH** | `db.js` does not cap pool size dynamically using environment variables (`DB_POOL_MAX`). In Render Starter PostgreSQL (limit typically 20-50 connections), 2 web instances + 1 worker with default pool sizes can exhaust available connections. |
| **RISK-06** | Ephemeral File Storage | **MEDIUM** | Render instances have ephemeral disks. User avatar and KYC file uploads must be securely handled via external storage (e.g. Cloudinary/S3). Already partly integrated via Cloudinary. |
| **RISK-07** | Timezone Inconsistencies | **LOW-MEDIUM** | Ensure all DB timestamps remain strict UTC, with display timezones adapted for Bangladesh (`Asia/Dhaka` UTC+6) and Saudi Arabia (`Asia/Riyadh` UTC+3). |

---

## 4. Action Plan for Phase 2–6
1. **Task 2:** Add `@socket.io/redis-adapter` and `connect-redis` to dependencies; create `render.yaml` with 2 Web instances, 1 Worker, PostgreSQL, and Redis.
2. **Task 3:** Wire `@socket.io/redis-adapter` into `services/socket.js` with graceful fallback; add Redis session store option in `app.js`.
3. **Task 4:** Create `worker.js` entrypoint for background processing and isolate web servers using `IS_WORKER` flags.
4. **Task 5:** Optimize PostgreSQL connection pool in `db.js` (`DB_POOL_MAX`, `DB_IDLE_TIMEOUT_MS`).
5. **Task 6:** Run load tests and verify all health checks.
