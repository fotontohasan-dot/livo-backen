// match-detail.js: openSlip() আগে সংজ্ঞাহীন applySide() ডাকত → ReferenceError।
// jsdom ছাড়াই ন্যূনতম DOM স্টাব দিয়ে স্ক্রিপ্ট চালিয়ে Back/Lay স্লিপ খোলা যাচাই।
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '../../public/js/views/match-detail.js'), 'utf8');

function makeEl(attrs = {}) {
  const classes = new Set();
  const el = {
    textContent: '', value: '', hidden: false, disabled: false, className: '', style: {},
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      toggle: (c, on) => { (on === undefined ? !classes.has(c) : on) ? classes.add(c) : classes.delete(c); },
      contains: (c) => classes.has(c)
    },
    _classes: classes, _listeners: {},
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    setAttribute: (k, v) => { attrs[k] = v; },
    addEventListener: (ev, fn) => { (el._listeners[ev] = el._listeners[ev] || []).push(fn); },
    querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, focus() {}, select() {}
  };
  return el;
}

function run() {
  const els = {};
  const ids = ['bsOverlay', 'bsStake', 'bsError', 'bsPlace', 'bsMarket', 'bsPick', 'bsSideTag', 'bsOdd',
    'bsReturn', 'bsReturnLabel', 'bsLiabRow', 'bsLiab', 'bsLiabLabel', 'bsClose', 'bsCancel'];
  ids.forEach((id) => { els[id] = makeEl(); });
  els.bsReturnLabel.textContent = 'Potential return';
  const sheet = makeEl();
  els.bsOverlay.querySelector = (sel) => (sel === '.bs-sheet' ? sheet : null);
  const listeners = {};
  const document = {
    getElementById: (id) => els[id] || null,
    querySelectorAll: () => [],
    addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
    createElement: () => makeEl()
  };
  const ctx = { document, window: { crypto: { getRandomValues: (a) => a } }, console, setTimeout: () => 0, clearTimeout() {}, Uint8Array, Math, Date, Number, parseInt, parseFloat, String, JSON, Array };
  vm.runInNewContext(SRC, ctx);

  const click = (betType) => {
    const cell = makeEl();
    const btn = makeEl({ 'data-odd': '2.5', 'data-market-id': '7', 'data-runner': 'A', 'data-bet-type': betType, 'data-label': 'Team A', 'data-market-name': 'Match Odds' });
    btn.closest = (sel) => (sel === '.market-cell' ? cell : null);
    cell.querySelector = () => btn;
    const target = { closest: (sel) => (sel === '.market-cell' ? cell : sel === '.odds' ? btn : null) };
    listeners.click.forEach((fn) => fn({ target }));
  };
  return { els, sheet, click };
}

describe('match-detail bet slip — applySide', () => {
  test('Lay ক্লিকে ReferenceError ছাড়াই স্লিপ খোলে, is-lay ও LAY ট্যাগ বসে', () => {
    const { els, sheet, click } = run();
    expect(() => click('lay')).not.toThrow();
    expect(sheet._classes.has('is-lay')).toBe(true);
    expect(els.bsSideTag.textContent).toBe('LAY');
    expect(els.bsOverlay._classes.has('open')).toBe(true);
  });

  test('Lay-এর পর Back খুললে is-lay সরে যায়, BACK ট্যাগ ও আসল রিটার্ন লেবেল ফেরে', () => {
    const { els, sheet, click } = run();
    click('lay');
    click('back');
    expect(sheet._classes.has('is-lay')).toBe(false);
    expect(els.bsSideTag.textContent).toBe('BACK');
    expect(els.bsReturnLabel.textContent).toBe('Potential return');
  });
});
