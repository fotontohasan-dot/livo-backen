# Integrations: status page, circuit breaker, API-log queue (Step 3)

## Status page
`/admin/integrations` (JSON: `/admin/api/integrations`) — needs admin + `system_diagnostics_view`.
Per integration: web/worker **configured** (true/false/unknown — from a 30s heartbeat each process writes to Postgres,
env *presence booleans only*), last success, last error (sanitized, ≤200 chars), breaker state per process.
Never shows any env value, URL or token. Errors are redacted by `services/integrationStatus.js#sanitizeError`.
Code reports results via `recordIntegrationResult(name, ok, errorMessage)` (fire-and-forget, throttled).
The page is linked from the admin menu (System group) and shown only to admins with `system_diagnostics_view`.

> **Email caveat:** an email may still be delivered even if our call to the mail server timed out (we stop waiting after
> `EMAIL_TIMEOUT_MS`, but the server may already have accepted or be about to send the message). The status page can
> therefore show an error for an email that was actually sent. A timeout error here means "no confirmation received",
> not "not delivered". Do not retry automatically on this error (it could send duplicates).

## Circuit breaker (`services/circuitBreaker.js`)
Wraps sports, casino sync, SMS, email, Telegram. States closed → open → half_open (one probe). Default timeout 5s.
No automatic retries anywhere. Sports serve last-good (stale) data when open/failing.
**Payments (SSLCommerz) and wallet callbacks are NOT breaker-wrapped and never auto-retried** (fast-failing could lose
a callback or double-charge). Cloudinary is record-only.

| Env | Default |
|---|---|
| `BREAKER_TIMEOUT_MS` | 5000 |
| `BREAKER_FAILURE_THRESHOLD` (consecutive) | 5 |
| `BREAKER_ERROR_RATE` / `BREAKER_MIN_REQUESTS` / `BREAKER_WINDOW_MS` | 0.5 / 10 / 30000 |
| `BREAKER_RESET_TIMEOUT_MS` | 30000 |
| `BREAKER_HALF_OPEN_MAX` | 1 |
Per-integration override: `BREAKER_<NAME>_<KEY>` (e.g. `BREAKER_SMS_TIMEOUT_MS`). `EMAIL_TIMEOUT_MS` (5000), `SPORTS_API_TIMEOUT_MS`.

## API-log queue (A1)
`API_LOG_MAX_QUEUE_DEPTH` (5000; checked in Redis ≈1/s across all instances; over → drop+count),
`API_LOG_KEEP_COMPLETED` (100), `API_LOG_KEEP_FAILED` (200), `API_LOG_SAMPLE_RATE` (1; samples successful GETs only).
Redis error → drop (no per-request DB insert). Memory: ~1 KB/job → worst case ≈5–6 MB (~2% of 256 MB).

## Login/OTP limits (A2)
Per account (normalized identifier/email, hashed in the key): login 10/15min, reset 5/15min — unchanged.
Per-IP ceiling added: login 100/15min, reset 50/15min. `/register` keeps strict 10/15min per IP.
