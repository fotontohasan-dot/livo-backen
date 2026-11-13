// utils/integrationHttp.js
// ==================== বাইরের API কল: timeout + circuit breaker + স্ট্যাটাস রেকর্ড এক জায়গায় ====================
// integrationFetch(name, url, options, { breaker: true|false, timeoutMs })
//   • breaker: true (ডিফল্ট) — breaker timeout (ডিফল্ট ৫s, BREAKER_TIMEOUT_MS) প্রয়োগ করে; OPEN থাকলে সঙ্গে সঙ্গে
//     CircuitOpenError। HTTP 5xx/429 ব্যর্থতা হিসেবে গোনা হয় (রেসপন্স ফেরত যায়, throw নয়)।
//   • breaker: false — *পেমেন্ট/ওয়ালেট* কলের জন্য: শুধু timeout + স্ট্যাটাস রেকর্ড; breaker-এ পড়ে না, কোনো রিট্রাই নেই।
//     (callback/validation fast-fail হলে callback হারানোর ঝুঁকি, তাই এগুলো breaker-মুক্ত — docs/INTEGRATIONS.md)
// রিট্রাই কোথাও নেই: একটা কল একবারই যায়।
//
// প্রতিটা ফলাফল recordIntegrationResult-এ যায় (শেষ সফল/ব্যর্থ সময়, sanitize করা error)।

const { getBreaker, CircuitOpenError } = require('../services/circuitBreaker');
const { recordIntegrationResult } = require('../services/integrationStatus');
const autoSuspend = require('../services/autoSuspend');

const isUpstreamFailure = (res) => !!res && (res.status >= 500 || res.status === 429);

async function integrationFetch(name, url, options = {}, cfg = {}) {
  const useBreaker = cfg.breaker !== false;
  const timeoutMs = Number(cfg.timeoutMs) > 0 ? Number(cfg.timeoutMs) : undefined;
  try {
    let res;
    if (useBreaker) {
      const breaker = getBreaker(name);
      res = await breaker.fire(
        (signal) => fetch(url, { ...options, signal: mergeSignals(options.signal, signal) }),
        { timeoutMs, isFailure: isUpstreamFailure }
      );
    } else {
      res = await plainTimeoutFetch(url, options, timeoutMs || Number(process.env.HTTP_TIMEOUT_MS) || 5000);
    }
    recordIntegrationResult(name, res.ok, res.ok ? null : `HTTP ${res.status}`);
    // K10: ৫xx/429 = upstream সমস্যা; 4xx (যেমন 401/404) API-র "ডাউন" সংকেত নয়। payment:*/wallet:* এখানে উপেক্ষিত।
    autoSuspend.recordOutcome(name, !isUpstreamFailure(res), { rateLimited: res.status === 429 });
    return res;
  } catch (err) {
    // breaker OPEN-এ কোনো কল যায়নি — upstream-এর "ব্যর্থতা" হিসেবে আবার রেকর্ড করার দরকার নেই
    if (!(err instanceof CircuitOpenError)) {
      recordIntegrationResult(name, false, err && err.message);
      autoSuspend.recordOutcome(name, false);
    }
    throw err;
  }
}

function mergeSignals(a, b) {
  if (!a) return b;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([a, b]);
  return b;
}

async function plainTimeoutFetch(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error(`গেটওয়ে ${timeoutMs}ms-এর মধ্যে সাড়া দেয়নি (timeout)`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** non-fetch কল (nodemailer, Cloudinary SDK ইত্যাদি): breaker + স্ট্যাটাস, fn(signal) ফেরত দেয়। */
async function integrationCall(name, fn, cfg = {}) {
  const useBreaker = cfg.breaker !== false;
  try {
    const result = useBreaker
      ? await getBreaker(name).fire(fn, { timeoutMs: cfg.timeoutMs })
      : await fn();
    recordIntegrationResult(name, true);
    autoSuspend.recordOutcome(name, true);
    return result;
  } catch (err) {
    if (!(err instanceof CircuitOpenError)) {
      recordIntegrationResult(name, false, err && err.message);
      autoSuspend.recordOutcome(name, false);
    }
    throw err;
  }
}

module.exports = { integrationFetch, integrationCall };
