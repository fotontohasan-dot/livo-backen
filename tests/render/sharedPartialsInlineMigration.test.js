const { scriptOrder, readScript, withScripts } = require('../helpers/viewScripts');
const fs = require('fs');
const path = require('path');

// docs/CSP.md ধাপ ২ — শেয়ার করা partial তিনটে আর দুটো অ্যাডমিন পেজ।
//
// partial গুলো বিশেষভাবে গুরুত্বপূর্ণ: admin-layout ৩৯টা পেজে, navbar ও
// announcements কার্যত সব ইউজার পেজে যায়। এখানে একটা বাটন নীরবে অকেজো
// হলে সেটা একটা পেজে নয়, সবগুলোতে একসাথে ভাঙে।

const ROOT = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const count = (src, re) => (src.match(re) || []).length;
const HANDLER_RE = /\son(?:click|change|submit|input|load|error|focus|blur|keyup|keydown|mouseover)=/g;

function scriptBlocks(src) {
  return [...src.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

// বাঁধার কোড আর ফাংশনের সংজ্ঞা একই <script> ব্লকে না থাকলে রানটাইমে
// ReferenceError — বাটনটা নীরবে মরে যায়। প্রতিটা ফাইলে সেটাই যাচাই।
// docs/CSP.md ধাপ ৩-এ অনেক টেমপ্লেটের কোড public/js/views/-এ সরানো হয়েছে।
// তাই "বাঁধার কোড আর ফাংশনের সংজ্ঞা একই স্কোপে আছে কি না" প্রশ্নটার উত্তর
// এখন ইনলাইন ব্লক আর বাইরের স্ক্রিপ্ট — দুই জায়গাতেই খুঁজতে হয়।
// একটা ফাইল = একটা স্কোপ, তাই সম্পত্তিটা অপরিবর্তিত।
function bindingBlock(src, marker) {
  const candidates = scriptBlocks(src)
    .concat(scriptOrder(src).map(readScript))
    .filter((b) => b.includes(marker));
  expect(candidates.length).toBe(1);
  return candidates[0];
}

describe('admin-layout partial — সাইডবার ও লগআউট', () => {
  const src = read('views', 'admin', 'partials', 'admin-layout.ejs');

  test('কোনো ইনলাইন হ্যান্ডলার নেই', () => {
    expect(src).not.toMatch(HANDLER_RE);
  });

  test('চারটে কন্ট্রোলই data-admin-nav পেয়েছে', () => {
    expect(count(src, /data-admin-nav="close-sidebar"/g)).toBe(2);
    expect(src).toContain('data-admin-nav="toggle-sidebar"');
    expect(src).toContain('data-admin-nav="logout"');
  });

  test('তিনটে ফাংশনই বাঁধার ব্লকেই সংজ্ঞায়িত', () => {
    const block = bindingBlock(src, 'data-admin-nav');
    ['closeMobileSidebar', 'toggleMobileSidebar', 'logout'].forEach((fn) => {
      expect(block).toMatch(new RegExp('function\\s+' + fn + '\\s*\\('));
    });
  });

  test('লগআউটের নিশ্চিতকরণ টিকে আছে', () => {
    expect(withScripts(src)).toMatch(/confirm\('Are you sure you want to logout\?'\)/);
  });
});

describe('navbar partial', () => {
  const src = read('views', 'partials', 'navbar.ejs');

  test('কোনো ইনলাইন হ্যান্ডলার নেই', () => {
    expect(src).not.toMatch(HANDLER_RE);
  });

  test('দুটো অ্যাকশনই hook পেয়েছে ও একই ব্লকে সংজ্ঞায়িত', () => {
    expect(src).toContain('data-navbar-action="toggle-menu"');
    expect(src).toContain('data-navbar-action="refresh-balance"');
    const block = bindingBlock(src, 'data-navbar-action');
    ['toggleMenu', 'refreshBalance'].forEach((fn) => {
      expect(block).toMatch(new RegExp('function\\s+' + fn + '\\s*\\('));
    });
  });
});

describe('announcements partial — দুই রকম বন্ধ করার বাটন', () => {
  const src = read('views', 'partials', 'announcements.ejs');

  test('কোনো ইনলাইন হ্যান্ডলার নেই', () => {
    expect(src).not.toMatch(HANDLER_RE);
  });

  test('ব্যানার closest() দিয়ে, পপআপ id দিয়ে খোঁজা হয়', () => {
    // দুটোর DOM কাঠামো আলাদা: ব্যানারটা বাটনের পূর্বপুরুষ, পপআপ ওভারলে নয়।
    // একটাই কৌশল ব্যবহার করলে একটা নীরবে বন্ধ হত না।
    expect(src).toContain('data-dismiss-target=".livo-announce-banner"');
    expect(src).toContain('data-dismiss-id="livoAnnouncePopupOverlay"');
    expect(count(src, /data-dismiss-announcement=/g)).toBe(2); // দুটো বাটন
    expect(withScripts(src)).toContain('[data-dismiss-announcement]'); // সিলেক্টর
    const block = bindingBlock(src, 'data-dismiss-announcement');
    expect(block).toMatch(/btn\.closest\(sel\)/);
    expect(block).toMatch(/document\.getElementById\(byId\)/);
    expect(block).toMatch(/function\s+livoDismissAnnouncement\s*\(/);
  });

  test('dismiss id সার্ভারে পাঠানো হয়', () => {
    expect(withScripts(src)).toMatch(/fetch\('\/announcements\/' \+ id \+ '\/dismiss'/);
  });
});

describe('admin/users.ejs — বাল্ক নির্বাচন', () => {
  const src = read('views', 'admin', 'users.ejs');

  test('কোনো ইনলাইন হ্যান্ডলার নেই', () => {
    expect(src).not.toMatch(HANDLER_RE);
  });

  test('চারটে কন্ট্রোলই hook পেয়েছে ও ফাংশন একই ব্লকে', () => {
    ['data-users-check', 'data-users-select-all',
     'data-users-action="bulk-ban"', 'data-users-action="clear"']
      .forEach((h) => expect(src).toContain(h));
    const block = bindingBlock(src, 'data-users-action');
    ['updateBulkBar', 'toggleSelectAllUsers', 'bulkBanSelected', 'clearBulkSelection']
      .forEach((fn) => expect(block).toMatch(new RegExp('function\\s+' + fn + '\\s*\\(')));
  });

  test('select-all চেকবক্সটাই ফাংশনে যায়', () => {
    // আগের কল ছিল toggleSelectAllUsers(this) — ফাংশনটা checked পড়ে।
    expect(withScripts(src)).toMatch(/toggleSelectAllUsers\(cb\)/);
  });
});

describe('admin/markets.ejs — সেটেল মডাল', () => {
  const src = read('views', 'admin', 'markets.ejs');

  test('কোনো ইনলাইন হ্যান্ডলার নেই', () => {
    expect(src).not.toMatch(HANDLER_RE);
  });

  test('মার্কেটের id ও নাম দুটোই hook-এ যায়', () => {
    // আগের কল ছিল showSettleModal(id, name) — নাম হারালে মডালের শিরোনাম
    // খালি থাকত এবং অ্যাডমিন কোন মার্কেট সেটেল করছে বুঝত না।
    expect(src).toContain('data-settle-id="<%= m.id %>"');
    expect(src).toContain('data-settle-name="<%= m.name %>"');
    const block = bindingBlock(src, 'data-settle-id');
    expect(block).toMatch(/getAttribute\('data-settle-id'\), btn\.getAttribute\('data-settle-name'\)/);
    ['exportMarketsCSV', 'showSettleModal', 'hideSettleModal']
      .forEach((fn) => expect(block).toMatch(new RegExp('function\\s+' + fn + '\\s*\\(')));
  });
});
