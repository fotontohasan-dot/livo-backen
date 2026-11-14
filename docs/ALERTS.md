# Alerts and monitors (PROPOSAL — owner approves the final numbers)

Nothing is configured yet. Thresholds are starting points; tune them after the first staging load test.
Metrics come from `GET /metrics` (protected: `x-metrics-token: $METRICS_TOKEN` or an admin session). Scrape each web
instance separately (Render exposes them behind one URL, so use Render metrics or a scraper that can address instances). The worker has no `/metrics`; its queue depth is visible through the web instance.

## External monitors (create these two separately)
| Monitor | URL | Check | Alert when |
|---|---|---|---|
| Uptime | `https://<prod>/health` | every 1 min, expect 200 | 2 consecutive failures (≈2 min) |
| Readiness | `https://<prod>/ready` | every 1 min, expect 200 | 2 consecutive non-200. This is the **Redis down / DB down / migrations not complete** signal (`/ready` returns 503 when the session Redis PING fails). Page the owner, but do not use `/ready` as the Render health check (it would pull every instance when Redis blips). |

Create the same two against staging first and fire a test alert (acceptance 6): pause the staging web service or restart staging Redis, confirm the notification arrives, record the time.
Free options: UptimeRobot / Better Stack / Render's own notifications. Alert channel: Telegram bot already used by the app (`TELEGRAM_*`) or email, owner's choice.

## Proposed thresholds
| # | Signal | Source / expression | Threshold | For | Severity |
|---|---|---|---|---|---|
| 1 | 5xx rate | `sum(rate(bet420_http_requests_total{status_code=~"5.."}[5m])) / sum(rate(bet420_http_requests_total[5m]))` | > 1% | 5 min | page |
| 2 | DB pool waiting | `bet420_db_pool_waiting` (existing) | > 0 | 2 min | page |
| 3 | DB pool in use | `bet420_db_pool_in_use / 10` (web pool max 10) | > 80% | 5 min | warn |
| 4 | DB connections vs plan | Render DB metrics: connections | > 70 of 100 | 5 min | warn |
| 5 | Redis memory (queue, noeviction) | `bet420_redis_memory_ratio{instance="queue"}` | > 70% | 5 min | page (noeviction rejects writes at 100%) |
| 6 | Redis memory (cache, LRU) | `bet420_redis_memory_ratio{instance="cache"}` | > 90% | 15 min | info (eviction is normal) |
| 7 | Redis scrape failing | `bet420_redis_info_ok == 0` | any instance | 2 min | page |
| 8 | Queue depth growing | `deriv(bet420_bullmq_jobs{state="waiting"}[10m]) > 0` and `bet420_queue_pending_jobs` (job_queue) same | growing | 10 min | warn |
| 9 | Failed jobs | `increase(bet420_queue_failed_jobs[10m])` | > 0 | 10 min | warn |
| 10 | api-log drops | `increase(bet420_apilog_dropped[5m])` | > 0 | 5 min | warn (audit-log loss; see below) |
| 11 | Breaker open | `bet420_circuit_breaker_state == 2` | any | 2 min | warn |
| 12 | Event loop lag | `bet420_nodejs_eventloop_lag_p99_seconds` | > 0.2 s | 5 min | warn |
| 13 | Memory | `bet420_process_resident_memory_bytes` | > 400 MB (512 MB plan) | 10 min | warn |
| 14 | p95 latency | `histogram_quantile(0.95, sum(rate(bet420_http_request_duration_seconds_bucket[5m])) by (le))` | target agreed with owner | 10 min | warn |
| 15 | 429 spike | `rate(bet420_http_requests_total{status_code="429"}[5m]) / total` | > 5% | 10 min | warn (possible CGNAT blocking real users) |
| 16 | Worker down | `bet420_queue_worker_up == 0` | — | 2 min | page |
| 17 | API অটো-সাসপেন্ড (K10) | `bet420_integration_suspended == 1` | যেকোনো `name` | 2 min | warn (casino/sports), info (email/sms) |
| 18 | সাসপেন্ড flapping | `increase(bet420_integration_suspend_count[1h]) >= 3` | যেকোনো `name` | — | warn |

Notes
- `bet420_apilog_dropped` and `_failed` are per-process counters that reset on restart; alert on `increase()`, not the absolute value.
- Metric names follow the existing `bet420_` prefix; labels contain only fixed names (`instance`, `queue`, `state`, `name`), never URLs or secrets.
- Thresholds 5 and 6 only work if Redis `maxmemory` is reported; on Render Key Value it is the plan size. If `maxmemory` is 0 the ratio is not emitted; use Render's Redis memory metric instead.
- If no Prometheus is available, use Render's built-in metrics/alerts for CPU, memory, DB connections, Redis memory, and the external monitors for #1/#7; the rest can be checked by hand from `/metrics` during load tests.
