// utils/adminNav.js
// ---------------------------------------------------------------------------
// অ্যাডমিন নেভিগেশনের কাঠামো — একটাই সত্যের উৎস।
//
// আগে নেভিগেশন views/admin/partials/admin-layout.ejs-এর ভেতরে ~৩১৫ লাইন জুড়ে
// হার্ডকোড করা ছিল: ৫১টা লিংকের একটা সমতল তালিকা, কোনো গ্রুপিং/কোলাপস ছাড়া।
// আরও দুটো প্রতিদ্বন্দ্বী সাইডবার ফাইলও ছিল (views/partials/admin-sidebar.ejs
// ও views/admin/partials/sidebar.ejs) — কোনোটাই admin-layout ব্যবহার করত না,
// অর্থাৎ সেগুলো সম্পাদনা করলে বাস্তবে কিছুই বদলাত না।
//
// এখন কাঠামোটা ডেটা, টেমপ্লেট নয় — ফলে টেস্ট করে দেখা যায় কোনো গন্তব্য
// হারায়নি (tests/render/adminNavIntegrity.test.js) এবং একই লিংক দুইবার
// আসেনি।
//
// permission ফিল্ড: services/rbac.js-এর PERMISSIONS ক্যাটালগের key। যে
// অ্যাডমিনের ওই permission নেই তাকে লিংকটা দেখানো হয় না — এটা নিছক UI
// পরিচ্ছন্নতা; আসল সুরক্ষা রুটের requirePermission() মিডলওয়্যারেই থাকে।
// ---------------------------------------------------------------------------

