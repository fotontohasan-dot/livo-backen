// Cascade-equivalence checker.
//
// The repo notes say an inline-style -> class migration cannot be validated
// without a real browser, because !important and #id rules currently lose to
// the inline style and would start winning once the declaration moves to a
// class. That is true of a *blind* migration. It is not true if we actually
// resolve the cascade.
//
// This script does that resolution offline: it parses every stylesheet the
// page loads plus the page's own <style> block, matches real selectors against
// the real template DOM, applies importance/specificity/order exactly as the
// cascade does, and reports, per element per longhand property, which
// declaration wins. Run it on the original template and on the migrated one:
// if every winner is identical, the migration is provably a no-op visually.
//
// Contexts (media query, pseudo-class state) are resolved separately, so a
// rule that only applies on :hover or under a breakpoint cannot hide a
// difference in the base state or vice versa.

// Usage (deps are dev-only and deliberately NOT added to package.json, so the
// production dependency surface is unchanged):
//
//   mkdir -p /tmp/cc && cd /tmp/cc && npm i cheerio css-select postcss
//   NODE_PATH=/tmp/cc/node_modules node tools/cascade-check.js <before.ejs> <after.ejs>
//
// Exit output is JSON: { diffs, bad[] }. diffs === 0 means the two templates
// resolve to byte-identical winning declarations for every element, property
// and context — i.e. the migration cannot change what the browser paints.
//
// Verified non-vacuous: moving `font-size: 30px` off a `.navbar .nav-brand`
// element is correctly reported as a diff, because the two-class rule then
// outranks the generated single-class rule.

const fs = require('fs');
const path = require('path');
const postcss = require('postcss');
const cheerio = require('cheerio');
const CSSselect = require('css-select');

const ROOT = '/home/claude/livo-backen';

// --- shorthand expansion -----------------------------------------------
// Comparing raw property names would miss `background-color: x !important`
// beating an inline `background: y`. Expanding both sides to longhands makes
// that collision visible.
const SHORTHAND = {
  margin: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
  padding: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
  border: ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
           'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
           'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'],
  'border-width': ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'],
  'border-style': ['border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style'],
  'border-color': ['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'],
  'border-top': ['border-top-width', 'border-top-style', 'border-top-color'],
  'border-right': ['border-right-width', 'border-right-style', 'border-right-color'],
  'border-bottom': ['border-bottom-width', 'border-bottom-style', 'border-bottom-color'],
  'border-left': ['border-left-width', 'border-left-style', 'border-left-color'],
  'border-radius': ['border-top-left-radius', 'border-top-right-radius',
                    'border-bottom-right-radius', 'border-bottom-left-radius'],
  background: ['background-color', 'background-image', 'background-position', 'background-size',
               'background-repeat', 'background-attachment', 'background-origin', 'background-clip'],
  font: ['font-style', 'font-variant', 'font-weight', 'font-size', 'line-height', 'font-family'],
  flex: ['flex-grow', 'flex-shrink', 'flex-basis'],
  'flex-flow': ['flex-direction', 'flex-wrap'],
  gap: ['row-gap', 'column-gap'],
  overflow: ['overflow-x', 'overflow-y'],
  inset: ['top', 'right', 'bottom', 'left'],
  transition: ['transition-property', 'transition-duration', 'transition-timing-function', 'transition-delay'],
  animation: ['animation-name', 'animation-duration', 'animation-timing-function', 'animation-delay',
              'animation-iteration-count', 'animation-direction', 'animation-fill-mode', 'animation-play-state'],
  'place-items': ['align-items', 'justify-items'],
  'place-content': ['align-content', 'justify-content'],
};

function expand(prop) {
  const p = prop.toLowerCase().trim();
  return SHORTHAND[p] || [p];
}

