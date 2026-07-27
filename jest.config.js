// jest.config.js
// ---------------------------------------------------------------------------
// app.js নিজে বুট হওয়ার সময় DB connect, migration, session store, scheduler,
// queue system ইত্যাদি চালু করে ফেলে (server.listen সহ)। Jest প্রতিটা টেস্ট
// ফাইলকে নিজস্ব sandboxed module registry দেয় — তাই সরাসরি `require('../../app')`
// করলে প্রতিটা ফাইল নিজের একটা করে app.js ইনস্ট্যান্স (নিজস্ব scheduler/timer সহ)
// বুট করে ফেলত, যেগুলো একে অপরের সাথে race করে মাঝেমধ্যে flaky ফেইলিওর তৈরি করছিল।
//
// সমাধান: globalSetup.js পুরো টেস্ট রানের জন্য app.js ঠিক একবার সত্যিকার child
// process হিসেবে বুট করে (একটা isolated test PostgreSQL-এর বিপরীতে), আর প্রতিটা
// টেস্ট ফাইল supertest-কে সেই একই লাইভ সার্ভারের base URL দিয়ে ব্যবহার করে।
// globalTeardown.js শেষে সেই child process বন্ধ করে দেয়। maxWorkers=1/runInBand
// রাখা হয়েছে যাতে ভাগাভাগি করা টেস্ট DB-তে একাধিক ফাইল একসাথে না লেখে (deterministic)।
// ---------------------------------------------------------------------------

module.exports = {
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  setupFiles: ['<rootDir>/tests/setup/env.js'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup/jest.setup.js'],
  globalSetup: '<rootDir>/tests/globalSetup.js',
  globalTeardown: '<rootDir>/tests/globalTeardown.js',
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
