// ক্লিনআপের "আক্রান্ত" শর্ত ↔ utils/holderName.js ভ্যালিডেটর: আসল Postgres-এ, বড় নির্ধারিত (deterministic) নমুনায়।
// নিয়ম: ভ্যালিডেটর যা প্রত্যাখ্যান করে ক্লিনআপ তা ধরে; ভ্যালিডেটর যা গ্রহণ করে (বাংলা স্বরচিহ্ন/হসন্ত/ZWJ/ZWNJ সহ)
// ক্লিনআপ তা কখনো ছোঁয় না। একমাত্র ইচ্ছাকৃত ব্যতিক্রম: NULL/ফাঁকা/শুধু-স্পেস — এতে মোছার মতো কোনো গোপন মান নেই।
const { Client, Pool } = require('pg');
const { run, scanAffected, BACKUP_TABLE } = require('../../scripts/cleanupBankCardHolderName');
const { validateHolderName } = require('../../utils/holderName');

const BASE = process.env.DATABASE_URL;
const urlFor = (db) => { const u = new URL(BASE); u.pathname = '/' + db; return u.toString(); };
const ZWJ = '\u200d';
const ZWNJ = '\u200c';

// নির্ধারিত নমুনা: নামের সত্যিকারের ধরন + প্রান্তিক কেস
const FIXED = [
  'মোহাম্মদ রফিকুল ইসলাম', 'ফাতেমা খাতুন', 'আব্দুল্লাহ', 'শ্রীমতী কৃষ্ণা', 'রাজ্জাক', 'র‍্যাব আলী', `র${ZWJ}্যাব আলী`, `কার${ZWNJ}্য সম্পাদক`,
  'Md. Rahim', "O'Brien", 'O’Brien', 'Anne-Marie', 'José Álvarez', 'Cafe\u0301 Noir', '李小龍', 'আলি', 'Ana',
  // হসন্ত/স্বরচিহ্ন দিয়ে শেষ বা শুরু হওয়া (\p{M} শুরুতে বৈধ নয়, শেষে বৈধ)
  'ক্', 'কি', 'ি', '্', 'ক\u09cd', '\u09cdক', `${ZWJ}ক`, `ক${ZWJ}`, `${ZWNJ}${ZWNJ}`,
  // পাসওয়ার্ড-সদৃশ ও অন্যান্য অবৈধ
  'Pass1234', 'P@ssw0rd!', '12345678', '১২৩৪৫৬', 'নাম১২৩', 'name_1', 'a', 'ক', 'x'.repeat(61), '-name', '.name', "'name",
  '<b>x</b>', '😀 smile', 'a\nb', 'a\tb', '\tRahim\n', '\u00a0\u00a0', '\t', '\n', '\u200b\u200b', '..', '--',
  // ফাঁকা/শুধু-স্পেস (ইচ্ছাকৃত ব্যতিক্রম), এবং স্পেস ঘেরা বৈধ/অবৈধ
  '', ' ', '   ', '        ', '  Rahim   Uddin  ', '  Pass1234  ',
];

// seed-যুক্ত LCG: একই নমুনা প্রতিবার
function makeRng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; }; }
const ALPHABET = [
  ...'কখগঘঙচছজঝঞটঠডঢণতথদধনপফবভমযরলশষসহড়ঢ়য়ৎংঃঁ', ...'ািীুূৃেৈোৌ', '\u09cd', ZWJ, ZWNJ,
  ...'abcdefghijklmnopqrstuvwxyzABCXYZéÁ', ...'0123456789১২৩৪', ...' .\'’-', ...'@#_!$%&*', ' ', ' ', '\t', '\n', '\u00a0', '😀', '李', '<', '>',
];
function generated(count, seed) {
  const rnd = makeRng(seed); const out = new Set();
  while (out.size < count) {
    const len = Math.floor(rnd() * 8) + (rnd() < 0.1 ? 55 : 1); // বেশিরভাগ ছোট, কিছু ৬০-এর কাছাকাছি/ওপরে
    let s = '';
    for (let i = 0; i < len; i += 1) s += ALPHABET[Math.floor(rnd() * ALPHABET.length)];
    out.add(s);
  }
  return [...out];
}

// Postgres BTRIM শুধু ASCII স্পেস ছাঁটে — স্ক্রিপ্টের NON_BLANK_WHERE-এর হুবহু JS রূপ
const isBlankLikeSql = (v) => v === null || v.replace(/ /g, '') === '';
// TEXT-এ NUL রাখা যায় না — নমুনা থেকে বাদ (ALPHABET-এ নেই; FIXED-এও নেই)

const created = []; const pools = [];
afterAll(async () => {
  for (const p of pools) await p.end().catch(() => {});
  const admin = new Client({ connectionString: BASE }); await admin.connect();
  for (const n of created) await admin.query(`DROP DATABASE IF EXISTS ${n}`);
  await admin.end();
});

