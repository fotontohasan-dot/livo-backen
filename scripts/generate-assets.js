#!/usr/bin/env node
/* ==========================================================================
   Livo — Reference Asset Generator
   রেফারেন্স স্ক্রিনশটের ভিজ্যুয়াল ল্যাঙ্গুয়েজে original SVG আর্টওয়ার্ক তৈরি করে।
   কোনো তৃতীয় পক্ষের ব্র্যান্ড/ক্লাব লোগো বা প্রোভাইডার গেম আর্ট কপি করা হয় না —
   সবই generic, in-house, Livo palette-এ আঁকা।

   চালাতে:  node scripts/generate-assets.js
   আউটপুট:  public/images/hero, public/images/games, public/images/sports
   ========================================================================== */

const fs = require('fs');
const path = require('path');

const C = {
  dark: '#0A1C14',
  surface: '#10291D',
  green: '#008F5A',
  greenDeep: '#006A4E',
  gold: '#D4A72C',
  goldLite: '#E9C25A',
  red: '#D62828',
  white: '#F2F5F3',
};

const OUT = path.join(__dirname, '..', 'public', 'images');
const write = (rel, svg) => {
  const p = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, svg.trim() + '\n', 'utf8');
  console.log('  ✓', path.relative(path.join(__dirname, '..'), p));
};

