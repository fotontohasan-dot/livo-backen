// services/liveApi.js
// LIVE API ক্লায়েন্ট (ডকুমেন্টেশন সেকশন ৩: General API request method)
//  1. প্যারামিটার → JSON স্ট্রিং
//  2. params    = Base64(AES-ECB-PKCS5(json, AES_KEY))
//  3. signature = MD5(json + MD5_KEY) বড় হাতের hex
//  4. POST { merchantCode, params, signature } → LIVE_API_ROOT + method + "/v1"
//  5. টাইমআউট ৩০ সেকেন্ড
// env: LIVE_MERCHANT_CODE, LIVE_AES_KEY, LIVE_MD5_KEY, LIVE_API_ROOT (শেষে "/" সহ)
// ⚠️ কোনো key কোডে হার্ডকোড করা হয়নি।
const crypto = require('crypto');
const { fetchWithTimeout } = require('../utils/httpClient');

const TIMEOUT_MS = 30000;

function cfg() {
  return {
    merchantCode: process.env.LIVE_MERCHANT_CODE || '',
    aesKey: process.env.LIVE_AES_KEY || '',
    md5Key: process.env.LIVE_MD5_KEY || '',
    apiRoot: process.env.LIVE_API_ROOT || '',
  };
}

function isEnabled() {
  const c = cfg();
  return !!(c.merchantCode && c.aesKey && c.md5Key && c.apiRoot);
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

async function submit(method, params) {
  if (!isEnabled()) throw new Error('LIVE API কনফিগার করা নেই (LIVE_* env ভ্যারিয়েবল দিন)');
  const c = cfg();
  const res = await fetchWithTimeout(
    `${c.apiRoot}${method}/v1`,
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

const ts = () => Date.now();

const createPlayer = (loginName, loginPassword) =>
  submit('create', { loginName, loginPassword, oddType: 4333, lang: 1, timestamp: ts() });

const getBalance = (loginName) => submit('balance', { loginName, timestamp: ts() });

module.exports = {
  isEnabled, submit, createPlayer, getBalance,
  encryptParams, decryptParams, sign, buildRequest,
};
