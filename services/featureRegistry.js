// services/featureRegistry.js
// ---------------------------------------------------------------------------
// কেন্দ্রীয় ফিচার রেজিস্ট্রি — Feature Management-এর একমাত্র সত্যের উৎস।
//
// এখানে শুধু সেইসব key আছে যেগুলোর পেছনে এই রিপোতে সত্যিকারের রুট/সার্ভিস আছে।
// কাল্পনিক key (live_casino, live_streaming ইত্যাদি — যেগুলোর কোনো বাস্তবায়ন নেই)
// ইচ্ছাকৃতভাবে বাদ দেওয়া হয়েছে: বন্ধ করলে কিছুই হয় না এমন টগল অ্যাডমিনকে
// মিথ্যা নিয়ন্ত্রণের অনুভূতি দেয়।
//
// প্রতিটা এন্ট্রির enforcement কলাম কোথায় গেট বসানো আছে সেটা নথিবদ্ধ করে —
// tests/unit/featureFlags.test.js এটাকে বাস্তব রুটের সাথে মিলিয়ে দেখে।
//
// নতুন ফিচার যোগ করার নিয়ম:
//   ১. এখানে একটা এন্ট্রি যোগ করুন (key, label, description, category)।
//   ২. সংশ্লিষ্ট রুটে requireFeature('key') বসান।
//   ৩. migrations.js এমনিতেই seed করে নেবে (ON CONFLICT DO NOTHING)।
// ---------------------------------------------------------------------------

// Feature Management UI-তে দেখানো গ্রুপ। VALID_CATEGORIES-এর সাথে মিলতে হবে।
const CATEGORIES = {
  gaming:        { label: 'Gaming', labelKey: 'admin_ff_cat_gaming',        order: 1 },
  sports:        { label: 'Sports', labelKey: 'admin_ff_cat_sports',        order: 2 },
  wallet:        { label: 'Wallet', labelKey: 'admin_ff_cat_wallet',        order: 3 },
  rewards:       { label: 'Rewards', labelKey: 'admin_ff_cat_rewards',       order: 4 },
  communication: { label: 'Communication', labelKey: 'admin_ff_cat_communication', order: 5 },
  // পুরনো (pre-existing) ক্যাটাগরিগুলো — ইতিমধ্যে DB-তে থাকা ফ্ল্যাগগুলোর জন্য
  // ধরে রাখা হয়েছে, নাহলে সেগুলো UI থেকে হারিয়ে যেত।
  feature:       { label: 'General', labelKey: 'admin_ff_cat_feature',       order: 6 },
  maintenance:   { label: 'Maintenance', labelKey: 'admin_ff_cat_maintenance',   order: 7 },
  beta:          { label: 'Beta', labelKey: 'admin_ff_cat_beta',          order: 8 },
  security:      { label: 'Security', labelKey: 'admin_ff_cat_security',      order: 9 },
  api:           { label: 'API', labelKey: 'admin_ff_cat_api',           order: 10 }
};