const NAV = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    labelKey: 'admin_nav_dashboard',
    icon: 'fa-gauge-high',
    items: [
      { href: '/admin', label: 'Dashboard', labelKey: 'admin_nav_item_dashboard', icon: 'fa-home', active: 'dashboard', permission: 'dashboard_view' }
    ]
  },
  {
    id: 'users',
    label: 'Users',
    labelKey: 'admin_nav_users',
    icon: 'fa-users',
    items: [
      { href: '/admin/users',              label: 'All Users', labelKey: 'admin_nav_item_all_users',         icon: 'fa-users',              active: 'users',              permission: 'users_view' },
      { href: '/admin/kyc',                label: 'KYC', labelKey: 'admin_nav_item_kyc',               icon: 'fa-id-card',            active: 'kyc',                permission: 'kyc_view', badge: 'kyc' },
      { href: '/admin/user-roles',         label: 'User Roles', labelKey: 'admin_nav_item_user_roles',        icon: 'fa-user-tag',           active: 'user-roles',         permission: 'roles_manage' },
      { href: '/admin/login-history',      label: 'Login History', labelKey: 'admin_nav_item_login_history',     icon: 'fa-clock-rotate-left',  active: 'login-history',      permission: 'activity_log_view' },
      { href: '/admin/duplicate-accounts', label: 'Duplicate Accounts', labelKey: 'admin_nav_item_duplicate_accounts',icon: 'fa-clone',              active: 'duplicate-accounts', permission: 'bot_monitoring_manage' }
    ]
  },
  {
    id: 'finance',
    label: 'Finance',
    labelKey: 'admin_nav_finance',
    icon: 'fa-wallet',
    items: [
      { href: '/payment/admin/payments', label: 'Payment Approval', labelKey: 'admin_nav_item_payment_approval',  icon: 'fa-money-bill-wave', active: 'payments',     permission: 'payments_view', badge: 'payments' },
      { href: '/payment/admin/deposits', label: 'Deposit Reports', labelKey: 'admin_nav_item_deposit_reports',   icon: 'fa-chart-column',    active: 'deposits',     permission: 'reports_view' },
      { href: '/payment/admin/summary',  label: 'Daily Summary', labelKey: 'admin_nav_item_daily_summary',     icon: 'fa-chart-pie',       active: 'summary',      permission: 'reports_view' },
      { href: '/admin/transactions',     label: 'Transactions', labelKey: 'admin_nav_item_transactions',      icon: 'fa-receipt',         active: 'transactions', permission: 'payments_view' },
      { href: '/admin/bets',             label: 'Bets', labelKey: 'admin_nav_item_bets',              icon: 'fa-dice',            active: 'bets',         permission: 'games_manage' }
    ]
  },
  {
    id: 'sports',
    label: 'Sports & Gaming',
    labelKey: 'admin_nav_sports',
    icon: 'fa-futbol',
    items: [
      { href: '/admin/matches',     label: 'Matches & Markets', labelKey: 'admin_nav_item_matches_markets', icon: 'fa-futbol',       active: 'matches',     permission: 'matches_manage' },
      { href: '/admin/tournaments', label: 'Tournaments', labelKey: 'admin_nav_item_tournaments',       icon: 'fa-trophy',       active: 'tournaments', permission: 'matches_manage' },
      { href: '/admin/games',       label: 'Games', labelKey: 'admin_nav_item_games',             icon: 'fa-gamepad',      active: 'games',       permission: 'games_manage' },
      { href: '/admin/leaderboard', label: 'Leaderboard', labelKey: 'admin_nav_item_leaderboard',       icon: 'fa-ranking-star', active: 'leaderboard', permission: 'games_manage' }
    ]
  },
  {
    id: 'rewards',
    label: 'Rewards & Growth',
    labelKey: 'admin_nav_rewards',
    icon: 'fa-gift',
    items: [
      { href: '/admin/vip',         label: 'VIP', labelKey: 'admin_nav_item_vip',         icon: 'fa-crown',      active: 'vip',         permission: 'vip_manage' },
      { href: '/admin/vip/history', label: 'VIP History', labelKey: 'admin_nav_item_vip_history', icon: 'fa-history',    active: 'vip-history', permission: 'vip_manage' },
      { href: '/admin/bonuses',     label: 'Bonuses', labelKey: 'admin_nav_item_bonuses',     icon: 'fa-gift',       active: 'bonuses',     permission: 'vip_manage' },
      { href: '/admin/referrals',   label: 'Referrals', labelKey: 'admin_nav_item_referrals',   icon: 'fa-user-group', active: 'referrals',   permission: 'reports_view' },
      { href: '/admin/promotions',  label: 'Promotions', labelKey: 'admin_nav_item_promotions',  icon: 'fa-bullhorn',   active: 'promotions',  permission: 'games_manage' }
    ]
  },
  {
    id: 'communication',
    label: 'Communication',
    labelKey: 'admin_nav_communication',
    icon: 'fa-comments',
    items: [
      { href: '/chat/admin',                 label: 'Live Support Chat', labelKey: 'admin_nav_item_live_chat',     icon: 'fa-headset',            active: 'chat',                   permission: 'support_view' },
      { href: '/admin/support',              label: 'Support Tickets', labelKey: 'admin_nav_item_support_tickets',       icon: 'fa-life-ring',          active: 'support',                permission: 'support_view' },
      { href: '/admin/notifications',        label: 'Send Notification', labelKey: 'admin_nav_item_send_notification',     icon: 'fa-paper-plane',        active: 'notifications',          permission: 'support_reply' },
      { href: '/admin/notification-templates', label: 'Notification Templates', labelKey: 'admin_nav_item_notification_templates', icon: 'fa-envelope-open-text', active: 'notification-templates', permission: 'settings_edit' },
      { href: '/admin/announcements',        label: 'Announcements', labelKey: 'admin_nav_item_announcements',         icon: 'fa-bell',               active: 'announcements',          permission: 'games_manage' },
      { href: '/admin/news',                 label: 'News', labelKey: 'admin_nav_item_news',                  icon: 'fa-newspaper',          active: 'news',                   permission: 'games_manage' }
    ]
  },
  {
    id: 'security',
    label: 'Security & Risk',
    labelKey: 'admin_nav_security',
    icon: 'fa-shield-halved',
    items: [
      { href: '/admin/security-overview',      label: 'Security Overview', labelKey: 'admin_nav_item_security_overview', icon: 'fa-shield-halved',        active: 'security-overview', permission: 'activity_log_view' },
      { href: '/admin/fraud-monitoring',       label: 'Fraud Monitoring', labelKey: 'admin_nav_item_fraud_monitoring',  icon: 'fa-triangle-exclamation', active: 'fraud-monitoring',  permission: 'bot_monitoring_manage' },
      { href: '/admin/fraud-logs',             label: 'Fraud Logs', labelKey: 'admin_nav_item_fraud_logs',        icon: 'fa-file-shield',          active: 'fraud-logs',        permission: 'bot_monitoring_manage' },
      { href: '/admin/bot-monitoring',         label: 'Bot Monitoring', labelKey: 'admin_nav_item_bot_monitoring',    icon: 'fa-robot',                active: 'bot-monitoring',    permission: 'bot_monitoring_manage' },
      { href: '/admin/bot-monitoring/ip-rules',label: 'IP Rules', labelKey: 'admin_nav_item_ip_rules',          icon: 'fa-network-wired',        active: 'ip-rules',          permission: 'bot_monitoring_manage' },
      { href: '/admin/bot-logs',               label: 'Bot Logs', labelKey: 'admin_nav_item_bot_logs',          icon: 'fa-list-ul',              active: 'bot-logs',          permission: 'bot_monitoring_manage' },
      { href: '/admin/audit-logs',             label: 'Audit Logs', labelKey: 'admin_nav_item_audit_logs',        icon: 'fa-file-contract',        active: 'audit-logs',        permission: 'activity_log_view' }
    ]
  },
  {
    id: 'reports',
    label: 'Reports & Analytics',
    labelKey: 'admin_nav_reports',
    icon: 'fa-chart-bar',
    items: [
      { href: '/admin/reports',  label: 'Reports', labelKey: 'admin_nav_item_reports',    icon: 'fa-file-export',   active: 'reports',  permission: 'reports_view' },
      { href: '/admin/activity', label: 'Activity Log', labelKey: 'admin_nav_item_activity_log', icon: 'fa-list-check', active: 'logs',     permission: 'activity_log_view' },
      { href: '/admin/api-logs', label: 'API Logs', labelKey: 'admin_nav_item_api_logs',   icon: 'fa-code-compare',  active: 'api-logs', permission: 'activity_log_view' }
    ]
  },
  {
    id: 'system',
    label: 'System',
    labelKey: 'admin_nav_system',
    icon: 'fa-gears',
    items: [
      { href: '/admin/features',            label: 'Feature Management', labelKey: 'admin_nav_item_feature_management', icon: 'fa-toggle-on',    active: 'features',            permission: 'settings_edit' },
      { href: '/admin/settings',            label: 'Site Settings', labelKey: 'admin_nav_item_site_settings',      icon: 'fa-cogs',         active: 'settings',            permission: 'settings_view' },
      { href: '/admin/system-settings',     label: 'System Settings', labelKey: 'admin_nav_item_system_settings',    icon: 'fa-sliders',      active: 'system-settings',     permission: 'settings_edit' },
      { href: '/admin/localization',        label: 'Localization', labelKey: 'admin_nav_item_localization',       icon: 'fa-language',     active: 'localization',        permission: 'settings_edit' },
      { href: '/admin/queues',              label: 'Queue Health', labelKey: 'admin_nav_item_queue_health',       icon: 'fa-layer-group',  active: 'queues',              permission: 'cron_jobs_manage' },
      { href: '/admin/cron-jobs',           label: 'Cron Jobs', labelKey: 'admin_nav_item_cron_jobs',          icon: 'fa-clock',        active: 'cron-jobs',           permission: 'cron_jobs_manage' },
      { href: '/admin/cache',               label: 'Cache', labelKey: 'admin_nav_item_cache',              icon: 'fa-bolt',         active: 'cache',               permission: 'settings_edit' },
      { href: '/admin/backups',             label: 'Backups', labelKey: 'admin_nav_item_backups',            icon: 'fa-database',     active: 'backups',             permission: 'backups_manage' },
      { href: '/admin/system-diagnostics',  label: 'System Health', labelKey: 'admin_nav_item_system_health',      icon: 'fa-heart-pulse',  active: 'system-diagnostics',  permission: 'settings_view' },
      { href: '/admin/diagnostics',         label: 'Diagnostics', labelKey: 'admin_nav_item_diagnostics',        icon: 'fa-stethoscope',  active: 'diagnostics',         permission: 'settings_view' },
      { href: '/admin/sentry-status',       label: 'Sentry Status', labelKey: 'admin_nav_item_sentry_status',      icon: 'fa-bug',          active: 'sentry-status',       permission: 'settings_view' },
      { href: '/admin/telegram',            label: 'Telegram', labelKey: 'admin_nav_item_telegram',           icon: 'fa-paper-plane',  active: 'telegram',            permission: 'settings_edit' },
      { href: '/admin/api-keys',            label: 'API Keys', labelKey: 'admin_nav_item_api_keys',           icon: 'fa-key',          active: 'api-keys',            permission: 'settings_edit' }
    ]
  },
  {
    id: 'admin-security',
    label: 'Admin Security',
    labelKey: 'admin_nav_admin_security',
    icon: 'fa-user-shield',
    items: [
      { href: '/admin/roles',        label: 'Roles & Permissions', labelKey: 'admin_nav_item_roles_permissions', icon: 'fa-user-shield',  active: 'roles',        permission: 'roles_manage' },
      { href: '/admin/roles/matrix', label: 'Permission Matrix', labelKey: 'admin_nav_item_permission_matrix',   icon: 'fa-table-cells',  active: 'roles-matrix', permission: 'roles_manage' }
    ]
  }
];

