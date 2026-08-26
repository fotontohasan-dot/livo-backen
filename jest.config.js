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
    'utils/**/*.js',
    'app.js'
  ],

  // কভারেজ থ্রেশহোল্ড — আগে কোনোটাই ছিল না, তাই কভারেজ রিপোর্ট তৈরি হতো
  // কিন্তু কমে গেলেও CI পাস করত।
  //
  // লক্ষ্য ১০০% নয়। যেসব ফাইলে টাকা, প্রমাণীকরণ ও অনুমোদন হয় সেখানে
  // থ্রেশহোল্ড আলাদা করে বসানো হয়েছে; বাকি কোডবেসের জন্য একটা নিচু
  // গ্লোবাল মেঝে, যাতে সামগ্রিক কভারেজ ধসে না পড়ে।
  //
  // মানগুলো বর্তমান কভারেজের সামান্য নিচে রাখা হয়েছে — উদ্দেশ্য নতুন কাজ
  // আটকানো নয়, পিছিয়ে যাওয়া ধরা। কভারেজ বাড়লে এই সংখ্যাগুলোও বাড়ানো উচিত।
  coverageThreshold: {
    global: {
      statements: 25,
      branches: 15,
      functions: 20,
      lines: 25
    },
    './middleware/auth.js': {
      statements: 50,
      branches: 35,
      lines: 50
    },
    './utils/publicUrl.js': {
      statements: 70,
      branches: 55,
      lines: 70
    },
    './utils/tokens.js': {
      statements: 80,
      lines: 80
    },
    './utils/secretBox.js': {
      statements: 60,
      lines: 60
    }
  },
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'text-summary', 'lcov', 'html'],
  maxWorkers: 1,
  forceExit: true,
  verbose: true
};
