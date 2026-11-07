// services/teamLogos.js
// ---------------------------------------------------------------------------
// Remote team logos from a feed cannot be shown directly (CSP is img-src 'self'
// data:) and must not be hot-linked from arbitrary hosts. Instead the feed ingest
// downloads each logo ONCE, validates it, and stores it under
// public/images/teams/<hash>.<ext>; matches then point at that local path.
//
// There is deliberately NO public "/api/proxy-logo?url=" endpoint: an open fetch
// proxy is an SSRF/bandwidth-abuse vector. Only URLs that arrive through the
// authenticated feed (API-key protected) are ever fetched.
//
// Safety: https only, no credentials/odd ports, every resolved IP must be public
// (and the connection is pinned to the validated IP — no DNS rebinding), manual
// redirects (max 2, each re-validated), 5s timeout, 200 KB cap, magic-byte check
// (PNG/JPEG/WEBP/GIF — never SVG), content-type is not trusted.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const https = require('https');

const DIR = process.env.TEAM_LOGO_DIR || path.join(__dirname, '..', 'public', 'images', 'teams');
const PUBLIC_PREFIX = '/images/teams/';
const MAX_BYTES = 200 * 1024;
const TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 2;
const MAX_PARALLEL = 3;
const FAIL_TTL_MS = 10 * 60 * 1000;
const EXTS = ['png', 'jpg', 'webp', 'gif'];

const inflight = new Map();   // url -> Promise<path|null>
const failed = new Map();     // url -> timestamp of last failure
let running = 0;
const waiting = [];

function isRemote(u) {
  return typeof u === 'string' && u.length <= 500 && /^https:\/\/[^\s"'<>]+$/i.test(u);
}

function hashOf(url) { return crypto.createHash('sha256').update(url).digest('hex').slice(0, 24); }

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
           (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::' || l === '::1') return true;
    if (l.startsWith('fe8') || l.startsWith('fe9') || l.startsWith('fea') || l.startsWith('feb')) return true; // link-local
    if (l.startsWith('fc') || l.startsWith('fd')) return true;                                              // unique local
    const m = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);                                                      // v4-mapped
    if (m) return isPrivateIp(m[1]);
    return false;
  }
  return true; // not an IP at all -> refuse
}

function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.toString('ascii', 0, 4) === 'GIF8') return 'gif';
  return null;
}

// '/images/teams/<hash>.<ext>' if the logo is already on disk, else null.
function cachedPath(url) {
  const h = hashOf(url);
  for (const ext of EXTS) {
    if (fs.existsSync(path.join(DIR, `${h}.${ext}`))) return `${PUBLIC_PREFIX}${h}.${ext}`;
  }
  return null;
}

async function resolvePublicIp(hostname) {
  const addrs = await dns.lookup(hostname, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('blocked address');
  return addrs[0];
}

function fetchOnce(urlStr) {
  return new Promise(async (resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error('bad url')); }
    if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return reject(new Error('url not allowed'));
    let addr;
    try { addr = await resolvePublicIp(u.hostname); } catch (e) { return reject(e); }

    const req = https.request({
      host: u.hostname, servername: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: { 'User-Agent': 'LivoLogoCache/1.0', Accept: 'image/png,image/jpeg,image/webp,image/gif' },
      // pin the connection to the IP we validated (defeats DNS rebinding)
      lookup: (_h, _o, cb) => cb(null, addr.address, addr.family),
      timeout: TIMEOUT_MS
    }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve({ redirect: new URL(res.headers.location, u).toString() });
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('status ' + res.statusCode)); }
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > MAX_BYTES) { res.destroy(); return reject(new Error('too large')); }
      const chunks = []; let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BYTES) { res.destroy(); return reject(new Error('too large')); }
        chunks.push(c);
      });
      res.on('end', () => resolve({ body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function download(url) {
  let current = url;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const r = await fetchOnce(current);
    if (r.redirect) { current = r.redirect; continue; }
    const ext = sniff(r.body);
    if (!ext) throw new Error('not an allowed image type');
    await fs.promises.mkdir(DIR, { recursive: true });
    const name = `${hashOf(url)}.${ext}`;
    const tmp = path.join(DIR, `.${name}.${process.pid}.tmp`);
    await fs.promises.writeFile(tmp, r.body);
    await fs.promises.rename(tmp, path.join(DIR, name)); // atomic
    return PUBLIC_PREFIX + name;
  }
  throw new Error('too many redirects');
}

function runLimited(fn) {
  return new Promise((resolve, reject) => {
    const go = () => { running++; fn().then(resolve, reject).finally(() => { running--; const n = waiting.shift(); if (n) n(); }); };
    if (running < MAX_PARALLEL) go(); else waiting.push(go);
  });
}

// Resolves to the local public path, or null on any failure (never throws).
function cacheLogo(url) {
  if (!isRemote(url)) return Promise.resolve(null);
  const hit = cachedPath(url);
  if (hit) return Promise.resolve(hit);
  const lastFail = failed.get(url);
  if (lastFail && Date.now() - lastFail < FAIL_TTL_MS) return Promise.resolve(null);
  if (inflight.has(url)) return inflight.get(url);
  const p = runLimited(() => download(url))
    .catch((err) => { failed.set(url, Date.now()); console.warn('[teamLogos] skip', url.slice(0, 80), '-', err.message); return null; })
    .finally(() => inflight.delete(url));
  inflight.set(url, p);
  return p;
}

module.exports = { isRemote, isPrivateIp, sniff, hashOf, cachedPath, cacheLogo, DIR, PUBLIC_PREFIX };
