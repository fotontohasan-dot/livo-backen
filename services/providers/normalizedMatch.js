// services/providers/normalizedMatch.js
// ---------------------------------------------------------------------------
// সব প্রোভাইডার অ্যাডাপ্টার এই একটাই আকারে ডেটা ফেরত দেয়। কোর অ্যাপ (matchUpdater)
// এর বাইরে কোনো প্রোভাইডার-নির্দিষ্ট JSON আকার চেনে না — নতুন প্রোভাইডার যোগ করতে
// হলে শুধু একটা অ্যাডাপ্টার লিখে এই আকারে ম্যাপ করলেই হয়।
//
// ফিল্ডগুলো সরাসরি বিদ্যমান `matches` টেবিলের কলামে ম্যাপ করে — নতুন কোনো নামকরণ
// প্রথা চালু করা হয়নি:
//
//   provider     → matches.provider      (কোন অ্যাডাপ্টার এনেছে)
//   externalId   → matches.external_id   (প্রোভাইডারের নিজস্ব স্থায়ী ম্যাচ আইডি)
//   title        → matches.title
//   sport        → matches.sport
//   league       → matches.league         (না জানা থাকলে null — বানানো হয় না)
//   teamA/teamB  → matches.team_a/team_b
//   status       → matches.status         ('live' | 'upcoming' | 'finished')
//   scoreA/scoreB→ matches.score_a/score_b
//   overs        → matches.overs          (ক্রিকেট ছাড়া null)
//   startTime    → matches.start_time
//   metadata     → matches.provider_metadata (JSONB, ঐচ্ছিক ডায়াগনস্টিক তথ্য)
//
// নীতি: প্রোভাইডার যে ফিল্ড দেয় না, সেটা null থাকে। অনুমান করে ভরাট করা হয় না।
// ---------------------------------------------------------------------------

const VALID_STATUSES = ['live', 'upcoming', 'finished'];

/**
 * অ্যাডাপ্টারের কাঁচা আউটপুট থেকে একটা নিরাপদ normalized রেকর্ড বানায়।
 * অবৈধ/অসম্পূর্ণ রেকর্ড হলে null ফেরত দেয় — কল সাইট সেটা skip করে, throw করে না।
 */
function buildNormalizedMatch(input) {
  if (!input || typeof input !== 'object') return null;

  const provider = typeof input.provider === 'string' ? input.provider.trim() : '';
  const externalId = input.externalId != null ? String(input.externalId).trim() : '';
  const sport = typeof input.sport === 'string' ? input.sport.trim() : '';

  // এই তিনটা ছাড়া রেকর্ডটা idempotent ভাবে সেভ করা যায় না — তাই বাদ
  if (!provider || !externalId || !sport) return null;

  const status = VALID_STATUSES.includes(input.status) ? input.status : 'upcoming';

  return {
    provider,
    externalId,
    sport,
    title: nonEmpty(input.title),
    league: nonEmpty(input.league),
    teamA: nonEmpty(input.teamA) || 'TBA',
    teamB: nonEmpty(input.teamB) || 'TBA',
    status,
    scoreA: nonEmpty(input.scoreA),
    scoreB: nonEmpty(input.scoreB),
    overs: nonEmpty(input.overs),
    startTime: toDateOrNull(input.startTime),
    metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : null
  };
}

function nonEmpty(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

function toDateOrNull(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

module.exports = { buildNormalizedMatch, VALID_STATUSES };
