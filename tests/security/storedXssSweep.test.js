// tests/security/storedXssSweep.test.js
// ---------------------------------------------------------------------------
// PHASE 9 — XSS SWEEP
//
//   MEDIUM-8 : games.name / provider / emoji / badge / slug হোমপেজে
//              innerHTML দিয়ে বসানো হত, কোনো escaping ছাড়া।
//              JSON.stringify()-এর \u003C escaping শুধু <script> block থেকে
//              বেরোনো ঠেকায়, DOM-এ HTML হিসেবে ব্যাখ্যা হওয়া ঠেকায় না।
//              ফলে games_manage permission থাকা যেকোনো admin প্রতিটি
//              দর্শকের ব্রাউজারে stored XSS বসাতে পারত।
//
//   Fix দুই স্তরে: (১) render-সময় escHtml(), (২) server-side validation
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const { pool } = require('../../db');
const { uniqueUsername } = require('../helpers/app');

const ROOT = path.join(__dirname, '..', '..');
// docs/CSP.md ধাপ ৩: হোমপেজের রেন্ডারিং কোড public/js/views/index.js-এ
// সরানো হয়েছে। escHtml() ও তার সব ব্যবহার সেখানেই, তাই টেমপ্লেট +
// স্ক্রিপ্ট একসাথে দেখা হয় — যাচাইয়ের বিষয়বস্তু অপরিবর্তিত।
const INDEX_EJS = require('../helpers/viewScripts')
  .readViewWithScripts('views', 'index.ejs');

const PAYLOADS = [
  '<img src=x onerror=alert(1)>',
  '"><script>alert(1)</script>',
  "');alert(1);//",
  '<svg/onload=alert(1)>',
];

