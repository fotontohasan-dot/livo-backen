import { test } from '@playwright/test';
import fs from 'fs';

test('Verify localized pages', async ({ page }) => {
  const pages = [
    { name: 'home', path: '/' },
    { name: 'terms', path: '/terms' },
    { name: 'rules', path: '/rules' },
    { name: 'privacy', path: '/privacy' },
    { name: 'accumulator', path: '/accumulator' }
  ];

  for (const p of pages) {
    // English
    await page.goto(`http://localhost:3000/lang/en`);
    await page.goto(`http://localhost:3000${p.path}`);
    await page.screenshot({ path: `/home/jules/verification/${p.name}_en.png`, fullPage: true });

    // Bengali
    await page.goto(`http://localhost:3000/lang/bn`);
    await page.goto(`http://localhost:3000${p.path}`);
    await page.screenshot({ path: `/home/jules/verification/${p.name}_bn.png`, fullPage: true });
  }
});
