// routes/adminLeaderboard.js
// ---------------------------------------------------------------------------
// Admin → Leaderboard ম্যানেজমেন্ট (/admin/leaderboard)।
//
// এই পেজ দুটো বিদ্যমান লিডারবোর্ড উৎস থেকেই ডেটা দেখায়, কোনোটার লজিক নতুন করে
// লেখা হয়নি:
//  • পয়েন্ট লিডারবোর্ড — routes/leaderboard.js যে র‍্যাঙ্কিং পাবলিকভাবে দেখায়
//    (u.role='user' AND is_banned=false, total_points DESC) সেই একই শর্ত এখানে
//    রি-ইউজ করে rank কম্পিউট করা হয়েছে, শুধু পাবলিক পেজের মতো টপ ৫০-এ সীমাবদ্ধ না
//    রেখে সার্চ/ফিল্টার/পেজিনেশনসহ পূর্ণ তালিকা দেখানো হয়েছে। পাবলিক /leaderboard
//    রুট বা তার cache/query কিছুই এখানে স্পর্শ করা হয়নি।
//  • মাসিক রেফারেল কনটেস্ট — services/contest.js-এর getLeaderboard()/getPastContests()
//    হুবহু রি-ইউজ (import) করা হয়েছে, prize/reward কলাম দেখানোর জন্য।
//
// নিরাপত্তা:
//  • isAdmin — app.js-এ মাউন্টের সময় বসানো (routes/adminTelegram.js-এর প্যাটার্নেই)
//  • rbac.requirePermission('reports_view') — GET পেজ (routes/admin.js-এর
//    /referrals লিস্টও এই একই permission ব্যবহার করে, তাই নতুন permission key
//    যোগ করা হয়নি — নতুন key বিদ্যমান role রো-গুলোতে ON CONFLICT DO NOTHING-এর
//    কারণে পৌঁছাত না, routes/adminTelegram.js-এ যে কারণে explained করা আছে)
//  • rbac.requirePermission('users_ban') — এই পেজ থেকে ব্যান/আনব্যান টগল করার জন্য;
//    routes/admin.js-এর /users/:id/ban রুট যে permission ব্যবহার করে সেটাই
//  • CSRF — গ্লোবাল middleware/csrf.js + views/admin/partials/pwa-head.ejs-এর
//    অটো-ইনজেকশন স্ক্রিপ্ট (ফর্মে হিডেন _csrf ইনপুট বসিয়ে দেয়), আলাদা কিছু লাগে না
//  • Audit — ব্যান/আনব্যান টগল admin_logs + audit_logs দুই জায়গাতেই লেখা হয়
//    (routes/admin.js-এর /users/:id/ban রুটের মতোই ফরম্যাট, যাতে Activity Log/
//    Audit Log পাতায় একই ধরনের এন্ট্রি হিসেবে দেখা যায়)
//
// এই ফাইল routes/admin.js বা routes/leaderboard.js কোনোটাই এডিট করে না —
// সম্পূর্ণ আলাদা, self-contained রুট (adminTelegram.js-এর মতোই মাউন্ট হয়)।
// ---------------------------------------------------------------------------

const express = require('express');
const router = express.Router();

const { pool } = require('../db');
const rbac = require('../services/rbac');
const { requireIntParam } = require('../middleware/validate');
const { logAdminAction, logEvent: logAuditEvent } = require('../services/auditLog');
const cache = require('../services/cache');
const cacheKeys = require('../services/cacheKeys');
const { getLeaderboard: getContestLeaderboard, getPastContests, PRIZES } = require('../services/contest');

const PAGE_SIZE = 25;

function actorOf(req) {
  return {
    id: req.session && req.session.user ? req.session.user.id : null,
    username: req.session && req.session.user ? req.session.user.username : 'UNKNOWN'
  };
}

