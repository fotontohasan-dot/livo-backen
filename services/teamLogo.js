// services/teamLogo.js
// ---------------------------------------------------------------------------
// Downloads team logos named by the sports feed and stores them locally in
// public/images/teams/. The feed is authenticated, but its URLs are still treated as hostile:
//
//   * https only, default port only, no credentials in the URL
//   * optional host allow-list (LOGO_ALLOWED_HOSTS=cdn.example.com,img.example.org)
//   * DNS is resolved ONCE; every returned address must be public, and the socket is then
//     pinned to that address (no second lookup => no DNS rebinding)
//   * redirects are followed manually (max 3) and every hop is re-validated the same way
//   * 200 KB hard cap while streaming, 5 s timeout
//   * the bytes must be a real PNG / JPEG / GIF / WebP (magic numbers); SVG is never accepted
//   * the file name is derived from a hash of the CONTENT, never from the URL => no path traversal,
//     identical logos are stored once
//   * team_logos remembers every URL (success or failure) so the same logo is not re-downloaded
//     repeatedly; failures back off for FAIL_BACKOFF_MS
// ---------------------------------------------------------------------------
const dns = require('dns');
const net = require('net');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 200 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 5000;
const FAIL_BACKOFF_MS = 6 * 60 * 60 * 1000;
const URL_MAX_LEN = 2048;
const DEFAULT_DIR = path.join(__dirname, '..', 'public', 'images', 'teams');
const WEB_PREFIX = '/images/teams/';
const SAFE_FILE = /^[a-f0-9]{32}\.(png|jpg|gif|webp)$/;

// ---- blocked address space ------------------------------------------------
const blocked = new net.BlockList();
[
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
].forEach(([a, p]) => blocked.addSubnet(a, p, 'ipv4'));
[
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32], ['64:ff9b::', 96], ['100::', 64]
].forEach(([a, p]) => blocked.addSubnet(a, p, 'ipv6'));

/** true when the literal IP must never be contacted. Anything unparsable is blocked. */
function isBlockedIp(ip) {
  const family = net.isIP(ip);
  if (!family) return true;
  if (family === 6) {
    // IPv4-mapped (::ffff:a.b.c.d) -> judge the embedded IPv4 address
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    if (m) return isBlockedIp(m[1]);
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
    if (hex) {
      const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
      return isBlockedIp([hi >> 8, hi & 255, lo >> 8, lo & 255].join('.'));
    }
    return blocked.check(ip, 'ipv6');
  }
  return blocked.check(ip, 'ipv4');
}

function allowedHosts() {
  return String(process.env.LOGO_ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
}

/** Syntactic validation of a logo URL. Returns the parsed URL or throws Error(code). */
function validateLogoUrl(raw, hosts = allowedHosts()) {
  if (typeof raw !== 'string' || !raw || raw.length > URL_MAX_LEN) throw new Error('bad_url');
  let u;
  try { u = new URL(raw); } catch (e) { throw new Error('bad_url'); }
  if (u.protocol !== 'https:') throw new Error('not_https');
  if (u.username || u.password) throw new Error('credentials_in_url');
  if (u.port && u.port !== '443') throw new Error('bad_port');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) throw new Error('blocked_host');
  if (net.isIP(host) && isBlockedIp(host)) throw new Error('blocked_ip');
  if (hosts.length && !hosts.some((h) => host === h || host.endsWith('.' + h))) throw new Error('host_not_allowed');
  return u;
}

/** Resolve once, require every address to be public, return the one we will connect to. */
async function resolvePublic(host, lookup = dns.promises.lookup) {
  const bare = host.replace(/^\[|\]$/g, '');
  if (net.isIP(bare)) {
    if (isBlockedIp(bare)) throw new Error('blocked_ip');
    return { address: bare, family: net.isIP(bare) };
  }
  const addrs = await lookup(bare, { all: true });
  if (!Array.isArray(addrs) || !addrs.length) throw new Error('dns_failed');
  if (addrs.some((a) => isBlockedIp(a.address))) throw new Error('blocked_ip'); // one private answer poisons the host
  return { address: addrs[0].address, family: addrs[0].family };
}

