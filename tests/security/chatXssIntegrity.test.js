// tests/security/chatXssIntegrity.test.js
// ---------------------------------------------------------------------------
// রিগ্রেশন গার্ড — অডিট P0-05 (অ্যাডমিন সাপোর্ট-চ্যাটে stored XSS)।
//
// আগের আচরণ: views/admin/chat.ejs-এর appendMessage() ও loadConversations()
// ইউজারের বার্তা, ইউজারনেম এবং fileUrl সরাসরি innerHTML-এ বসাত, এবং fileUrl
// একটা onclick="window.open('${fileUrl}')" অ্যাট্রিবিউটেও যেত। fileUrl আসে
// socket পেলোড থেকে (services/socket.js), অর্থাৎ পুরোপুরি ক্লায়েন্ট-নিয়ন্ত্রিত।
// app.js-এর CSP-তে script-src ও script-src-attr দুটোতেই 'unsafe-inline' আছে,
// তাই ইনজেক্ট করা কোড ব্লক হতো না — যেকোনো সাধারণ ইউজার একটা বার্তা পাঠিয়েই
// অ্যাডমিনের সেশনে কোড চালাতে পারত।
//
// দুই স্তরেই যাচাই করা হচ্ছে:
//   ১) উৎস — services/mediaUrl.js: বিষাক্ত মান কখনো DB-তেই ঢোকে না
//   ২) সিংক — views/admin/chat.ejs: ইউজার-ডেটা আর innerHTML-এ যায় না
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const {
  safeMediaUrl,
  safeFileType,
  safeMessageText,
  MAX_MESSAGE_LENGTH
} = require('../../services/mediaUrl');

const ADMIN_CHAT_VIEW = path.join(__dirname, '..', '..', 'views', 'admin', 'chat.ejs');

describe('services/mediaUrl — চ্যাট অ্যাটাচমেন্ট যাচাই (P0-05 উৎস)', () => {
  test('বৈধ Cloudinary https URL গ্রহণ করা হয়', () => {
    const url = 'https://res.cloudinary.com/demo/image/upload/v1/livo/chat/a.png';
    expect(safeMediaUrl(url)).toBe(url);
  });

  test('অ্যাট্রিবিউট-ব্রেকআউট পেলোড প্রত্যাখ্যাত', () => {
    // ঠিক এই আকারের মানই আগে onclick="window.open('...')"-এ বসে কোড চালাতে পারত
    expect(safeMediaUrl("x');alert(document.cookie);//")).toBeNull();
    expect(safeMediaUrl('" onerror="alert(1)')).toBeNull();
    // দ্রষ্টব্য: অনুমোদিত হোস্টের পাথে উদ্ধৃতি/বন্ধনী থাকা URL (যেমন
    // https://res.cloudinary.com/a.png');alert(1);// ) allow-list পেরিয়ে যায়, এবং
    // সেটা ইচ্ছাকৃত — রেন্ডারিং এখন img.src = url (DOM API) দিয়ে হয়, কোনো HTML বা
    // অ্যাট্রিবিউট স্ট্রিং তৈরি হয় না, তাই ওই অক্ষরগুলোর আর কোনো সিনট্যাক্টিক অর্থ নেই।
    // যেটা আসলে গুরুত্বপূর্ণ তা হলো হোস্ট allow-list পেরোনো যায় না — নিচের টেস্টে যাচাই।
    expect(safeMediaUrl("https://evil.example/a.png');alert(1);//")).toBeNull();
  });

  test('বিপজ্জনক স্কিম প্রত্যাখ্যাত', () => {
    for (const u of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'vbscript:msgbox(1)',
      'file:///etc/passwd'
    ]) {
      expect(safeMediaUrl(u)).toBeNull();
    }
  });

  test('অননুমোদিত হোস্ট প্রত্যাখ্যাত (allow-list বাইপাসের চেষ্টা সহ)', () => {
    for (const u of [
      'https://evil.example/a.png',
      'https://res.cloudinary.com.evil.example/a.png',
      'https://evil.example/?x=res.cloudinary.com',
      'https://res.cloudinary.com@evil.example/a.png'
    ]) {
      expect(safeMediaUrl(u)).toBeNull();
    }
  });

  test('http:// প্রত্যাখ্যাত — শুধু https', () => {
    expect(safeMediaUrl('http://res.cloudinary.com/a.png')).toBeNull();
  });

  test('non-string ও অস্বাভাবিক বড় ইনপুট নিরাপদে প্রত্যাখ্যাত', () => {
    for (const bad of [null, undefined, 42, {}, [], '', '   ']) {
      expect(safeMediaUrl(bad)).toBeNull();
    }
    expect(safeMediaUrl('https://res.cloudinary.com/' + 'a'.repeat(5000))).toBeNull();
  });

  test('fileType allow-list — অজানা টাইপ প্রত্যাখ্যাত', () => {
    expect(safeFileType('image')).toBe('image');
    expect(safeFileType('video')).toBe('video');
    for (const bad of ['script', 'html', '', null, undefined, 'IMAGE']) {
      expect(safeFileType(bad)).toBeNull();
    }
  });

  test('বার্তার দৈর্ঘ্য সীমাবদ্ধ, কিন্তু বৈধ HTML-সদৃশ টেক্সট নষ্ট হয় না', () => {
    // রেন্ডারিং textContent দিয়ে হয়, তাই `<` থাকা সম্পূর্ণ নিরাপদ — স্ট্রিপ করলে
    // বরং কোড-স্নিপেট পাঠানো বৈধ বার্তা নষ্ট হতো।
    expect(safeMessageText('a < b && c > d')).toBe('a < b && c > d');
    expect(safeMessageText('  hello  ')).toBe('hello');
    expect(safeMessageText('x'.repeat(MAX_MESSAGE_LENGTH + 500)).length).toBe(MAX_MESSAGE_LENGTH);
    for (const bad of [null, undefined, 42, {}, '', '   ']) {
      expect(safeMessageText(bad)).toBeNull();
    }
  });
});

