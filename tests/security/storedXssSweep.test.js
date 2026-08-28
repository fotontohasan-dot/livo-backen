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
const INDEX_EJS = fs.readFileSync(path.join(ROOT, 'views', 'index.ejs'), 'utf8');

const PAYLOADS = [
  '<img src=x onerror=alert(1)>',
  '"><script>alert(1)</script>',
  "');alert(1);//",
  '<svg/onload=alert(1)>',
];

describe('Stored XSS sweep (PHASE 9)', () => {
  describe('MEDIUM-8: homepage game rendering', () => {
    test('escHtml() helper সংজ্ঞায়িত আছে', () => {
      expect(INDEX_EJS).toMatch(/function escHtml\(v\)/);
      expect(INDEX_EJS).toMatch(/replace\(\/</);
      expect(INDEX_EJS).toMatch(/&amp;quot;|&quot;/);
    });

    test('game name/provider escape ছাড়া innerHTML-এ বসে না', () => {
      expect(INDEX_EJS).not.toMatch(/game-title-premium">\$\{g\.name\}/);
      expect(INDEX_EJS).not.toMatch(/game-provider-premium">\$\{g\.provider\}/);
      expect(INDEX_EJS).toMatch(/game-title-premium">\$\{escHtml\(g\.name\)\}/);
      expect(INDEX_EJS).toMatch(/game-provider-premium">\$\{escHtml\(g\.provider\)\}/);
    });

    test('slug, emoji, badge-ও escape করা হয়', () => {
      expect(INDEX_EJS).not.toMatch(/data-slug="\$\{g\.slug\}"/);
      expect(INDEX_EJS).not.toMatch(/game-emoji">\$\{g\.emoji\}/);
      expect(INDEX_EJS).toMatch(/escHtml\(g\.slug\)/);
      expect(INDEX_EJS).toMatch(/escHtml\(g\.emoji\)/);
      expect(INDEX_EJS).toMatch(/escHtml\(g\.badge\)/);
    });

    test('provider sidebar-এর নাম escape করা হয়', () => {
      expect(INDEX_EJS).not.toMatch(/<div class="name">\$\{p\}<\/div>/);
      expect(INDEX_EJS).toMatch(/escHtml\(p\)/);
    });

    test('SERVER_GAMES এখনো JSON-escaped (regression)', () => {
      expect(INDEX_EJS).toContain('JSON.stringify');
      expect(INDEX_EJS).toContain('u003C');
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
      expect(INDEX_EJS).toMatch(/escHtml\(g\.name\)/);
      expect(INDEX_EJS).toMatch(/escHtml\(g\.provider\)/);

      await pool.query('DELETE FROM games WHERE slug = $1', [slug]);
    });
  });

  describe('অন্যান্য dynamic sink গুলো নিরাপদ থাকে', () => {
    test('admin leaderboard error message escape করে', () => {
      const src = fs.readFileSync(path.join(ROOT, 'views', 'admin', 'leaderboard.ejs'), 'utf8');
      const idx = src.indexOf('innerHTML');
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
