// tests/helpers/humanAgent.js
// ---------------------------------------------------------------------------
// app.js-এর loginLimiter (/login ও /register-এ শেয়ার্ড) IP-ভিত্তিক — Redis
// অনুপলব্ধ থাকলে services/redisRateLimitStore.js একটা প্রসেস-ওয়াইড in-memory
// Map-এ fallback করে, IP প্রতি ১৫ মিনিটে ১০টা রিকোয়েস্ট পর্যন্ত। সম্পূর্ণ
// টেস্ট স্যুট (অনেকগুলো টেস্ট ফাইল, --runInBand-এ একই প্রসেসে) যদি একই IP
// (127.0.0.1) থেকে বারবার register/login করে, প্রকৃত ব্যবহারকারীদের মতোই
// দ্রুত rate-limit-এ আটকে যাবে।
//
// এই হেল্পার প্রতিটা "ভার্চুয়াল ব্যবহারকারী"-কে (test agent) তার নিজস্ব
// এলোমেলো X-Forwarded-For IP দেয় (app.js-এ trust proxy সেট করা আছে, তাই এটা
// getReqIp()/express-rate-limit উভয়ের কাছেই real client IP হিসেবে গণ্য হয়) —
// production কোড পরিবর্তন ছাড়াই বাস্তবসম্মতভাবে ভিন্ন ভিন্ন ব্যবহারকারী সিমুলেট করে।
// ---------------------------------------------------------------------------

const request = require('supertest');

const CHROME_VERSIONS = ['120', '121', '122', '123', '124', '125', '126', '127', '128', '129'];
const LOCALES = ['en-US,en;q=0.9', 'en-GB,en;q=0.9', 'bn-BD,bn;q=0.9,en;q=0.8', 'en-US,en;q=0.8'];

function randomHumanHeaders() {
  const ver = CHROME_VERSIONS[Math.floor(Math.random() * CHROME_VERSIONS.length)];
  const lang = LOCALES[Math.floor(Math.random() * LOCALES.length)];
  return {
    'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver}.0.0.0 Safari/537.36`,
    'Accept-Language': lang,
    'Accept-Encoding': 'gzip, deflate, br',
    'sec-ch-ua': `"Chromium";v="${ver}", "Not:A-Brand";v="24"`
  };
}

function fakeIp() {
  const octet = () => Math.floor(Math.random() * 254) + 1;
  return `10.${octet()}.${octet()}.${octet()}`;
}

// একটা কুকি-পার্সিস্টেন্ট, "human" agent তৈরি করে — নিজস্ব ফেক IP + নিজস্ব
// (র‍্যান্ডমাইজড) ব্রাউজার ফিঙ্গারপ্রিন্ট সহ, যাতে একই টেস্ট রানে অনেকগুলো এজেন্ট
// তৈরি হলেও services/botDetection.js-এর fingerprint_ip_rotation সিগন্যাল ট্রিগার না হয়
function humanAgent(app, { ip } = {}) {
  const raw = request.agent(app);
  const fixedIp = ip || fakeIp();
  const headers = { ...randomHumanHeaders(), 'X-Forwarded-For': fixedIp };

  return {
    ip: fixedIp,
    get: (path) => raw.get(path).set(headers),
    post: (path) => raw.post(path).set(headers),
    put: (path) => raw.put(path).set(headers),
    delete: (path) => raw.delete(path).set(headers),
  };
}

// এজেন্ট/সেশন ছাড়া এক-বার ব্যবহারের অ্যানোনিমাস "human" রিকোয়েস্ট (rate-limit টেস্টের জন্য
// ইচ্ছাকৃতভাবে একই IP বারবার ব্যবহার করা যায়)
function humanRequest(app, { ip } = {}) {
  const fixedIp = ip || fakeIp();
  const headers = { ...randomHumanHeaders(), 'X-Forwarded-For': fixedIp };
  return {
    ip: fixedIp,
    get: (path) => request(app).get(path).set(headers),
    post: (path) => request(app).post(path).set(headers),
  };
}

// ফর্ম রেন্ডারের সময় হিসেবে যথেষ্ট পুরনো একটা টাইমস্ট্যাম্প — "too_fast_submission" বট-সিগন্যাল এড়াতে
function formRenderedAt() {
  return Date.now() - 5000;
}

module.exports = { humanAgent, humanRequest, fakeIp, formRenderedAt, randomHumanHeaders };