/** Identify the image from its bytes. SVG/HTML/anything else -> null. */
function sniffImage(buf) {
  if (buf.length >= 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', mime: 'image/png' };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf.length >= 6 && (buf.slice(0, 6).toString('latin1') === 'GIF87a' || buf.slice(0, 6).toString('latin1') === 'GIF89a')) return { ext: 'gif', mime: 'image/gif' };
  if (buf.length >= 12 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  return null;
}

// One pinned HTTPS GET. Resolves { status, headers, body } with body capped at MAX_BYTES.
function pinnedGet(u, pin, requestImpl = https.request) {
  return new Promise((resolve, reject) => {
    const req = requestImpl({
      protocol: 'https:', hostname: u.hostname.replace(/^\[|\]$/g, ''), port: 443, path: u.pathname + u.search, method: 'GET',
      servername: net.isIP(u.hostname) ? undefined : u.hostname,
      headers: { 'User-Agent': 'LivoLogoSync/1.0', Accept: 'image/png,image/jpeg,image/webp,image/gif', 'Accept-Encoding': 'identity' },
      // pin the socket to the address we already validated: no second DNS lookup can redirect us
      lookup: (_h, opts, cb) => (opts && opts.all ? cb(null, [{ address: pin.address, family: pin.family }]) : cb(null, pin.address, pin.family)),
      timeout: TIMEOUT_MS
    }, (res) => {
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > MAX_BYTES) { res.destroy(); return reject(new Error('too_large')); }
      const chunks = []; let total = 0;
      res.on('data', (c) => {
        total += c.length;
        if (total > MAX_BYTES) { res.destroy(); reject(new Error('too_large')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

/** Download + validate. Returns { buffer, ext, mime }. Never writes to disk. */
async function downloadLogo(rawUrl, deps = {}) {
  const lookup = deps.lookup || dns.promises.lookup;
  const get = deps.get || ((u, pin) => pinnedGet(u, pin, deps.request));
  let url = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = validateLogoUrl(url, deps.hosts);
    const pin = await resolvePublic(u.hostname, lookup);
    const res = await get(u, pin);
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers && res.headers.location;
      if (!loc) throw new Error('bad_redirect');
      url = new URL(loc, u).toString(); // re-validated at the top of the next iteration
      continue;
    }
    if (res.status !== 200) throw new Error('http_' + res.status);
    if (!res.body.length) throw new Error('empty');
    if (res.body.length > MAX_BYTES) throw new Error('too_large');
    const kind = sniffImage(res.body);
    if (!kind) throw new Error('not_an_image'); // covers SVG, HTML, and a lying Content-Type
    return { buffer: res.body, ext: kind.ext, mime: kind.mime };
  }
  throw new Error('too_many_redirects');
}

/** Content-addressed file name; the only name ever used on disk. */
function fileNameFor(buffer, ext) {
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 32) + '.' + ext;
}

async function storeLogo(buffer, ext, dir = DEFAULT_DIR) {
  const name = fileNameFor(buffer, ext);
  if (!SAFE_FILE.test(name)) throw new Error('unsafe_name');
  await fs.promises.mkdir(dir, { recursive: true });
  const dest = path.join(dir, name);
  if (!path.resolve(dest).startsWith(path.resolve(dir) + path.sep)) throw new Error('unsafe_path');
  try { await fs.promises.access(dest); return name; } catch (_) { /* not stored yet */ }
  const tmp = path.join(dir, `.${name}.${process.pid}.${Date.now()}.tmp`);
  await fs.promises.writeFile(tmp, buffer, { mode: 0o644 });
  await fs.promises.rename(tmp, dest);
  return name;
}

const urlHash = (u) => crypto.createHash('sha256').update(u).digest('hex');

/**
 * Resolve a feed logo URL to a local web path (or null). Uses team_logos as a cache so the same URL
 * is fetched once, and failures are not retried for FAIL_BACKOFF_MS.
 */
async function ensureLogo(pool, rawUrl, deps = {}) {
  if (!rawUrl) return null;
  let u;
  try { u = validateLogoUrl(rawUrl, deps.hosts); } catch (e) { return null; }
  const key = urlHash(u.toString());
  const hit = await pool.query('SELECT file, status, fetched_at FROM team_logos WHERE url_hash = $1', [key]);
  const row = hit.rows[0];
  if (row && row.status === 'ok' && row.file && SAFE_FILE.test(row.file)) {
    // hosting disks can be ephemeral (redeploy wipes public/): only trust the cache if the file is still there
    try { await fs.promises.access(path.join(deps.dir || DEFAULT_DIR, row.file)); return WEB_PREFIX + row.file; } catch (_) { /* re-download */ }
  }
  if (row && row.status === 'failed' && Date.now() - new Date(row.fetched_at).getTime() < FAIL_BACKOFF_MS) return null;
  try {
    const { buffer, ext } = await downloadLogo(u.toString(), deps);
    const file = await storeLogo(buffer, ext, deps.dir);
    await pool.query(
      `INSERT INTO team_logos (url_hash, file, status, error, fetched_at) VALUES ($1,$2,'ok',NULL,NOW())
       ON CONFLICT (url_hash) DO UPDATE SET file = EXCLUDED.file, status = 'ok', error = NULL, fetched_at = NOW()`, [key, file]);
    return WEB_PREFIX + file;
  } catch (err) {
    await pool.query(
      `INSERT INTO team_logos (url_hash, file, status, error, fetched_at) VALUES ($1,NULL,'failed',$2,NOW())
       ON CONFLICT (url_hash) DO UPDATE SET status = 'failed', error = EXCLUDED.error, fetched_at = NOW()`,
      [key, String(err.message || 'error').slice(0, 60)]).catch(() => {});
    return null;
  }
}

/** After the feed transaction has COMMITTED: fetch both logos and attach them to the match. */
async function syncMatchLogos(pool, matchId, { team_a_logo_url, team_b_logo_url } = {}, deps = {}) {
  const [a, b] = await Promise.all([ensureLogo(pool, team_a_logo_url, deps), ensureLogo(pool, team_b_logo_url, deps)]);
  if (!a && !b) return { a: null, b: null };
  await pool.query(
    `UPDATE matches SET team_a_logo = COALESCE($1, team_a_logo), team_b_logo = COALESCE($2, team_b_logo) WHERE id = $3`,
    [a, b, matchId]);
  return { a, b };
}

module.exports = {
  isBlockedIp, validateLogoUrl, resolvePublic, sniffImage, downloadLogo, storeLogo, ensureLogo, syncMatchLogos,
  fileNameFor, MAX_BYTES, WEB_PREFIX, SAFE_FILE
};
