module.exports = {
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['**/tests/**/*.test.js'],
  setupFiles: ['<rootDir>/tests/setup.js'],
  setupFilesAfterEnv: ['<rootDir>/tests/afterEnv.js'],
  globalSetup: '<rootDir>/tests/globalSetup.js',
  testTimeout: 30000,
  collectCoverage: true,
  collectCoverageFrom: [
    'routes/**/*.js',
    'middleware/**/*.js',
    'services/**/*.js',
    'app.js'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'text-summary', 'lcov', 'html'],
  maxWorkers: 1,
  // --runInBand সব suite মূল প্রসেসে চালাত, তাই ৮৩টি suite জুড়ে heap জমে
  // OOM (exit 137) হতো। একটি worker রাখলে ক্রম একই থাকে, কিন্তু heap সীমা
  // ছাড়ালে Jest worker রিসাইকল করতে পারে।
  workerIdleMemoryLimit: '512MB',
  forceExit: true,
  verbose: true
};
