const secureRandom = require('../utils/secureRandom');

// ==================== গেম রেজিস্ট্রি ====================
// এক জায়গা থেকেই ঠিক হয় কোন গেম আসলে খেলা যায়।
//
// আগে `routes/games.js`-এ দুটো আলাদা তালিকা ছিল: ১১৮টি গেমের নাম আর ৭টি
// হ্যান্ডলার। নাম আছে কিন্তু হ্যান্ডলার নেই — এমন ১১১টি গেম একটা জেনেরিক
// `chance(0.45) ? bet * 2 : 0` fallback-এ সেটেল হতো। অর্থাৎ ইউজার যে গেম
// খেলছে বলে ভাবত, সার্ভার সেটা খেলত না; সব গেমের ফল একই নিয়মে আসত।
//
// এখন নিয়ম একটাই: **হ্যান্ডলার না থাকলে গেম খেলা যাবে না।** ক্যাটালগে নাম
// থাকা মানে শুধু গেমটা চেনা যায় — লবিতে "শীঘ্রই আসছে" হিসেবে দেখানো যায়।
//
// নতুন গেম যোগ করতে: docs/ADDING_A_GAME.md দেখুন। সংক্ষেপে — CATALOGUE-এ
// নাম, HANDLERS-এ লজিক। দুটোই থাকলে গেম নিজে থেকেই খেলার যোগ্য হয়ে যায়।

const CATALOGUE = {
  "aviator": "Aviator",
  "slots": "Slots",
  "roulette": "Roulette",
  "andar-bahar": "Andar Bahar",
  "teen-patti": "Teen Patti",
  "blackjack": "Blackjack",
  "poker": "Poker",
  "baccarat": "Baccarat",
  "crash-game": "Crash Game",
  "starburst": "Starburst",
  "book-of-dead": "Book of Dead",
  "gonzos-quest": "Gonzo's Quest",
  "mega-moolah": "Mega Moolah",
  "gates-of-olympus": "Gates of Olympus",
  "sweet-bonanza": "Sweet Bonanza",
  "legacy-of-dead": "Legacy of Dead",
  "crazy-time": "Crazy Time",
  "lightning-roulette": "Lightning Roulette",
  "monopoly-live": "Monopoly Live",
  "mega-ball": "Mega Ball",
  "dream-catcher": "Dream Catcher",
  "super-sic-bo": "Super Sic Bo",
  "fan-tan": "Fan Tan",
  "bac-bo": "Bac Bo",
  "rummy": "Rummy",
  "call-break": "Call Break",
  "dragon-tiger": "Dragon Tiger",
  "jetx": "JetX",
  "plinko": "Plinko",
  "keno": "Keno",
  "bingo": "Bingo",
  "5d-lottery": "5D Lottery",
  "win-go": "Win Go",
  "coin-flip": "Coin Flip",
  "dice": "Dice",
  "fortune-gems": "Fortune Gems",
  "golden-empire": "Golden Empire",
  "sugar-rush": "Sugar Rush",
  "k3-lottery": "K3 Lottery",
  "spaceman": "Spaceman",
  "sic-bo": "Sic Bo",
  "fish-prawn-crab": "Fish Prawn Crab",
  "fruit-slot": "Fruit Slot",
  "diamond-slot": "Diamond Slot",
  "7up-7down": "7up 7down",
  "triple-card": "Triple Card",
  "jhandi-munda": "Jhandi Munda",
  "cricket-war": "Cricket War",
  "football-war": "Football War",
  "minesweeper-pro": "Minesweeper Pro",
  "tower-game": "Tower Game",
  "limbo": "Limbo",
  "wheel-pro": "Wheel Pro",
  "panda-slot": "Panda Slot",
  "tiger-slot": "Tiger Slot",
  "dragon-slot": "Dragon Slot",
  "phoenix-slot": "Phoenix Slot",
  "lion-slot": "Lion Slot",
  "coin-master": "Coin Master",
  "gold-rush": "Gold Rush",
  "treasure-hunt": "Treasure Hunt",
  "pirate-gold": "Pirate Gold",
  "ninja-game": "Ninja Game",
  "samurai-slot": "Samurai Slot",
  "mahjong-ways": "Mahjong Ways",
  "thai-paradise": "Thai Paradise",
  "monkey-king": "Monkey King",
  "wild-west": "Wild West",
  "space-wars": "Space Wars",
  "ocean-king": "Ocean King",
  "fire-dice": "Fire Dice",
  "ice-slot": "Ice Slot",
  "storm-slot": "Storm Slot",
  "royal-flush": "Royal Flush",
  "lucky-7": "Lucky 7",
  "magic-ball": "Magic Ball",
  "neon-slots": "Neon Slots",
  "cash-burst": "Cash Burst",
  "live-blackjack": "Live Blackjack",
  "live-roulette": "Live Roulette",
  "live-baccarat": "Live Baccarat",
  "live-poker": "Live Poker",
  "mines": "Mines",
  "football-studio": "Football Studio",
  "cash-or-crash": "Cash or Crash",
  "extra-chill": "Extra Chill",
  "fire-in-the-hole": "Fire in the Hole",
  "wanted-dead-or-a-wild": "Wanted Dead or Wild",
  "mental": "Mental",
  "razor-shark": "Razor Shark",
  "jammin-jars": "Jammin Jars",
  "san-quentin": "San Quentin",
  "aviator-pro": "Aviator Pro",
  "jetx-pro": "JetX Pro",
  "spaceman-pro": "Spaceman Pro",
  "aviatrix": "Aviatrix",
  "balloon": "Balloon",
  "minesweeper": "Minesweeper",
  "football-x": "Football X",
  "ludo": "Online Ludo",
  "color-prediction": "Color Prediction",
  "mine": "Mine Game",
  "hilo": "Hi-Lo",
  "card-war": "Card War",
  "lucky-spin": "Lucky Spin",
  "number-guess": "Number Guess",
  "age-of-the-gods": "Age of the Gods",
  "buffalo-blitz": "Buffalo Blitz",
  "immortal-romance": "Immortal Romance",
  "thunderstruck-2": "Thunderstruck II",
  "sugar-pop": "Sugar Pop",
  "slotfather": "The Slotfather",
  "valley-of-the-gods": "Valley of the Gods",
  "vikings-go-berzerk": "Vikings Go Berzerk",
  "gonzos-quest-megaways": "Gonzo's Quest Megaways",
  "piggy-riches-megaways": "Piggy Riches Megaways",
  "big-bad-wolf": "Big Bad Wolf",
  "sakura-fortune": "Sakura Fortune"
};


