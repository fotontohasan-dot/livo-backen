/**
 * utils/contentFilter.js
 * ---------------------------------------------------------------------------
 * কেন্দ্রীয় কনটেন্ট ফিল্টার — গালাগালি, অশ্লীল/১৮+ শব্দ এবং সন্দেহজনক লিঙ্ক শনাক্ত করে।
 * এই ফাইলটাই একমাত্র জায়গা যেখানে ব্যাড-ওয়ার্ড লিস্ট থাকবে — তালিকা আপডেট করতে
 * শুধু নিচের BANGLA_BAD_WORDS / ENGLISH_BAD_WORDS অ্যারেতে নতুন শব্দ যোগ করলেই হবে,
 * বাকি কোড (middleware, routes, socket handler) স্বয়ংক্রিয়ভাবে নতুন তালিকা ব্যবহার করবে।
 *
 * এক্সপোর্ট করা ফাংশনগুলো:
 *   - containsBadContent(text)   → { flagged, reason, matched }  (টেক্সটে গালি/অশ্লীল শব্দ/১৮+ প্যাটার্ন)
 *   - containsBadLink(text)      → { flagged, reason, matched }  (১৮+ সাইটের লিঙ্ক)
 *   - checkContent(text)         → উপরের দুইটা একসাথে চালিয়ে একটা কম্বাইন্ড রেজাল্ট দেয়
 * ---------------------------------------------------------------------------
 */

// ============================================================================
// ১) শব্দ তালিকা — এখানে যোগ/বাদ দিয়ে সহজেই আপডেট করা যায়
//    (ছোট হাতের অক্ষরে রাখা হয়েছে, normalize() ফাংশন সবকিছু lowercase করে মেলাবে)
// ============================================================================

// বাংলা গালাগালি/অশ্লীল শব্দ (রোমান বাংলা বানানসহ, কারণ ইউজাররা প্রায়ই বাংলিশে লেখে)
const BANGLA_BAD_WORDS = [
  'মাদারচোদ', 'বাইনচোদ', 'বাল', 'খানকি', 'খানকির', 'বেশ্যা', 'বেশ্যার',
  'চুদি', 'চুদা', 'চুদার', 'চুদির', 'চোদা', 'চোদার', 'চোদন', 'গুদ', 'গুদা',
  'ল্যাওড়া', 'ল্যাওরা', 'লেওড়া', 'শালা', 'শালী', 'শুয়ার', 'শুওর', 'কুত্তা',
  'কুত্তার বাচ্চা', 'হারামজাদা', 'হারামি', 'হারামজাদি', 'রেন্ডি', 'বেটিচোদ',
  'মাগি', 'মাগীর', 'পোঁদ', 'পোদ', 'ভোদা', 'ভোদার', 'ধোন', 'ধোনের',
  // রোমান হরফে বাংলা (বাংলিশ) সংস্করণ
  'madarchod', 'বাইনচোদ', 'baynchod', 'banchod', 'bal', 'khanki', 'beshsha',
  'chudi', 'chuda', 'chudir', 'choda', 'chodar', 'gud', 'guda', 'lawra',
  'lawora', 'shala', 'shali', 'shuor', 'kuttar bachcha', 'haramjada',
  'harami', 'haramjadi', 'magi', 'magir', 'pod', 'bhoda', 'dhon',
];

// ইংরেজি গালাগালি (সাধারণ ও প্রচলিত তালিকা, obfuscation ধরার জন্য কমন ভ্যারিয়েন্টসহ)
const ENGLISH_BAD_WORDS = [
  'fuck', 'fucking', 'fucker', 'motherfucker', 'shit', 'bullshit', 'bitch',
  'bastard', 'asshole', 'ass', 'dick', 'dickhead', 'cock', 'pussy', 'cunt',
  'whore', 'slut', 'slutty', 'douche', 'douchebag', 'twat', 'wanker',
  'jerkoff', 'jackass', 'piss', 'retard', 'faggot', 'fag', 'nigger', 'nigga',
];

// ১৮+ / পর্নোগ্রাফি সম্পর্কিত শব্দ (নিজস্ব রেগেক্স গ্রুপে আলাদা রাখা হয়েছে,
// কারণ এগুলোর জন্য word-boundary ছাড়াও substring ম্যাচ দরকার হতে পারে)
const ADULT_KEYWORDS = [
  'porn', 'pornhub', 'porno', 'pornography', 'xxx', 'xnxx', 'xvideos',
  'nude', 'nudes', 'naked', 'sex video', 'sextape', 'sex tape', 'sexvideo',
  'hardcore', 'blowjob', 'handjob', 'cumshot', 'creampie', 'anal sex',
  'onlyfans', 'escort service', 'call girl', 'cam girl', 'camgirl',
  'live sex', 'adult video', 'adult content', 'strip video', 'fap',
  'হস্তমৈথুন', 'যৌন ভিডিও', 'নগ্ন ছবি', 'নগ্ন ভিডিও', 'সেক্স ভিডিও',
];

// ১৮+ সাইট হিসেবে পরিচিত ডোমেইন (লিঙ্ক শেয়ার করলে ব্লক করার জন্য)
const ADULT_DOMAINS = [
  'pornhub.com', 'xvideos.com', 'xnxx.com', 'xhamster.com', 'redtube.com',
  'youporn.com', 'onlyfans.com', 'chaturbate.com', 'livejasmin.com',
  'brazzers.com', 'spankbang.com', 'motherless.com', 'thumbzilla.com',
  'sex.com', 'porn.com',
];