const svg = (w, h, body, extra = '') => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img">
${extra}
${body}
</svg>`;

/* ---------- shared defs ------------------------------------------------- */
const goldGrad = (id = 'g') => `
  <linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${C.gold}"/><stop offset="1" stop-color="${C.goldLite}"/>
  </linearGradient>`;
const greenGrad = (id = 'gr') => `
  <linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${C.greenDeep}"/><stop offset="1" stop-color="${C.green}"/>
  </linearGradient>`;
const cardBg = (id = 'bg') => `
  <linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#123526"/><stop offset="1" stop-color="#07130D"/>
  </linearGradient>`;

/* ==========================================================================
   1. HERO — welcome bonus gift artwork (banner-এর ডান পাশে বসে)
   ========================================================================== */
function hero() {
  const confetti = [
    [292, 40, C.gold, 8], [330, 74, C.red, 6], [258, 96, C.goldLite, 5],
    [352, 132, C.green, 7], [244, 150, C.gold, 6], [368, 62, C.white, 4],
    [222, 62, C.red, 5], [312, 176, C.goldLite, 6],
  ].map(([x, y, c, s]) =>
    `<rect x="${x}" y="${y}" width="${s}" height="${s * 1.6}" rx="1.5" fill="${c}" opacity=".85" transform="rotate(${(x + y) % 70 - 35} ${x} ${y})"/>`
  ).join('\n  ');

  return svg(420, 260, `
  <rect width="420" height="260" fill="none"/>
  <ellipse cx="300" cy="150" rx="120" ry="96" fill="url(#glow)"/>
  ${confetti}
  <!-- gift box -->
  <rect x="232" y="132" width="140" height="96" rx="8" fill="url(#box)"/>
  <rect x="222" y="106" width="160" height="34" rx="7" fill="url(#lid)"/>
  <rect x="292" y="106" width="22" height="122" fill="url(#gold)"/>
  <rect x="222" y="116" width="160" height="14" fill="url(#gold)" opacity=".95"/>
  <path d="M303 106c-18-4-30-16-26-28 3-9 15-10 22-3 6 6 8 18 4 31z" fill="url(#gold)"/>
  <path d="M303 106c18-4 30-16 26-28-3-9-15-10-22-3-6 6-8 18-4 31z" fill="url(#gold)"/>
  <circle cx="303" cy="82" r="7" fill="${C.goldLite}"/>
  <!-- 100% BONUS seal -->
  <circle cx="150" cy="150" r="58" fill="url(#seal)" stroke="${C.gold}" stroke-width="3"/>
  <text x="150" y="145" text-anchor="middle" font-family="Teko, Arial, sans-serif" font-size="38" font-weight="700" fill="${C.goldLite}">100%</text>
  <text x="150" y="172" text-anchor="middle" font-family="Teko, Arial, sans-serif" font-size="20" font-weight="600" letter-spacing="3" fill="${C.white}">BONUS</text>
  `, `<defs>
  ${goldGrad('gold')}
  <radialGradient id="glow"><stop offset="0" stop-color="${C.gold}" stop-opacity=".28"/><stop offset="1" stop-color="${C.gold}" stop-opacity="0"/></radialGradient>
  <linearGradient id="box" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1E7A4F"/><stop offset="1" stop-color="#0C4630"/></linearGradient>
  <linearGradient id="lid" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2A9463"/><stop offset="1" stop-color="#146A45"/></linearGradient>
  <radialGradient id="seal"><stop offset="0" stop-color="#14432E"/><stop offset="1" stop-color="#07160F"/></radialGradient>
  </defs>`);
}


/* ---------- Mega Jackpot banner artwork -------------------------------- */
function jackpot() {
  return svg(360, 200, `
  <rect width="360" height="200" rx="14" fill="url(#jb)"/>
  <ellipse cx="180" cy="100" rx="150" ry="86" fill="url(#jglow)"/>
  <rect x="86" y="46" width="188" height="108" rx="14" fill="#0B0605" stroke="url(#g)" stroke-width="4"/>
  ${[0, 1, 2].map(i => `<rect x="${104 + i * 56}" y="62" width="44" height="76" rx="7" fill="#1B0C0A"/>
    <text x="${126 + i * 56}" y="116" text-anchor="middle" font-family="Teko, Arial, sans-serif" font-size="42" font-weight="700" fill="url(#g)">7</text>`).join('')}
  <rect x="86" y="160" width="188" height="10" rx="5" fill="url(#g)"/>
  <circle cx="288" cy="96" r="14" fill="${C.red}" stroke="url(#g)" stroke-width="3"/>
  <rect x="284" y="52" width="8" height="44" rx="4" fill="url(#g)"/>
  ${[[44, 40], [312, 44], [56, 158], [320, 152], [180, 24]].map(([x, y], i) =>
    `<circle cx="${x}" cy="${y}" r="${3 + (i % 3)}" fill="${C.goldLite}" opacity=".8"/>`).join('')}
  `, `<defs>${goldGrad()}
  <linearGradient id="jb" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4A0F0F"/><stop offset="1" stop-color="#180707"/></linearGradient>
  <radialGradient id="jglow"><stop offset="0" stop-color="${C.gold}" stop-opacity=".22"/><stop offset="1" stop-color="${C.gold}" stop-opacity="0"/></radialGradient>
  </defs>`);
}

/* ==========================================================================
   2. GAME THUMBNAILS — ক্যাটাগরি-ভিত্তিক generic আর্ট (১:১, কার্ডের সাথে ম্যাচ)
   ========================================================================== */
const S = 300;

/* একই ক্যাটাগরির দুটি গেম যেন হুবহু এক না দেখায় — slug থেকে স্থিতিশীল
   accent টোন ও ব্যাকড্রপ ভ্যারিয়েশন তৈরি হয়। */
let CURRENT = 'livo';
const TONES = ['#D62828', '#008F5A', '#1F6FB2', '#D4A72C', '#5B2E8F', '#0F766E', '#B45309', '#0E7490'];
const hashOf = (str) => [...str].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);

const frame = (inner, defs = '') => {
  const h = hashOf(CURRENT);
  const tone = TONES[h % TONES.length];
  const ang = h % 360;
  return svg(S, S, `
  <rect width="${S}" height="${S}" rx="18" fill="url(#bg)"/>
  <g opacity=".30">
    <circle cx="${40 + (h % 220)}" cy="${40 + (h >> 3) % 220}" r="${90 + (h % 60)}" fill="${tone}" opacity=".38"/>
    <path d="M0 ${170 + (h % 60)} q75 -${30 + (h % 40)} 150 0 t150 0 V300 H0 Z" fill="${tone}" opacity=".22"/>
  </g>
  <g transform="rotate(${ang % 12 - 6} 150 150)">${inner}</g>
  <rect x="1" y="1" width="${S - 2}" height="${S - 2}" rx="17" fill="none" stroke="#1E4633"/>`,
  `<defs>${cardBg()}${goldGrad()}${greenGrad()}${defs}</defs>`);
};

const art = {
  crash: () => frame(`
    <path d="M20 250 C90 235 140 190 180 120 C200 84 214 60 226 44" stroke="${C.red}" stroke-width="6" fill="none" stroke-linecap="round"/>
    <path d="M20 250 C90 235 140 190 180 120 C200 84 214 60 226 44 L226 250 Z" fill="${C.red}" opacity=".14"/>
    <g transform="translate(214 34) rotate(-38)">
      <path d="M0 -20 L14 16 L0 8 L-14 16 Z" fill="url(#g)"/>
    </g>
    <circle cx="70" cy="86" r="3" fill="${C.white}" opacity=".5"/>
    <circle cx="120" cy="54" r="2.5" fill="${C.white}" opacity=".35"/>
    <circle cx="252" cy="120" r="2.5" fill="${C.white}" opacity=".35"/>`),

  slots: () => frame(`
    <rect x="46" y="70" width="208" height="130" rx="14" fill="#08170F" stroke="url(#g)" stroke-width="3"/>
    ${[0, 1, 2].map(i => `<rect x="${62 + i * 62}" y="86" width="50" height="98" rx="8" fill="#0F3324"/>`).join('')}
    ${[0, 1, 2].map(i => `<text x="${87 + i * 62}" y="146" text-anchor="middle" font-family="Teko, Arial, sans-serif" font-size="44" font-weight="700" fill="url(#g)">7</text>`).join('')}
    <rect x="46" y="206" width="208" height="10" rx="5" fill="url(#gr)"/>
    <circle cx="264" cy="118" r="12" fill="${C.red}"/>`),

  wheel: () => frame(`
    <circle cx="150" cy="150" r="92" fill="#08170F" stroke="url(#g)" stroke-width="4"/>
    ${Array.from({ length: 12 }, (_, i) => {
      const a1 = (i * 30 - 90) * Math.PI / 180, a2 = ((i + 1) * 30 - 90) * Math.PI / 180;
      const col = i % 3 === 0 ? C.gold : (i % 3 === 1 ? C.greenDeep : C.red);
      return `<path d="M150 150 L${(150 + 88 * Math.cos(a1)).toFixed(1)} ${(150 + 88 * Math.sin(a1)).toFixed(1)} A88 88 0 0 1 ${(150 + 88 * Math.cos(a2)).toFixed(1)} ${(150 + 88 * Math.sin(a2)).toFixed(1)} Z" fill="${col}" opacity=".85"/>`;
    }).join('')}
    <circle cx="150" cy="150" r="26" fill="#08170F" stroke="url(#g)" stroke-width="3"/>
    <path d="M150 34 l12 22 h-24 z" fill="${C.white}"/>`),

  cards: () => frame(`
    <g transform="rotate(-14 150 160)"><rect x="66" y="90" width="98" height="140" rx="12" fill="${C.white}"/>
      <text x="82" y="122" font-family="Georgia, serif" font-size="26" fill="${C.red}">A</text>
      <path d="M115 180 l24 24 -24 24 -24-24z" fill="${C.red}"/></g>
    <g transform="rotate(12 150 160)"><rect x="140" y="86" width="98" height="140" rx="12" fill="${C.white}"/>
      <text x="156" y="118" font-family="Georgia, serif" font-size="26" fill="#111">K</text>
      <path d="M189 176 c-16-18-34-4-24 12 6 10 24 22 24 22s18-12 24-22c10-16-8-30-24-12z" fill="#111"/></g>`),

  roulette: () => frame(`
    <circle cx="150" cy="150" r="94" fill="#08170F" stroke="url(#g)" stroke-width="4"/>
    ${Array.from({ length: 18 }, (_, i) => {
      const a1 = (i * 20 - 90) * Math.PI / 180, a2 = ((i + 1) * 20 - 90) * Math.PI / 180;
      return `<path d="M150 150 L${(150 + 90 * Math.cos(a1)).toFixed(1)} ${(150 + 90 * Math.sin(a1)).toFixed(1)} A90 90 0 0 1 ${(150 + 90 * Math.cos(a2)).toFixed(1)} ${(150 + 90 * Math.sin(a2)).toFixed(1)} Z" fill="${i % 2 ? C.red : '#111A15'}"/>`;
    }).join('')}
    <circle cx="150" cy="150" r="46" fill="#0C2318" stroke="url(#g)" stroke-width="2"/>
    <circle cx="150" cy="150" r="16" fill="url(#g)"/>
    <circle cx="206" cy="104" r="9" fill="${C.white}"/>`),

  dice: () => frame(`
    <g transform="rotate(-12 120 160)"><rect x="66" y="110" width="106" height="106" rx="18" fill="${C.white}"/>
      ${[[96, 140], [142, 140], [96, 186], [142, 186], [119, 163]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="9" fill="${C.red}"/>`).join('')}</g>
    <g transform="rotate(16 200 130)"><rect x="156" y="72" width="88" height="88" rx="16" fill="url(#g)"/>
      ${[[182, 98], [218, 98], [182, 134], [218, 134]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="7.5" fill="#0A1C14"/>`).join('')}</g>`),

  board: () => frame(`
    <rect x="60" y="60" width="180" height="180" rx="14" fill="#08170F" stroke="url(#g)" stroke-width="3"/>
    <rect x="60" y="60" width="90" height="90" fill="${C.red}" opacity=".85"/>
    <rect x="150" y="60" width="90" height="90" fill="${C.green}" opacity=".85"/>
    <rect x="60" y="150" width="90" height="90" fill="${C.gold}" opacity=".85"/>
    <rect x="150" y="150" width="90" height="90" fill="#1F6FB2" opacity=".85"/>
    <rect x="126" y="126" width="48" height="48" rx="8" fill="#08170F" stroke="url(#g)" stroke-width="2"/>
    ${[[105, 105], [195, 105], [105, 195], [195, 195]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="15" fill="#08170F" opacity=".55"/>`).join('')}`),

  mines: () => frame(`
    ${Array.from({ length: 9 }, (_, i) => `<rect x="${64 + (i % 3) * 62}" y="${64 + Math.floor(i / 3) * 62}" width="52" height="52" rx="10" fill="#0F3324" stroke="#1E4633"/>`).join('')}
    <circle cx="150" cy="150" r="20" fill="#0B0B0B"/>
    <rect x="147" y="118" width="6" height="16" rx="3" fill="url(#g)"/>
    <path d="M150 112 l6 -10 M150 112 l-8 -8" stroke="${C.red}" stroke-width="3" stroke-linecap="round"/>
    <circle cx="142" cy="143" r="5" fill="#3A3A3A"/>`),

  fishing: () => frame(`
    <path d="M0 210 q75 -22 150 0 t150 0 v90 H0 z" fill="${C.greenDeep}" opacity=".35"/>
    <g transform="translate(150 140)">
      <path d="M-56 0 q28 -40 74 -22 q28 12 34 22 q-6 10 -34 22 q-46 18 -74 -22 z" fill="url(#g)"/>
      <path d="M-56 0 l-30 -24 v48 z" fill="${C.goldLite}"/>
      <circle cx="30" cy="-6" r="5" fill="#0A1C14"/>
    </g>
    <circle cx="74" cy="96" r="6" fill="${C.white}" opacity=".3"/>
    <circle cx="96" cy="72" r="4" fill="${C.white}" opacity=".22"/>`),

  keno: () => frame(`
    ${[[104, 108, C.gold, '7'], [166, 96, C.red, '21'], [128, 172, C.green, '33'], [196, 168, '#1F6FB2', '45']]
      .map(([x, y, c, n]) => `<circle cx="${x}" cy="${y}" r="34" fill="${c}"/><text x="${x}" y="${y + 10}" text-anchor="middle" font-family="Teko, Arial, sans-serif" font-size="30" font-weight="700" fill="#08170F">${n}</text>`).join('')}`),


  egypt: () => frame(`
    <path d="M150 62 L246 226 H54 Z" fill="url(#g)"/>
    <path d="M150 62 L246 226 H150 Z" fill="#000" opacity=".18"/>
    <path d="M120 226 v-52 a30 30 0 0 1 60 0 v52 z" fill="#08170F"/>
    <circle cx="150" cy="192" r="9" fill="url(#g)"/>
    <circle cx="150" cy="52" r="16" fill="${C.goldLite}" opacity=".55"/>
    <path d="M40 232 h220" stroke="url(#g)" stroke-width="4" stroke-linecap="round"/>`),

  gems: () => frame(`
    ${[[150, 96, 44, C.red], [104, 176, 34, '#1F6FB2'], [196, 176, 34, C.green]].map(([x, y, r, c]) =>
      `<g><path d="M${x} ${y - r} L${x + r} ${y} L${x} ${y + r} L${x - r} ${y} Z" fill="${c}"/>
       <path d="M${x} ${y - r} L${x + r} ${y} L${x} ${y} Z" fill="#fff" opacity=".28"/></g>`).join('')}
    <circle cx="150" cy="150" r="118" fill="none" stroke="url(#g)" stroke-width="2" opacity=".35"/>`),

  fruit: () => frame(`
    <circle cx="120" cy="164" r="52" fill="${C.red}"/>
    <path d="M120 112 q10 -22 30 -26 q-8 20 -26 28z" fill="${C.green}"/>
    <circle cx="196" cy="188" r="34" fill="${C.gold}"/>
    <circle cx="106" cy="150" r="12" fill="#fff" opacity=".25"/>
    <path d="M60 226 h180" stroke="url(#g)" stroke-width="4" stroke-linecap="round"/>`),

  animal: () => frame(`
    <circle cx="150" cy="158" r="62" fill="${C.gold}"/>
    <path d="M96 116 l-8 -34 34 16z M204 116 l8 -34 -34 16z" fill="${C.gold}"/>
    <circle cx="128" cy="148" r="8" fill="#08170F"/><circle cx="172" cy="148" r="8" fill="#08170F"/>
    <path d="M138 186 q12 12 24 0" stroke="#08170F" stroke-width="5" fill="none" stroke-linecap="round"/>
    <path d="M150 166 l-10 8 h20z" fill="#08170F"/>
    <path d="M96 150 h-24 M204 150 h24" stroke="#08170F" stroke-width="3" opacity=".55"/>`),

  western: () => frame(`
    <path d="M62 168 q88 -46 176 0 q-12 26 -88 26 t-88 -26z" fill="#6B4A22"/>
    <path d="M104 168 q0 -62 46 -62 t46 62z" fill="#8A6130"/>
    <path d="M104 154 h92" stroke="url(#g)" stroke-width="7"/>
    <circle cx="150" cy="216" r="9" fill="url(#g)"/>
    <path d="M46 92 l10 22 24 4 -18 16 5 24 -21 -12 -21 12 5 -24 -18 -16 24 -4z" fill="url(#g)" opacity=".8"/>`),

  space: () => frame(`
    <circle cx="150" cy="152" r="46" fill="#1F6FB2"/>
    <ellipse cx="150" cy="152" rx="86" ry="22" fill="none" stroke="url(#g)" stroke-width="7" transform="rotate(-18 150 152)"/>
    <circle cx="132" cy="136" r="10" fill="#fff" opacity=".2"/>
    ${[[64, 70], [232, 88], [88, 226], [222, 214], [150, 52]].map(([x, y], i) =>
      `<circle cx="${x}" cy="${y}" r="${2 + (i % 3)}" fill="${C.white}" opacity=".7"/>`).join('')}`),

  money: () => frame(`
    ${[0, 1, 2].map(i => `<g transform="rotate(${i * 8 - 8} 150 ${150 + i * 6})">
      <rect x="${74 + i * 4}" y="${112 + i * 22}" width="152" height="62" rx="8" fill="#12603F" stroke="url(#g)" stroke-width="2"/>
      <circle cx="150" cy="${143 + i * 22}" r="18" fill="none" stroke="url(#g)" stroke-width="2"/>
      <text x="150" y="${151 + i * 22}" text-anchor="middle" font-family="Teko, Arial, sans-serif" font-size="26" font-weight="700" fill="url(#g)">৳</text>
    </g>`).join('')}`),

  ball: () => frame(`
    <circle cx="150" cy="150" r="96" fill="none" stroke="url(#g)" stroke-width="3" opacity=".4"/>
    ${[[112, 118, C.red, '8'], [188, 118, C.green, '19'], [112, 190, '#1F6FB2', '27'], [188, 190, C.gold, '36']]
      .map(([x, y, c, n]) => `<circle cx="${x}" cy="${y}" r="32" fill="${c}"/>
      <circle cx="${x}" cy="${y}" r="18" fill="#fff" opacity=".92"/>
      <text x="${x}" y="${y + 8}" text-anchor="middle" font-family="Teko, Arial, sans-serif" font-size="24" font-weight="700" fill="#08170F">${n}</text>`).join('')}`),

  table: () => frame(`
    <path d="M40 210 q110 -108 220 0 z" fill="#0E4A33" stroke="url(#g)" stroke-width="3"/>
    <path d="M74 196 q76 -68 152 0" stroke="url(#g)" stroke-width="2" fill="none" opacity=".6"/>
    <g transform="rotate(-10 132 150)"><rect x="106" y="120" width="52" height="72" rx="7" fill="#fff"/>
      <text x="118" y="144" font-family="Georgia, serif" font-size="18" fill="${C.red}">A</text></g>
    <g transform="rotate(10 176 150)"><rect x="150" y="118" width="52" height="72" rx="7" fill="#fff"/>
      <text x="162" y="142" font-family="Georgia, serif" font-size="18" fill="#111">J</text></g>
    <circle cx="72" cy="226" r="14" fill="${C.red}" stroke="#fff" stroke-width="3"/>
    <circle cx="228" cy="226" r="14" fill="#1F6FB2" stroke="#fff" stroke-width="3"/>`),

  plinko: () => frame(`
    ${Array.from({ length: 4 }, (_, r) => Array.from({ length: r + 3 }, (_, c) => {
      const x = 150 - (r + 2) * 22 + c * 44, y = 96 + r * 40;
      return `<circle cx="${x}" cy="${y}" r="6" fill="url(#g)" opacity=".9"/>`;
    }).join('')).join('')}
    <circle cx="128" cy="72" r="12" fill="${C.red}"/>
    <path d="M128 84 q-16 40 6 76 q16 26 -4 58" stroke="${C.red}" stroke-width="2.5" fill="none" opacity=".55" stroke-dasharray="5 5"/>`),

  generic: (slug = 'livo') => {
    const H = [...slug].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
    const tone = ['#D62828', '#008F5A', '#1F6FB2', '#D4A72C', '#5B2E8F', '#0F766E'][H % 6];
    const mono = slug.split('-').map(w => w[0]).join('').slice(0, 2).toUpperCase() || 'L';
    return frame(`
      <circle cx="150" cy="150" r="150" fill="${tone}" opacity=".16"/>
      <path d="M150 40 l${(H % 30) + 60} 60 -${(H % 20) + 40} 110 h-${(H % 40) + 80} z" fill="${tone}" opacity=".55"/>
      <circle cx="150" cy="150" r="62" fill="#08170F" stroke="url(#g)" stroke-width="3"/>
      <text x="150" y="172" text-anchor="middle" font-family="Teko, Arial, sans-serif" font-size="54" font-weight="700" fill="url(#g)">${mono}</text>`);
  },
};

