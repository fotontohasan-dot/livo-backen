// Playwright কনফিগ।
//
// আগে `executablePath` হার্ডকোড করা ছিল `/opt/pw-browsers/chromium` — সেটা
// শুধু একটা নির্দিষ্ট স্যান্ডবক্সে থাকে, CI বা ডেভেলপারের মেশিনে নয়। ফলে
// E2E কার্যত কোথাও চলত না। এখন Playwright নিজের ইনস্টল করা ব্রাউজার ব্যবহার
// করে; দরকার হলে PLAYWRIGHT_CHROMIUM_PATH দিয়ে ওভাররাইড করা যায়।
const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;

module.exports = {
  testDir: './tests/e2e',
  // রিট্রাই ইচ্ছাকৃতভাবে কম — বেশি রিট্রাই ফ্লেকি টেস্ট ঢেকে দেয়, ঠিক করে না।
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 60000,
  // CI-তে `github` রিপোর্টার যোগ করা হলো: ব্যর্থ টেস্ট GitHub annotation হিসেবে
  // চেক-রানে দেখা যায়, তাই Actions-এর লগ blob storage পড়তে না পারলেও (অনেক
  // নেটওয়ার্ক থেকে ব্লকড) ব্যর্থতার কারণ সরাসরি PR-এ দেখা যায়।
  reporter: process.env.CI ? [['github'], ['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  // CI-তে অ্যাপটা নিজে থেকেই চালু হবে। লোকালি অ্যাপ আগে থেকে চললে
  // reuseExistingServer সেটাই ব্যবহার করে।
  webServer: process.env.E2E_SKIP_WEBSERVER ? undefined : {
    command: 'node app.js',
    url: process.env.E2E_BASE_URL || 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
    env: { NODE_ENV: 'development' }
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        ...(chromiumPath ? { launchOptions: { executablePath: chromiumPath } } : {})
      }
    }
  ]
};
