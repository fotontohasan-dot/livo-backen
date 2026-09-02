// tests/render/crashGameUiRouting.test.js
// ---------------------------------------------------------------------------
// LIVO-03 রিগ্রেশন — ক্র্যাশ গেমের UI রাউটিং মিসম্যাচ।
//
// services/gameRegistry.js-এ খেলার যোগ্য স্লাগটি `crash-game`
// (routes/games.js-ও `['aviator', 'crash-game']` ধরেই রাউন্ড/ক্যাশআউট পথে যায়)।
// কিন্তু views/games/play.ejs-এর ডিসপ্যাচ শর্ত ছিল:
//
//     gameSlug === 'aviator' || gameSlug === 'crash'
//
// `crash` ক্যাটালগে নেই (gameRegistry.isKnown('crash') === false), তাই ওই শাখাটা
// কখনো চলত না — আর আসল `crash-game` স্লাগ নিচে গড়িয়ে গিয়ে **জেনেরিক** গেম
// টেমপ্লেটে পড়ত। জেনেরিক টেমপ্লেটে কোনো ক্যাশআউট কন্ট্রোল নেই; সে শুধু
// POST /games/play করে আর `data.winAmount` দেখে ফল দেখায়। ক্র্যাশ গেমের
// /games/play রেসপন্সে `winAmount` থাকেই না, তাই স্টেক কেটে নেওয়ার পরেও
// ইউজার কখনো ক্যাশআউট করতে পারত না।
//
// এই টেস্ট স্ট্রাকচারালভাবে (স্ক্রিনশট নয়) প্রমাণ করে যে —
//   ১) `crash-game` সত্যিই খেলার যোগ্য স্লাগ;
//   ২) /games/crash-game ক্র্যাশ (aviator) UI রেন্ডার করে;
//   ৩) সেই UI-তে ক্যাশআউট প্রক্রিয়া সত্যিই পৌঁছায়;
//   ৪) `crash-game`-এর জন্য জেনেরিক শাখা বাছাই হয় না;
//   ৫) বিদ্যমান `aviator` আচরণ অপরিবর্তিত।
// ---------------------------------------------------------------------------

const { getCsrfAgent, uniqueUsername, uniquePhone } = require('../helpers/app');
const gameRegistry = require('../../services/gameRegistry');

// ক্র্যাশ (aviator) UI-এর স্বতন্ত্র চিহ্ন — views/games/aviator.ejs
const CRASH_UI_MARKERS = ['id="aviatorGame"', 'id="multiplier"', 'function cashOut('];

// জেনেরিক ফলব্যাক টেমপ্লেটের স্বতন্ত্র চিহ্ন — views/games/play.ejs-এর শেষ else শাখা
const GENERIC_UI_MARKERS = ['g_status', 'g_result'];

async function makeUserAgent() {
  const { agent, token } = await getCsrfAgent('/register');
  await agent
    .post('/register')
    .type('form')
    .send({
      username: uniqueUsername(),
      phone: uniquePhone(),
      password: 'SecurePass123',
      confirmPassword: 'SecurePass123',
      _csrf: token
    });
  return agent;
}

describe('LIVO-03 — ক্র্যাশ গেমের UI রাউটিং', () => {
  let agent;

  beforeAll(async () => {
    agent = await makeUserAgent();
  });

  test('১) crash-game রেজিস্ট্রিতে খেলার যোগ্য, আর `crash` স্লাগটা আদৌ নেই', () => {
    expect(gameRegistry.isPlayable('crash-game')).toBe(true);
    // পুরনো শর্তে যে স্লাগটা খোঁজা হতো সেটা ক্যাটালগে নেই — এটাই মিসম্যাচের মূল।
    expect(gameRegistry.isKnown('crash')).toBe(false);
  });

  test('২+৩) /games/crash-game ক্র্যাশ UI দেয় এবং তাতে ক্যাশআউট পথ আছে', async () => {
    const res = await agent.get('/games/crash-game');
    expect(res.status).toBe(200);

    CRASH_UI_MARKERS.forEach((marker) => {
      expect(res.text).toContain(marker);
    });

    // ক্যাশআউট সত্যিই সার্ভারের /games/cashout-এ পৌঁছায় (play.ejs-এর recordWin
    // ফাংশন হয়ে), শুধু বাটন থাকা যথেষ্ট নয়। এন্ডপয়েন্টটা কোন হেল্পারের ভেতর
    // থেকে ডাকা হচ্ছে সেটা বাস্তবায়নের বিস্তারিত — LIVO-05-এ fetch() সরাসরি না
    // ডেকে শেয়ার্ড betRequest() ব্যবহার শুরু হয়েছে — তাই এখানে এন্ডপয়েন্ট ও
    // কল-সাইট দুটোই দেখা হয়, নির্দিষ্ট কোনো কল-সাইট নয়।
    expect(res.text).toContain('recordWin(');
    expect(res.text).toMatch(/async function recordWin\s*\(/);
    expect(res.text).toContain("'/games/cashout'");
  });

  test('৪) crash-game কখনো জেনেরিক শাখায় পড়বে না', async () => {
    const res = await agent.get('/games/crash-game');
    GENERIC_UI_MARKERS.forEach((marker) => {
      expect(res.text).not.toContain(marker);
    });
  });

  test('৫) aviator-এর আগের আচরণ অপরিবর্তিত', async () => {
    const res = await agent.get('/games/aviator');
    expect(res.status).toBe(200);
    CRASH_UI_MARKERS.forEach((marker) => {
      expect(res.text).toContain(marker);
    });
    GENERIC_UI_MARKERS.forEach((marker) => {
      expect(res.text).not.toContain(marker);
    });
  });
});
