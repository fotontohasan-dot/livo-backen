// services/templates.js
// ==================== Notification Template Engine ====================
// Email/SMS/In-App নোটিফিকেশনের কনটেন্ট DB-চালিত টেমপ্লেট থেকে আসে, {{variable}} প্লেসহোল্ডার সাপোর্ট সহ।
// এই মডিউল সম্পূর্ণ additive — বিদ্যমান services/email.js, notification প্রসেসর ইত্যাদির
// কোনো হার্ডকোডেড টেমপ্লেট মোছা বা পরিবর্তন করা হয়নি। renderByKey() টেমপ্লেট না পেলে null
// রিটার্ন করে — caller তখন পুরনো হার্ডকোডেড ভার্সন ব্যবহার করে, তাই backward-compatible।

const { pool } = require('../db');

const VALID_CHANNELS = ['email', 'sms', 'in_app'];
const VALID_LANGS = ['bn', 'en'];

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
    return match; // ভ্যারিয়েবল না পাওয়া গেলে placeholder-ই রেখে দেয় (silent-fail এড়াতে দৃশ্যমান থাকে)
  });
}

/** নির্দিষ্ট key+channel+lang দিয়ে টেমপ্লেট খুঁজে বের করে; না পেলে বিপরীত ভাষায় fallback চেষ্টা করে। */
async function getTemplate(templateKey, channel, lang = 'bn') {
  const r = await pool.query(
    `SELECT * FROM notification_templates WHERE template_key = $1 AND channel = $2 AND lang = $3 AND is_active = true LIMIT 1`,
    [templateKey, channel, lang]
  );
  if (r.rows[0]) return r.rows[0];

  // ফলব্যাক: অন্য ভাষায় থাকলে সেটা ব্যবহার করে (কিছু না দেখানোর চেয়ে ভালো)
  const fallbackLang = lang === 'bn' ? 'en' : 'bn';
  const r2 = await pool.query(
    `SELECT * FROM notification_templates WHERE template_key = $1 AND channel = $2 AND lang = $3 AND is_active = true LIMIT 1`,
    [templateKey, channel, fallbackLang]
  );
  return r2.rows[0] || null;
}

/** টেমপ্লেট রেন্ডার করে {subject, body} রিটার্ন করে; টেমপ্লেট না থাকলে null (caller নিজের ফলব্যাক ব্যবহার করবে)। */
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

// ==================== CRUD (অ্যাডমিন প্যানেলের জন্য) ====================
async function listTemplates({ channel = '', lang = '', q = '' } = {}) {
  const conditions = [];
  const params = [];
  if (channel && VALID_CHANNELS.includes(channel)) { params.push(channel); conditions.push(`channel = $${params.length}`); }
  if (lang && VALID_LANGS.includes(lang)) { params.push(lang); conditions.push(`lang = $${params.length}`); }
  if (q) { params.push(`%${q}%`); conditions.push(`(template_key ILIKE $${params.length} OR name ILIKE $${params.length})`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const r = await pool.query(`SELECT * FROM notification_templates ${where} ORDER BY template_key, channel, lang`, params);
  return r.rows;
}

async function getTemplateById(id) {
  const r = await pool.query(`SELECT * FROM notification_templates WHERE id = $1`, [id]);
  return r.rows[0] || null;
}

async function createTemplate(data, adminId, adminUsername) {
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