/* slug/নাম → আর্ট ম্যাপিং (কীওয়ার্ড-ভিত্তিক, নতুন গেম যোগ হলেও কাজ করে) */
const RULES = [
  [/aviator|crash|jet|rocket|spaceman|fly/i, 'crash'],
  [/roulette|dragon-?tiger|fan-?tan/i, 'roulette'],
  [/wheel|crazy-?time|dream-?catcher|monopoly|spin/i, 'wheel'],
  [/blackjack|poker|teen-?patti|andar|rummy|call-?break|baccarat|bac-?bo|card/i, 'table'],
  [/dice|sic-?bo|hilo/i, 'dice'],
  [/ludo|chess|board|carrom|snake/i, 'board'],
  [/mine|tower|goal/i, 'mines'],
  [/plinko/i, 'plinko'],
  [/fish|shark|ocean/i, 'fishing'],
  [/keno|lottery|bingo|mega-?ball|ball|number|color-?prediction/i, 'ball'],
  [/egypt|dead|pharaoh|cleopatra|empire|anubis|ra\b|sphinx/i, 'egypt'],
  [/starburst|star|gem|jewel|diamond|crystal|solar|sakura|bloom/i, 'gems'],
  [/bonanza|fruit|sweet|candy|cherry|watermelon|juice/i, 'fruit'],
  [/tiger|dog|piggy|bandito|panda|buffalo|wolf|lion|dragon|beast|zoo/i, 'animal'],
  [/west|wanted|cowboy|bandit|gold-?rush|gonzo|quest|viking|adventure/i, 'western'],
  [/space|galaxy|cosmic|moon|nova|alien|orbit/i, 'space'],
  [/money|cash|coin|bank|train|moolah|riches|fortune|wealth|super-?ace|mental|larry/i, 'money'],
  [/slot|megaways|reel|777|jackpot|luck/i, 'slots'],
];
const artFor = (slug) => (RULES.find(([re]) => re.test(slug)) || [null, 'generic'])[1];