// সোর্স-লেভেল অ্যাসারশনগুলো কোড দেখতে চায়, কমেন্ট নয় — ফিক্সের ব্যাখ্যায় পুরনো
// ঝুঁকিপূর্ণ প্যাটার্নটা উদ্ধৃত করা আছে, সেটা যেন মিথ্যা ব্যর্থতা না ঘটায়।
function stripComments(source) {
  return source
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

describe('views/admin/chat.ejs — ইউজার-ডেটা আর innerHTML-এ যায় না (P0-05 সিংক)', () => {
  const src = stripComments(fs.readFileSync(ADMIN_CHAT_VIEW, 'utf8'));

  test('ইউজার-নিয়ন্ত্রিত মান কোনো innerHTML অ্যাসাইনমেন্টে ইন্টারপোলেট হয় না', () => {
    // innerHTML = `...${...}...` আকারের যেকোনো টেমপ্লেট-লিটারাল অ্যাসাইনমেন্ট খুঁজি
    const interpolatedInnerHtml = src.match(/innerHTML\s*=\s*`[^`]*\$\{[^`]*`/g) || [];
    expect(interpolatedInnerHtml).toEqual([]);
  });

  test('পুরনো দুটো ঝুঁকিপূর্ণ সিংক আর নেই', () => {
    expect(src).not.toContain('${user.username}');
    expect(src).not.toContain('${lastPreview}');
    expect(src).not.toContain('${text}');
    // fileUrl আর কোনো ইনলাইন ইভেন্ট-হ্যান্ডলার অ্যাট্রিবিউটে বসে না
    expect(src).not.toMatch(/onclick\s*=\s*"[^"]*\$\{fileUrl\}/);
    expect(src).not.toContain('src="${fileUrl}"');
  });

  test('নিরাপদ রেন্ডারিং প্যাটার্নই ব্যবহৃত হচ্ছে', () => {
    expect(src).toContain('textContent');
    expect(src).toContain('createElement');
    expect(src).toContain('replaceChildren');
    // ক্লায়েন্ট-সাইড দ্বিতীয় স্তর: পুরনো, ফিক্সের আগে DB-তে জমা হওয়া রো-ও ব্লক হয়
    expect(src).toContain('safeMediaUrl');
    expect(src).toContain("res.cloudinary.com");
  });

  test('ব্যবহারকারী-চ্যাটের নিরাপদ প্যাটার্নের সাথে সামঞ্জস্যপূর্ণ', () => {
    // views/profile/chat.ejs শুরু থেকেই সঠিক ছিল — দুটো ভিউ যেন আর আলাদা না হয়
    const userChat = stripComments(fs.readFileSync(
      path.join(__dirname, '..', '..', 'views', 'profile', 'chat.ejs'), 'utf8'
    ));
    expect(userChat).toContain('textContent');
    expect((userChat.match(/innerHTML\s*=\s*`[^`]*\$\{[^`]*`/g) || [])).toEqual([]);
  });
});

describe('services/socket.js — send_message উৎসেই যাচাই করে (P0-05)', () => {
  const src = stripComments(fs.readFileSync(
    path.join(__dirname, '..', '..', 'services', 'socket.js'), 'utf8'
  ));

  test('message/fileUrl/fileType আর কাঁচা পেলোড থেকে নেওয়া হয় না', () => {
    expect(src).not.toContain('const fileUrl = (data && data.fileUrl) || null;');
    expect(src).not.toContain('const message = (data && data.message) || null;');
    expect(src).toContain('safeMediaUrl(data && data.fileUrl)');
    expect(src).toContain('safeMessageText(data && data.message)');
  });

  test('Socket.IO আর wildcard CORS ব্যবহার করে না (P1-03)', () => {
    expect(src).not.toContain('origin: "*"');
    expect(src).toContain('allowRequest');
    expect(src).toContain('ALLOWED_SOCKET_ORIGINS');
  });

  test('admin role সেশন থেকে নয়, DB থেকে যাচাই হয় (P1-03)', () => {
    expect(src).toContain('isCurrentlyAdmin');
    expect(src).not.toMatch(/if\s*\(\s*u\s*&&\s*u\.role\s*===\s*'admin'\s*\)/);
    expect(src).not.toContain("const isAdmin = u.role === 'admin';");
  });
});