// ============================================================================
// ২) সাধারণ leetspeak / স্পেসিং অবফাসকেশন নরমালাইজ করার জন্য ম্যাপ
//    (যেমন: f*ck, f u c k, f4ck, fück ইত্যাদি ধরার জন্য)
// ============================================================================
const LEET_MAP = {
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a',
  '$': 's', '!': 'i', '+': 't', 'ph': 'f',
};

function normalize(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let text = raw.toLowerCase();

  // ইউনিকোড ডায়াক্রিটিক্স সরানো (é → e, ü → u ইত্যাদি)
  text = text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');

  // leetspeak ক্যারেক্টার রিপ্লেস
  Object.keys(LEET_MAP).forEach((k) => {
    text = text.split(k).join(LEET_MAP[k]);
  });

  // শব্দের মাঝে ঢুকিয়ে দেওয়া স্পেস/ডট/ড্যাশ/আন্ডারস্কোর সরিয়ে একসাথে করা
  // যাতে "f u c k" বা "f.u.c.k" বা "f-u-c-k" ও ধরা পড়ে
  const squashed = text.replace(/[\s._\-*]+/g, '');

  return `${text}\n${squashed}`; // দুই ভার্সনই রিটার্ন করি — normal + squashed
}

// ============================================================================
// ৩) মূল ফাংশন
// ============================================================================

/**
 * টেক্সটে গালাগালি/অশ্লীল/১৮+ শব্দ আছে কিনা চেক করে
 * @param {string} text
 * @returns {{ flagged: boolean, reason: string|null, matched: string|null }}
 */
function containsBadContent(text) {
  if (!text || typeof text !== 'string' || !text.trim()) {
    return { flagged: false, reason: null, matched: null };
  }

  const normalized = normalize(text);
  const plainLower = text.toLowerCase();
  const allWords = [...BANGLA_BAD_WORDS, ...ENGLISH_BAD_WORDS, ...ADULT_KEYWORDS];

  for (const word of allWords) {
    const w = word.toLowerCase();
    // ছোট (৩ অক্ষরের কম) ইংরেজি শব্দের জন্য word-boundary বাধ্যতামূলক, নাহলে false-positive বেশি হবে
    if (/^[a-z]+$/.test(w) && w.length <= 3) {
      const re = new RegExp(`\\b${w}\\b`, 'i');
      if (re.test(normalized)) {
        return { flagged: true, reason: 'inappropriate_word', matched: word };
      }
    } else if (normalized.includes(w)) {
      return { flagged: true, reason: 'inappropriate_word', matched: word };
    }
  }

  // ১৮+ ইঙ্গিতবাহী রেগেক্স প্যাটার্ন (শব্দ তালিকার বাইরেও সাধারণ প্যাটার্ন ধরার জন্য)
  // — এইগুলো plainLower-এর ওপর চালানো হয় (leet-normalize নয়), কারণ '1'→'i' রূপান্তর
  // সংখ্যাভিত্তিক প্যাটার্ন যেমন "18+" ভেঙে দেয়
  const ADULT_PATTERNS = [
    /\b18\s*\+/i,
    /\bxxx\b/i,
    /\bnsfw\b/i,
    /\bnud[e3]s?\b/i,
    /\bp[o0]rn\w*/i,
    /\bs[e3]x\s*(video|tape|cam|chat|call)\b/i,
    /\bescort(s)?\b/i,
  ];
  for (const re of ADULT_PATTERNS) {
    if (re.test(plainLower) || re.test(normalized)) {
      return { flagged: true, reason: 'adult_content_pattern', matched: re.source };
    }
  }

  return { flagged: false, reason: null, matched: null };
}

/**
 * টেক্সটের ভেতরে থাকা যেকোনো URL ১৮+ সাইটের কিনা চেক করে
 * @param {string} text
 * @returns {{ flagged: boolean, reason: string|null, matched: string|null }}
 */
function containsBadLink(text) {
  if (!text || typeof text !== 'string') {
    return { flagged: false, reason: null, matched: null };
  }

  const urlRegex = /(https?:\/\/[^\s]+|www\.[^\s]+|[a-z0-9-]+\.[a-z]{2,}(?:\/[^\s]*)?)/gi;
  const urls = text.match(urlRegex) || [];

  for (const raw of urls) {
    const lower = raw.toLowerCase();
    for (const domain of ADULT_DOMAINS) {
      if (lower.includes(domain)) {
        return { flagged: true, reason: 'adult_link', matched: domain };
      }
    }
  }

  return { flagged: false, reason: null, matched: null };
}

/**
 * টেক্সট + লিঙ্ক দুটোই একসাথে চেক করে একটা কম্বাইন্ড রেজাল্ট দেয়
 * @param {string} text
 * @returns {{ flagged: boolean, reason: string|null, matched: string|null }}
 */
function checkContent(text) {
  const wordCheck = containsBadContent(text);
  if (wordCheck.flagged) return wordCheck;

  const linkCheck = containsBadLink(text);
  if (linkCheck.flagged) return linkCheck;

  return { flagged: false, reason: null, matched: null };
}

module.exports = {
  containsBadContent,
  containsBadLink,
  checkContent,
  // তালিকাগুলো এক্সপোর্ট করা হলো — চাইলে অ্যাডমিন প্যানেল থেকে ভবিষ্যতে
  // ডাইনামিকভাবে দেখতে/এডিট করতে চাইলে কাজে লাগবে
  BANGLA_BAD_WORDS,
  ENGLISH_BAD_WORDS,
  ADULT_KEYWORDS,
  ADULT_DOMAINS,
};
