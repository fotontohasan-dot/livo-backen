// tests/security/adminChatXss.test.js
// ---------------------------------------------------------------------------
// অ্যাডমিন চ্যাটের স্টোরড XSS।
//
// আক্রমণের চেইনটা ছিল সম্পূর্ণ: একজন সাধারণ ইউজার সাপোর্ট চ্যাটে একটা মেসেজ পাঠায়
// → সেটা chat_messages টেবিলে হুবহু জমা হয় → অ্যাডমিন /admin/chat খুলে ইতিহাস লোড
// করে → views/admin/chat.ejs সেটা `div.innerHTML = ...${text}...` দিয়ে বসায় →
// অ্যাডমিনের সেশনে আক্রমণকারীর JavaScript চলে। অর্থাৎ যেকোনো রেজিস্টার্ড ইউজার
// একটামাত্র চ্যাট মেসেজ দিয়ে অ্যাডমিন অ্যাকাউন্ট দখলের চেষ্টা করতে পারত।
//
// একই ফাইলে আরও দুটো ইনজেকশন পয়েন্ট ছিল:
//   * কনভারসেশন সাইডবারে `${user.username}` ও শেষ-মেসেজের প্রিভিউ;
//   * file_url — `<img src="${fileUrl}" onclick="window.open('${fileUrl}')">`,
//     যেখানে অ্যাট্রিবিউট থেকে বেরিয়ে আসা এবং `javascript:` স্কিম দুটোই সম্ভব ছিল।
//
// রেন্ডারিং সম্পূর্ণ ক্লায়েন্ট-সাইডে হয় (fetch → JS), তাই সার্ভার রেসপন্সে পে-লোড
// খুঁজে লাভ নেই — DB-তে সেটা কাঁচা অবস্থায় থাকাই স্বাভাবিক ও কাম্য (সেটাই আসল ডেটা)।
// আসল প্রতিরক্ষা হলো টেমপ্লেটের রেন্ডারিং কৌশল, তাই এই টেস্ট সেটাকেই পাহারা দেয়:
// মেসেজ বডি textContent দিয়ে বসে, কোনো ইউজার-নিয়ন্ত্রিত মান innerHTML টেমপ্লেটে
// এস্কেপ ছাড়া যায় না, এবং URL গুলো স্কিম-যাচাই পার হয়।
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const CHAT_VIEW = path.join(__dirname, '..', '..', 'views', 'admin', 'chat.ejs');
const source = fs.readFileSync(CHAT_VIEW, 'utf8');

// টাস্কে চাওয়া ন্যূনতম পে-লোড সেট।
const PAYLOADS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<svg onload=alert(1)>',
  '"><script>alert(1)</script>'
];