// Crash ধরনের গেম: বাজি ও ক্যাশআউট দুই ধাপে হয়, তাই এদের তাৎক্ষণিক
// হ্যান্ডলার নেই। `routes/games.js` নিজেই রাউন্ড তৈরি ও সেটেল করে।
const CRASH_GAMES = ['aviator', 'crash-game'];
const CRASH_PLACEHOLDER = () => {
  throw new Error('crash গেম getHandler() দিয়ে সেটেল হয় না — রাউন্ড ফ্লো ব্যবহার করুন');
};

// আসল ৮-ডেক ব্যাকারাটের আউটকাম সম্ভাবনা (Player, Banker, Tie) — নিচের
// baccarat হ্যান্ডলারের কমেন্টে বিস্তারিত ব্যাখ্যা আছে।
const BACCARAT_WEIGHTS = [0.4462, 0.4586, 0.0952];

const HANDLERS = {
  slots: (betAmount) => {
    const symbols = ["🍒", "🍋", "🍊", "🍇", "🔔", "💎", "7️⃣", "⭐", "🌟", "👑"];
    const r = [secureRandom.pick(symbols), secureRandom.pick(symbols), secureRandom.pick(symbols)];
    let multiplier = 0;
    if (r[0] === r[1] && r[1] === r[2]) multiplier = 10;
    else if (r[0] === r[1] || r[1] === r[2] || r[0] === r[2]) multiplier = 2;
    return { winAmount: betAmount * multiplier, gameResult: { results: r } };
  },
  roulette: (betAmount, selection) => {
    const number = secureRandom.randomInt(37);
    const isRed = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36].includes(number);
    let winAmount = 0;
    if ((selection === 'Red' && isRed) || (selection === 'Black' && number !== 0 && !isRed)) winAmount = betAmount * 2;
    return { winAmount, gameResult: { number, color: number === 0 ? 'Green' : (isRed ? 'Red' : 'Black') } };
  },
  'andar-bahar': (betAmount, selection) => {
    const isAndar = secureRandom.chance(0.5);
    const winAmount = (isAndar && selection === 'Andar') || (!isAndar && selection === 'Bahar') ? betAmount * 1.9 : 0;
    return { winAmount, gameResult: { side: isAndar ? 'Andar' : 'Bahar' } };
  },
  'teen-patti': (betAmount) => {
    const winAmount = secureRandom.chance(0.40) ? betAmount * 1.95 : 0;
    return { winAmount, gameResult: {} };
  },
  blackjack: (betAmount) => {
    const winAmount = secureRandom.chance(0.42) ? betAmount * 2 : 0;
    return { winAmount, gameResult: {} };
  },
  poker: (betAmount) => {
    const winAmount = secureRandom.chance(0.35) ? betAmount * 2.5 : 0;
    return { winAmount, gameResult: {} };
  },
  // ---------------------------------------------------------------------
  // Baccarat — আউটকাম বণ্টন (LIVO-02)
  //
  // আগে: secureRandom.pick(['Player','Banker','Tie']) — অর্থাৎ তিনটাই সমান
  // ১/৩ সম্ভাবনা। Tie ৮× ফেরত দেয় (winAmount হলো gross return, দেখুন
  // routes/games.js:217 → netChange = winAmount - betAmount), তাই Tie বাজির
  // প্রত্যাশিত ফেরত ছিল (1/3) × 8 = 2.667× — অর্থাৎ RTP ২৬৬.৭%, প্রতি বাজিতে
  // খেলোয়াড়ের গড় লাভ +১৬৬.৭%। একজন খেলোয়াড় শুধু Tie-তে বাজি ধরে অসীম
  // পরিমাণ টাকা তুলে নিতে পারত। এটাই এই পাসের একমাত্র P0 আর্থিক ত্রুটি ছিল।
  //
  // এখন: আসল ব্যাকারাটের (৮-ডেক, স্ট্যান্ডার্ড drawing rules) প্রতিষ্ঠিত
  // সম্ভাবনা ব্যবহার করা হয় —
  //     Player 44.62%, Banker 45.86%, Tie 9.52%
  // পেআউট টেবিল অপরিবর্তিত (Player/Banker 1.95×, Tie 8×), ফলে RTP দাঁড়ায়:
  //     Player 0.4462 × 1.95 = 87.0%
  //     Banker 0.4586 × 1.95 = 89.4%
  //     Tie    0.0952 × 8.00 = 76.2%
  // তিনটাতেই হাউস এজ ধনাত্মক — কোনো বাজিতেই খেলোয়াড় প্রত্যাশিতভাবে জেতে না।
  //
  // Blast radius: gameResult-এর আকৃতি ({ outcome }) ও winAmount-এর অর্থ
  // অপরিবর্তিত, তাই routes/games.js, ledger, wallet ও ফ্রন্টএন্ড কনট্র্যাক্টে
  // কোনো পরিবর্তন লাগে না — শুধু কোন আউটকাম কত ঘন ঘন আসে সেটা বদলেছে।
  // ---------------------------------------------------------------------
  baccarat: (betAmount, selection) => {
    const resultOptions = ['Player', 'Banker', 'Tie'];
    const outcome = resultOptions[secureRandom.weightedIndex(BACCARAT_WEIGHTS)];
    let winAmount = 0;
    if (outcome === selection) {
      if (outcome === 'Tie') winAmount = betAmount * 8;
      else winAmount = betAmount * 1.95;
    }
    return { winAmount, gameResult: { outcome } };
  }
};


