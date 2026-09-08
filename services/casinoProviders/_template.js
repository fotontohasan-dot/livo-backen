// services/casinoProviders/_template.js
// ---------------------------------------------------------------------------
// নতুন ক্যাসিনো অ্যাডাপ্টার লেখার টেমপ্লেট। এই ফাইলটা নিজে কখনো রেজিস্ট্রিতে
// যোগ করা হয় না — কপি করে নতুন নামে সংরক্ষণ করুন।
//
// নতুন প্রোভাইডার যোগ করার সম্পূর্ণ ধাপ (কোর অ্যাপে কোনো পরিবর্তন লাগে না):
//   ১. এই ফাইল কপি করে services/casinoProviders/<name>.js বানান।
//   ২. services/casinoProviders/index.js-এর ADAPTERS অ্যারেতে একটা লাইন যোগ করুন।
//   ৩. অ্যাডাপ্টারের ইউনিট টেস্ট লিখুন (নেটওয়ার্ক ছাড়া — normalize দিয়ে)।
//   ৪. .env-এ PROVIDER_<NAME>_* ভেরিয়েবল বসান।
//   ৫. ডিপ্লয়। বুট-sync চলে, গেম লবিতে চলে আসে।
//
// ⚠️ কোনো credential, API key, agent id বা secret এখানে হার্ডকোড করবেন না।
//    সবকিছু process.env থেকে; isEnabled() শুধু সেগুলোর উপস্থিতিই দেখে।
// ---------------------------------------------------------------------------

const { normalizeAll } = require('./normalizedGame');

// অ্যাডাপ্টারের নাম = games.provider কলামে যা লেখা হবে, এবং env key-র ভিত্তি।
// হাইফেন থাকলে env-এ আন্ডারস্কোর হয়: "my-provider" → PROVIDER_MY_PROVIDER_SECRET
const NAME = 'template-provider';

function env(suffix) {
  return process.env[`PROVIDER_${NAME.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${suffix}`] || '';
}

module.exports = {
  name: NAME,

  /**
   * প্রোভাইডারটা কনফিগার করা আছে কি না — শুধু এটাই দেখা হয়।
   * এই ফাংশন সত্য হওয়া মানেই বুট-sync তার গেম আনার চেষ্টা করবে।
   */
  isEnabled() {
    return !!(env('API_URL') && env('AGENT_ID') && env('SECRET'));
  },

  /**
   * প্রোভাইডারের গেম ক্যাটালগ → normalizedGame[]।
   * থ্রো করলে sync worker সেটা ধরে provider_sync_log-এ failed হিসেবে লেখে;
   * আগের sync করা গেমগুলো অক্ষত থাকে (মুছে যায় না)।
   */
  async fetchGames() {
    const res = await fetch(`${env('API_URL')}/games`, {
      method: 'GET',
      headers: { 'X-Agent-Id': env('AGENT_ID') }
    });
    if (!res.ok) throw new Error(`${NAME} fetchGames HTTP ${res.status}`);
    const data = await res.json();

    return normalizeAll((data.games || []).map(g => ({
      providerGameId: g.game_code,
      name: g.game_name,
      category: g.category,
      subCategory: g.sub_category,
      thumbnailUrl: g.image_url,
      rtp: g.rtp,
      hasDemo: g.demo_supported,
      isMobile: g.mobile_supported,
      isActive: g.status === 'active',
      raw: g
    })));
  },

  /**
   * গেম লঞ্চ URL। `game` হলো games টেবিলের সারি, `opts` হলো
   * { sessionToken, mode, lang, returnUrl, ip }।
   * @returns {{ url: string, method: 'GET'|'POST' }}
   */
  async getLaunchUrl(user, game, opts = {}) {
    const params = new URLSearchParams({
      agent_id: env('AGENT_ID'),
      game_code: game.provider_game_id,
      token: opts.sessionToken,
      mode: opts.mode || 'real',
      lang: opts.lang || 'en'
    });
    return { url: `${env('API_URL')}/launch?${params.toString()}`, method: 'GET' };
  },

  /**
   * ওয়ালেট কলব্যাকের স্বাক্ষর যাচাই। services/wallet/signature.js-এর
   * হেল্পারগুলো ব্যবহার করুন — বিশেষ করে timingSafeEqual তুলনা ও
   * timestamp উইন্ডো, দুটোই বাধ্যতামূলক।
   */
  verifySignature(req) {
    const signature = require('../wallet/signature');
    const r = signature.verify({
      provider: NAME,
      timestamp: req.get('x-timestamp'),
      signature: req.get('x-signature'),
      rawBody: req.rawBody || '',
      secret: env('SECRET')
    });
    return r.ok;
  },

  /** প্রোভাইডারের কলব্যাক বডি → কোর ওয়ালেট লেয়ারের সাধারণ আকার। */
  parseWalletRequest(req) {
    const b = req.body || {};
    return {
      txId: b.transaction_id,
      roundId: b.round_id,
      referenceTxId: b.original_transaction_id,
      sessionToken: b.token,
      userId: null,
      gameId: b.game_code,
      amount: b.amount,
      currency: b.currency || 'BDT'
    };
  },

  /** কোর ফলাফল → প্রোভাইডারের প্রত্যাশিত JSON। */
  formatWalletResponse(result) {
    return {
      status: 0,
      balance: result.balance,
      currency: result.currency,
      transaction_id: result.transaction_id
    };
  },

  /** কোর error code → প্রোভাইডারের নিজস্ব error format। */
  formatError(code) {
    const MAP = {
      INSUFFICIENT_FUNDS: 1001,
      USER_NOT_FOUND: 1002,
      SESSION_INVALID: 1003,
      INVALID_AMOUNT: 1004,
      TX_NOT_FOUND: 1005
    };
    return { status: MAP[code] || 1999, message: code };
  }
};
