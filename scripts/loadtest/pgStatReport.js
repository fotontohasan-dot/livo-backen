#!/usr/bin/env node
// scripts/loadtest/pgStatReport.js — লোড টেস্টের পর staging DB থেকে রিপোর্ট (পড়ার-কোয়েরি ছাড়া কিছু নয়)।
//   LOADTEST_DB_URL=… node scripts/loadtest/pgStatReport.js [--explain "SELECT …"]
// আউটপুট (Markdown, stdout + results/pgstat-<ts>.md):
//   • top 10 সবচেয়ে ধীর (total_exec_time) • top 10 সবচেয়ে ঘন (calls) • top 10 mean_exec_time
//   • সংযোগ: এই মুহূর্তের সংখ্যা, max_connections, state অনুযায়ী ভাগ (+ ⚠️ শিখর নিতে লোডের সময় বারবার চালান: --watch 5)
//   • --explain "<কোয়েরি>": EXPLAIN (ANALYZE, BUFFERS) — শুধু SELECT; ইনডেক্স যোগের আগে/পরে একই কোয়েরিতে চালিয়ে তুলনা করুন।
// কোয়েরি টেক্সটে ইউজারের ডেটা পড়ে থাকতে পারে না (pg_stat_statements প্যারামিটার $1 দিয়ে নর্মালাইজ করে), তবু ফাইল রিপোতে কমিট করবেন না।
const fs = require('fs');
const path = require('path');
const { assertStagingDb } = require('./lib/guard');
const { sleep } = require('./lib/env');

const trunc = (s, n = 140) => String(s).replace(/\s+/g, ' ').slice(0, n);

async function statements(pool, order, limit = 10) {
  const r = await pool.query(
    `SELECT left(query, 400) AS query, calls, round(total_exec_time::numeric, 1) AS total_ms, round(mean_exec_time::numeric, 2) AS mean_ms,
            round(max_exec_time::numeric, 1) AS max_ms, rows, shared_blks_read + shared_blks_hit AS blks
       FROM pg_stat_statements WHERE query NOT ILIKE '%pg_stat_statements%' ORDER BY ${order} DESC LIMIT $1`, [limit]);
  return r.rows;
}
const table = (rows) => ['| # | calls | total ms | mean ms | max ms | rows | query |', '|---|---|---|---|---|---|---|', ...rows.map((r, i) => `| ${i + 1} | ${r.calls} | ${r.total_ms} | ${r.mean_ms} | ${r.max_ms} | ${r.rows} | \`${trunc(r.query).replace(/\|/g, '\\|')}\` |`)].join('\n');

async function connections(pool) {
  const [m, a] = await Promise.all([
    pool.query('SHOW max_connections'),
    pool.query(`SELECT state, count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() GROUP BY state ORDER BY n DESC`)
  ]);
  const total = a.rows.reduce((s, r) => s + r.n, 0);
  return { max: Number(m.rows[0].max_connections), total, byState: a.rows };
}

async function main() {
  const db = assertStagingDb();
  const { Pool } = require('pg');
  const ssl = /\.render\.com|sslmode=require/i.test(db.url) ? { rejectUnauthorized: false } : undefined;
  const pool = new Pool({ connectionString: db.url, max: 2, ssl });
  try {
    const wi = process.argv.indexOf('--watch');
    if (wi > -1) { // লোডের সময় শিখর কানেকশন নিতে
      const every = Number(process.argv[wi + 1]) || 5; let peak = 0; console.log(`peak connections watch (প্রতি ${every}s; Ctrl-C-তে বন্ধ)`);
      for (;;) { const c = await connections(pool); peak = Math.max(peak, c.total); console.log(`${new Date().toISOString()} now=${c.total} peak=${peak} max=${c.max}`); await sleep(every * 1000); }
    }
    const ei = process.argv.indexOf('--explain');
    if (ei > -1) {
      const q = process.argv[ei + 1] || '';
      if (!/^\s*select\b/i.test(q) || /;\s*\S/.test(q)) { console.error('❌ --explain শুধু একটা SELECT নেয়।'); process.exit(2); }
      const r = await pool.query(`EXPLAIN (ANALYZE, BUFFERS) ${q}`);
      console.log(r.rows.map((x) => x['QUERY PLAN']).join('\n'));
      return;
    }
    const ext = await pool.query(`SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'`);
    if (!ext.rowCount) { console.error('❌ pg_stat_statements চালু নেই — sql/enable_pg_stat_statements.sql দেখুন।'); process.exit(2); }
    const [slow, freq, mean, conn] = await Promise.all([statements(pool, 'total_exec_time'), statements(pool, 'calls'), statements(pool, 'mean_exec_time'), connections(pool)]);
    const md = [`# DB report — ${new Date().toISOString()} (${db.host}/${db.dbName})`, '',
      '## Top 10 by total execution time', table(slow), '', '## Top 10 by calls', table(freq), '', '## Top 10 by mean execution time', table(mean), '',
      '## Connections (এই মুহূর্তে)', `max_connections=${conn.max}, now=${conn.total} (${((conn.total / conn.max) * 100).toFixed(0)}%)`, '',
      conn.byState.map((r) => `- ${r.state || 'null'}: ${r.n}`).join('\n'), '',
      'নোট: শিখর কানেকশন নিতে লোডের সময় `--watch 5` চালান; Render ড্যাশবোর্ডের DB মেট্রিক্সও মিলিয়ে দেখুন।'].join('\n');
    console.log(md);
    const dir = path.join(__dirname, 'results'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `pgstat-${new Date().toISOString().replace(/[:.]/g, '-')}.md`), md);
  } finally { await pool.end(); }
}
main().catch((e) => { console.error('pgstat report error:', e.message); process.exit(1); });
