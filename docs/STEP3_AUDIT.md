# Step 3 follow-up audit (A1–A5) — read-only findings

Audited on the branch stacked on PR #258 (`3f5d4fd`). No betting, wallet or settlement code was changed.
Only A3 allowed a code change; none was needed. Items marked **FINDING** need an owner decision.

## A1. Stale sports data: display-only?
**Mostly yes, with one real gap.**
- The stale copy is only `lastGood` in `services/sportsAPI.js:48-57` (`staleOr`, no expiry, in memory, per process).
- **Bet acceptance** never reads it: `routes/matches.js:372` locks the `matches` row (`FOR SHARE`) and reads `matches.status`, then reads the `markets` row (status, odds, runner status) inside the same transaction. Odds come from the DB (`resolveOdd`), the client's odd is ignored.
- **Settlement** never reads provider data: it is admin-triggered (`routes/admin.js:2937` `winning_runner` chosen by the admin, `services/settlement.js`). No automatic settlement from scores exists (`settleMarketBets` has only admin callers).
- **FINDING (medium): stale data is written into the DB as if fresh.** `staleOr` data flows through the provider adapters to `services/matchUpdater.js`, whose upsert does `status = EXCLUDED.status`, scores, and `synced_at = NOW()` (lines ~29-44). The `stale` flag is never consumed anywhere, so a stale snapshot is indistinguishable from fresh data once it is in `matches`. Consequences: (a) during a provider outage the DB keeps being re-stamped with old "live/upcoming" statuses, so a match that really ended stays open for betting until an admin closes it; (b) the other writer, `routes/feedIngest.js:37,123`, has a guard ("a feed must not revive a match an admin finished/cancelled"), but `matchUpdater` has **no such guard**, so a stale `live` can overwrite `finished`/`cancelled`. Market rows stay closed/voided, which limits the damage, but match status itself regresses.
- Suggested fix (not applied, it touches match status that betting reads): in the provider adapters skip the upsert when the data came from `staleOr`; and copy the `TERMINAL_MATCH_STATUSES` guard from `feedIngest` into `matchUpdater.upsertMatch`.

## A2. Login lockout by a third party; reset limits and account existence
**FINDING (high): a third party can lock a victim out.**
- `loginLimiter` (`app.js:486`) is keyed by the account identifier only (`loginAccountKey`), max 10 per 15 min, and **counts every POST**: there is no `skipSuccessfulRequests`/failure-only counting, and no IP in the key. Anyone, from any IP, can send 10 wrong-password POSTs with the victim's identifier and the victim gets 429 for 15 minutes. Legitimate users also burn the budget with successful logins.
- The new per-IP ceiling (`loginIpCeilingLimiter`) only protects shared IPs from each other; it does not stop this attack.
- Second throttle, `isAccountThrottled(user.id)` (`routes/auth.js:610`, `services/fraudDetection.js:480`), is also per account (failed attempts by user id), so the same attack works through it, and it is fail-open on errors.
- Suggested fix (not applied): count failures only (`skipSuccessfulRequests: true`, or increment in the handler on failure), key by `account + IP` for the strict limit (e.g. 5/15 min), keep a looser account-only ceiling (e.g. 30/15 min) plus the IP ceiling, and require captcha instead of a hard block when only the account-only ceiling is hit. Test: attacker IP A fails 10× on victim; victim from IP B must still log in.
- **Reset limits do not reveal existence (OK):** `resetLimiter` keys on the hashed submitted email regardless of whether the account exists, and `/forgot-password` returns the same generic response. Minor: the existing-account branch does extra work (token UPDATE + queued email), a small timing difference; low risk, not fixed.

## A3. Payment gateways
| Gateway | Direction in code | Request timeout | Late callback |
|---|---|---|---|
| SSLCommerz (`services/sslcommerz.js`) | outbound: init, validate, validate-by-tran-id; inbound: success/fail/cancel/ipn | **Yes**: `integrationFetch(..., { breaker: false, timeoutMs: SSLCZ_TIMEOUT_MS || 15000 })`, no retry, circuit breaker deliberately off (line 22-29) | Processed whenever it arrives while the payment is still pending; `/ipn` has no age cut-off, and `services/gatewayReconcile.js` re-checks stuck deposits |
| bKash, Nagad, Rocket, Upay (`services/walletCallback.js`) | **inbound callbacks only**; no outbound call exists | n/a | `tsHeader: null` for all four, so there is no freshness window and late callbacks are accepted; replay is handled by signature + idempotency, not time |
| Manual deposit methods (`paymentMethods`) | admin-approved, no gateway call | n/a | n/a |
| Casino providers (`providerWallet.js`, seamless wallet) | inbound signed callbacks (HMAC + IP allow-list + 30 s timestamp) | n/a for callbacks; I found no raw outbound HTTP call in the casino adapters (not audited further, they are not payment gateways) | callbacks outside 30 s are rejected by design (provider retries) |

No gateway call was missing a timeout, so **no code change was made**. Observations: the IPN handler holds a row lock (`FOR UPDATE`) while it calls the gateway validate (up to 15 s); a slow gateway can hold one DB connection per in-flight IPN. Consider lowering `SSLCZ_TIMEOUT_MS` to ~8 s. If the validation call times out the IPN returns an error and SSLCommerz retries, and the reconcile job covers the rest.

## A4. The 4 older guard tests changed in #258 (vs #257)
Diff reviewed with `git diff 2e2f867 3f5d4fd -- tests`. New tests (`step3Resilience`, etc.) are additions and not listed.
1. `tests/security/rateLimitAuditMatrix.test.js` — (a) login limiter regexes updated for the new `keyGenerator`/ceiling chain, `max: 10` assertion kept; (b) `/register` now expected on `registerLimiter` (max 10 per IP) instead of `loginLimiter`; (c) the runtime test now sends the **same** identifier on each attempt (it used distinct `no-such-user-N` values, which would never reach the limit once the key became per-account); a test was added that distinct accounts do not block each other. Not weakened, but (c) documents the per-account key behind A2.
2. `tests/security/supplyChainAndAbuse.test.js` — mount-order regexes updated for the same limiter chain; same strictness.
3. `tests/unit/step2LoadBalance.test.js` — regex for the login limiter relaxed only to allow `keyGenerator` between options; `max: 10` and window assertions unchanged.
4. `tests/security/sportsApiTimeout.test.js` — rewritten because the local `fetchWithTimeout` helper no longer exists (calls now go through `integrationFetch`). **Slightly weaker in two places**: it no longer asserts the literal `[]`/`null` fallback in each catch (now covered indirectly by `staleOr(key, fallback)`), and it does not assert the abort-timer clear for the payment `breaker:false` path. The 1–30 s default-timeout bound is still asserted (against the circuit-breaker default).
Conclusion: three are mechanical; #4 is a rewrite with two minor gaps, listed so nobody can claim they were silently weakened.

## A5. `rewardLedgerIntegrity` failure
**Cause: missing database, not a code bug.** `tests/globalSetup.js` runs migrations before any test; with no Postgres reachable the whole Jest run dies with `connect ECONNREFUSED 127.0.0.1:5432` (this is not specific to that test; every integration test fails the same way). With a local Postgres 16 and `DATABASE_URL=postgres://postgres@localhost:5432/bet420_test`, `tests/integration/rewardLedgerIntegrity.test.js` passes 7/7 on this branch. CI must provide a Postgres service.
