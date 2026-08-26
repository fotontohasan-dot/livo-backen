// রিগ্রেশন: GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET আগে services/envValidator.js-এর
// OPTIONAL_GROUPS-এ ছিল না — Cloudinary/Email/SSLCommerz/VAPID/Telegram সবগুলোর জন্য
// আংশিক কনফিগারেশন (একটা কী সেট, অন্যটা নেই) বুট-টাইমে warning দিলেও Google OAuth-এর
// জন্য কোনো সংকেত ছিল না, ফলে অপারেটর একটা টাইপো/আংশিক পেস্ট করা credential নিয়ে কিছু না
// জেনেই সার্ভার চালিয়ে যেতে পারতেন (Google লগইন বাটন নীরবে no-op হয়ে যেত)।
const { validateEnv } = require('../../services/envValidator');

describe('envValidator — Google OAuth আংশিক কনফিগারেশন সতর্কতা', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  test('শুধু GOOGLE_CLIENT_ID সেট থাকলে (SECRET নেই) warning আসে', () => {
    delete process.env.GOOGLE_CLIENT_SECRET;
    process.env.GOOGLE_CLIENT_ID = 'some-client-id.apps.googleusercontent.com';
    const { warnings } = validateEnv();
    expect(warnings.some(w => w.includes('Google OAuth'))).toBe(true);
  });

  test('দুটোই সেট থাকলে বা দুটোই অনুপস্থিত থাকলে Google OAuth নিয়ে কোনো warning আসে না', () => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    let { warnings } = validateEnv();
    expect(warnings.some(w => w.includes('Google OAuth'))).toBe(false);

    process.env.GOOGLE_CLIENT_ID = 'id';
    process.env.GOOGLE_CLIENT_SECRET = 'secret';
    ({ warnings } = validateEnv());
    expect(warnings.some(w => w.includes('Google OAuth'))).toBe(false);
  });
});
