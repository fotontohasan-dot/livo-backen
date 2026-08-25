// services/mediaUrl.js
// ---------------------------------------------------------------------------
// চ্যাট অ্যাটাচমেন্টের URL যাচাই — সার্ভার-সাইড allow-list।
//
// কেন দরকার: services/socket.js-এর send_message হ্যান্ডলার `data.fileUrl` সরাসরি
// socket পেলোড থেকে নিয়ে chat_messages-এ লিখত — কোনো যাচাই ছাড়াই। বৈধ ফ্লো-তে
// URL-টা routes/chat.js-এর /upload এন্ডপয়েন্ট থেকে Cloudinary-র রেসপন্স হিসেবে আসে,
// কিন্তু কেউ raw socket emit করলে সেখানে যেকোনো স্ট্রিং বসানো যেত — যা পরে
// অ্যাডমিন প্যানেলে রেন্ডার হতো (stored XSS-এর মূল উৎস, অডিট P0-05)।
//
// ভিউ-লেয়ারে (views/admin/chat.ejs) এখন DOM API ব্যবহার হয় বলে HTML ইনজেকশন
// এমনিতেই সম্ভব না, কিন্তু সেটা একটামাত্র প্রতিরক্ষা স্তর। এখানে উৎসেই আটকানো হচ্ছে,
// যাতে বিষাক্ত মান কখনো ডাটাবেসে ঢুকতেই না পারে (defense in depth)।
// ---------------------------------------------------------------------------

// routes/chat.js শুধুমাত্র Cloudinary-তেই আপলোড করে, আর app.js-এর CSP-তে
// img-src/media-src-এও একই হোস্ট অনুমোদিত — তাই allow-list ঠিক এটুকুই।
const ALLOWED_MEDIA_HOSTS = ['res.cloudinary.com'];

const MAX_URL_LENGTH = 2048;
// একটা সাপোর্ট চ্যাট বার্তার জন্য যথেষ্ট, কিন্তু কেউ যাতে মেগাবাইট-আকারের পেলোড
// পাঠিয়ে DB/সকেট ব্রডকাস্ট ফোলাতে না পারে।
const MAX_MESSAGE_LENGTH = 4000;

const ALLOWED_FILE_TYPES = ['image', 'video'];

/**
 * URL-টা একটা অনুমোদিত হোস্টের https রিসোর্স কিনা যাচাই করে।
 * @returns {string|null} নরমালাইজ করা URL, অথবা null (অবৈধ হলে)
 */
function safeMediaUrl(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > MAX_URL_LENGTH) return null;

  let parsed;
  try {
    parsed = new URL(value);
  } catch (e) {
    return null; // আপেক্ষিক পাথ, javascript:, বা একেবারে অর্থহীন স্ট্রিং
  }

  // http: ইচ্ছাকৃতভাবে বাদ — Cloudinary সবসময় https দেয়, আর CSP-তে
  // upgrade-insecure-requests থাকায় প্লেইন http এমনিতেও কাজ করত না।
  if (parsed.protocol !== 'https:') return null;
  if (!ALLOWED_MEDIA_HOSTS.includes(parsed.hostname)) return null;

  return parsed.href;
}

/** fileType ক্লায়েন্ট পাঠায়; শুধু জানা দুটো মানই গ্রহণযোগ্য। */
function safeFileType(raw) {
  return ALLOWED_FILE_TYPES.includes(raw) ? raw : null;
}

/**
 * চ্যাট বার্তার টেক্সট — টাইপ যাচাই ও দৈর্ঘ্য সীমা। HTML স্ট্রিপ করা হয় *না*:
 * রেন্ডারিং এখন textContent দিয়ে হয়, তাই বার্তায় `<` থাকা সম্পূর্ণ নিরাপদ এবং
 * স্ট্রিপ করলে বরং বৈধ বার্তা (যেমন কোড স্নিপেট) নষ্ট হতো।
 * @returns {string|null}
 */
function safeMessageText(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;
  return value.length > MAX_MESSAGE_LENGTH ? value.slice(0, MAX_MESSAGE_LENGTH) : value;
}

module.exports = {
  safeMediaUrl,
  safeFileType,
  safeMessageText,
  ALLOWED_MEDIA_HOSTS,
  MAX_MESSAGE_LENGTH,
  MAX_URL_LENGTH
};