const FEATURES = [
  // ---------------- Gaming ----------------
  {
    key: 'games', label: 'Casino Games', labelKey: 'admin_ff_name_games', descriptionKey: 'admin_ff_desc_games', category: 'gaming', icon: 'fa-dice', order: 10,
    defaultEnabled: true,
    description: 'ক্যাসিনো/ইনস্ট্যান্ট গেমস — গেম তালিকা, রাউন্ড খেলা ও ক্যাশআউট',
    enforcement: ['routes/games.js']
  },

  // ---------------- Sports ----------------
  {
    key: 'sports', label: 'Sports', labelKey: 'admin_ff_name_sports', descriptionKey: 'admin_ff_desc_sports', category: 'sports', icon: 'fa-futbol', order: 20,
    defaultEnabled: true,
    description: 'স্পোর্টস সেকশন — ম্যাচ তালিকা, ক্রিকেট/ফুটবল/টেনিস পেজ',
    enforcement: ['routes/sports.js', 'routes/matches.js']
  },
  {
    key: 'sports_betting', label: 'Sports Betting', labelKey: 'admin_ff_name_sports_betting', descriptionKey: 'admin_ff_desc_sports_betting', category: 'sports', icon: 'fa-ticket', order: 21,
    defaultEnabled: true,
    description: 'ম্যাচে বাজি ধরা (POST /matches/:id/bet)। বন্ধ থাকলে ম্যাচ দেখা যাবে, বাজি ধরা যাবে না',
    enforcement: ['routes/matches.js']
  },
  {
    key: 'accumulator', label: 'Accumulator', labelKey: 'admin_ff_name_accumulator', descriptionKey: 'admin_ff_desc_accumulator', category: 'sports', icon: 'fa-layer-group', order: 22,
    defaultEnabled: true,
    description: 'একাধিক নির্বাচন মিলিয়ে অ্যাকুমুলেটর বাজি',
    enforcement: ['routes/accumulator.js']
  },
  {
    key: 'tournaments', label: 'Tournaments', labelKey: 'admin_ff_name_tournaments', descriptionKey: 'admin_ff_desc_tournaments', category: 'sports', icon: 'fa-trophy', order: 23,
    defaultEnabled: true,
    description: 'টুর্নামেন্ট তালিকা, বিস্তারিত ও জয়েন করা',
    enforcement: ['routes/tournaments.js']
  },

  // ---------------- Wallet ----------------
  {
    key: 'deposit', label: 'Deposit', labelKey: 'admin_ff_name_deposit', descriptionKey: 'admin_ff_desc_deposit', category: 'wallet', icon: 'fa-arrow-down', order: 30,
    defaultEnabled: true,
    description: 'ইউজারের ডিপোজিট রিকোয়েস্ট ও পেমেন্ট গেটওয়ে ইনিশিয়েশন',
    enforcement: ['routes/payment.js']
  },
  {
    key: 'withdrawal', label: 'Withdrawal', labelKey: 'admin_ff_name_withdrawal', descriptionKey: 'admin_ff_desc_withdrawal', category: 'wallet', icon: 'fa-arrow-up', order: 31,
    defaultEnabled: true,
    description: 'ইউজারের উইথড্র রিকোয়েস্ট। বন্ধ থাকলে অ্যাডমিন পুরনো রিকোয়েস্ট প্রসেস করতে পারবেন',
    enforcement: ['routes/payment.js']
  },

  // ---------------- Rewards ----------------
  {
    key: 'vip', label: 'VIP', labelKey: 'admin_ff_name_vip', descriptionKey: 'admin_ff_desc_vip', category: 'rewards', icon: 'fa-crown', order: 40,
    defaultEnabled: true,
    description: 'VIP লেভেল পেজ ও প্রোগ্রেস API',
    enforcement: ['routes/profile.js']
  },
  {
    key: 'cashback', label: 'Cashback', labelKey: 'admin_ff_name_cashback', descriptionKey: 'admin_ff_desc_cashback', category: 'rewards', icon: 'fa-rotate-left', order: 41,
    defaultEnabled: true,
    description: 'ক্যাশব্যাক পেজ ও ক্লেইম',
    enforcement: ['routes/profile.js']
  },
  {
    key: 'referral', label: 'Referral', labelKey: 'admin_ff_name_referral', descriptionKey: 'admin_ff_desc_referral', category: 'rewards', icon: 'fa-user-group', order: 42,
    defaultEnabled: true,
    description: 'রেফারেল পেজ ও ইনভাইটেশন',
    enforcement: ['routes/profile.js', 'routes/extra.js']
  },
  {
    key: 'missions', label: 'Missions', labelKey: 'admin_ff_name_missions', descriptionKey: 'admin_ff_desc_missions', category: 'rewards', icon: 'fa-list-check', order: 43,
    defaultEnabled: true,
    description: 'ডেইলি/উইকলি মিশন ও ক্লেইম',
    enforcement: ['routes/profile.js']
  },
  {
    key: 'lucky_wheel', label: 'Lucky Wheel', labelKey: 'admin_ff_name_lucky_wheel', descriptionKey: 'admin_ff_desc_lucky_wheel', category: 'rewards', icon: 'fa-compact-disc', order: 44,
    defaultEnabled: true,
    description: 'লাকি হুইল পেজ, স্পিন ও ফলাফল',
    enforcement: ['routes/profile.js']
  },
  {
    key: 'daily_rewards', label: 'Daily Rewards', labelKey: 'admin_ff_name_daily_rewards', descriptionKey: 'admin_ff_desc_daily_rewards', category: 'rewards', icon: 'fa-gift', order: 45,
    defaultEnabled: true,
    description: 'দৈনিক রিওয়ার্ড, লাল প্যাকেট ও সোনার ডিম',
    enforcement: ['routes/profile.js', 'routes/coins.js']
  },
  {
    key: 'free_bet', label: 'Free Bet', labelKey: 'admin_ff_name_free_bet', descriptionKey: 'admin_ff_desc_free_bet', category: 'rewards', icon: 'fa-hand-holding-dollar', order: 46,
    defaultEnabled: true,
    description: 'ফ্রি বেট ক্লেইম। বন্ধ থাকলেও অ্যাডমিন গ্রান্ট করতে পারবেন',
    enforcement: ['routes/profile.js']
  },
  {
    key: 'leaderboard', label: 'Leaderboard', labelKey: 'admin_ff_name_leaderboard', descriptionKey: 'admin_ff_desc_leaderboard', category: 'rewards', icon: 'fa-ranking-star', order: 47,
    defaultEnabled: true,
    description: 'পাবলিক লিডারবোর্ড',
    enforcement: ['routes/leaderboard.js']
  },
  {
    key: 'promotions', label: 'Promotions', labelKey: 'admin_ff_name_promotions', descriptionKey: 'admin_ff_desc_promotions', category: 'rewards', icon: 'fa-bullhorn', order: 48,
    defaultEnabled: true,
    description: 'প্রমোশন পেজ ও ব্যানার',
    enforcement: ['routes/extra.js']
  },

  // ---------------- Communication ----------------
  {
    key: 'live_chat', label: 'Live Support Chat', labelKey: 'admin_ff_name_live_chat', descriptionKey: 'admin_ff_desc_live_chat', category: 'communication', icon: 'fa-headset', order: 50,
    defaultEnabled: true,
    description: 'ইউজারের লাইভ সাপোর্ট চ্যাট। বন্ধ থাকলেও অ্যাডমিন চ্যাট কনসোল খোলা থাকে',
    enforcement: ['routes/chat.js']
  },
  {
    key: 'ai_chatbot', label: 'AI Chatbot', labelKey: 'admin_ff_name_ai_chatbot', descriptionKey: 'admin_ff_desc_ai_chatbot', category: 'communication', icon: 'fa-robot', order: 51,
    defaultEnabled: true,
    description: 'হেল্প সেন্টারের স্বয়ংক্রিয় বট রিপ্লাই',
    enforcement: ['routes/help-center.js']
  },
  {
    key: 'news', label: 'News', labelKey: 'admin_ff_name_news', descriptionKey: 'admin_ff_desc_news', category: 'communication', icon: 'fa-newspaper', order: 52,
    defaultEnabled: true,
    description: 'নিউজ তালিকা ও বিস্তারিত পেজ',
    enforcement: ['routes/news.js']
  },
  {
    key: 'notifications', label: 'Notifications', labelKey: 'admin_ff_name_notifications', descriptionKey: 'admin_ff_desc_notifications', category: 'communication', icon: 'fa-bell', order: 53,
    defaultEnabled: true,
    description: 'ইউজারের নোটিফিকেশন সেন্টার',
    enforcement: ['routes/notifications.js']
  }
];