/* ==========================================================================
   3. SPORTS / LEAGUE MARKS — generic crest ও খেলার আইকন
   কোনো আসল ক্লাব বা লিগের লোগো নয়; দল-নির্দিষ্ট ব্যাজ রানটাইমে
   public/js/team-crest.js দিয়ে initials থেকে আঁকা হয়।
   ========================================================================== */
const sportIcon = (inner, ring = C.green) => svg(96, 96, `
  <circle cx="48" cy="48" r="46" fill="#0C2318" stroke="${ring}" stroke-width="3"/>
  ${inner}`, `<defs>${goldGrad()}${greenGrad()}</defs>`);

const sports = {
  football: () => sportIcon(`
    <circle cx="48" cy="48" r="28" fill="${C.white}"/>
    <path d="M48 30 l12 9 -4.5 14h-15L36 39z" fill="#111"/>
    ${[[48, 20], [24, 42], [33, 70], [63, 70], [72, 42]].map(([x, y]) =>
      `<path d="M${x} ${y} l7 5 -3 8h-8l-3-8z" fill="#111" opacity=".85"/>`).join('')}`),

  cricket: () => sportIcon(`
    <g transform="rotate(-38 48 48)">
      <rect x="43" y="18" width="10" height="30" rx="4" fill="#8A6A3A"/>
      <rect x="36" y="46" width="24" height="34" rx="9" fill="url(#g)"/>
    </g>
    <circle cx="68" cy="66" r="10" fill="${C.red}"/>
    <path d="M62 62 q6 4 0 9 M74 62 q-6 4 0 9" stroke="${C.white}" stroke-width="1.6" fill="none"/>`, C.gold),

  tennis: () => sportIcon(`
    <circle cx="48" cy="48" r="24" fill="#C6E85B"/>
    <path d="M28 34 q20 14 0 28 M68 34 q-20 14 0 28" stroke="${C.white}" stroke-width="2.5" fill="none"/>`),

  basketball: () => sportIcon(`
    <circle cx="48" cy="48" r="26" fill="#E07B2A"/>
    <path d="M22 48h52 M48 22v52 M30 28 q18 20 0 40 M66 28 q-18 20 0 40" stroke="#0A1C14" stroke-width="2.2" fill="none"/>`, C.red),

  live: () => sportIcon(`
    <circle cx="48" cy="48" r="9" fill="${C.red}"/>
    <path d="M32 32 a22 22 0 0 0 0 32 M64 32 a22 22 0 0 1 0 32" stroke="${C.red}" stroke-width="3.5" fill="none" stroke-linecap="round"/>
    <path d="M24 24 a34 34 0 0 0 0 48 M72 24 a34 34 0 0 1 0 48" stroke="${C.red}" stroke-width="3" fill="none" opacity=".5" stroke-linecap="round"/>`, C.red),

  tournament: () => sportIcon(`
    <path d="M34 26h28v14a14 14 0 0 1-28 0z" fill="url(#g)"/>
    <path d="M34 30h-8a10 10 0 0 0 10 10 M62 30h8a10 10 0 0 1-10 10" stroke="url(#g)" stroke-width="3" fill="none"/>
    <rect x="44" y="54" width="8" height="12" fill="url(#g)"/>
    <rect x="34" y="66" width="28" height="7" rx="3" fill="url(#g)"/>`, C.gold),
};

