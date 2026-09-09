// services/casinoGameSync.js
// ---------------------------------------------------------------------------
// প্রোভাইডার গেম ক্যাটালগ sync — "credential বসালেই গেম ভেসে ওঠে"-র ইঞ্জিন।
//
// পুরো মেকানিজমটা এইটুকুই:
//   .env-এ credential → অ্যাডাপ্টারের isEnabled() সত্য হয় → sync চলে →
//   গেম games টেবিলে ঢোকে → লবি DB থেকে পড়ে → গেম দেখা যায় ও খেলা যায়।
// কোনো ধাপেই কোড পরিবর্তন লাগে না।
//
// তিনভাবে ট্রিগার হয়:
//   ১. বুটে      — app.js (নতুন enabled প্রোভাইডার থাকলে সাথে সাথে)
//   ২. Cron      — services/scheduler.js-এর casino_game_sync জব
//   ৩. ম্যানুয়াল — অ্যাডমিন প্যানেলের "Sync Now" বোতাম
//
// সতর্কভাবে নেওয়া কয়েকটা সিদ্ধান্ত:
//
//   • এবারের sync-এ যে গেম আসেনি সেটা **ডিলিট নয়, is_active = false**।
//     ওই গেমের ঐতিহাসিক bet/provider_transactions সারি রয়ে গেছে; row মুছে
//     ফেললে রিপোর্টে অনাথ রেফারেন্স তৈরি হতো।
//
//   • admin_disabled কলাম sync কখনো লেখে না। অ্যাডমিন একটা গেম বন্ধ করলে
//     পরের sync সেটা আবার চালু করে দিলে অ্যাডমিনের সিদ্ধান্তের কোনো মূল্যই
//     থাকত না — তাই UPSERT-এর DO UPDATE তালিকায় ওটা ইচ্ছাকৃতভাবে নেই।
//
//   • একটা প্রোভাইডার ব্যর্থ হলে বাকিদের sync থামে না; প্রতিটার নিজস্ব
//     provider_sync_log সারি থাকে।
// ---------------------------------------------------------------------------

const { pool } = require('../db');
const registry = require('./casinoProviders');

// games.slug কলামটা UNIQUE NOT NULL এবং লেগেসি কোড/অ্যাডমিন UI এখনো এটা
// ব্যবহার করে। প্রোভাইডার গেমের জন্য slug = "<provider>:<providerGameId>" —
// দুই প্রোভাইডারে একই game id থাকলেও সংঘর্ষ হয় না।
function slugFor(provider, providerGameId) {
  return `${provider}:${providerGameId}`;
}

/**
 * থাম্বনেইল Cloudinary-তে তুলে CDN URL ফেরত দেয়।
 *
 * কেন প্রোভাইডারের URL সরাসরি ব্যবহার না: তাদের ছবি-হোস্ট প্রায়ই ধীর,
 * hotlink-ব্লকড, বা মেয়াদি টোকেনসহ আসে — লবিতে ভাঙা ছবি দেখা যেত।
 *
 * Cloudinary কনফিগার করা না থাকলে বা আপলোড ব্যর্থ হলে মূল URL-ই রাখা হয়:
 * ছবির জন্য পুরো গেম sync ব্যর্থ হওয়া অযৌক্তিক।
 */
async function uploadThumbnail(sourceUrl, publicId) {
  if (!sourceUrl) return null;
  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY) return sourceUrl;
  try {
    const cloudinary = require('cloudinary').v2;
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET
    });
    const res = await cloudinary.uploader.upload(sourceUrl, {
      folder: 'livo/games',
      public_id: publicId,
      overwrite: false,
      resource_type: 'image'
    });
    return res.secure_url || sourceUrl;
  } catch (e) {
    console.error(`[casinoSync] থাম্বনেইল আপলোড ব্যর্থ (${publicId}):`, e.message);
    return sourceUrl;
  }
}

