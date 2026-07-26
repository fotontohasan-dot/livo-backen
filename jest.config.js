// jest.config.js
// ---------------------------------------------------------------------------
// এই প্রজেক্টের Test Framework কনফিগারেশন। app.js নিজেই বুট হওয়ার সময় DB
// connect, migration, session store, queue system ইত্যাদি চালু করে ফেলে,
// তাই ইন্টিগ্রেশন টেস্টগুলো একটা সত্যিকার (আলাদা টেস্ট) PostgreSQL ডাটাবেজের
// বিপরীতে পুরো অ্যাপ বুট করেই supertest দিয়ে চালানো হয় — production কোড
// পরিবর্তন না করেই।
//
// maxWorkers/runInBand: app.js একবার require হলেই server.listen() + DB
// migration চালিয়ে দেয়। একাধিক worker process একসাথে চললে একই পোর্ট/ডাটাবেজে
// race condition হতে পারে, তাই সব টেস্ট সিরিয়ালি (একই প্রসেসে) চালানো হয়।
// ---------------------------------------------------------------------------

module.exports = {
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  setupFiles: ['<rootDir>/tests/setup/env.js'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup/jest.setup.js'],
  testTimeout: 30000,
  maxWorkers: 1,
  forceExit: true,
  verbose: true,
  collectCoverage: false, // `npm run test:coverage` দিয়ে চালু করা হয় (--coverage ফ্ল্যাগ)
  collectCoverageFrom: [
    'routes/**/*.js',
    'middleware/**/*.js',
    'services/**/*.js',
    '!services/sentry.js',
    '!**/node_modules/**'
  ],
  coverageDirectory: '<rootDir>/coverage',
  coverageReporters: ['text', 'text-summary', 'lcov', 'html'],
  testPathIgnorePatterns: ['/node_modules/', '/public/', '/views/'],
};