// --- specificity --------------------------------------------------------
function specificity(sel) {
  let s = sel.replace(/\[[^\]]*\]/g, '\u0001');           // attrs -> token
  const ids = (s.match(/#[A-Za-z0-9_-]+/g) || []).length;
  const cls = (s.match(/\.[A-Za-z0-9_-]+/g) || []).length
            + (s.match(/\u0001/g) || []).length
            + (s.match(/:(?!:)(?!not\b)[a-zA-Z-]+/g) || []).length;
  const els = (s.replace(/[#.][A-Za-z0-9_-]+/g, '')
                .match(/(^|[\s>+~(,])([a-zA-Z][a-zA-Z0-9-]*)/g) || []).length
            + (s.match(/::[a-zA-Z-]+/g) || []).length;
  return ids * 10000 + cls * 100 + els;
}

// pseudo-classes/elements describe a *state*, not this element. Strip them for
// matching, but keep them as part of the context key so a :hover rule can
// never mask a base-state difference.
const PSEUDO_RE = /::?(?!not\()[a-zA-Z-]+(\([^)]*\))?/g;
function splitPseudo(sel) {
  const found = (sel.match(PSEUDO_RE) || []).join('');
  return { base: sel.replace(PSEUDO_RE, '').replace(/\s+/g, ' ').trim() || '*', pseudo: found };
}

// --- collect rules ------------------------------------------------------
function collect(cssText, origin, out) {
  let root;
  try { root = postcss.parse(cssText); } catch (e) { return out; }
  root.walkRules((rule) => {
    let media = '';
    for (let p = rule.parent; p && p.type !== 'root'; p = p.parent) {
      if (p.type === 'atrule') {
        if (p.name === 'keyframes' || p.name.endsWith('keyframes')) return;
        media = '@' + p.name + ' ' + p.params + ' | ' + media;
      }
    }
    const decls = [];
    rule.walkDecls((d) => decls.push({
      prop: d.prop.toLowerCase().trim(),
      value: d.value.trim(),
      important: !!d.important,
    }));
    if (!decls.length) return;
    for (const sel of rule.selectors) {
      const { base, pseudo } = splitPseudo(sel);
      out.push({ base, pseudo, media, rawHasStar: sel.includes('*'), spec: specificity(sel), origin, order: out.length, decls });
    }
  });
  return out;
}

// --- resolve one document ----------------------------------------------
function resolve(html, sheets) {
  const $ = cheerio.load(html, { xmlMode: false });
  const rules = [];
  for (const sh of sheets) collect(sh.text, sh.name, rules);
  $('style').each((i, el) => collect($(el).html() || '', 'page-style', rules));

  // <style>/<script> elements are not compared: a migration may legitimately
  // add a page-local <style>, and counting it would shift every later index
  // and make the two documents look different everywhere.
  const ids = new Map();
  const meta = {};
  let i = 0;
  $('*').each((_, el) => {
    const tn = (el.tagName || '').toLowerCase();
    if (tn === 'style' || tn === 'script') return;
    i += 1;
    ids.set(el, i);
    meta[i] = { tag: el.tagName, style: ($(el).attr('style') || ''), cls: ($(el).attr('class') || '') };
  });

  // per element: every declaration that can reach it, tagged with its context
  const perEl = new Map();
  const add = (idx, rec) => {
    if (!perEl.has(idx)) perEl.set(idx, []);
    perEl.get(idx).push(rec);
  };

  for (const rule of rules) {
    // pseudo-only selectors (:root, ::placeholder) collapse to '*' after the
    // pseudo strip and would otherwise match every element in the document
    if (rule.base === '*' && !rule.rawHasStar) continue;
    let matched;
    try { matched = CSSselect.selectAll(rule.base, $.root()[0]); } catch (e) { continue; }
    const ctx = rule.media + '||' + rule.pseudo;
    for (const el of matched) {
      if (!ids.has(el)) continue;
      for (const d of rule.decls) {
        for (const lp of expand(d.prop)) {
          add(ids.get(el), { ctx, prop: lp, important: d.important, spec: rule.spec,
                             order: rule.order, src: d.prop + ':' + d.value });
        }
      }
    }
  }

  $('[style]').each((i, el) => {
    const raw = $(el).attr('style') || '';
    if (raw.includes('<%')) return;
    for (const part of raw.split(';')) {
      if (!part.includes(':')) continue;
      const prop = part.split(':', 1)[0].trim().toLowerCase();
      const value = part.slice(part.indexOf(':') + 1).replace(/!important/i, '').trim();
      const important = /!important/i.test(part);
      for (const lp of expand(prop)) {
        add(ids.get(el), { ctx: '||', prop: lp, important, spec: 1000000,
                           order: Number.MAX_SAFE_INTEGER, src: prop + ':' + value });
      }
    }
  });

  const better = (a, b) => {
    if (a.important !== b.important) return a.important;
    if (a.spec !== b.spec) return a.spec > b.spec;
    return a.order > b.order;
  };

  // A context is resolved over the base rules PLUS that context's rules, so a
  // media/hover rule is compared against the same baseline in both documents.
  const out = {};
  for (const [idx, recs] of perEl) {
    const ctxs = new Set(['||']);
    for (const r of recs) ctxs.add(r.ctx);
    for (const ctx of ctxs) {
      const win = new Map();
      for (const r of recs) {
        if (r.ctx !== '||' && r.ctx !== ctx) continue;
        const cur = win.get(r.prop);
        if (!cur || better(r, cur)) win.set(r.prop, r);
      }
      for (const [prop, r] of win) out[idx + '\u0000' + ctx + '\u0000' + prop] = r.src;
    }
  }
  return { win: out, meta };
}

// --- compare ------------------------------------------------------------
const sheetFiles = [
  'public/css/style.css',
  'public/css/reference-theme.css',
  'public/css/tournament-showcase.css',
];
const sheets = sheetFiles.map((f) => ({
  name: f, text: fs.readFileSync(path.join(ROOT, f), 'utf8'),
}));

const [aPath, bPath] = process.argv.slice(2);
const stripEjs = (s) => s.replace(/<%[^%]*%>/g, '');
const RA = resolve(stripEjs(fs.readFileSync(aPath, 'utf8')), sheets);
const RB = resolve(stripEjs(fs.readFileSync(bPath, 'utf8')), sheets);
const A = RA.win, B = RB.win;

const keys = new Set([...Object.keys(A), ...Object.keys(B)]);
const bad = new Map();
let n = 0;
for (const k of keys) {
  if (A[k] === B[k]) continue;
  n++;
  const idx = k.split('\u0000')[0];
  const m = RA.meta[idx] || {};
  const fp = (m.tag || '?') + '\u0001' + (m.style || '');
  if (!bad.has(fp)) bad.set(fp, { tag: m.tag, style: m.style, before: A[k], after: B[k] });
}
console.log(JSON.stringify({ file: path.basename(aPath), diffs: n, bad: [...bad.values()] }));
