// services/ipRules.js
// Bot Detection System-এর IP Block/Whitelist অংশ।

const { pool } = require('../db');
const cache = require('./cache');

let tableReady = false;
let tableEnsurePromise = null;

async function ensureTable() {
  if (tableReady) return;
  if (tableEnsurePromise) return tableEnsurePromise;
  tableEnsurePromise = (async () => {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ip_rules (
          id SERIAL PRIMARY KEY,
          ip TEXT NOT NULL UNIQUE,
          type TEXT NOT NULL CHECK (type IN ('block', 'whitelist')),
          reason TEXT,
          created_by TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_ip_rules_ip ON ip_rules(ip)`);
      tableReady = true;
    } catch (e) {
      console.error('ip_rules ensureTable error:', e.message);
    }
  })();
  return tableEnsurePromise;
}

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.ip || (req.connection && req.connection.remoteAddress) || '';
}

/** 'block' | 'whitelist' | null রিটার্ন করে */
async function getIpRule(ip) {
  if (!ip) return null;
  try {
    await ensureTable();
    return await cache.getOrSet(`ip_rule:${ip}`, 30, async () => {
      const r = await pool.query('SELECT type FROM ip_rules WHERE ip = $1 LIMIT 1', [ip]);
      return r.rows[0] ? r.rows[0].type : null;
    });
  } catch (e) {
    console.error('getIpRule error:', e.message);
    return null;
  }
}

async function setIpRule(ip, type, reason, createdBy) {
  await ensureTable();
  await pool.query(
    `INSERT INTO ip_rules (ip, type, reason, created_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (ip) DO UPDATE SET type = $2, reason = $3, created_by = $4, created_at = NOW()`,
    [ip, type, reason || null, createdBy || null]
  );
  await cache.del(`ip_rule:${ip}`);
}

async function removeIpRule(ip) {
  await ensureTable();
  await pool.query('DELETE FROM ip_rules WHERE ip = $1', [ip]);
  await cache.del(`ip_rule:${ip}`);
}

async function listIpRules() {
  await ensureTable();
  const r = await pool.query('SELECT * FROM ip_rules ORDER BY created_at DESC');
  return r.rows;
}

module.exports = { getClientIp, getIpRule, setIpRule, removeIpRule, listIpRules };
