// services/templates.js
// ==================== Notification Template Engine ====================

const { pool } = require('../db');

const VALID_CHANNELS = ['email', 'sms', 'in_app'];
const VALID_LANGS = ['bn', 'en'];

let tableReady = false;
let tableEnsurePromise = null;

async function ensureTable() {
  if (tableReady) return;
  if (tableEnsurePromise) return tableEnsurePromise;
  tableEnsurePromise = (async () => {
    try {
      await pool.query(`
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
      `);
      tableReady = true;
    } catch (e) {
      console.error('notification_templates ensureTable error:', e.message);
    }
  })();
  return tableEnsurePromise;
}

function extractVariableNames(body, subject) {
  const text = (subject || '') + ' ' + (body || '');
  const matches = text.match(/{{\s*([a-zA-Z0-9_]+)\s*}}/g) || [];
  return [...new Set(matches.map(m => m.replace(/[{}]/g, '').trim()))];
}

function interpolate(str, variables = {}) {
  if (!str) return str;
  return str.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(variables, key) && variables[key] !== undefined && variables[key] !== null) {
      return String(variables[key]);
    }
    return match;
  });
}

async function getTemplate(templateKey, channel, lang = 'bn') {
  await ensureTable();
  const r = await pool.query(
    `SELECT * FROM notification_templates WHERE template_key = $1 AND channel = $2 AND lang = $3 AND is_active = true LIMIT 1`,
    [templateKey, channel, lang]
  );
  if (r.rows[0]) return r.rows[0];

  const fallbackLang = lang === 'bn' ? 'en' : 'bn';
  const r2 = await pool.query(
    `SELECT * FROM notification_templates WHERE template_key = $1 AND channel = $2 AND lang = $3 AND is_active = true LIMIT 1`,
    [templateKey, channel, fallbackLang]
  );
  return r2.rows[0] || null;
}

async function renderByKey(templateKey, channel, lang, variables = {}) {
  try {
    const tmpl = await getTemplate(templateKey, channel, lang);
    if (!tmpl) return null;
    return {
      subject: interpolate(tmpl.subject, variables),
      body: interpolate(tmpl.body, variables),
      templateId: tmpl.id
    };
  } catch (err) {
    console.error('renderByKey error:', err.message);
    return null;
  }
}

function renderTemplateRow(tmpl, variables = {}) {
  return {
    subject: interpolate(tmpl.subject, variables),
    body: interpolate(tmpl.body, variables)
  };
}

async function listTemplates({ channel = '', lang = '', q = '' } = {}) {
  await ensureTable();
  try {
    const conditions = [];
    const params = [];
    if (channel && VALID_CHANNELS.includes(channel)) { params.push(channel); conditions.push(`channel = $${params.length}`); }
    if (lang && VALID_LANGS.includes(lang)) { params.push(lang); conditions.push(`lang = $${params.length}`); }
    if (q) { params.push(`%${q}%`); conditions.push(`(template_key ILIKE $${params.length} OR name ILIKE $${params.length})`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const r = await pool.query(`SELECT * FROM notification_templates ${where} ORDER BY template_key, channel, lang`, params);
    return r.rows;
  } catch (err) {
    console.error('listTemplates error:', err.message);
    return [];
  }
}

async function getTemplateById(id) {
  await ensureTable();
  const r = await pool.query(`SELECT * FROM notification_templates WHERE id = $1`, [id]);
  return r.rows[0] || null;
}

async function createTemplate(data, adminId, adminUsername) {
  await ensureTable();
  if (!VALID_CHANNELS.includes(data.channel)) throw new Error('অবৈধ চ্যানেল');
  if (!VALID_LANGS.includes(data.lang)) throw new Error('অবৈধ ভাষা');
  if (!data.template_key || !data.name || !data.body) throw new Error('টেমপ্লেট key, নাম ও body আবশ্যক');

  const variables = extractVariableNames(data.body, data.subject);
  const r = await pool.query(
    `INSERT INTO notification_templates
      (template_key, channel, lang, name, subject, body, variables, is_active, created_by_id, created_by_username, updated_by_id, updated_by_username)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$9,$10)
     RETURNING *`,
    [
      data.template_key.trim(), data.channel, data.lang, data.name.trim(),
      data.subject || null, data.body, JSON.stringify(variables),
      data.is_active !== false, adminId, adminUsername
    ]
  );
  return r.rows[0];
}

async function updateTemplate(id, data, adminId, adminUsername) {
  await ensureTable();
  const existing = await getTemplateById(id);
  if (!existing) throw new Error('টেমপ্লেট পাওয়া যায়নি');

  const variables = extractVariableNames(data.body, data.subject);
  const r = await pool.query(
    `UPDATE notification_templates
     SET name = $1, subject = $2, body = $3, variables = $4, is_active = $5,
         updated_by_id = $6, updated_by_username = $7, updated_at = NOW()
     WHERE id = $8
     RETURNING *`,
    [
      data.name.trim(), data.subject || null, data.body, JSON.stringify(variables),
      data.is_active !== false, adminId, adminUsername, id
    ]
  );
  return r.rows[0];
}

async function deleteTemplate(id) {
  await ensureTable();
  const r = await pool.query(`DELETE FROM notification_templates WHERE id = $1 RETURNING *`, [id]);
  return r.rows[0] || null;
}

module.exports = {
  VALID_CHANNELS,
  VALID_LANGS,
  extractVariableNames,
  interpolate,
  getTemplate,
  renderByKey,
  renderTemplateRow,
  listTemplates,
  getTemplateById,
  createTemplate,
  updateTemplate,
  deleteTemplate
};