/** সব গ্রুপ মিলিয়ে সমতল আইটেম তালিকা। */
function allItems() {
  return NAV.reduce((acc, g) => acc.concat(g.items), []);
}

/** সব গন্তব্য (href) — টেস্টে "কোনো লিংক হারায়নি" যাচাইয়ের জন্য। */
function allHrefs() {
  return allItems().map(i => i.href);
}

/**
 * অ্যাডমিনের permission অনুযায়ী ফিল্টার করা নেভিগেশন।
 * super_admin (বা backward-compatible role_key=NULL admin) সব দেখেন।
 * খালি হয়ে যাওয়া গ্রুপ বাদ পড়ে — নাহলে শূন্য শিরোনাম পড়ে থাকত।
 */
function navFor(isSuperAdmin, permissions) {
  if (isSuperAdmin) return NAV;
  const perms = permissions || {};
  return NAV
    .map(g => ({ ...g, items: g.items.filter(i => !i.permission || perms[i.permission] === true) }))
    .filter(g => g.items.length > 0);
}

/** কোন গ্রুপে একটা active key আছে — ওই গ্রুপটা ডিফল্টে খোলা রাখার জন্য। */
function groupForActive(activeKey) {
  const g = NAV.find(group => group.items.some(i => i.active === activeKey));
  return g ? g.id : null;
}

module.exports = { NAV, allItems, allHrefs, navFor, groupForActive };
