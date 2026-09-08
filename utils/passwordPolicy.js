// utils/passwordPolicy.js
// পাসওয়ার্ড নীতির একমাত্র সংজ্ঞা।
//
// আগে নিয়ম ছিল শুধু `password.length < 8` — রেজিস্ট্রেশন, রিসেট আর প্রোফাইল
// পরিবর্তন তিন জায়গায় আলাদাভাবে লেখা। কোনো কমপ্লেক্সিটি ছিল না, কমন-পাসওয়ার্ড
// ব্লকলিস্ট ছিল না, তাই `password123` বা `12345678` নির্দ্বিধায় গৃহীত হতো।
// টাকার প্ল্যাটফর্মে অ্যাকাউন্ট টেকওভার মানে সরাসরি উইথড্র, তাই এখানে
// credential stuffing-ই সবচেয়ে সস্তা আক্রমণ।
//
// নিয়ম এক জায়গায় রাখলে তিনটে কপি আলাদা হয়ে যাওয়ার ঝুঁকি থাকে না।

const MIN_LENGTH = 10;

// ==================== bcrypt cost ====================
// আগে সব জায়গায় ১০ ছিল। ১২ মানে হ্যাশ প্রতি প্রায় ৪ গুণ বেশি কাজ, অর্থাৎ
// ডাটাবেস ফাঁস হলে অফলাইন ক্র্যাকিং ৪ গুণ ধীর। বিদ্যমান হ্যাশ ভাঙে না —
// bcrypt হ্যাশের ভেতরেই cost লেখা থাকে, তাই পুরনো cost-১০ হ্যাশ যাচাই
// স্বাভাবিকভাবেই চলতে থাকে; পরের সফল লগইনে rehash করে নেওয়া যায়।
const BCRYPT_COST = 12;

// টপ কমন পাসওয়ার্ড — সম্পূর্ণ তালিকা নয়, কিন্তু ব্রুট-ফোর্স তালিকার
// একেবারে উপরের দিকটা ঢাকে। বড় তালিকা (rockyou ইত্যাদি) চাইলে ফাইল থেকে
// লোড করা যায়, কিন্তু এই ছোট সেটটাই বাস্তবে সবচেয়ে বেশি চেষ্টা হওয়া
// পাসওয়ার্ডগুলো ধরে।
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password12', 'password123', 'password1234',
  'passw0rd', 'p@ssword', 'p@ssw0rd', 'passw0rd123',
  '123456', '1234567', '12345678', '123456789', '1234567890',
  '12345678910', '123123123', '111111111', '000000000',
  'qwertyuiop', 'qwerty123', 'qwertyu123', 'asdfghjkl',
  'iloveyou1', 'iloveyou123', 'sunshine1', 'princess1',
  'football1', 'baseball1', 'superman1', 'trustno1234',
  'welcome123', 'welcome1234', 'admin12345', 'administrator',
  'letmein123', 'monkey1234', 'dragon1234', 'master1234',
  'abc12345', 'abcd1234', 'abcd12345', 'a1234567',
  'bangladesh', 'bangladesh1', 'bangladesh123', 'dhaka12345',
  'livo123456', 'livo1234567', 'casino1234', 'cricket123'
]);

/**
 * পাসওয়ার্ড নীতির সাথে মেলে কিনা।
 * ফেরত দেয়: { valid: true } অথবা { valid: false, reason: '<locale key>' }
 *
 * reason একটা locale key — কলার req.t() দিয়ে অনুবাদ করবে, যাতে বার্তা
 * ইংরেজি/বাংলা দুই ভাষাতেই ঠিক আসে।
 */
function validatePassword(password, { username = '', email = '' } = {}) {
  const value = String(password == null ? '' : password);

  if (value.length < MIN_LENGTH) {
    return { valid: false, reason: 'auth_password_min_length' };
  }

  // কমপ্লেক্সিটি — অক্ষর ও সংখ্যা দুটোই থাকতে হবে। বিশেষ ক্যারেক্টার
  // বাধ্যতামূলক করা হয়নি: বাস্তবে সেটা ইউজারকে `Password1!` টাইপের
  // অনুমানযোগ্য প্যাটার্নে ঠেলে দেয়, নিরাপত্তা বাড়ায় না।
  if (!/[a-zA-Z]/.test(value) || !/\d/.test(value)) {
    return { valid: false, reason: 'auth_password_needs_letter_and_number' };
  }

  // একই ক্যারেক্টার বারবার (`aaaaaaaaaa`) দৈর্ঘ্যের শর্ত পূরণ করলেও
  // এনট্রপি শূন্যের কাছাকাছি।
  if (/^(.)\1+$/.test(value)) {
    return { valid: false, reason: 'auth_password_too_simple' };
  }

  if (COMMON_PASSWORDS.has(value.toLowerCase())) {
    return { valid: false, reason: 'auth_password_too_common' };
  }

  // পাসওয়ার্ডের ভেতরে নিজের ইউজারনেম/ইমেইল থাকলে সেটা কার্যত পাবলিক তথ্য।
  const lower = value.toLowerCase();
  const localPart = String(email || '').split('@')[0];
  for (const personal of [username, localPart]) {
    if (personal && personal.length >= 4 && lower.includes(String(personal).toLowerCase())) {
      return { valid: false, reason: 'auth_password_contains_identity' };
    }
  }

  return { valid: true };
}

module.exports = { validatePassword, MIN_LENGTH, BCRYPT_COST, COMMON_PASSWORDS };