/** একটা প্রোভাইডারের সব গেম UPSERT করে; ফলাফলের গণনা ফেরত দেয়। */
async function syncProvider(adapter) {
  const started = await pool.query(
    `INSERT INTO provider_sync_log (provider, status) VALUES ($1, 'running') RETURNING id`,
    [adapter.name]
  );
  const logId = started.rows[0].id;

  let added = 0, updated = 0, removed = 0;
  try {
    const games = await adapter.fetchGames();
    if (!Array.isArray(games)) throw new Error('fetchGames() অ্যারে ফেরত দেয়নি');

    const seenIds = [];
    for (const g of games) {
      seenIds.push(g.providerGameId);
      const thumb = await uploadThumbnail(g.thumbnailUrl, slugFor(adapter.name, g.providerGameId).replace(/[^a-zA-Z0-9_-]/g, '_'));

      // ON CONFLICT (provider, provider_game_id) — নতুন হলে INSERT, থাকলে
      // তথ্য হালনাগাদ। xmax = 0 দিয়ে বোঝা যায় সারিটা নতুন ছিল কি না।
      const r = await pool.query(
        `INSERT INTO games
           (slug, name, category, sub_category, provider, provider_game_id, thumbnail_url,
            rtp, has_demo, is_mobile, is_active, last_synced_at, raw_meta)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),$12)
         ON CONFLICT (provider, provider_game_id) DO UPDATE SET
           name           = EXCLUDED.name,
           category       = EXCLUDED.category,
           sub_category   = EXCLUDED.sub_category,
           thumbnail_url  = COALESCE(EXCLUDED.thumbnail_url, games.thumbnail_url),
           rtp            = EXCLUDED.rtp,
           has_demo       = EXCLUDED.has_demo,
           is_mobile      = EXCLUDED.is_mobile,
           is_active      = EXCLUDED.is_active,
           last_synced_at = NOW(),
           raw_meta       = EXCLUDED.raw_meta
         RETURNING (xmax = 0) AS inserted`,
        [
          slugFor(adapter.name, g.providerGameId), g.name, g.category, g.subCategory,
          adapter.name, g.providerGameId, thumb, g.rtp, g.hasDemo, g.isMobile, g.isActive,
          g.raw ? JSON.stringify(g.raw) : null
        ]
      );
      if (r.rows[0].inserted) added++; else updated++;
    }

    // এবার আসেনি এমন গেম নিষ্ক্রিয় — মোছা নয়।
    const deactivated = await pool.query(
      `UPDATE games SET is_active = false
        WHERE provider = $1 AND is_active = true AND NOT (provider_game_id = ANY($2::text[]))`,
      [adapter.name, seenIds]
    );
    removed = deactivated.rowCount;

    await pool.query(
      `UPDATE provider_sync_log
          SET finished_at = NOW(), status = 'success',
              games_added = $2, games_updated = $3, games_removed = $4
        WHERE id = $1`,
      [logId, added, updated, removed]
    );
    console.log(`✅ [casinoSync] ${adapter.name}: +${added} নতুন, ${updated} হালনাগাদ, ${removed} নিষ্ক্রিয়`);
    return { provider: adapter.name, status: 'success', added, updated, removed };
  } catch (err) {
    await pool.query(
      `UPDATE provider_sync_log
          SET finished_at = NOW(), status = 'failed', error_message = $2,
              games_added = $3, games_updated = $4
        WHERE id = $1`,
      [logId, String(err.message).slice(0, 1000), added, updated]
    );
    console.error(`❌ [casinoSync] ${adapter.name} ব্যর্থ:`, err.message);
    return { provider: adapter.name, status: 'failed', error: err.message, added, updated, removed };
  }
}

/**
 * সব সক্রিয় প্রোভাইডার sync করে।
 * @param {string} [only] শুধু একটা প্রোভাইডার (অ্যাডমিনের "Sync Now")
 */
async function syncAll(only) {
  let adapters = registry.getEnabledProviders();
  if (only) adapters = adapters.filter(a => a.name === only);

  if (!adapters.length) {
    console.log('[casinoSync] কোনো প্রোভাইডার কনফিগার করা নেই — কিছু করা হয়নি');
    return { skipped: true, results: [] };
  }

  const results = [];
  for (const adapter of adapters) {
    results.push(await syncProvider(adapter));
  }
  return { skipped: false, results };
}

/**
 * বুট-টাইম sync। উদ্দেশ্য: একটা নতুন প্রোভাইডারের credential যোগ করে ডিপ্লয়
 * করলে অ্যাডমিনকে কিছু না করেই গেম চলে আসবে।
 *
 * ইচ্ছাকৃতভাবে await করা হয় না এবং কখনো throw করে না — sync-এর জন্য সার্ভার
 * বুট আটকে থাকা বা ব্যর্থ হওয়া গ্রহণযোগ্য নয়।
 *
 * যে প্রোভাইডারের কখনো সফল sync হয়নি শুধু সেটাই বুটে চালানো হয়; বাকিদের
 * জন্য cron-ই যথেষ্ট (প্রতি রিস্টার্টে পুরো ক্যাটালগ টানা অপ্রয়োজনীয়)।
 */
async function syncNewProvidersOnBoot() {
  try {
    const adapters = registry.getEnabledProviders();
    if (!adapters.length) return;

    const seen = await pool.query(
      `SELECT DISTINCT provider FROM provider_sync_log WHERE status = 'success'`
    );
    const already = new Set(seen.rows.map(r => r.provider));
    const fresh = adapters.filter(a => !already.has(a.name));
    if (!fresh.length) return;

    console.log(`[casinoSync] নতুন প্রোভাইডার পাওয়া গেছে: ${fresh.map(a => a.name).join(', ')} — বুট sync শুরু`);
    for (const adapter of fresh) {
      await syncProvider(adapter);
    }
  } catch (e) {
    console.error('[casinoSync] বুট sync ব্যর্থ (নন-ব্লকিং):', e.message);
  }
}

/** অ্যাডমিন প্যানেলের জন্য শেষ কয়েকটা sync-এর ফলাফল। */
async function recentLogs(limit = 20) {
  const r = await pool.query(
    `SELECT * FROM provider_sync_log ORDER BY started_at DESC LIMIT $1`,
    [Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100)]
  );
  return r.rows;
}

module.exports = { syncAll, syncProvider, syncNewProvidersOnBoot, recentLogs, slugFor };
