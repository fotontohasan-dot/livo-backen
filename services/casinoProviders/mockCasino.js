// services/casinoProviders/mockCasino.js
// ---------------------------------------------------------------------------
// পরীক্ষামূলক (mock) অ্যাডাপ্টার — কোনো বাস্তব প্রোভাইডার নয়।
//
// কেন এটা রিপোতে আছে: পুরো "credential বসালেই গেম ভেসে ওঠে" দাবিটা আসল
// প্রোভাইডার ছাড়া যাচাই করার আর কোনো উপায় নেই। এটা দিয়ে
// PROVIDER_MOCK_CASINO_* বসিয়ে বুট করলেই sync চলে, গেম DB-তে ঢোকে, লবিতে
// দেখা যায় — অর্থাৎ পুরো পাইপলাইনটা এন্ড-টু-এন্ড প্রমাণ হয়ে যায়।
//
// এটা কোনো নেটওয়ার্ক কল করে না এবং কোনো আসল টাকার ফ্লো তৈরি করে না।
// credential না থাকলে isEnabled() মিথ্যা — অর্থাৎ প্রোডাকশনে env সেট না
// করলে এটা অস্তিত্বহীনই থাকে।
// ---------------------------------------------------------------------------

const { normalizeAll } = require('./normalizedGame');

const NAME = 'mock-casino';
const ENV_PREFIX = 'PROVIDER_MOCK_CASINO_';

function env(suffix) {
  return process.env[ENV_PREFIX + suffix] || '';
}

// লবির ক্যাটাগরি ট্যাব DISTINCT(category) থেকে আসে, তাই একাধিক ক্যাটাগরি
// থাকলে ট্যাব-রেন্ডারিংও যাচাই হয়ে যায়।
const CATEGORIES = ['slots', 'live', 'table', 'crash'];

/** কতগুলো গেম তৈরি হবে — env দিয়ে নিয়ন্ত্রিত, ডিফল্ট ২৪। */
function gameCount() {
  const n = parseInt(env('GAME_COUNT'), 10);
  return Number.isFinite(n) && n > 0 && n <= 500 ? n : 24;
}

module.exports = {
  name: NAME,

  isEnabled() {
    // আসল অ্যাডাপ্টারের মতোই — শুধু credential-এর উপস্থিতি দেখে।
    return !!(env('API_URL') && env('AGENT_ID') && env('SECRET'));
  },

  async fetchGames() {
    const total = gameCount();
    const raw = [];
    for (let i = 1; i <= total; i++) {
      const category = CATEGORIES[i % CATEGORIES.length];
      raw.push({
        providerGameId: `mock-${String(i).padStart(3, '0')}`,
        name: `Mock ${category} ${i}`,
        category,
        subCategory: null,
        thumbnailUrl: null, // sync worker ফলব্যাক প্লেসহোল্ডার ব্যবহার করবে
        rtp: 96 + (i % 4) * 0.5,
        hasDemo: i % 2 === 0,
        isMobile: true,
        isActive: true,
        raw: { source: 'mock-adapter' }
      });
    }
    return normalizeAll(raw);
  },

  async getLaunchUrl(user, game, opts = {}) {
    // বাস্তব গেম নয় — একটা স্থির প্লেসহোল্ডার পেজে পাঠানো হয়, যাতে iframe
    // কন্টেইনার ও session টোকেনের ফ্লো পরীক্ষা করা যায়।
    const params = new URLSearchParams({
      game: game.provider_game_id || '',
      token: opts.sessionToken || '',
      mode: opts.mode || 'real'
    });
    return { url: `${env('API_URL')}/launch?${params.toString()}`, method: 'GET' };
  },

  verifySignature(req) {
    const signature = require('../wallet/signature');
    const r = signature.verify({
      provider: NAME,
      timestamp: req.get('x-timestamp') || (req.body && req.body.timestamp),
      signature: req.get('x-signature') || (req.body && req.body.signature),
      rawBody: req.rawBody || '',
      secret: env('SECRET')
    });
    return r.ok;
  },

  parseWalletRequest(req) {
    const b = req.body || {};
    return {
      txId: b.tx_id || b.transaction_id || null,
      roundId: b.round_id || null,
      referenceTxId: b.reference_tx_id || null,
      sessionToken: b.token || b.session_token || null,
      userId: b.user_id || null,
      gameId: b.game_id || null,
      amount: b.amount,
      currency: b.currency || 'BDT'
    };
  },

  formatWalletResponse(result) {
    return { success: true, ...result };
  },

  formatError(code) {
    return { success: false, error: code };
  }
};
