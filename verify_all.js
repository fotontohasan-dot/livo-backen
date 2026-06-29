const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  const pages = [
    { name: 'home', path: '/' },
    { name: 'sports', path: '/sports' },
    { name: 'matches', path: '/matches' },
    { name: 'leaderboard', path: '/leaderboard' },
    { name: 'profile', path: '/profile' },
    { name: 'kyc', path: '/extra/kyc' },
    { name: 'coins', path: '/coins' },
    { name: 'news', path: '/news' },
    { name: 'tournaments', path: '/tournaments' },
    { name: 'terms', path: '/terms' },
    { name: 'accumulator', path: '/accumulator' }
  ];

  const screenshotDir = process.env.VERIFICATION_DIR || path.join(__dirname, 'verification');
  if (!fs.existsSync(screenshotDir)) {
    fs.mkdirSync(screenshotDir, { recursive: true });
  }

  for (const p of pages) {
    try {
      // English
      await page.goto(`http://localhost:3000/lang/en`);
      await page.goto(`http://localhost:3000${p.path}`);
      await page.screenshot({ path: path.join(screenshotDir, `${p.name}_en.png`), fullPage: true });
      console.log(`Captured ${p.name}_en.png`);

      // Bengali
      await page.goto(`http://localhost:3000/lang/bn`);
      await page.goto(`http://localhost:3000${p.path}`);
      await page.screenshot({ path: path.join(screenshotDir, `${p.name}_bn.png`), fullPage: true });
      console.log(`Captured ${p.name}_bn.png`);
    } catch (err) {
      console.error(`Failed to capture ${p.name}: `, err.message);
    }
  }

  await browser.close();
})();