// ==================== পয়েন্ট লিডারবোর্ড (সার্চ/ফিল্টার/পেজিনেশনসহ) ====================
router.get('/', rbac.requirePermission('reports_view'), async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const offset = (page - 1) * PAGE_SIZE;
    const search = (req.query.search || '').trim();
    const status = req.query.status || ''; // '', 'active', 'banned'

    const countConditions = [`u.role = 'user'`];
    const countParams = [];
    if (search) {
      countParams.push(`%${search}%`);
      countConditions.push(`(u.username ILIKE $${countParams.length} OR u.email ILIKE $${countParams.length} OR u.phone ILIKE $${countParams.length})`);
    }
    if (status === 'banned') countConditions.push('u.is_banned = true');
    if (status === 'active') countConditions.push('(u.is_banned IS NULL OR u.is_banned = false)');

    const countRes = await pool.query(
      `SELECT COUNT(*) FROM users u WHERE ${countConditions.join(' AND ')}`,
      countParams
    );
    const total = parseInt(countRes.rows[0].count);

    // rank শুধু "active" (ব্যান না হওয়া) ইউজারদের মধ্যে কম্পিউট করা হয় — ঠিক পাবলিক
    // /leaderboard পেজ যেভাবে র‍্যাঙ্ক করে সেভাবেই (রোল/ব্যান শর্ত অভিন্ন)। ব্যান হওয়া
    // ইউজারের rank NULL — তারা পাবলিক লিডারবোর্ডে দেখানো হয় না বলেই।
    const dataParams = [];
    let searchClause = '';
    if (search) {
      dataParams.push(`%${search}%`);
      searchClause = `WHERE (username ILIKE $${dataParams.length} OR email ILIKE $${dataParams.length} OR phone ILIKE $${dataParams.length})`;
    }
    let statusClause = '';
    if (status === 'banned') statusClause = `${searchClause ? 'AND' : 'WHERE'} is_banned = true`;
    if (status === 'active') statusClause = `${searchClause ? 'AND' : 'WHERE'} (is_banned IS NULL OR is_banned = false)`;

    dataParams.push(PAGE_SIZE, offset);
    const dataRes = await pool.query(
      `WITH base AS (
         SELECT
           u.id, u.username, u.avatar, u.email, u.total_points, u.coins, u.is_banned, u.created_at,
           COUNT(b.id) FILTER (WHERE b.status = 'won') AS wins,
           COUNT(b.id) AS total_bets
         FROM users u
         LEFT JOIN bets b ON b.user_id = u.id
         WHERE u.role = 'user'
         GROUP BY u.id, u.username, u.avatar, u.email, u.total_points, u.coins, u.is_banned, u.created_at
       ),
       ranked AS (
         SELECT base.*,
           CASE WHEN (is_banned IS NULL OR is_banned = false)
             THEN ROW_NUMBER() OVER (
               PARTITION BY (is_banned IS NULL OR is_banned = false)
               ORDER BY total_points DESC, id ASC
             )
             ELSE NULL
           END AS rank
         FROM base
       )
       SELECT * FROM ranked
       ${searchClause} ${statusClause}
       ORDER BY (rank IS NULL) ASC, rank ASC NULLS LAST, total_points DESC
       LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
      dataParams
    );

    const contest = await getContestLeaderboard(null).catch(err => {
      console.error('adminLeaderboard: রেফারেল কনটেস্ট লোড ব্যর্থ:', err.message);
      return { leaders: [], myRank: null, prizes: PRIZES, monthName: '' };
    });

    res.render('admin/leaderboard', {
      entries: dataRes.rows,
      page,
      totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
      total,
      search,
      status,
      contest,
      saved: req.query.saved === '1',
      saveError: req.query.error ? String(req.query.error) : ''
    });
  } catch (err) {
    console.error('Admin leaderboard load error:', err && err.stack ? err.stack : err);
    res.render('admin/leaderboard', {
      entries: [], page: 1, totalPages: 1, total: 0, search: '', status: '',
      contest: { leaders: [], myRank: null, prizes: PRIZES, monthName: '' },
      saved: false, saveError: 'লিডারবোর্ড লোড করা যায়নি।'
    });
  }
});

// আগের মাসের কনটেস্ট রেজাল্ট — আলাদা JSON এন্ডপয়েন্ট, পেজেই "আগের মাসগুলো" বাটনে fetch হয়
router.get('/contest/history', rbac.requirePermission('reports_view'), async (req, res) => {
  try {
    const monthsBack = Math.min(12, Math.max(1, parseInt(req.query.months) || 3));
    const past = await getPastContests(null, monthsBack);
    res.json({ success: true, past });
  } catch (err) {
    console.error('Admin leaderboard contest history error:', err.message);
    res.status(500).json({ success: false, error: 'আগের কনটেস্ট রেজাল্ট লোড করা যায়নি।' });
  }
});

// ==================== মডারেশন: ব্যান/আনব্যান টগল ====================
// routes/admin.js-এর /users/:id/ban রুটের হুবহু একই আচরণ (একই কুয়েরি/একই ধরনের লগ)
// যাতে ইউজার ম্যানেজমেন্ট পেজ ও এই পেজ থেকে ব্যান করলে Activity Log-এ একই রকম দেখায়।
// শুধু পার্থক্য: এখান থেকে ব্যান করলে সরাসরি /admin/leaderboard-এ ফিরিয়ে আনা হয়
// (তাই আগের সার্চ/ফিল্টার/পেজ ধরে রাখা যায়) এবং leaderboard:top50 ক্যাশ ইনভ্যালিডেট
// করা হয় — কারণ ব্যান/আনব্যান সরাসরি পাবলিক র‍্যাঙ্কিং বদলে দেয়।
router.post('/:id/toggle-ban', rbac.requirePermission('users_ban'), requireIntParam('id'), async (req, res) => {
  const baseUrl = (() => {
    const qs = new URLSearchParams();
    if (req.body.page) qs.set('page', String(req.body.page));
    if (req.body.search) qs.set('search', String(req.body.search));
    if (req.body.status) qs.set('status', String(req.body.status));
    return '/admin/leaderboard' + (qs.toString() ? `?${qs}` : '');
  })();
  const redirectWith = (param) => res.redirect(baseUrl + (baseUrl.includes('?') ? '&' : '?') + param);

  try {
    const r = await pool.query(
      `UPDATE users SET is_banned = NOT COALESCE(is_banned, false) WHERE id = $1 AND role = 'user' RETURNING is_banned, username`,
      [req.params.id]
    );
    if (!r.rows.length) {
      return redirectWith('error=' + encodeURIComponent('ইউজার পাওয়া যায়নি।'));
    }

    const nowBanned = r.rows[0].is_banned;
    const username = r.rows[0].username;
    const actor = actorOf(req);

    await cache.del(cacheKeys.leaderboardTop50()).catch(() => {});

    await logAdminAction(
      actor.id, actor.username,
      nowBanned ? 'USER_BAN' : 'USER_UNBAN',
      `লিডারবোর্ড পেজ থেকে ${username} (#${req.params.id}) কে ${nowBanned ? 'ব্যান' : 'আনব্যান'} করা হয়েছে`,
      req.ip
    );
    logAuditEvent({
      req, actorType: 'admin', actorId: actor.id, actorUsername: actor.username,
      action: nowBanned ? 'USER_BANNED' : 'USER_UNBANNED', category: 'security', status: 'success',
      riskLevel: nowBanned ? 'high' : 'medium',
      details: { userId: req.params.id, username, source: 'admin_leaderboard' }
    }).catch(e => console.error('adminLeaderboard logAuditEvent error:', e.message));

    return redirectWith('saved=1');
  } catch (err) {
    console.error('Admin leaderboard ban toggle error:', err && err.stack ? err.stack : err);
    return redirectWith('error=' + encodeURIComponent('স্ট্যাটাস পরিবর্তন করা যায়নি।'));
  }
});

module.exports = router;
