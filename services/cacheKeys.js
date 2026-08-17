// services/cacheKeys.js
// কেন্দ্রীয় ক্যাশ-কী বিল্ডার — যাতে যেখানে ক্যাশ পড়া হয় আর যেখানে invalidate করা হয়
// (সাধারণত ভিন্ন route ফাইলে) সবসময় একই কী স্ট্রিং ব্যবহার করে, টাইপো/মিসম্যাচ এড়াতে।
module.exports = {
  matchDetail: (matchId) => `match:detail:${matchId}`,
  matchesByStatusPattern: () => `api:matches:*`,
  leaderboardTop50: () => 'leaderboard:top50',
  leaderboardApiPattern: () => 'api:leaderboard:*',
  profileActivity: (userId) => `profile:activity:${userId}`,
  homepageGames: () => 'homepage:games',
  userActiveStatus: (userId) => `auth:active:${userId}`,
};