const BY_KEY = new Map(FEATURES.map(f => [f.key, f]));

/** রেজিস্ট্রিতে সংজ্ঞায়িত key কিনা — অজানা key দিয়ে গেট বসানো ঠেকাতে। */
function isKnownKey(key) {
  return BY_KEY.has(key);
}

function get(key) {
  return BY_KEY.get(key) || null;
}

/**
 * ডিফল্ট অবস্থা। DB-তে রেকর্ড না থাকলে (যেমন seed চলার আগে, বা কেউ সারি মুছে
 * ফেললে) এই মানটাই ব্যবহৃত হয়। সব ফিচারের ডিফল্ট true — অর্থাৎ ফ্ল্যাগ
 * সিস্টেম ব্যর্থ হলে সাইট আগের মতোই চলবে, হঠাৎ সব ফিচার বন্ধ হয়ে যাবে না।
 */
function defaultFor(key) {
  const f = BY_KEY.get(key);
  return f ? f.defaultEnabled !== false : false;
}

function categoryOrder(category) {
  return (CATEGORIES[category] && CATEGORIES[category].order) || 99;
}

function categoryLabel(category) {
  return (CATEGORIES[category] && CATEGORIES[category].label) || category;
}

/** ক্যাটাগরির i18n key — টেমপ্লেটে t() দিয়ে অনুবাদের জন্য। */
function categoryLabelKey(category) {
  return (CATEGORIES[category] && CATEGORIES[category].labelKey) || null;
}

module.exports = {
  FEATURES,
  CATEGORIES,
  categoryLabelKey,
  isKnownKey,
  get,
  defaultFor,
  categoryOrder,
  categoryLabel,
  keys: () => FEATURES.map(f => f.key)
};
