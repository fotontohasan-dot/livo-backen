# Testing Guide

## Stack
Jest + Supertest. Tests run against the real Express app (`app.js`) and a real
PostgreSQL database — no mocking of routes/DB, since this app boots its DB
pool and runs migrations on require().

## Setup (local)
1. Create a dedicated test database (never point this at production):
   ```
   createdb livo_test
   ```
2. Copy `.env.test` (already committed with dummy/test-only values) or export
   equivalents yourself:
   ```
   DATABASE_URL=postgres://postgres:postgres@localhost:5432/livo_test
   SESSION_SECRET=test_secret_key_for_ci_only
   NODE_ENV=test
   REDIS_ENABLED=false
   SSLCZ_IS_LIVE=false
   VAPID_SUBJECT=mailto:test@example.com
   FRONTEND_URL=http://localhost:4123
   ```
3. Run:
   ```
   npm test
   ```

## What's covered
- `tests/health.test.js` — `/health`, `/ready`
- `tests/auth.test.js` — register/login success + validation failures, CSRF
  enforcement, protected-route redirect
- `tests/admin.test.js` — admin login page, unauthenticated admin access
  blocked
- `tests/payment.test.js` — deposit/withdraw routes require login
- `tests/security.test.js` — Helmet headers, Origin/CSRF mismatch rejection,
  login rate limiting
- `tests/api.test.js` — unauthenticated `/api/*` surface returns 404, no
  CSRF-error leakage on API paths

## Design notes
- `tests/globalSetup.js` runs the app's real migrations **once** before any
  test file starts, so each test file's own `require('../app.js')` (which
  triggers `startServer()` and re-runs migrations) only does fast no-op
  schema checks instead of racing concurrent DDL across files.
- `tests/setup.js` sets required env vars and randomizes `PORT` per test file
  to avoid `EADDRINUSE`, since `app.js` starts its own real listener and
  cannot be modified.
- `tests/afterEnv.js` adds a short settle delay before assertions run, to let
  each freshly-required app instance finish booting (socket.io, schedulers).
- Registration tests use a generated **phone number** identifier instead of
  email, to avoid the app's real verification-email send path timing out on
  networks that block outbound SMTP (common in CI/sandboxes).
- Rate-limit-sensitive tests are ordered so CSRF/auth-redirect checks run
  before tests that intentionally exhaust the login rate limiter, and accept
  `429` as an additional valid "rejected" outcome where relevant.
- No production code was modified to make tests pass — all workarounds live
  in `tests/`.

## Coverage
`npm test` generates a coverage report (text summary in the console, plus
`coverage/lcov-report/index.html` and `coverage/lcov.info`) via
`jest.config.js`'s `collectCoverage` setting over `routes/`, `middleware/`,
`services/`, and `app.js`.

## CI
`.github/workflows/node.js.yml` runs on every push/PR to `main` across
Node 18/20/22, spins up a disposable Postgres 16 service container, runs
`npm test`, and fails the build if any test fails. The coverage report is
uploaded as a build artifact on the Node 20 job.
