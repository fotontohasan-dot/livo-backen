const fs = require('fs');
const path = require('path');

// ==================== ভাঙা <script> ট্যাগের গার্ড ====================
//
// ৫০টা গেম টেমপ্লেটে একটা বাড়তি `<script>` খোলা ট্যাগ ছিল, কোনো বন্ধ ট্যাগ
// ছাড়াই — ঠিক এই আকৃতিতে:
//
//     <script>
//     document.getElementById('gameUI').innerHTML = `
//       ...
//     `;
//     <script>            <-- বাড়তি, কখনো বন্ধ হয়নি
//     (function(){ ... })();
//     </script>
//
// HTML পার্সার `<script>` খোলার পরে প্রথম `</script>` না পাওয়া পর্যন্ত সব
// টেক্সটকে স্ক্রিপ্টের বডি ধরে। ফলে ওই দ্বিতীয় `<script>` লাইনটা JavaScript
// টোকেন হিসেবে পার্স হত এবং SyntaxError দিত — অর্থাৎ পুরো ব্লকটাই চলত না।
// গেমের UI বসত না, বাটন তৈরি হত না, বাজিও ধরা যেত না।
//
// টেস্টগুলো টিকে থাকত, কারণ কেউ ব্রাউজারে স্ক্রিপ্টটা আসলে চালিয়ে দেখেনি।

const ROOT = path.join(__dirname, '..', '..');
const GAMES_DIR = path.join(ROOT, 'views', 'games');
const gameFiles = fs.readdirSync(GAMES_DIR).filter((f) => f.endsWith('.ejs'));

function scriptBlocks(src) {
  return [...src.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)];
}

describe('গেম টেমপ্লেট — <script> ট্যাগ ভারসাম্যে আছে', () => {
  test('গেম ফাইল পাওয়া গেছে', () => {
    // ১০০টা অব্যবহৃত টেমপ্লেট মুছে ফেলার পরে ১৯টা বাকি (১৮টা গেম +
    // play.ejs)। সংখ্যাটা শূন্যের বেশি হলেই যথেষ্ট — আসল যাচাই নিচের
    // প্রতি-ফাইল টেস্টগুলো।
    expect(gameFiles.length).toBeGreaterThan(0);
  });

  test.each(gameFiles)('%s — খোলা ও বন্ধ ট্যাগের সংখ্যা সমান', (file) => {
    const src = fs.readFileSync(path.join(GAMES_DIR, file), 'utf8');
    const open = (src.match(/<script/g) || []).length;
    const close = (src.match(/<\/script>/g) || []).length;
    expect({ file, open, close }).toEqual({ file, open: close, close });
  });

  test.each(gameFiles)('%s — কোনো ব্লকের ভেতরে raw <script> নেই', (file) => {
    const src = fs.readFileSync(path.join(GAMES_DIR, file), 'utf8');
    // ব্রাউজার প্রথম `</script>` পর্যন্ত যা পড়বে, তাতে `<script>` থাকা মানেই
    // নিশ্চিত SyntaxError।
    const start = src.indexOf('<script>');
    if (start === -1) return;
    const end = src.indexOf('</script>', start);
    expect(end).toBeGreaterThan(start);
    expect(src.slice(start + '<script>'.length, end)).not.toContain('<script>');
  });

  test.each(gameFiles)('%s — প্রতিটা ইনলাইন ব্লক বৈধ JavaScript', (file) => {
    const src = fs.readFileSync(path.join(GAMES_DIR, file), 'utf8');
    for (const m of scriptBlocks(src)) {
      // EJS ইন্টারপোলেশন থাকা ব্লক আলাদাভাবে পার্স করা যায় না — বাদ।
      if (/<%/.test(m[1]) || /application\/json/.test(m[0])) continue;
      // eslint-disable-next-line no-new-func
      expect(() => new Function(m[1])).not.toThrow();
    }
  });
});