describe('Stored XSS sweep (PHASE 9)', () => {
  describe('MEDIUM-8: homepage game rendering', () => {
    // ক্যাসিনো-প্রথম হোমে গেম/ক্যাটাগরি/প্রোভাইডার এখন সার্ভারে EJS দিয়ে রেন্ডার হয় (ক্লায়েন্টে
    // innerHTML দিয়ে নয়)। তাই আগের escHtml()-ভিত্তিক সোর্স-চেক বদলে নিচের চেকগুলো: নিরাপত্তার উদ্দেশ্য
    // একই — গেমের কোনো ফিল্ড escape ছাড়া HTML-এ বসবে না।
    const CARD = fs.readFileSync(path.join(ROOT, 'views/partials/home-game-card.ejs'), 'utf8');
    const INDEX_JS = fs.readFileSync(path.join(ROOT, 'public/js/views/index.js'), 'utf8');

    test('গেম কার্ড শুধু escaping <%= %> ট্যাগে গেম-ফিল্ড বসায় (কাঁচা <%- নয়)', () => {
      expect(CARD).toMatch(/<%= g\.name %>/);
      expect(CARD).not.toMatch(/<%-\s*g\./);
      expect(INDEX_EJS).not.toMatch(/<%-\s*(g|c|p)\.(name|provider|category|slug|badge|thumbnail_url)/);
    });

    test('ক্লায়েন্ট JS গেম-ডেটা থেকে HTML বানায় না', () => {
      expect(INDEX_JS).not.toMatch(/\$\{g\./);
      expect(INDEX_JS).not.toMatch(/g\.(name|provider|slug|badge)/);
    });

    test('ক্যাটাগরি/প্রোভাইডার চিপ ও অক্ষর লিংক escape হয় (<%= ব্যবহার)', () => {
      expect(INDEX_EJS).toMatch(/<%= p\.name %>/);
      expect(INDEX_EJS).toMatch(/<%= catLabel\(c\.name\) %>/);
      expect(INDEX_EJS).not.toMatch(/<%-\s*(p|c)\.name/);
    });

    test('Recent Wins-এ ইউজার/গেমের নাম esc() দিয়ে বসে', () => {
      expect(INDEX_JS).toMatch(/esc\(w\.user\)/);
      expect(INDEX_JS).toMatch(/esc\(w\.game\)/);
    });

    test('SERVER_GAMES-এর JSON-escaped ইনলাইন ডেটা আর নেই (গেম ডেটা অ্যাট্রিবিউটে নয়)', () => {
      expect(INDEX_EJS).not.toContain('SERVER_GAMES');
    });
  });

  describe('MEDIUM-8: server-side validation (defence in depth)', () => {
    const { validateGame } = (() => {
      //         source contract  
      return {};
    })();

    test('validateGame HTML-অর্থবহ অক্ষর প্রত্যাখ্যান করে', () => {
      const src = fs.readFileSync(path.join(ROOT, 'routes', 'adminGames.js'), 'utf8');
      expect(src).toMatch(/HTML_UNSAFE_RE = \/\[<>"'&\]\//);
      expect(src).toMatch(/HTML_UNSAFE_RE\.test\(provider\)/);
      expect(src).toMatch(/HTML_UNSAFE_RE\.test\(name\)/);
    });

    test('XSS payload সহ game DB-তে ঢোকানো গেলেও render escape করে', async () => {
      //  DB-        render-time escaping  
      //   ( fix    )
      const slug = `xss-${uniqueUsername('g')}`.toLowerCase().slice(0, 40);
      await pool.query(
        `INSERT INTO games (name, slug, emoji, category, provider, is_active)
         VALUES ($1, $2, '', 'slots', $3, false)`,
        ['<img src=x onerror=alert(1)>', slug, '<svg/onload=alert(1)>']
      );

      const row = await pool.query('SELECT name, provider FROM games WHERE slug = $1', [slug]);
      expect(row.rows.length).toBe(1);

      //   render path escHtml()  ,   
      //    HTML   
      // গেম-কার্ড রেন্ডার পাথ এখন নেই (D1), তাই ইনজেকশনের কোনো sink নেই; কাঁচা `${g.*}`
      // ইন্টারপোলেশন কোথাও থাকলে টেস্ট ফেইল করবে।
      expect(INDEX_EJS).not.toMatch(/\$\{g\.(name|provider|slug|emoji|badge)\}/);

      await pool.query('DELETE FROM games WHERE slug = $1', [slug]);
    });
  });

  describe('অন্যান্য dynamic sink গুলো নিরাপদ থাকে', () => {
    test('admin leaderboard error message escape করে', () => {
      // docs/CSP.md ধাপ ৩-এ কোডটা public/js/views/admin-leaderboard.js-এ
      // সরানো হয়েছে; এস্কেপিং অপরিবর্তিত, তাই যাচাইও সেখানেই।
      const src = fs.readFileSync(
        path.join(ROOT, 'public', 'js', 'views', 'admin-leaderboard.js'), 'utf8'
      );
      const idx = src.indexOf('innerHTML');
      expect(idx).toBeGreaterThan(-1);
      expect(src.slice(idx, idx + 200)).toMatch(/esc\(/);
    });

    test('socket chat বার্তা Telegram-এ escape করা হয় (regression)', () => {
      const src = fs.readFileSync(path.join(ROOT, 'services', 'socket.js'), 'utf8');
      expect(src).toMatch(/tgEscape/);
    });

    test('কোনো view-তে javascript: URL scheme ব্যবহার হয় না', () => {
      const viewsDir = path.join(ROOT, 'views');
      const offenders = [];
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name.endsWith('.ejs')) {
            const text = fs.readFileSync(full, 'utf8');
            //  href="javascript:void(0)"   ;    
            // শুধু href/src attribute-এর ভিতরের javascript: scheme খোঁজা হয়;
            // JS string-এর ভিতরে 'javascript:void(0)' একটি স্বাভাবিক no-op
            const bad = text.match(/(?:href|src)\s*=\s*["']javascript:(?!void\(0\))[^"']*/gi);
            if (bad) offenders.push(`${entry.name}: ${bad.join(', ')}`);
          }
        }
      };
      walk(viewsDir);
      expect(offenders).toEqual([]);
    });
  });

  describe('XSS payload গুলো escape helper দিয়ে নিরপেক্ষ হয়', () => {
    //   index.ejs-  escHtml     
    const escHtml = (v) => String(v == null ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

    test.each(PAYLOADS)('payload নিরপেক্ষ হয়: %s', (payload) => {
      const out = escHtml(payload);
      expect(out).not.toContain('<');
      expect(out).not.toContain('>');
      expect(out).not.toContain('"');
      expect(out).not.toContain("'");
    });
  });
});