/* generic crest — দলের ব্যাজের placeholder (initials রানটাইমে বসে) */
const crest = () => svg(72, 72, `
  <path d="M36 3 L67 13 v27c0 17-13 26-31 32C18 66 5 57 5 40V13z" fill="url(#gr)" stroke="url(#g)" stroke-width="2.5"/>
  <path d="M36 3 L67 13 v27c0 17-13 26-31 32z" fill="#000" opacity=".12"/>`,
  `<defs>${goldGrad()}${greenGrad()}</defs>`);

/* ==========================================================================
   RUN
   ========================================================================== */
const SLUGS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['aviator', 'slots', 'color-prediction', 'crazy-time', 'fortune-tiger', 'sweet-bonanza',
     'gates-of-olympus', 'baccarat', 'roulette', 'dragon-tiger', 'teen-patti', 'andar-bahar',
     'online-ludo', 'mines', 'plinko', 'dice', 'keno', 'fishing', 'jetx', 'mega-wheel',
     'cricket-stars', 'spaceman'];

console.log('Livo asset generator');
write('hero/welcome-bonus.svg', hero());
write('hero/mega-jackpot.svg', jackpot());

const counts = {};
SLUGS.forEach(slug => {
  CURRENT = slug;
  const kind = artFor(slug);
  counts[kind] = (counts[kind] || 0) + 1;
  write(`games/${slug}.svg`, art[kind](slug));
});
CURRENT = 'livo';
write('games/_fallback.svg', art.generic('livo'));

Object.entries(sports).forEach(([name, fn]) => write(`sports/${name}.svg`, fn()));
write('sports/crest.svg', crest());

console.log('\nআর্ট ম্যাপিং:', counts);
console.log('মোট ফাইল:', 1 + SLUGS.length + 1 + Object.keys(sports).length + 1);