describe('অ্যাডমিন চ্যাট — স্টোরড XSS প্রতিরোধ', () => {
  test('মেসেজের বডি innerHTML-এ নয়, textContent দিয়ে বসানো হয়', () => {
    // এটাই মূল ফিক্স — বাবল তৈরি হয় DOM API দিয়ে, স্ট্রিং কনক্যাট দিয়ে নয়।
    expect(source).toMatch(/bubble\.textContent\s*=\s*text/);
    // পুরনো দুর্বল প্যাটার্নটা আর থাকা চলবে না।
    expect(source).not.toMatch(/rounded-3xl text-sm[^`]*\$\{text\}/);
  });

  test('appendMessage আর কোনো innerHTML টেমপ্লেট ব্যবহার করে না', () => {
    const fn = /function appendMessage\([^)]*\)\s*\{([\s\S]*?)\n    \}/.exec(source);
    expect(fn).not.toBeNull();
    // কমেন্টে শব্দটা ব্যাখ্যা হিসেবে থাকতে পারে — আসল কোডে আছে কিনা সেটাই প্রশ্ন।
    const code = fn[1].replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/innerHTML/);
  });

  test('inline onclick হ্যান্ডলারে file_url আর বসানো হয় না', () => {
    // `onclick="window.open('${fileUrl}', ...)"` — এখানে একটা কোট ভাঙলেই
    // নির্বিচারে JS চলত।
    expect(source).not.toMatch(/onclick="window\.open\('\$\{/);
    expect(source).toMatch(/addEventListener\('click'/);
  });

  test('মিডিয়া URL স্কিম-যাচাই পার হয়ে তবেই রেন্ডার হয় (javascript:/data: বাদ)', () => {
    expect(source).toMatch(/function safeMediaUrl/);
    // fail-closed: অজানা স্কিম হলে null, ফলে এলিমেন্টটাই তৈরি হয় না।
    expect(source).toMatch(/protocol === 'http:' \|\| .*protocol === 'https:'/);
    expect(source).toMatch(/img\.src = mediaUrl/);
    expect(source).toMatch(/video\.src = mediaUrl/);
  });

  test('সাইডবারে username ও শেষ-মেসেজ প্রিভিউ এস্কেপ করা হয়', () => {
    expect(source).toMatch(/\$\{escapeHtml\(user\.username\)\}/);
    expect(source).toMatch(/\$\{escapeHtml\(lastPreview\)\}/);
    // কাঁচা ইন্টারপোলেশন আর থাকা চলবে না।
    expect(source).not.toMatch(/\$\{user\.username\}/);
    expect(source).not.toMatch(/\$\{prefix\}\$\{lastPreview\}/);
  });

  test('escapeHtml সব বিপজ্জনক ক্যারেক্টার সরায়', () => {
    // টেমপ্লেটের ভেতরের হেল্পারটা বের করে এনে আসল পে-লোড দিয়ে যাচাই।
    const helper = /function escapeHtml\(str\) \{[\s\S]*?\n    \}/.exec(source);
    expect(helper).not.toBeNull();
    // eslint-disable-next-line no-new-func
    const escapeHtml = new Function(`${helper[0]}; return escapeHtml;`)();

    PAYLOADS.forEach((payload) => {
      const escaped = escapeHtml(payload);
      expect(escaped).not.toContain('<');
      expect(escaped).not.toContain('>');
      // এস্কেপ করার পরও মানুষের কাছে বার্তাটা পড়ার মতো থাকে (তথ্য হারায় না)।
      expect(escaped).toContain('alert(1)');
    });
  });

  test('unread_count সংখ্যায় রূপান্তরিত হয়ে তবেই HTML-এ যায়', () => {
    // DB থেকে আসা মান হলেও এটা HTML-এ ইন্টারপোলেট হয়; Number() একটা
    // টাইপ-লেভেল গ্যারান্টি দেয়।
    expect(source).toMatch(/Number\(user\.unread_count\)/);
  });
});

describe('অন্যান্য অ্যাডমিন ভিউতে ইউজার-নিয়ন্ত্রিত মান', () => {
  test('লিডারবোর্ডে username এস্কেপ করা হয়', () => {
    const lb = fs.readFileSync(
      path.join(__dirname, '..', '..', 'views', 'admin', 'leaderboard.ejs'), 'utf8'
    );
    expect(lb).toMatch(/esc\(l\.username\)/);
    expect(lb).not.toMatch(/'<\/td><td>@' \+ l\.username/);
  });

  test('বটম-নেভ টোস্ট innerHTML নয়, textContent ব্যবহার করে', () => {
    // টোস্টের টেক্সট আসে admin_alert ইভেন্ট থেকে, যার message ফিল্ডে ইউজারের
    // পাঠানো চ্যাট-বার্তা বসে — অর্থাৎ সম্পূর্ণ অবিশ্বস্ত।
    //
    // আগে এই অ্যাসারশন এলিমেন্ট ভ্যারিয়েবলের নাম (`t`) ধরে লেখা ছিল। নামটা
    // res.locals.t অনুবাদককে shadow করত, তাই সেটা `toastEl` করা হয়েছে —
    // নিরাপত্তার বৈশিষ্ট্য বদলায়নি। এখন অ্যাসারশন নাম-নিরপেক্ষ: showToast()
    // ফাংশনের ভেতরে textContent ব্যবহার হয় এবং innerHTML কোথাও নেই।
    const nav = fs.readFileSync(
      path.join(__dirname, '..', '..', 'views', 'admin', 'partials', 'bottom-nav.ejs'), 'utf8'
    );
    const fn = nav.slice(nav.indexOf('function showToast('));
    const body = fn.slice(0, fn.indexOf('\n  }') + 4);
    expect(body).toMatch(/\.textContent\s*=\s*'🔔 '/);
    expect(body).not.toMatch(/\.innerHTML/);
  });
});
