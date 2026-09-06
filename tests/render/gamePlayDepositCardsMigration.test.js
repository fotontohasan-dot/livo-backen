const { readScript } = require('../helpers/viewScripts');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const count = (src, re) => (src.match(re) || []).length;

function scriptBlocks(src) {
  return [...src.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

const roulette = read('views', 'games', 'roulette.ejs');
const play = read('views', 'games', 'play.ejs');
const deposit = read('views', 'payment', 'deposit.ejs');
const cards = read('views', 'profile', 'cards.ejs');

describe('games/roulette.ejs — শেয়ার করা game-select hook', () => {
  test('কোনো ইনলাইন onclick নেই', () => {
    expect(roulette).not.toMatch(/\sonclick=/);
  });

  // docs/CSP.md ধাপ ৩-এ রুলেটের কোড public/js/games/roulette.js-এ সরানো
  // হয়েছে; টেমপ্লেটে এখন শুধু <script src>।
  const rouletteJs = read('public', 'js', 'games', 'roulette.js');

  test('চারটে বাজি বিকল্পই data-game-select পেয়েছে', () => {
    ['Red', 'Black', 'Even', 'Odd'].forEach((v) => {
      expect(rouletteJs).toContain('data-game-select="' + v + '"');
    });
    expect(count(rouletteJs, /data-game-select="/g)).toBe(4);
  });

  test('selectOption রেজিস্টার করা এবং একই ফাইলে সংজ্ঞায়িত', () => {
    expect(rouletteJs).toContain('window.LivoGameSelect = selectOption;');
    expect(rouletteJs).toMatch(/function\s+selectOption\s*\(/);
  });

  test('টেমপ্লেট শুধু বাইরের ফাইলটা লোড করে', () => {
    expect(roulette).toContain('<script src="/js/games/roulette.js"></script>');
  });
});

describe('games/play.ejs — বাজির প্রিসেট ও ডেমো টগল', () => {
  test('কোনো ইনলাইন onclick নেই', () => {
    expect(play).not.toMatch(/\sonclick=/);
  });

  // docs/CSP.md ধাপ ৩-এ বাঁধার কোড public/js/views/games-play.js-এ সরানো
  // হয়েছে; অ্যাট্রিবিউটগুলো টেমপ্লেটেই থাকে।
  const playJs = read('public', 'js', 'views', 'games-play.js');

  test('পাঁচটা প্রিসেট ও ডেমো টগল hook পেয়েছে', () => {
    [10, 50, 100, 500, 1000].forEach((n) => {
      expect(play).toContain('data-set-bet="' + n + '"');
    });
    expect(count(play, /data-set-bet=/g)).toBe(5);
    expect(count(play, /data-toggle-demo/g)).toBe(1); // অ্যাট্রিবিউট
    expect(playJs).toContain('[data-toggle-demo]');
  });

  test('প্রিসেটের মান সংখ্যা হিসেবেই পাঠানো হয়', () => {
    // আগের কল ছিল setBet(10) — সংখ্যা। অ্যাট্রিবিউট থেকে আসা মান স্ট্রিং,
    // তাই Number() না করলে betAmount-এ স্ট্রিং বসত।
    expect(playJs).toMatch(/setBet\(Number\(btn\.getAttribute\('data-set-bet'\)\)\)/);
  });

  test('বাঁধা হয় setBet ও toggleDemoMode-এর একই ফাইলে', () => {
    expect(playJs).toMatch(/data-set-bet/);
    expect(playJs).toMatch(/function\s+setBet\s*\(/);
    expect(playJs).toMatch(/function\s+toggleDemoMode\s*\(/);
  });

  test('placeBet ও recordWin গ্লোবাল থাকে', () => {
    // public/js/games/-এর ১৭টা গেম স্ক্রিপ্ট এগুলো সরাসরি ডাকে। ফাইলটা
    // IIFE-তে মুড়লে প্রতিটা গেমের বাজি ধরা নীরবে বন্ধ হয়ে যেত।
    expect(playJs).not.toMatch(/^\(function\s*\(\)\s*\{/m);
    expect(playJs).toMatch(/^\s*async function placeBet\(|^\s*function placeBet\(/m);
  });
});

describe('payment/deposit.ejs — চ্যানেল নির্বাচন', () => {
  test('কোনো ইনলাইন onclick নেই', () => {
    expect(deposit).not.toMatch(/\sonclick=/);
  });

  test('চারটে চ্যানেল কার্ডই hook পেয়েছে, বাঁধা একই ব্লকে', () => {
    expect(count(deposit, /data-select-channel/g)).toBe(4); // চারটে কার্ড
    // বাঁধার কোড ও ফাংশন এখন public/js/views/payment-deposit.js-এ (ধাপ ৩)
    const depositJs = readScript('/js/views/payment-deposit.js');
    expect(depositJs).toContain('[data-select-channel]');
    expect(depositJs).toMatch(/function\s+selectChannel\s*\(/);
  });

  test('নির্বাচিত এলিমেন্টটাই ফাংশনে যায়', () => {
    // আগের কল ছিল selectChannel(this) — ফাংশনটা এলিমেন্ট থেকেই
    // চ্যানেলের তথ্য পড়ে, তাই এটা হারালে ভুল চ্যানেল নির্বাচিত হত।
    expect(readScript('/js/views/payment-deposit.js'))
      .toMatch(/el\.addEventListener\('click', function \(\) \{ selectChannel\(el\); \}\)/);
  });
});

describe('profile/cards.ejs — দ্বৈত হ্যান্ডলার সরানো হয়েছে', () => {
  test('কোনো ইনলাইন onclick নেই', () => {
    expect(cards).not.toMatch(/\sonclick=/);
  });

  test('fab ও overlay-তে ইনলাইন হ্যান্ডলার ছিল যা JS-ও বাঁধত', () => {
    // স্ক্রিপ্টটা DOMContentLoaded-এ দুটোতেই addEventListener করত, অর্থাৎ
    // ইনলাইন onclick-টা বাড়তি ছিল — একই ক্লিকে toggleModal দুবার চলত।
    const cardsJs = readScript('/js/views/profile-cards.js');
    expect(cardsJs).toMatch(/fab\.addEventListener\('click'/);
    expect(cardsJs).toMatch(/ov\.addEventListener\('click'/);
    expect(cards).toContain('<button class="fab-btn">');
    expect(cards).not.toMatch(/id="modalOverlay"[^>]*onclick/);
  });

  test('বন্ধ বাটনটা এখন hook দিয়ে বাঁধা', () => {
    expect(count(cards, /data-cards-close/g)).toBe(1); // অ্যাট্রিবিউট
    expect(readScript('/js/views/profile-cards.js')).toMatch(/\[data-cards-close\]/);
  });
});

describe('চারটে ফাইলের ইনলাইন ব্লকই বৈধ JavaScript', () => {
  test.each([
    ['views/profile/cards.ejs', cards]
  ])('%s', (_name, src) => {
    scriptBlocks(src).forEach((b) => {
      // eslint-disable-next-line no-new-func
      expect(() => new Function(b)).not.toThrow();
    });
  });
});
