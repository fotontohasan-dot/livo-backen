// scripts/loadtest/lib/client.js — কোনো এক্সট্রা ডিপেন্ডেন্সি ছাড়া HTTP ক্লায়েন্ট (keep-alive, কুকি জার, টাইমআউট)।
// প্রতিটা কলের সময় মাপা হয়; কুকি/পাসওয়ার্ড কোথাও লগ হয় না।
const http = require('http');
const https = require('https');

function makeClient(baseUrl, { maxSockets = 256, timeoutMs = 15000, userAgent = 'livo-loadtest/1.0' } = {}) {
  const u = new URL(baseUrl);
  const lib = u.protocol === 'https:' ? https : http;
  const agent = new lib.Agent({ keepAlive: true, maxSockets, maxFreeSockets: Math.min(maxSockets, 64) });

  /** @returns {Promise<{status:number, headers:object, text:string, ms:number, err?:string}>} — কখনো throw করে না। */
  function request({ method = 'GET', path = '/', headers = {}, body, jar }) {
    return new Promise((resolve) => {
      const t0 = process.hrtime.bigint();
      const h = { 'user-agent': userAgent, accept: 'application/json,text/html;q=0.9,*/*;q=0.5', ...headers };
      if (jar && jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      let payload = null;
      if (body !== undefined) {
        payload = typeof body === 'string' ? body : JSON.stringify(body);
        if (!h['content-type']) h['content-type'] = typeof body === 'string' ? 'application/x-www-form-urlencoded' : 'application/json';
        h['content-length'] = Buffer.byteLength(payload);
      }
      const done = (extra) => resolve({ status: 0, headers: {}, text: '', ms: Number(process.hrtime.bigint() - t0) / 1e6, ...extra });
      const req = lib.request({ protocol: u.protocol, hostname: u.hostname, port: u.port || undefined, method, path, headers: h, agent }, (res) => {
        const chunks = [];
        res.on('data', (c) => { if (chunks.reduce((n, x) => n + x.length, 0) < 2_000_000) chunks.push(c); });
        res.on('end', () => {
          if (jar) {
            for (const sc of [].concat(res.headers['set-cookie'] || [])) {
              const [pair] = sc.split(';'); const i = pair.indexOf('=');
              if (i > 0) { const k = pair.slice(0, i).trim(); const v = pair.slice(i + 1).trim(); if (/;\s*expires=.*1970/i.test(sc) || v === '') jar.delete(k); else jar.set(k, v); }
            }
          }
          done({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', (e) => done({ err: e.code || 'RES_ERROR' }));
      });
      req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
      req.on('error', (e) => done({ err: e.code || (e.message === 'timeout' ? 'TIMEOUT' : 'REQ_ERROR') }));
      if (payload) req.write(payload);
      req.end();
    });
  }
  return { request, destroy: () => agent.destroy(), baseUrl: u.origin };
}

module.exports = { makeClient };
