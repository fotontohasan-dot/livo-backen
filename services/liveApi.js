// services/liveApi.js
// LIVE API ক্লায়েন্ট (ডকুমেন্টেশন সেকশন ৩: General API request method)
//  1. প্যারামিটার → JSON স্ট্রিং
//  2. params    = Base64(AES-ECB-PKCS5(json, AES_KEY))
//  3. signature = MD5(json + MD5_KEY) বড় হাতের hex
//  4. POST { merchantCode, params, signature } → LIVE_API_ROOT + method + "/" + LIVE_API_VERSION
//     ডিফল্ট: https://api.obothapi.com/api/merchant/ + create + /v2
//  5. টাইমআউট ৩০ সেকেন্ড
// env (আবশ্যক): LIVE_MERCHANT_CODE, LIVE_AES_KEY, LIVE_MD5_KEY
// env (ঐচ্ছিক): LIVE_API_ROOT (শেষে "/" সহ), LIVE_API_VERSION (v1/v2, ডিফল্ট v2)
// ⚠️ কোনো key কোডে হার্ডকোড করা হয়নি।
const crypto = require('crypto');
const { fetchWithTimeout } = require('../utils/httpClient');

const TIMEOUT_MS = 30000;
const DEFAULT_API_ROOT = 'https://api.obothapi.com/api/merchant/';
const DEFAULT_VERSION = 'v2';

function normalizeRoot(root) {
  return root.endsWith('/') ? root : `${root}/`;
}

// "v2", "V2" বা "2" সবই গ্রহণযোগ্য → "v2"
function normalizeVersion(v) {
  const m = String(v).trim().toLowerCase().match(/^v?(\d+)$/);
  if (!m) throw new Error('LIVE_API_VERSION ভুল (যেমন v1 বা v2)');
  return `v${m[1]}`;
}

function cfg() {
  return {
    merchantCode: process.env.LIVE_MERCHANT_CODE || '',
    aesKey: process.env.LIVE_AES_KEY || '',
    md5Key: process.env.LIVE_MD5_KEY || '',
    apiRoot: normalizeRoot(process.env.LIVE_API_ROOT || DEFAULT_API_ROOT),
    version: normalizeVersion(process.env.LIVE_API_VERSION || DEFAULT_VERSION),
  };
}

function isEnabled() {
  const c = cfg();
  return !!(c.merchantCode && c.aesKey && c.md5Key);
}

function algoFor(key) {
  const len = Buffer.byteLength(key, 'utf8');
  if (![16, 24, 32].includes(len)) throw new Error('LIVE_AES_KEY অবশ্যই ১৬/২৪/৩২ বাইটের হতে হবে');
  return `aes-${len * 8}-ecb`;
}

function encryptParams(jsonStr, aesKey) {
  const k = Buffer.from(aesKey, 'utf8');
  const cipher = crypto.createCipheriv(algoFor(aesKey), k, null); // PKCS5/7 padding ডিফল্ট
  return Buffer.concat([cipher.update(jsonStr, 'utf8'), cipher.final()]).toString('base64');
}

function decryptParams(b64, aesKey) {
  const k = Buffer.from(aesKey, 'utf8');
  const d = crypto.createDecipheriv(algoFor(aesKey), k, null);
  return Buffer.concat([d.update(Buffer.from(b64, 'base64')), d.final()]).toString('utf8');
}

function sign(jsonStr, md5Key) {
  return crypto.createHash('md5').update(jsonStr + md5Key, 'utf8').digest('hex').toUpperCase();
}

function buildRequest(params, c = cfg()) {
  const source = JSON.stringify(params);
  return {
    merchantCode: c.merchantCode,
    params: encryptParams(source, c.aesKey),
    signature: sign(source, c.md5Key),
  };
}

// loginName = ছোট হাতের merchantCode + username (যেমন "272ava" + "user1")
function buildLoginName(username, c = cfg()) {
  return `${c.merchantCode.toLowerCase()}${username}`;
}

function endpointUrl(method, c = cfg()) {
  return `${c.apiRoot}${method}/${c.version}`;
}

async function submit(method, params) {
  if (!isEnabled()) throw new Error('LIVE API কনফিগার করা নেই (LIVE_* env ভ্যারিয়েবল দিন)');
  const c = cfg();
  const res = await fetchWithTimeout(
    endpointUrl(method, c),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildRequest(params, c)),
    },
    TIMEOUT_MS
  );
  if (!res.ok) throw new Error(`LIVE API HTTP ${res.status}`);
  const result = await res.json();
  if (typeof result.data === 'string') {
    try { result.data = JSON.parse(decryptParams(result.data, c.aesKey)); } catch (_) { /* এনক্রিপ্টেড নয় */ }
  }
  return result; // code "200" = সফল, অন্যথায় ব্যর্থ (যেমন "90000" Parameter error)
}

const ts = () => String(Date.now());

// oddType ও lang স্ট্রিং ফরম্যাটে পাঠানো হয় (যেমন "4333", "1")
const createPlayer = (username, loginPassword, { oddType = '4333', lang = '1' } = {}) =>
  submit('create', {
    loginName: buildLoginName(username),
    loginPassword,
    oddType: String(oddType),
    lang: String(lang),
    timestamp: ts(),
  });

const getBalance = (username) =>
  submit('balance', { loginName: buildLoginName(username), timestamp: ts() });

module.exports = {
  isEnabled, submit, createPlayer, getBalance, buildLoginName, endpointUrl,
  encryptParams, decryptParams, sign, buildRequest,
};
