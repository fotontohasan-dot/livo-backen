const { allowChatMessage, CHAT_RATE_LIMIT } = require('../services/socket');

// services/socket.js-এর send_message হ্যান্ডলারে আগে কোনো rate limit ছিল না — একটা অ্যাকাউন্ট
// থেকে দ্রুতগতিতে বার্তা পাঠালে প্রতিটাই DB-তে লেখা হতো, সব admin সেশনে broadcast হতো, আর
// Telegram bot API-তেও কল যেত। allowChatMessage() সেই সুরক্ষার মূল লজিক — এখানে সরাসরি
// (Socket.IO হার্নেস ছাড়াই) সেই লজিক যাচাই করা হচ্ছে।
describe('চ্যাট মেসেজ রেট-লিমিট (services/socket.js allowChatMessage)', () => {
  test(`প্রতি উইন্ডোতে ${CHAT_RATE_LIMIT}টার বেশি বার্তা প্রত্যাখ্যাত হয়`, async () => {
    const userId = `test-user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const results = [];
    for (let i = 0; i < CHAT_RATE_LIMIT + 5; i++) {
      results.push(await allowChatMessage(userId));
    }
    const allowedCount = results.filter(Boolean).length;
    const deniedCount = results.filter((r) => !r).length;

    expect(allowedCount).toBe(CHAT_RATE_LIMIT);
    expect(deniedCount).toBe(5);
    // সীমার ঠিক আগ পর্যন্ত সব অনুমোদিত, তারপরেরগুলো প্রত্যাখ্যাত — ক্রম বজায় থাকা উচিত
    expect(results.slice(0, CHAT_RATE_LIMIT).every(Boolean)).toBe(true);
    expect(results.slice(CHAT_RATE_LIMIT).every((r) => !r)).toBe(true);
  });

  test('আলাদা ইউজারের বার্তা একে অপরের কাউন্টার প্রভাবিত করে না', async () => {
    const userA = `test-user-a-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const userB = `test-user-b-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    for (let i = 0; i < CHAT_RATE_LIMIT; i++) {
      expect(await allowChatMessage(userA)).toBe(true);
    }
    // userA এখন সীমায় পৌঁছেছে
    expect(await allowChatMessage(userA)).toBe(false);
    // কিন্তু userB সম্পূর্ণ স্বাধীন, এখনো অনুমোদিত
    expect(await allowChatMessage(userB)).toBe(true);
  });
});
