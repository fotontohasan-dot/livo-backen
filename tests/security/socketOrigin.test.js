// tests/security/socketOrigin.test.js
// ---------------------------------------------------------------------------
// Socket.IO-র ট্রাস্টেড-অরিজিন পলিসি।
//
// app.js-এর HTTP CORS লেয়ারে একটা কড়া allow-list বহু আগেই বসানো হয়েছিল, কিন্তু
// services/socket.js আলাদাভাবে ইনিশিয়ালাইজ হতো:
//
//     io = new Server(server, { cors: { origin: "*", methods: [...] } });
//
// আর ঠিক তার নিচেই handshake-এর সাথে Express session যুক্ত করা হয়
// (`io.engine.use(sessionMiddleware)`), যাতে socket.request.session.user থেকে
// আসল ইউজার পাওয়া যায়। এই দুটো মিলে একটা ফাঁক তৈরি করত: যেকোনো তৃতীয়-পক্ষের
// ওয়েবসাইট ভিকটিমের ব্রাউজার থেকে ক্রেডেনশিয়াল-সহ handshake করতে পারত, আর
// সংযোগের সাথে সাথেই সার্ভার তাকে `user:<id>` রুমে জয়েন করিয়ে দিত — অর্থাৎ
// আক্রমণকারীর পেজ ভিকটিমের প্রাইভেট চ্যাট/নোটিফিকেশন ইভেন্ট পড়তে পারত।
// লক্ষণীয়, রুম-অথরাইজেশন নিজে ঠিকই ছিল (session-ভিত্তিক, ক্লায়েন্টের দাবি নয়) —
// দুর্বলতাটা ছিল সংযোগ-স্তরে, রুম-স্তরে নয়।
//
// ফিক্স: utils/allowedOrigins.js-এ একটাই পলিসি, দুই লেয়ারেই ব্যবহৃত।
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const { isAllowedOrigin, ALLOWED_ORIGINS } = require('../../utils/allowedOrigins');
const { freshRequest } = require('../helpers/app');

describe('শেয়ার্ড অরিজিন পলিসি', () => {
  test('অনুমোদিত origin গ্রহণ করে', () => {
    ALLOWED_ORIGINS.forEach((origin) => {
      expect(isAllowedOrigin(origin)).toBe(true);
    });
  });

  test('অজানা origin প্রত্যাখ্যান করে', () => {
    expect(isAllowedOrigin('https://evil.example')).toBe(false);
    expect(isAllowedOrigin('https://livo-backen.onrender.com.evil.example')).toBe(false);
    // সাবস্ট্রিং নয়, পুরো মান মিলতে হবে।
    expect(isAllowedOrigin('https://evil.example/livo-backen.onrender.com')).toBe(false);
  });

  test('Origin: "null" কখনো অনুমোদিত নয়', () => {
    // sandboxed <iframe>, data:/file: URL এবং কিছু redirect chain এই মানটা পাঠায় —
    // এগুলোই credentialed cross-origin আক্রমণের আসল বাহন।
    expect(isAllowedOrigin('null')).toBe(false);
    expect(isAllowedOrigin('null', { allowMissing: true })).toBe(false);
  });

  test('Origin হেডার না থাকা কনফিগারযোগ্য, ডিফল্টে অনুমোদিত', () => {
    // নন-ব্রাউজার ক্লায়েন্টে (cURL, সার্ভার-টু-সার্ভার) ব্রাউজারের অ্যাম্বিয়েন্ট
    // কুকি স্বয়ংক্রিয়ভাবে যায় না, তাই এটা CSRF ভেক্টর নয়।
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin('', { allowMissing: false })).toBe(false);
  });
});

describe('Socket.IO সংযোগ-স্তরের অরিজিন যাচাই', () => {
  const socketSource = fs.readFileSync(
    path.join(__dirname, '..', '..', 'services', 'socket.js'), 'utf8'
  );

  // কমেন্টে পুরনো প্যাটার্নটা ব্যাখ্যা হিসেবে উদ্ধৃত আছে — যাচাই শুধু আসল কোডে।
  const socketCode = socketSource.replace(/\/\/[^\n]*/g, '');

  test('ওয়াইল্ডকার্ড CORS আর নেই', () => {
    expect(socketCode).not.toMatch(/origin:\s*["']\*["']/);
  });

  test('Socket.IO মূল অ্যাপের একই পলিসি ব্যবহার করে', () => {
    expect(socketSource).toMatch(/require\('\.\.\/utils\/allowedOrigins'\)/);
    expect(socketSource).toMatch(/isAllowedOrigin\(origin/);
  });

  test('পে-লোড সাইজ সীমিত — একটা সকেট থেকে বড় বার্তা স্প্যাম করা যায় না', () => {
    expect(socketSource).toMatch(/maxHttpBufferSize/);
  });

  test('চ্যাট মেসেজের দৈর্ঘ্য সার্ভার-সাইডে বাউন্ড করা', () => {
    // ক্লায়েন্টের maxlength বিশ্বাসযোগ্য নয় — সকেট ইভেন্ট সরাসরিও পাঠানো যায়।
    expect(socketSource).toMatch(/MAX_MESSAGE_LEN/);
  });

  test('Telegram নোটিফিকেশনে ইউজারের বার্তা এস্কেপ করা হয়', () => {
    // বার্তাটা parse_mode=HTML দিয়ে যায়, তাই কাঁচা `<` মার্কআপ ইনজেকশন ঘটাত।
    expect(socketSource).toMatch(/tgEscape/);
  });
});

describe('HTTP CORS লেয়ার (আচরণ অপরিবর্তিত থাকার প্রমাণ)', () => {
  test('অনুমোদিত origin-এ CORS হেডার ফেরত আসে', async () => {
    const res = await freshRequest().get('/health').set('Origin', 'http://localhost:3000');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });

  test('অজানা origin-এ CORS হেডার দেওয়া হয় না', async () => {
    const res = await freshRequest().get('/health').set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
