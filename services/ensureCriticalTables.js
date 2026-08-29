// services/ensureCriticalTables.js
// মাইগ্রেশনের মাঝে এরর হলে পরে থাকা টেবিল তৈরি নাও হতে পারে।
// বুটে এই ফাংশন আলাদা try/catch-এ critical টেবিলগুলো নিশ্চিত করে।

const { pool } = require('../db');

// PHASE 2 fix: আগে প্রতিটি ব্যর্থতা শুধু console-এ লেখা হত এবং function টি
// সফল হিসেবে return করত — অর্থাৎ critical table না থাকা সত্ত্বেও application
// listen করত। এখন ব্যর্থতাগুলো সংগ্রহ করে শেষে aggregate error throw করা হয়।
async function ensure(sql, label, failures) {
  try {
    await pool.query(sql);
  } catch (err) {
    console.error('[ensureCriticalTables]', label + ':', err.message);
    if (failures) failures.push(`${label}: ${err.message}`);
  }
}

async function ensureCriticalTables() {
  const failures = [];
  await ensure(`
    CREATE TABLE IF NOT EXISTS ip_rules (
      id SERIAL PRIMARY KEY,
      ip TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL CHECK (type IN ('block', 'whitelist')),
      reason TEXT,
      created_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `, 'ip_rules', failures);
  await ensure(`CREATE INDEX IF NOT EXISTS idx_ip_rules_ip ON ip_rules(ip)`, 'ip_rules index', failures);

  await ensure(`
    CREATE TABLE IF NOT EXISTS announcements (
      id SERIAL PRIMARY KEY,
      type VARCHAR(20) NOT NULL DEFAULT 'banner',
      title_bn TEXT, title_en TEXT,
      message_bn TEXT NOT NULL, message_en TEXT,
      target_type VARCHAR(20) NOT NULL DEFAULT 'all',
      target_role VARCHAR(20),
      target_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      active BOOLEAN DEFAULT true,
      starts_at TIMESTAMP DEFAULT NOW(),
      expires_at TIMESTAMP,
      created_by INTEGER,
      created_by_username TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `, 'announcements', failures);

  await ensure(`
    CREATE TABLE IF NOT EXISTS announcement_dismissals (
      id SERIAL PRIMARY KEY,
      announcement_id INTEGER REFERENCES announcements(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      dismissed_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(announcement_id, user_id)
    )
  `, 'announcement_dismissals', failures);

  await ensure(`
    CREATE TABLE IF NOT EXISTS step_up_verifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      code VARCHAR(10) NOT NULL,
      purpose VARCHAR(30) NOT NULL DEFAULT 'vpn_login',
      ip VARCHAR(45),
      attempts INTEGER NOT NULL DEFAULT 0,
      verified_at TIMESTAMP,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `, 'step_up_verifications', failures);

  await ensure(`
    CREATE TABLE IF NOT EXISTS notification_templates (
      id SERIAL PRIMARY KEY,
      template_key VARCHAR(100) NOT NULL,
      channel VARCHAR(20) NOT NULL CHECK (channel IN ('email', 'sms', 'in_app')),
      lang VARCHAR(5) NOT NULL DEFAULT 'bn',
      name VARCHAR(200) NOT NULL,
      subject TEXT,
      body TEXT NOT NULL,
      variables JSONB DEFAULT '[]',
      is_active BOOLEAN DEFAULT true,
      created_by_id INTEGER,
      created_by_username TEXT,
      updated_by_id INTEGER,
      updated_by_username TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(template_key, channel, lang)
    )
  `, 'notification_templates', failures);

  if (failures.length > 0) {
    throw new Error('Critical table verification failed: ' + failures.join('; '));
  }

  console.log('✅ Critical tables ensured (ip_rules, announcements, step_up_verifications, notification_templates)');
}

module.exports = { ensureCriticalTables };