async function scratch(tag) {
  const name = `chp_${tag}_${process.pid}_${Date.now()}`;
  const admin = new Client({ connectionString: BASE }); await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`); await admin.end();
  created.push(name);
  const pool = new Pool({ connectionString: urlFor(name) }); pools.push(pool);
  await pool.query(`
    CREATE TABLE users (id SERIAL PRIMARY KEY, username TEXT, password TEXT, must_reset_password BOOLEAN NOT NULL DEFAULT false);
    CREATE TABLE bank_cards (id SERIAL PRIMARY KEY, user_id INTEGER, bank_name TEXT, account_number TEXT, holder_name TEXT);
    CREATE TABLE device_sessions (sid TEXT, user_id INTEGER, revoked_at TIMESTAMPTZ);`);
  const uid = (await pool.query("INSERT INTO users (username) VALUES ('u_parity') RETURNING id")).rows[0].id; // password NULL → নিজের-পাসওয়ার্ড মিল অসম্ভব
  return { pool, uid };
}
async function seed(pool, uid, values) {
  const idOf = new Map();
  for (const v of values) {
    const r = await pool.query("INSERT INTO bank_cards (user_id, bank_name, account_number, holder_name) VALUES ($1,'bKash','01700000000',$2) RETURNING id", [uid, v]);
    idOf.set(r.rows[0].id, v);
  }
  return idOf;
}

describe('ক্লিনআপ ↔ ভ্যালিডেটর সমতা (আসল Postgres, ~৫০০ নমুনা)', () => {
  const SAMPLE = [...new Set([...FIXED, ...generated(450, 271)])];

  test('নমুনায় বৈধ ও অবৈধ দুটোই যথেষ্ট আছে (টেস্ট নিজেই ফাঁপা নয়)', () => {
    const ok = SAMPLE.filter((v) => validateHolderName(v).valid).length;
    expect(ok).toBeGreaterThan(30);
    expect(SAMPLE.length - ok).toBeGreaterThan(300);
  });

  test('scanAffected: আক্রান্ত = (অ-ফাঁকা ∧ ভ্যালিডেটর প্রত্যাখ্যান); বৈধ গণনা = ভ্যালিডেটর গ্রহণ', async () => {
    const { pool, uid } = await scratch('scan');
    const idOf = await seed(pool, uid, SAMPLE);
    const scan = await scanAffected(pool);
    const expected = [...idOf].filter(([, v]) => !isBlankLikeSql(v) && !validateHolderName(v).valid).map(([id]) => id).sort((a, b) => a - b);
    expect([...scan.ids].sort((a, b) => a - b)).toEqual(expected);
    expect(scan.valid).toBe([...idOf.values()].filter((v) => validateHolderName(v).valid).length);
    expect(scan.rows).toBe(expected.length);
    expect(scan.byClass.own_password).toBe(0);
    // কোনো বৈধ মান আক্রান্ত তালিকায় নেই (উভয় দিক আলাদা করে)
    for (const id of scan.ids) expect(validateHolderName(idOf.get(id)).valid).toBe(false);
  });

  test('ভ্যালিডেটর-প্রত্যাখ্যাত অথচ ক্লিনআপ-অধরা মান = শুধু ফাঁকা/শুধু-স্পেস (আর কিছু নয়)', async () => {
    const { pool, uid } = await scratch('gap');
    const idOf = await seed(pool, uid, SAMPLE);
    const scan = await scanAffected(pool);
    const caught = new Set(scan.ids);
    const missed = [...idOf].filter(([id, v]) => !validateHolderName(v).valid && !caught.has(id)).map(([, v]) => v);
    expect(missed.length).toBeGreaterThan(0);
    for (const v of missed) expect(v.replace(/ /g, '')).toBe('');
  });

  test('--apply: প্রতিটি বৈধ মান বাইট-বাই-বাইট অক্ষত; প্রতিটি আক্রান্ত NULL ও ব্যাকআপে; ফাঁকা অপরিবর্তিত', async () => {
    const { pool, uid } = await scratch('apply');
    const idOf = await seed(pool, uid, SAMPLE);
    const out = [];
    const code = await run({
      argv: ['--apply'], env: { DATABASE_URL: 'x://hidden' }, out: (m) => out.push(m),
      deps: { pool, revokeAllOtherSessions: async () => 0, invalidateAuthCache: async () => {}, createRedis: () => { throw new Error('unused'); } },
    });
    expect(code).toBe(0);
    const after = new Map((await pool.query('SELECT id, holder_name FROM bank_cards')).rows.map((r) => [r.id, r.holder_name]));
    const backup = (await pool.query(`SELECT bank_card_id, holder_name FROM ${BACKUP_TABLE}`)).rows;
    const backedIds = new Set(backup.map((r) => r.bank_card_id));
    for (const [id, v] of idOf) {
      if (validateHolderName(v).valid) {
        expect(Buffer.from(after.get(id), 'utf8').equals(Buffer.from(v, 'utf8'))).toBe(true); // বাইট-সমান
        expect(backedIds.has(id)).toBe(false);
      } else if (isBlankLikeSql(v)) {
        expect(after.get(id)).toBe(v); // ফাঁকা/শুধু-স্পেস/NULL: অপরিবর্তিত, ব্যাকআপে নয়
        expect(backedIds.has(id)).toBe(false);
      } else {
        expect(after.get(id)).toBeNull();
        expect(backedIds.has(id)).toBe(true);
      }
    }
    // আউটপুটে কোনো নমুনা-মান নেই (দীর্ঘগুলো, যাতে সাধারণ শব্দের অংশ না হয়)
    const all = out.join('\n');
    for (const v of SAMPLE.filter((x) => x.length >= 12)) expect(all).not.toContain(v);
  });
});