// ==================== পাবলিক API ====================

/** ক্যাটালগে গেমটি চেনা যায় কি না (খেলা যায় কি না — সেটা আলাদা প্রশ্ন)। */
function isKnown(slug) {
  return Object.prototype.hasOwnProperty.call(CATALOGUE, slug);
}

/** গেমটি আসলে খেলা যায় কি না — সার্ভার-সাইড লজিক আছে কি না। */
function isPlayable(slug) {
  return isKnown(slug) && typeof getHandler(slug) === 'function';
}

/** প্রদর্শনযোগ্য নাম; অচেনা হলে slug-ই ফেরত। */
function displayName(slug) {
  return CATALOGUE[slug] || slug;
}

/**
 * গেমের সেটেলমেন্ট লজিক। Aviator/crash আলাদা পথে চলে (রাউন্ড + ক্যাশআউট),
 * তাই এখানে নেই — `isCrashGame()` দিয়ে আলাদা করা হয়।
 */
function getHandler(slug) {
  if (isCrashGame(slug)) return CRASH_PLACEHOLDER;
  return HANDLERS[slug];
}

/** Crash ধরনের গেম — বাজি ও ক্যাশআউট দুই ধাপে, তাৎক্ষণিক ফল নয়। */
function isCrashGame(slug) {
  return CRASH_GAMES.includes(slug);
}

/** খেলার যোগ্য সব slug। */
function playableSlugs() {
  return Object.keys(CATALOGUE).filter(isPlayable);
}

/** ক্যাটালগে আছে কিন্তু এখনো খেলা যায় না — লবিতে "শীঘ্রই আসছে"। */
function comingSoonSlugs() {
  return Object.keys(CATALOGUE).filter((slug) => !isPlayable(slug));
}

/**
 * নতুন গেম রানটাইমে যোগ করার পথ। handler না দিলে গেমটি ক্যাটালগে ঢুকবে
 * কিন্তু খেলা যাবে না — ইচ্ছাকৃত, যাতে লজিক ছাড়া গেম কখনো লাইভ না হয়।
 */
function registerGame(slug, name, handler) {
  if (!slug || typeof slug !== 'string') throw new Error('registerGame: slug লাগবে');
  if (!name || typeof name !== 'string') throw new Error('registerGame: name লাগবে');
  CATALOGUE[slug] = name;
  if (handler !== undefined) {
    if (typeof handler !== 'function') throw new Error('registerGame: handler ফাংশন হতে হবে');
    HANDLERS[slug] = handler;
  }
  return { slug, playable: isPlayable(slug) };
}

module.exports = {
  CATALOGUE,
  isKnown,
  isPlayable,
  isCrashGame,
  displayName,
  getHandler,
  playableSlugs,
  comingSoonSlugs,
  registerGame
};
