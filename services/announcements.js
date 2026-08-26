const { pool } = require('../db');

async function getActiveForUser(user, type) {
  try {
    const params = [type];
    let q = `
      SELECT * FROM announcements
      WHERE type = $1 AND active = true
        AND starts_at <= NOW()
        AND (expires_at IS NULL OR expires_at > NOW())
        AND (
          target_type = 'all'
    `;
    if (user) {
      params.push(user.role || 'user');
      q += ` OR (target_type = 'role' AND target_role = $2)`;
      params.push(user.id);
      q += ` OR (target_type = 'user' AND target_user_id = $3)`;
    }
    q += `) ORDER BY created_at DESC`;
    const r = await pool.query(q, params);
    return r.rows;
  } catch (err) {
    console.error('announcements getActiveForUser error:', err.message);
    return [];
  }
}

async function getAllActiveForUser(user) {
  try {
    const params = [];
    let q = `
      SELECT a.* FROM announcements a
      WHERE a.active = true
        AND a.starts_at <= NOW()
        AND (a.expires_at IS NULL OR a.expires_at > NOW())
        AND (a.target_type = 'all'
    `;
    if (user) {
      params.push(user.role || 'user');
      q += ` OR (a.target_type = 'role' AND a.target_role = $1)`;
      params.push(user.id);
      q += ` OR (a.target_type = 'user' AND a.target_user_id = $2)`;
    }
    q += `)`;
    if (user) {
      params.push(user.id);
      q += ` AND NOT EXISTS (SELECT 1 FROM announcement_dismissals d WHERE d.announcement_id = a.id AND d.user_id = $${params.length} AND a.type IN ('popup','inapp'))`;
    }
    q += ` ORDER BY a.created_at DESC`;
    const r = await pool.query(q, params);
    return r.rows;
  } catch (err) {
    console.error('announcements getAllActiveForUser error:', err.message);
    return [];
  }
}

async function isDismissed(announcementId, userId) {
  if (!userId) return false;
  const r = await pool.query(
    'SELECT 1 FROM announcement_dismissals WHERE announcement_id = $1 AND user_id = $2',
    [announcementId, userId]
  );
  return r.rows.length > 0;
}

async function dismiss(announcementId, userId) {
  if (!userId) return;
  await pool.query(
    `INSERT INTO announcement_dismissals (announcement_id, user_id) VALUES ($1, $2)
     ON CONFLICT (announcement_id, user_id) DO NOTHING`,
    [announcementId, userId]
  );
}

module.exports = { getActiveForUser, getAllActiveForUser, isDismissed, dismiss };
