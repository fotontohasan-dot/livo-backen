// utils/holderName.js
// ---------------------------------------------------------------------------
// bank_cards.holder_name-এর একমাত্র সার্ভার-ভ্যালিডেটর (সব লেখার পথ এটাই ব্যবহার করে)।
// নিয়ম: শুধু Unicode অক্ষর (বাংলা স্বরচিহ্নসহ), সাধারণ স্পেস, ডট, হাইফেন ও অ্যাপোস্ট্রফি।
// অঙ্ক, অন্য চিহ্ন (@ # _ ! ইত্যাদি), ইমোজি, ট্যাব/নতুন লাইন, HTML — সব প্রত্যাখ্যাত; তাই "পাসওয়ার্ড-সদৃশ"
// (অঙ্ক/চিহ্নসহ) মান আটকায়।  সীমা: শুধু অক্ষরের পাসওয়ার্ড (যেমন "SecurePass") নাম থেকে আলাদা করা অসম্ভব — আটকায় না।
// দৈর্ঘ্য: ২–৬০ অক্ষর (কোড-পয়েন্ট)। ফেরত মান ছাঁটা, NFC, পরপর স্পেস একটা।
// এই ফাইল কখনো কোনো মান লগ করে না, throw করে না।
// ক্লায়েন্টের সমান নিয়ম: public/js/holder-name-validate.js (tests/unit/holderNameValidator.test.js দুটোর সমতা যাচাই করে)।
// ---------------------------------------------------------------------------

const MIN_LEN = 2;
const MAX_LEN = 60;
// \p{M} = বাংলা/হিন্দি স্বরচিহ্ন ও কম্বাইনিং চিহ্ন; \u200c\u200d = বাংলা শব্দে বৈধ ZWNJ/ZWJ
const HOLDER_NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M}\u200c\u200d .'’-]*$/u;

/** @returns {{ valid: boolean, value: string|null }} — valid না হলে value সবসময় null। */
function validateHolderName(input) {
  if (typeof input !== 'string') return { valid: false, value: null };
  let v;
  try { v = input.normalize('NFC').trim().replace(/ {2,}/g, ' '); } catch (_) { return { valid: false, value: null }; }
  const len = [...v].length;
  if (len < MIN_LEN || len > MAX_LEN) return { valid: false, value: null };
  if (!HOLDER_NAME_RE.test(v)) return { valid: false, value: null };
  if (([...v].filter((ch) => /\p{L}/u.test(ch)).length) < MIN_LEN) return { valid: false, value: null };
  return { valid: true, value: v };
}

/** ইমপোর্ট/রিস্টোরের জন্য: অবৈধ হলে null (সারি বাদ যায় না, শুধু নামের ঘর খালি)। ফেরত: { rows, cleared } */
function sanitizeImportedRows(rows) {
  let cleared = 0;
  const out = rows.map((r) => {
    if (!r || r.holder_name === undefined || r.holder_name === null || String(r.holder_name).trim() === '') return r;
    const res = validateHolderName(r.holder_name);
    if (res.valid) return { ...r, holder_name: res.value };
    cleared += 1;
    return { ...r, holder_name: null };
  });
  return { rows: out, cleared };
}

module.exports = { validateHolderName, sanitizeImportedRows, HOLDER_NAME_RE, MIN_LEN, MAX_LEN };
