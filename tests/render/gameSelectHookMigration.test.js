const fs = require('fs');
const path = require('path');

// docs/CSP.md ধাপ ২ — সাতটা গেম পেজের বাজি-নির্বাচন বাটন।
//
// এখানকার বিশেষত্ব: বাটনগুলো টেমপ্লেটে লেখা নেই। প্রতিটা গেমের ইনলাইন
// স্ক্রিপ্ট innerHTML দিয়ে রানটাইমে পুরো UI বানায়, আর ওই স্ট্রিং-এর ভেতরেই
// onclick বসত। অর্থাৎ ui-hooks.js-এর init() চলার সময় বাটনগুলো DOM-এ থাকেই
// না — তাই querySelectorAll কাজ করত না, ডেলিগেশন লাগে।

const ROOT = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const sharedJs = read('public', 'js', 'ui-hooks.js');

const GAMES = {
  'color-prediction': { fn: 'selectColor', values: ['red', 'violet', 'green'] },
  'dice': { fn: 'selectDice', values: ['low', 'seven', 'high'] },
  'dragon-tiger': { fn: 'selectDT', values: ['Dragon', 'Tie', 'Tiger'] },
  'coin-flip': { fn: 'selectSide', values: ['head', 'tail'] },
  'hilo': { fn: 'selectHL', values: ['high', 'low'] },
  'andar-bahar': { fn: 'selectAB', values: ['Andar', 'Bahar'] },
  'number-guess': { fn: 'selectNum', values: ['${n}'] }
};

// docs/CSP.md ধাপ ৩-এ গেমের কোড ইনলাইন ব্লক থেকে
// public/js/games/<slug>.js-এ সরানো হয়েছে, তাই hook ও রেজিস্ট্রেশন
// এখন ওই ফাইলে খোঁজা হয়। টেমপ্লেটে শুধু <script src> থাকে।
function gameSource(game) {
  return fs.readFileSync(path.join(ROOT, 'public', 'js', 'games', game + '.js'), 'utf8');
}

describe('গেম নির্বাচন — ডেলিগেটেড hook', () => {
  test('ui-hooks.js ডেলিগেশন ব্যবহার করে, querySelectorAll নয়', () => {
    expect(sharedJs).toMatch(/document\.addEventListener\('click'/);
    expect(sharedJs).toMatch(/closest\('\[data-game-select\]'\)/);
    expect(sharedJs).not.toMatch(/querySelectorAll\('\[data-game-select\]'\)/);
  });

  test('রেজিস্টার করা না থাকলে চুপচাপ কিছুই হয় না', () => {
    // কোনো পেজে LivoGameSelect না থাকলে ক্লিকে TypeError হওয়া চলবে না।
    expect(sharedJs).toMatch(/typeof window\.LivoGameSelect === 'function'/);
  });

  test('নির্বাচিত এলিমেন্টটাও ফাংশনে পাঠানো হয়', () => {
    // আগের কল ছিল selectDice('low', this) — কয়েকটা গেম দ্বিতীয়
    // আর্গুমেন্টটা হাইলাইট করতে ব্যবহার করে, তাই সেটা হারানো চলবে না।
    expect(sharedJs).toMatch(/window\.LivoGameSelect\(el\.getAttribute\('data-game-select'\), el\)/);
  });
});

describe.each(Object.entries(GAMES))('games/%s.ejs', (game, spec) => {
  const src = read('views', 'games', game + '.ejs');

  test('কোনো ইনলাইন onclick নেই', () => {
    expect(src).not.toMatch(/\sonclick=/);
  });

  test('প্রতিটা বিকল্প data-game-select পেয়েছে', () => {
    const js = gameSource(game);
    spec.values.forEach((v) => {
      expect(js).toContain('data-game-select="' + v + '"');
    });
    const found = (js.match(/data-game-select="/g) || []).length;
    expect(found).toBe(spec.values.length);
  });

  test('নির্বাচন-ফাংশন রেজিস্টার করা এবং একই ফাইলে সংজ্ঞায়িত', () => {
    // অন্য জায়গায় সংজ্ঞায়িত হলে রেজিস্ট্রেশনে ReferenceError হত এবং
    // গেমের বাটন নীরবে কাজ করা বন্ধ করত।
    const js = gameSource(game);
    expect(js).toContain('window.LivoGameSelect = ' + spec.fn + ';');
    expect(js).toMatch(new RegExp('function\\s+' + spec.fn + '\\s*\\('));
  });

  test('টেমপ্লেট শুধু বাইরের ফাইলটা লোড করে', () => {
    expect(src).toContain('<script src="/js/games/' + game + '.js"></script>');
    expect(src).not.toMatch(/<script>/);
  });

  test('বাইরের ফাইলটা বৈধ JavaScript', () => {
    // eslint-disable-next-line no-new-func
    expect(() => new Function(gameSource(game))).not.toThrow();
  });
});
