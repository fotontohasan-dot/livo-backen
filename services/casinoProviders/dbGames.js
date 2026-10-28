// services/casinoProviders/dbGames.js
// ---------------------------------------------------------------------------
// DB গেমস (ক্লায়েন্ট: "DB 260908 Livo") অ্যাডাপ্টার।
//
// ⚠️ অবস্থা: SCAFFOLD — DB-এর API ডকুমেন্টেশন এখনো হাতে আসেনি। যেসব জায়গা
//    ডকুমেন্টেশন দেখে নিশ্চিত করতে হবে সেগুলো "TODO(DB-DOC)" দিয়ে চিহ্নিত।
//    endpoint পাথ, স্বাক্ষর অ্যালগরিদম ও ফিল্ডের নাম এখানে অনুমান — আসল নয়।
//
// ক্রেডেনশিয়াল (কোডে নয়, শুধু .env-এ):
//   PROVIDER_DB_GAMES_API_URL     তাদের API বেস URL
//   PROVIDER_DB_GAMES_AGENT_ID    Ordinary Merchant code (9JENAA এজেন্ট কোড নয়!)
//   PROVIDER_DB_GAMES_SECRET      Ordinary Merchant ব্যাকএন্ডের Secret Key
//   PROVIDER_DB_GAMES_IPS         তাদের সার্ভারের IP (কলব্যাক allow-list)
//   PROVIDER_DB_GAMES_CURRENCY    CNY বা LGC (ডিফল্ট LGC)
//   PROVIDER_DB_GAMES_BDT_RATE    ১ BDT = কত CNY/LGC (ডিফল্ট 0.06 — আসল রেট বসান)
//
// সবগুলো না বসানো পর্যন্ত isEnabled() মিথ্যা, তাই এটা রেজিস্ট্রিতে থাকলেও
// কিছুই চালু হয় না।
// ---------------------------------------------------------------------------

const crypto = require('crypto');
const { fetchWithTimeout } = require('../../utils/httpClient');
const { normalizeAll } = require('./normalizedGame');

const NAME = 'db-games';

function env(suffix) {
  return process.env[`PROVIDER_${NAME.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${suffix}`] || '';
}

function currency() {
  const c = String(env('CURRENCY') || 'LGC').toUpperCase();
  return c === 'CNY' ? 'CNY' : 'LGC';
}

function bdtRate() {
  const r = parseFloat(env('BDT_RATE'));
  return Number.isFinite(r) && r > 0 ? r : 0.06;
}

/** আমাদের BDT → প্রোভাইডারের কারেন্সি (২ দশমিক)। */
function toProviderAmount(bdt) {
  return Math.round(Number(bdt) * bdtRate() * 100) / 100;
}

/** প্রোভাইডারের কারেন্সি → BDT (২ দশমিক)। */
function fromProviderAmount(amount) {
  return Math.round((Number(amount) / bdtRate()) * 100) / 100;
}

/**
 * TODO(DB-DOC): স্বাক্ষরের আসল নিয়ম ডকুমেন্টেশন থেকে মেলান।
 * এখন: HMAC-SHA256(secret, sorted "k=v&k=v" + merchant code) হেক্স।
 */
function sign(params) {
  const base = Object.keys(params)
    .filter(k => k !== 'sign' && params[k] !== undefined && params[k] !== '')
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('&');
  return crypto.createHmac('sha256', env('SECRET')).update(base).digest('hex');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = {
  name: NAME,

  // দুটো সেট key-র একটা ব্যবহার হয়; অন্যটা ব্যাকআপ — বদলাতে শুধু SECRET বদলান।
  isEnabled() {
    return !!(env('API_URL') && env('AGENT_ID') && env('SECRET'));
  },

  /** TODO(DB-DOC): গেম লিস্ট endpoint ও রেসপন্স ফিল্ড নিশ্চিত করুন। */
  async fetchGames() {
    const params = { merchant: env('AGENT_ID'), timestamp: Date.now() };
    params.sign = sign(params);
    const res = await fetchWithTimeout(`${env('API_URL')}/game/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    if (!res.ok) throw new Error(`${NAME} fetchGames HTTP ${res.status}`);
    const data = await res.json();
    const list = (data && (data.data || data.games)) || [];
    return normalizeAll(list.map(g => ({
      providerGameId: String(g.gameId || g.game_code || g.id),
      name: g.gameName || g.name,
      category: g.category || 'casino',
      subCategory: g.subCategory || null,
      thumbnailUrl: g.image || g.icon || null,
      rtp: g.rtp || null,
      hasDemo: !!g.demo,
      isMobile: g.mobile !== false,
      isActive: g.status === undefined ? true : (g.status === 1 || g.status === 'active'),
      raw: g
    })));
  },

  /** TODO(DB-DOC): লঞ্চ endpoint (সার্ভার-কল নাকি সরাসরি URL) নিশ্চিত করুন। */
  async getLaunchUrl(user, game, opts = {}) {
    const params = {
      merchant: env('AGENT_ID'),
      gameId: game.provider_game_id,
      token: opts.sessionToken,
      lang: opts.lang || 'en',
      currency: currency(),
      returnUrl: opts.returnUrl || '',
      timestamp: Date.now()
    };
    params.sign = sign(params);
    return { url: `${env('API_URL')}/game/launch?${new URLSearchParams(params).toString()}`, method: 'GET' };
  },

  /** TODO(DB-DOC): কলব্যাকে স্বাক্ষর কোন ফিল্ড/হেডারে আসে নিশ্চিত করুন। */
  verifySignature(req) {
    if (!env('SECRET')) return false;
    const body = req.body || {};
    const given = body.sign || req.get('x-signature');
    if (!given) return false;
    return safeEqual(sign(body), given);
  },

  parseWalletRequest(req) {
    const b = req.body || {};
    return {
      txId: b.transactionId || b.txId,
      roundId: b.roundId,
      referenceTxId: b.refTransactionId || null,
      sessionToken: b.token,
      userId: null,
      gameId: b.gameId,
      amount: fromProviderAmount(b.amount || 0), // কোর লেয়ার BDT বোঝে
      currency: 'BDT'
    };
  },

  formatWalletResponse(result) {
    return {
      code: 0,
      balance: toProviderAmount(result.balance),
      currency: currency(),
      transactionId: result.transaction_id
    };
  },

  formatError(code) {
    const MAP = { INSUFFICIENT_FUNDS: 1001, USER_NOT_FOUND: 1002, SESSION_INVALID: 1003, INVALID_AMOUNT: 1004, TX_NOT_FOUND: 1005 };
    return { code: MAP[code] || 1999, message: code };
  },

  // টেস্টের জন্য
  _internal: { sign, toProviderAmount, fromProviderAmount }
};
