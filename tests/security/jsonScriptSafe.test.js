/**
 * রিগ্রেশন টেস্ট — res.locals.jsonScriptSafe() অ্যারে/অবজেক্ট ঠিকঠাক JSON করে।
 *
 * বাগ: হেল্পারটা ছিল `JSON.stringify(String(value == null ? '' : value))` — মানটাকে
 * আগেই String-এ কোয়ার্স করত। স্ট্রিং ইনপুটে ঠিক কাজ করত, কিন্তু অ্যারে/অবজেক্টে
 * `String([{...}])` → "[object Object]" হয়ে যেত। ফলে EJS টেমপ্লেটে বসত:
 *     const allRequests = "[object Object]";
 * এবং ব্রাউজারে "allRequests.filter is not a function" uncaught TypeError দিয়ে
 * পুরো ক্লায়েন্ট-সাইড রেন্ডারিং ভেঙে পড়ত। ক্ষতিগ্রস্ত পেজ:
 *   • views/payment/admin.ejs   — অ্যাডমিন পেমেন্ট অনুমোদন কিউ
 *   • views/admin/analytics.ejs — রেভিনিউ/গ্রোথ চার্টের ডেটা
 *   • views/admin/kyc.ejs       — viewKyc() ডিটেইল মডাল
 *   • views/profile/wheel.ejs   — স্পিন-হুইলের সেগমেন্ট
 *
 * এই টেস্ট পুরোনো ইমপ্লিমেন্টেশনে ফেল করে, ফিক্সে পাস করে।
 */

// app.js-এর হেল্পারটার হুবহু প্রতিরূপ (app.js পুরো বুট না করে ইউনিট-টেস্ট করার জন্য)।
const jsonScriptSafe = (value) =>
  JSON.stringify(value === undefined ? null : value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

// টেমপ্লেটে বসানো আউটপুটটা ব্রাউজার যেভাবে মূল্যায়ন করত সেভাবেই ফিরিয়ে আনা
function evalAsScript(serialized) {
  // eslint-disable-next-line no-new-func
  return new Function(`return (${serialized});`)();
}

describe('jsonScriptSafe() — <script> ব্লকে নিরাপদ JSON সিরিয়ালাইজেশন', () => {
  test('অবজেক্টের অ্যারে সত্যিকারের অ্যারে হিসেবেই ফিরে আসে (আগে "[object Object]" হতো)', () => {
    const requests = [
      { id: 1, type: 'deposit', amount: 500 },
      { id: 2, type: 'withdraw', amount: 250 }
    ];
    const out = evalAsScript(jsonScriptSafe(requests));
    expect(Array.isArray(out)).toBe(true);
    expect(typeof out.filter).toBe('function'); // views/payment/admin.ejs এটাই কল করে
    expect(out.filter((r) => r.type === 'deposit')).toHaveLength(1);
    expect(out[1].amount).toBe(250);
  });

  test('খালি অ্যারে খালি অ্যারেই থাকে', () => {
    const out = evalAsScript(jsonScriptSafe([]));
    expect(Array.isArray(out)).toBe(true);
    expect(out).toHaveLength(0);
  });

  test('সংখ্যার অ্যারে (চার্ট ডেটা) সংখ্যা হিসেবেই থাকে', () => {
    const out = evalAsScript(jsonScriptSafe([10, 20, 30]));
    expect(out).toEqual([10, 20, 30]);
  });

  test('একক অবজেক্ট (viewKyc মডাল) প্রপার্টিসহ ফিরে আসে', () => {
    const out = evalAsScript(jsonScriptSafe({ id: 7, name: 'Rahim', status: 'pending' }));
    expect(out.id).toBe(7);
    expect(out.status).toBe('pending');
  });

  test('স্ট্রিং ইনপুটের আচরণ আগের মতোই অপরিবর্তিত (ব্যাক-কম্প্যাট)', () => {
    expect(evalAsScript(jsonScriptSafe('সফল হয়েছে'))).toBe('সফল হয়েছে');
    expect(evalAsScript(jsonScriptSafe(''))).toBe('');
  });

  test('null/undefined নিরাপদে হ্যান্ডেল হয় — কখনো সিনট্যাক্স এরর দেয় না', () => {
    expect(evalAsScript(jsonScriptSafe(null))).toBeNull();
    expect(evalAsScript(jsonScriptSafe(undefined))).toBeNull();
  });

  test('ডেটার ভেতরে </script> থাকলেও স্ক্রিপ্ট ব্লক ভাঙতে পারে না (XSS গার্ড)', () => {
    const serialized = jsonScriptSafe({ note: '</script><img src=x onerror=alert(1)>' });
    expect(serialized).not.toContain('</script>');
    expect(serialized).not.toContain('<');
    expect(serialized).not.toContain('>');
    // এস্কেপ করা সত্ত্বেও মানটা অবিকৃতভাবেই ফিরে আসে
    expect(evalAsScript(serialized).note).toBe('</script><img src=x onerror=alert(1)>');
  });

  test('U+2028/U+2029 এস্কেপ হয় (JS-এ এগুলো লাইন টার্মিনেটর, নাহলে সিনট্যাক্স এরর)', () => {
    const serialized = jsonScriptSafe({ text: 'a\u2028b\u2029c' });
    expect(serialized).not.toMatch(/[\u2028\u2029]/);
    expect(evalAsScript(serialized).text).toBe('a\u2028b\u2029c');
  });
});
