# Load test scripts (STAGING ONLY — drafts, not yet run)

Nothing here was run against any live environment. Smoke-tested only on a throwaway local Postgres with 20 WebSocket
connections and 10 HTTP users to confirm the scripts work mechanically; those numbers mean nothing.

## Safety rules (enforced in code, `lib/guard.js`)
- `LOADTEST_STAGING_URL` must be set explicitly. No default, never inferred from `BASE_URL`/`PUBLIC_APP_URL`.
- Host must contain the word `staging` (e.g. `livo-web-staging.onrender.com`) or be listed in `LOADTEST_ALLOWED_HOSTS`.
- Production hosts are refused even if allow-listed: built-in `bet420-backen.onrender.com`, `livo-web.onrender.com`, plus
  `LOADTEST_PRODUCTION_HOSTS` / `LOADTEST_PRODUCTION_SUFFIXES` (**owner: add the real production domain**). Also refused if it equals this process's `PUBLIC_APP_URL`/`CANONICAL_HOST`.
- https only. Loopback only with `LOADTEST_ALLOW_LOCAL=1` (local smoke tests).
- DB scripts use `LOADTEST_DB_URL` with the same logic (`staging` in host/db name, or `LOADTEST_ALLOWED_DB_HOSTS`; `LOADTEST_PRODUCTION_DB_HOSTS` refused).
- No secrets in the repo: passwords/keys come from env only and are never logged or written to results. Results go to `scripts/loadtest/results/` (git-ignored).
- Betting uses `demo: true` on seeded test users (coins = 0). Wallet, settlement and real payment code is not touched. No real provider is called: point the app at `mockProvider.js`.

## Files
| File | Purpose |
|---|---|
| `mockProvider.js` | Mock cricket/football/SMS/casino server with `/__control` (ok/slow/fail/flaky) |
| `seedTestUsers.js` | Create/remove `loadtest_NNNN` users on the staging DB |
| `ws.js` | Scenario 1: ramp to 1000 WebSockets over 5 min, hold 10 min, count live events |
| `http.js` | Scenario 2: HTTP mix (reads / logins / demo bets), many users per IP |
| `drills.js` | Scenario 3: Redis restart, web instance kill, slow/failing provider; measures recovery |
| `pgStatReport.js` | Top queries (pg_stat_statements), connections, EXPLAIN |
| `sql/enable_pg_stat_statements.sql` | Enable + reset on staging |
| `lib/` | guard, recorder (p50/p95/p99, error, 429, WS stats), client |

## Run order (after the owner creates staging, see `docs/STAGING_SETUP.md`)
```bash
export LOADTEST_STAGING_URL=https://livo-web-staging.onrender.com
export LOADTEST_PASSWORD='<new random 16+ chars, not used anywhere else>'
export LOADTEST_DB_URL='<staging external DB URL>'
export LOADTEST_FEED_KEY='<staging FEED_API_KEY>'

# 0. enable pg_stat_statements on staging DB, then reset counters
psql "$LOADTEST_DB_URL" -f scripts/loadtest/sql/enable_pg_stat_statements.sql
# 1. test users (500) and mock provider (own service, or locally reachable from staging)
npm run loadtest:seed -- --count 500
# 2. Scenario 1 (≈15 min)  — also run `npm run loadtest:pgstat -- --watch 5` in another terminal for peak DB connections
npm run loadtest:ws
# 3. Scenario 2 (≈10 min)
LOADTEST_GENERATOR_IPS=1 VUS=300 DURATION_SEC=600 npm run loadtest:http
# 4. Scenario 3 drills (each while the script's background load runs)
MOCK_URL=https://livo-mock-provider-staging.onrender.com MOCK_CONTROL_KEY=… npm run loadtest:drill -- provider
npm run loadtest:drill -- redis     # script prints ACTION NOW → restart Redis in the Render dashboard, press ENTER
npm run loadtest:drill -- web       # same, kill/restart one web instance
# 5. DB report + cleanup
npm run loadtest:pgstat
npm run loadtest:seed -- --cleanup
```

## Notes on realism
- **CGNAT**: the generator does not spoof `X-Forwarded-For` (behind Render's LB that would not work). Many users sharing few IPs happens naturally when you run from 1–3 machines; set `LOADTEST_GENERATOR_IPS`. Run once with the generator IP unlisted and watch for 429s and captcha demands (bot detection) on `/login`: that is what real CGNAT users would see.
- **Login cost**: bcrypt cost 12 makes `POST /login` CPU-heavy; keep the login share low (default 5%).
- **Per-account login limit**: each VU re-logs in rarely so it stays under 10 attempts / 15 min per account (the limiter counts every attempt, see `docs/STEP3_AUDIT.md` A2).
- **Slow provider**: the app reaches the mock only when `ALLOW_PROVIDER_BASE_URL_OVERRIDE=true` plus `CRICKET_API_BASE_URL` / `FOOTBALL_API_BASE_URL` are set (staging only; ignored otherwise).
- **Drills** do not call the Render API; recovery time is measured from the moment you mark the action (ENTER) until 10 consecutive healthy probes of `/health`, `/ready`, `/matches/api/live`.
- Acceptance targets are in the Step 4 brief; the scripts print the 1000-WS target check (<1% disconnects, 0 "Session ID unknown"). Owner confirms latency targets.
