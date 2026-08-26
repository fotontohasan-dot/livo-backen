import { test } from '@playwright/test';
import fs from 'fs';
import path from 'path';

// verify_all.js-এর মতোই পোর্টেবল আউটপুট পাথ — হার্ডকোড করা কোনো হোম ডিরেক্টরি নয়,
// তাই যেকোনো মেশিনে/CI-তে চলে। VERIFICATION_DIR দিয়ে ওভাররাইড করা যায়।
const screenshotDir = process.env.VERIFICATION_DIR || path.join(__dirname, 'verification');

test('Verify localized pages', async ({ page }) => {
  const pages = [
    { name: 'home', path: '/' },
    { name: 'terms', path: '/terms' },
    { name: 'rules', path: '/rules' },
    { name: 'privacy', path: '/privacy' },
    { name: 'accumulator', path: '/accumulator' }
  ];

  if (!fs.existsSync(screenshotDir)) {
    fs.mkdirSync(screenshotDir, { recursive: true });
  }

  for (const p of pages) {
    // English
    await page.goto(`http://localhost:3000/lang/en`);
    await page.goto(`http://localhost:3000${p.path}`);
    await page.screenshot({ path: path.join(screenshotDir, `${p.name}_en.png`), fullPage: true });

    // Bengali
    await page.goto(`http://localhost:3000/lang/bn`);
    await page.goto(`http://localhost:3000${p.path}`);
    await page.screenshot({ path: path.join(screenshotDir, `${p.name}_bn.png`), fullPage: true });
  }
});
