const { fetchWithTimeout } = require('./utils/httpClient');
const Anthropic = require('@anthropic-ai/sdk');
const crypto = require('crypto');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || 'https://livo-backen.onrender.com';

// ==================== নিরাপত্তা: Webhook যাচাইকরণ ====================
// Telegram প্রতিটি webhook request-এ এই secret token header হিসেবে পাঠাবে
// (setWebhook কল করার সময় এই একই token Telegram-কে জানিয়ে দেওয়া হয়)।
// header না থাকলে/না মিললে বুঝতে হবে request Telegram থেকে আসেনি।
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || null;
if (!WEBHOOK_SECRET) {
  console.warn('⚠️ TELEGRAM_WEBHOOK_SECRET সেট করা নেই — নিরাপত্তার জন্য বট কোনো webhook request গ্রহণ করবে না (fail-closed)। .env-এ TELEGRAM_WEBHOOK_SECRET সেট করুন (যেমন: openssl rand -hex 24)।');
}

// শুধুমাত্র এই chat ID থেকে আসা মেসেজ প্রসেস হবে (admin/Mahmud-এর Telegram chat id)।
// সেট না থাকলে বট fail-closed থাকবে — GitHub-writable AI bot কখনো সবার জন্য খোলা রাখা উচিত না।
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID;
if (!ADMIN_CHAT_ID) {
  console.warn('⚠️ TELEGRAM_ADMIN_CHAT_ID সেট করা নেই — নিরাপত্তার জন্য বট আপাতত কোনো মেসেজ প্রসেস করবে না। .env-এ আপনার Telegram chat id সেট করুন।');
}

function verifyWebhookSecret(headerValue) {
  if (!WEBHOOK_SECRET) return false; // secret সেট না থাকলে কোনো request-ই গ্রহণযোগ্য না
  if (!headerValue) return false;
  const a = Buffer.from(String(headerValue));
  const b = Buffer.from(WEBHOOK_SECRET);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ==================== নিরাপত্তা: প্রেরকের পরিচয় (chat নয়, user) ====================
// আগে অনুমোদন হতো শুধু chat id দেখে। ADMIN_CHAT_ID যদি কোনো গ্রুপ হয় (বা ভবিষ্যতে
// গ্রুপে বসানো হয়), তাহলে সেই গ্রুপের যেকোনো সদস্য GitHub-এ লেখার ক্ষমতা পেয়ে যেত।
// তাই এখন chat id + অপরিবর্তনীয় Telegram user id — দুটোই মিলতে হবে।
// TELEGRAM_ADMIN_USER_IDS সেট না থাকলে বট fail-closed (কোনো কমান্ড চলবে না)।
const ADMIN_USER_IDS = new Set(
  String(process.env.TELEGRAM_ADMIN_USER_IDS || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
);
if (ADMIN_USER_IDS.size === 0) {
  console.warn('⚠️ TELEGRAM_ADMIN_USER_IDS সেট করা নেই — বট fail-closed, কোনো DevOps কমান্ড চলবে না। .env-এ আপনার Telegram numeric user id দিন (কমা দিয়ে একাধিক)।');
}

/**
 * প্রেরক অনুমোদিত কিনা — username/display name/মেসেজের টেক্সট কিছুই বিশ্বাস করা হয় না,
 * শুধু অপরিবর্তনীয় numeric id দেখা হয়। যেকোনো একটা শর্ত না মিললে false (fail closed)।
 */
function isAuthorizedSender(msg) {
  const chatId = msg && msg.chat ? msg.chat.id : null;
  const fromId = msg && msg.from ? msg.from.id : null;
  if (chatId === null || chatId === undefined) return false;
  if (fromId === null || fromId === undefined) return false;
  if (msg.from && msg.from.is_bot) return false;
  if (!ADMIN_CHAT_ID || String(chatId) !== String(ADMIN_CHAT_ID)) return false;
  if (ADMIN_USER_IDS.size === 0) return false;
  return ADMIN_USER_IDS.has(String(fromId));
}

// ==================== নিরাপত্তা: রিপ্লে সুরক্ষা ====================
// Telegram ডেলিভারি নিশ্চিত করতে একই update বারবার পাঠাতে পারে (আমাদের রেসপন্স দেরি
// হলে বা 5xx হলে)। ডিডুপ ছাড়া একই কনফার্মেশন দুবার প্রসেস হয়ে ডুপ্লিকেট কমিট/ব্রাঞ্চ
// তৈরি হতে পারত। update_id একবারই গ্রহণযোগ্য।
const SEEN_UPDATE_LIMIT = 1000;
const seenUpdateIds = new Set();

function isDuplicateUpdate(updateId) {
  if (updateId === null || updateId === undefined) return false;
  const key = String(updateId);
  if (seenUpdateIds.has(key)) return true;
  seenUpdateIds.add(key);
  if (seenUpdateIds.size > SEEN_UPDATE_LIMIT) {
    // সবচেয়ে পুরোনোটা বাদ (Set ইনসারশন-অর্ডার ধরে রাখে)
    seenUpdateIds.delete(seenUpdateIds.values().next().value);
  }
  return false;
}

const GITHUB_OWNER = 'fotontohasan-dot';
const GITHUB_REPO = 'livo-backen';

// নিরাপত্তা: AI-র বলা ফাইলপাথ সরাসরি GitHub API URL-এ বসানো যাবে না।
// `..` দিয়ে repo-র বাইরে যাওয়া, `?`/`#` দিয়ে query বা ref বদলে দেওয়া
// (যেমন `app.js?ref=other-branch`), বা absolute path — সবই এখানে আটকানো হয়।
// বৈধ পাথ: repo-relative, শুধু অক্ষর/সংখ্যা/`.`/`-`/`_`/`/`।
const SAFE_PATH_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

function sanitizeRepoPath(rawPath) {
  if (typeof rawPath !== 'string') return null;
  const filePath = rawPath.trim();
  if (!filePath || filePath.length > 255) return null;
  if (filePath.startsWith('/') || filePath.endsWith('/')) return null;
  if (!SAFE_PATH_RE.test(filePath)) return null;
  if (filePath.split('/').some((segment) => segment === '.' || segment === '..')) return null;
  return filePath;
}

// ==================== নিরাপত্তা: যেসব ফাইল বট কখনো বদলাতে পারবে না ====================
// পাথ বৈধ হলেই সেটা লেখার যোগ্য নয়। CI ওয়ার্কফ্লো বদলাতে পারা মানে কার্যত
// arbitrary CI execution ও secret exfiltration — বট-ব্রাঞ্চ থেকেও PR টেমপ্লেট/অ্যাকশন
// দিয়ে সেটা করা সম্ভব। একইভাবে প্রমাণীকরণ/2FA/RBAC/CSRF-এর কোড বদলানো মানে
// নিজের নিরাপত্তা-নিয়ন্ত্রণ নিজেই খুলে ফেলার পথ তৈরি করা। তাই এগুলো fail-closed:
// পরিবর্তন করতে হলে মানুষকে সরাসরি PR দিতে হবে, Telegram/AI দিয়ে নয়।
const FORBIDDEN_WRITE_PREFIXES = [
  '.github/',
  'docker/',
  'scripts/',
  'middleware/',
  'queues/'
];
const FORBIDDEN_WRITE_FILES = new Set([
  'services/rbac.js',
  'services/twofactor.js',
  'services/auditLog.js',
  'services/envValidator.js',
  'services/secretBox.js',
  'utils/secretBox.js',
  'utils/tokens.js',
  'routes/auth.js',
  'routes/admin.js',
  'routes/adminTelegram.js',
  'telegram-bot.js',
  'reset-admin.js',
  'server.js',
  'db.js',
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.override.yml',
  'docker-compose.test.yml',
  'package.json',
  'package-lock.json'
]);

/**
 * লেখার অনুমতি আছে কিনা। sanitizeRepoPath() পাস করা পাথই এখানে আসা উচিত।
 * অজানা/সন্দেহজনক কিছু হলে false — fail closed।
 */
function isWritableRepoPath(safePath) {
  if (typeof safePath !== 'string' || !safePath) return false;
  const lower = safePath.toLowerCase();
  if (FORBIDDEN_WRITE_FILES.has(safePath)) return false;
  if (FORBIDDEN_WRITE_PREFIXES.some((p) => lower.startsWith(p))) return false;
  // .env, .env.example, যেকোনো শেল স্ক্রিপ্ট বা workflow ফাইল
  if (lower === '.env' || lower.startsWith('.env.')) return false;
  if (lower.endsWith('.sh')) return false;
  if (lower.endsWith('.yml') || lower.endsWith('.yaml')) return false;
  return true;
}

// Anthropic response-এ text ছাড়া অন্য block-ও থাকতে পারে; content[0].text ধরে
// নিলে undefined হয়ে পরের `.includes()` throw করে, ফলে admin শুধু generic
// "সমস্যা হয়েছে" দেখত। তাই সব text block জোড়া লাগানো হচ্ছে।
function extractText(response) {
  const blocks = Array.isArray(response?.content) ? response.content : [];
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const conversations = {};

// GitHub-এ commit করার আগে admin-এর explicit "হ্যাঁ" লাগবে — ভুল/দুর্ঘটনাক্রমে
// deploy হয়ে যাওয়া ঠেকাতে। chatId ধরে pending action রাখা হয়, ৫ মিনিট পর মেয়াদ শেষ।
const pendingActions = {};
const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_CONFIRM_ATTEMPTS = 3;

// ==================== নিরাপত্তা: অডিট ট্রেইল ====================
// প্রতিটা privileged অপারেশন — অনুমোদিত হোক বা প্রত্যাখ্যাত — audit_logs-এ যায়।
// কখনো টোকেন/সিক্রেট/ফাইলের কনটেন্ট লেখা হয় না; শুধু পরিচয়, কমান্ড ও ফলাফল।
// লগিং ব্যর্থ হলেও বটের ফ্লো কখনো ব্লক হয় না (auditLog নিজেই throw করে না)।
function auditTelegram({ action, status = 'success', riskLevel = 'medium', details = {} }) {
  try {
    require('./services/auditLog').logEvent({
      actorType: 'system',
      actorUsername: 'TELEGRAM_BOT',
      action,
      category: 'security',
      status,
      riskLevel,
      details
    });
  } catch (e) { /* non-fatal */ }
}

const SYSTEM_PROMPT = `তুমি Livo-র AI Assistant। Livo একটি অনলাইন গেমিং প্ল্যাটফর্ম Node.js/Express দিয়ে তৈরি।
তুমি বাংলায় কথা বলবে এবং Livo-র admin Mahmud-কে সাহায্য করবে।

তুমি করতে পারবে:
- Livo-র কোড সম্পর্কে সাহায্য করা
- Bug fix করতে সাহায্য করা
- নতুন feature এর পরামর্শ দেওয়া
- GitHub repository থেকে ফাইল দেখা ও edit করা

যখন কেউ কোনো ফাইল edit করতে বলবে, তখন এই format এ respond করো:
GITHUB_ACTION: edit_file
FILE: ফাইলের নাম (যেমন: app.js)
CONTENT: সম্পূর্ণ নতুন কোড এখানে

যখন কেউ কোনো ফাইল দেখতে চাইবে:
GITHUB_ACTION: read_file
FILE: ফাইলের নাম

সবসময় বাংলায় উত্তর দাও।`;

// Telegram API helper
async function telegramAPI(method, data) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  return response.json();
}

// GitHub: ফাইল পড়া
async function githubReadFile(filePath) {
  const safePath = sanitizeRepoPath(filePath);
  if (!safePath) return null;
  const encodedPath = safePath.split('/').map(encodeURIComponent).join('/');
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodedPath}`;
  const response = await fetchWithTimeout(url, {
    headers: {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json'
    }
  });
  const data = await response.json();
  if (data.content) {
    return {
      content: Buffer.from(data.content, 'base64').toString('utf8'),
      sha: data.sha
    };
  }
  return null;
}

// বট যে ব্রাঞ্চে লেখে। ডিফল্ট `main` **নয়** — ইচ্ছাকৃতভাবে।
//
// আগে বট সরাসরি ডিফল্ট ব্রাঞ্চে কমিট করত। অর্থাৎ যার হাতে Telegram
// অ্যাকাউন্ট বা বট টোকেন পড়ত, সে সরাসরি প্রোডাকশন কোড বদলাতে পারত — কোনো
// রিভিউ, CI বা মানুষের অনুমোদন ছাড়াই। একটা মেসেজেই পেমেন্ট রুট বা
// প্রমাণীকরণ মিডলওয়্যার বদলে দেওয়া সম্ভব ছিল।
//
// এখন লেখা যায় শুধু একটা আলাদা ব্রাঞ্চে। সেখান থেকে কোড প্রোডাকশনে যেতে
// হলে PR খুলতে হবে, CI পাস করতে হবে, আর মানুষকে মার্জ করতে হবে — অর্থাৎ
// বটের কোনো পরিবর্তন কখনো নিজে থেকে লাইভ হবে না।
const BOT_BRANCH = process.env.GITHUB_BOT_BRANCH || 'bot/automated-edits';
const PROTECTED_BRANCHES = ['main', 'master', 'production'];

/** বট-ব্রাঞ্চ না থাকলে ডিফল্ট ব্রাঞ্চের HEAD থেকে তৈরি করে। */
async function ensureBotBranch() {
  const base = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`;
  const headers = {
    'Authorization': `token ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json'
  };

  const existing = await fetchWithTimeout(`${base}/git/ref/heads/${encodeURIComponent(BOT_BRANCH)}`, { headers });
  if (existing.ok) return true;

  const repo = await fetchWithTimeout(base, { headers });
  if (!repo.ok) return false;
  const defaultBranch = (await repo.json()).default_branch;

  const head = await fetchWithTimeout(`${base}/git/ref/heads/${encodeURIComponent(defaultBranch)}`, { headers });
  if (!head.ok) return false;
  const sha = (await head.json()).object.sha;

  const created = await fetchWithTimeout(`${base}/git/refs`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: `refs/heads/${BOT_BRANCH}`, sha })
  });
  return created.ok;
}

// GitHub: ফাইল edit করা — শুধু বট-ব্রাঞ্চে
async function githubEditFile(filePath, newContent, commitMessage) {
  const safePath = sanitizeRepoPath(filePath);
  if (!safePath) return { success: false, error: 'অবৈধ ফাইলপাথ' };
  if (!isWritableRepoPath(safePath)) {
    return { success: false, error: 'এই ফাইলটি Telegram/AI দিয়ে পরিবর্তন করা যায় না (CI/নিরাপত্তা-সংবেদনশীল)।' };
  }

  // দ্বিগুণ সুরক্ষা: কনফিগে ভুল করে সুরক্ষিত ব্রাঞ্চ বসিয়ে দিলেও লেখা হবে না।
  if (PROTECTED_BRANCHES.includes(BOT_BRANCH)) {
    return { success: false, error: `বট সুরক্ষিত ব্রাঞ্চে (${BOT_BRANCH}) লিখতে পারে না — GITHUB_BOT_BRANCH বদলান।` };
  }

  const ready = await ensureBotBranch();
  if (!ready) return { success: false, error: `বট-ব্রাঞ্চ (${BOT_BRANCH}) তৈরি করা যায়নি` };

  // SHA অবশ্যই বট-ব্রাঞ্চের ফাইলেরই হতে হবে, ডিফল্ট ব্রাঞ্চের নয়।
  const encodedPath = safePath.split('/').map(encodeURIComponent).join('/');
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodedPath}`;
  const headers = {
    'Authorization': `token ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json',
    'Content-Type': 'application/json'
  };

  let sha;
  const existing = await fetchWithTimeout(`${url}?ref=${encodeURIComponent(BOT_BRANCH)}`, { headers });
  if (existing.ok) {
    sha = (await existing.json()).sha;
  }

  const response = await fetchWithTimeout(url, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      message: commitMessage || `🤖 Bot: ${safePath} updated`,
      content: Buffer.from(newContent).toString('base64'),
      branch: BOT_BRANCH,
      ...(sha ? { sha } : {})
    })
  });
  const result = await response.json();
  if (!result.commit) {
    // GitHub-এর কাঁচা রেসপন্স Telegram-এ পাঠানো হয় না — তাতে ইন্টারনাল URL,
    // rate-limit হেডার, টোকেন-স্কোপের ইঙ্গিত ফাঁস হতে পারে। বিস্তারিত শুধু সার্ভার লগে।
    console.error('[telegram-bot] GitHub commit ব্যর্থ:', response.status, result && result.message);
    return { success: false, error: 'GitHub-এ কমিট করা যায়নি — কোনো পরিবর্তন হয়নি।' };
  }

  return {
    success: true,
    branch: BOT_BRANCH,
    prUrl: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/pull/new/${BOT_BRANCH}`
  };
}

// GitHub action process করা
async function processGithubAction(responseText, chatId, fromId) {
  if (responseText.includes('GITHUB_ACTION: read_file')) {
    const fileMatch = responseText.match(/FILE: (.+)/);
    if (fileMatch) {
      const filePath = sanitizeRepoPath(fileMatch[1]);
      if (!filePath) {
        await telegramAPI('sendMessage', { chat_id: chatId, text: '❌ অবৈধ ফাইলপাথ — অনুরোধ বাতিল।' });
        return;
      }
      await telegramAPI('sendMessage', {
        chat_id: chatId,
        text: `📂 *${filePath}* পড়ছি...`,
        parse_mode: 'Markdown'
      });
      const file = await githubReadFile(filePath);
      if (file) {
        const preview = file.content.substring(0, 1000);
        await telegramAPI('sendMessage', {
          chat_id: chatId,
          text: `📄 *${filePath}* (প্রথম ১০০০ অক্ষর):\n\`\`\`\n${preview}\n\`\`\``,
          parse_mode: 'Markdown'
        });
      } else {
        await telegramAPI('sendMessage', {
          chat_id: chatId,
          text: `❌ ফাইল পাওয়া যায়নি: ${filePath}`
        });
      }
    }
  } else if (responseText.includes('GITHUB_ACTION: edit_file')) {
    const fileMatch = responseText.match(/FILE: (.+)/);
    const contentMatch = responseText.match(/CONTENT: ([\s\S]+)/);
    if (fileMatch && contentMatch) {
      const filePath = sanitizeRepoPath(fileMatch[1]);
      const newContent = contentMatch[1].trim();
      if (!filePath) {
        await telegramAPI('sendMessage', { chat_id: chatId, text: '❌ অবৈধ ফাইলপাথ — কোনো পরিবর্তন করা হয়নি।' });
        return;
      }
      if (!isWritableRepoPath(filePath)) {
        auditTelegram({
          action: 'TELEGRAM_DEVOPS_EDIT_DENIED',
          status: 'failure',
          riskLevel: 'high',
          details: { chatId: String(chatId), fromId: fromId === null ? null : String(fromId), path: filePath, reason: 'protected_path' }
        });
        await telegramAPI('sendMessage', {
          chat_id: chatId,
          text: '🚫 এই ফাইলটি Telegram/AI দিয়ে বদলানো যায় না (CI/নিরাপত্তা-সংবেদনশীল)। মানুষকে সরাসরি PR দিতে হবে।'
        });
        return;
      }

      // সরাসরি commit না করে, আগে admin-কে দেখিয়ে "হ্যাঁ" চাওয়া হচ্ছে।
      // কনফার্মেশন নির্দিষ্ট প্রেরক + নির্দিষ্ট অপারেশনের সাথে বাঁধা, একবারই ব্যবহারযোগ্য।
      pendingActions[chatId] = {
        operationId: crypto.randomBytes(12).toString('hex'),
        fromId: fromId === null ? null : String(fromId),
        filePath,
        newContent,
        attempts: 0,
        expiresAt: Date.now() + CONFIRM_TIMEOUT_MS
      };

      auditTelegram({
        action: 'TELEGRAM_DEVOPS_EDIT_REQUESTED',
        riskLevel: 'high',
        details: { chatId: String(chatId), fromId: fromId === null ? null : String(fromId), path: filePath, operationId: pendingActions[chatId].operationId }
      });

      const preview = newContent.length > 800 ? newContent.slice(0, 800) + '\n...(আরও আছে)' : newContent;
      await telegramAPI('sendMessage', {
        chat_id: chatId,
        text: `⚠️ *${filePath}* ফাইলটা এভাবে বদলাতে চাইছি:\n\`\`\`\n${preview}\n\`\`\`\n\nএটা সরাসরি GitHub-এ commit হয়ে যাবে এবং সাথে সাথে deploy শুরু হবে।\n\n✅ নিশ্চিত হলে লেখো: *হ্যাঁ*\n❌ বাতিল করতে লেখো: *না*\n\n(৫ মিনিটের মধ্যে সাড়া না দিলে এই অনুরোধ আপনা থেকেই বাতিল হয়ে যাবে)`,
        parse_mode: 'Markdown'
      });
    }
  } else {
    // Normal message
    await telegramAPI('sendMessage', {
      chat_id: chatId,
      text: responseText,
      parse_mode: 'Markdown'
    });
  }
}

// Webhook set
async function setWebhook() {
  if (!WEBHOOK_SECRET) {
    console.warn('⚠️ TELEGRAM_WEBHOOK_SECRET নেই — webhook রেজিস্টার করা হচ্ছে না, বট নিষ্ক্রিয় থাকবে।');
    return;
  }
  try {
    await telegramAPI('deleteWebhook', { drop_pending_updates: true });
    const webhookUrl = `${RENDER_URL}/telegram-webhook`;
    // secret_token পাঠানো হচ্ছে — Telegram এখন থেকে প্রতিটি request-এ
    // X-Telegram-Bot-Api-Secret-Token header-এ এই মানটা পাঠাবে, যা app.js যাচাই করবে।
    const result = await telegramAPI('setWebhook', { url: webhookUrl, secret_token: WEBHOOK_SECRET });
    console.log('🔗 Telegram Webhook set:', result.description);
  } catch (err) {
    console.error('⚠️ Telegram webhook setup skipped (network issue):', err.message);
  }
}

// Message handle করা
async function handleMessage(msg) {
  const chatId = msg && msg.chat ? msg.chat.id : null;
  const fromId = msg && msg.from ? msg.from.id : null;
  const userMessage = msg && typeof msg.text === 'string' ? msg.text : null;

  if (!userMessage) return;

  // নিরাপত্তা: chat id **এবং** অপরিবর্তনীয় user id — দুটোই allowlist-এ থাকতে হবে।
  // এই বট GitHub repo-তে write করতে পারে, তাই অননুমোদিত কেউ কোনো privileged
  // রেসপন্স পায় না — কোনো উত্তরও যায় না (probing-এ তথ্য ফাঁস হয় না)।
  if (!isAuthorizedSender(msg)) {
    console.warn(`⚠️ অননুমোদিত Telegram প্রেরক (chat=${chatId}, user=${fromId}) — উপেক্ষা করা হলো।`);
    auditTelegram({
      action: 'TELEGRAM_DEVOPS_UNAUTHORIZED',
      status: 'failure',
      riskLevel: 'high',
      details: { chatId: chatId === null ? null : String(chatId), fromId: fromId === null ? null : String(fromId) }
    });
    return;
  }

  if (userMessage === '/start') {
    conversations[chatId] = [];
    await telegramAPI('sendMessage', {
      chat_id: chatId,
      text: '🎮 *Livo AI Assistant*\n\nআমি তোমার Livo প্ল্যাটফর্মের AI Assistant!\n\nআমি এখন GitHub থেকে ফাইল পড়তে ও edit করতে পারি! 🔥\n\nউদাহরণ:\n• "app.js দেখাও"\n• "telegram-bot.js এ নতুন feature যোগ করো"\n\n/clear - কথোপকথন মুছো',
      parse_mode: 'Markdown'
    });
    return;
  }

  if (userMessage === '/clear') {
    conversations[chatId] = [];
    await telegramAPI('sendMessage', { chat_id: chatId, text: '✅ কথোপকথন মুছে ফেলা হয়েছে!' });
    return;
  }

  // pending GitHub edit-এর জবাব (হ্যাঁ/না) এখানেই সামলানো হয়, AI-কে ডাকার প্রয়োজন নেই
  const pending = pendingActions[chatId];
  if (pending) {
    if (Date.now() > pending.expiresAt) {
      delete pendingActions[chatId];
    } else if (pending.fromId !== null && String(fromId) !== String(pending.fromId)) {
      // অন্য কেউ (একই অনুমোদিত chat-এ থাকলেও) অন্যের অনুরোধ নিশ্চিত করতে পারবে না
      auditTelegram({
        action: 'TELEGRAM_DEVOPS_CONFIRM_DENIED',
        status: 'failure',
        riskLevel: 'high',
        details: { chatId: String(chatId), fromId: String(fromId), operationId: pending.operationId, reason: 'sender_mismatch' }
      });
      return;
    } else {
      const normalized = userMessage.trim().toLowerCase();
      const isYes = ['হ্যাঁ', 'হা', 'yes', 'y', 'confirm'].includes(normalized);
      const isNo = ['না', 'no', 'n', 'cancel'].includes(normalized);

      if (isYes) {
        delete pendingActions[chatId];
        await telegramAPI('sendMessage', {
          chat_id: chatId,
          text: `✏️ *${pending.filePath}* commit করছি...`,
          parse_mode: 'Markdown'
        });
        const result = await githubEditFile(pending.filePath, pending.newContent, `🤖 Bot: ${pending.filePath} updated via Telegram (admin confirmed)`);
        auditTelegram({
          action: 'TELEGRAM_DEVOPS_EDIT_COMMITTED',
          status: result.success ? 'success' : 'failure',
          riskLevel: 'critical',
          details: {
            chatId: String(chatId),
            fromId: fromId === null ? null : String(fromId),
            operationId: pending.operationId,
            repository: `${GITHUB_OWNER}/${GITHUB_REPO}`,
            branch: result.branch || BOT_BRANCH,
            path: pending.filePath,
            reason: result.success ? null : result.error
          }
        });
        if (result.success) {
          // বার্তাটা আগে বলত "Render এ deploy হচ্ছে..." — সেটা এখন মিথ্যা হতো,
          // কারণ পরিবর্তন বট-ব্রাঞ্চে যায়, প্রোডাকশনে নয়। ভুল আশ্বাস দিলে
          // অ্যাডমিন ভাবতেন কাজ শেষ, অথচ কোড কোথাও যায়নি।
          await telegramAPI('sendMessage', {
            chat_id: chatId,
            text: `✅ *${pending.filePath}* \`${result.branch}\` ব্রাঞ্চে কমিট হয়েছে।\n\n` +
                  `⚠️ এটি এখনো লাইভ নয়। প্রোডাকশনে নিতে PR খুলে মার্জ করুন:\n${result.prUrl}`,
            parse_mode: 'Markdown'
          });
        } else {
          await telegramAPI('sendMessage', { chat_id: chatId, text: `❌ Error: ${result.error}` });
        }
        return;
      }
      if (isNo) {
        delete pendingActions[chatId];
        await telegramAPI('sendMessage', { chat_id: chatId, text: '🚫 বাতিল করা হলো, কোনো পরিবর্তন হয়নি।' });
        return;
      }
      // অস্পষ্ট জবাব — pending অনুরোধটা মনে করিয়ে দেওয়া হচ্ছে, AI-কে ডাকা হচ্ছে না।
      // বারবার অস্পষ্ট জবাব দিয়ে একটা critical অনুরোধ অনির্দিষ্টকাল ঝুলিয়ে রাখা যাবে না।
      pending.attempts = (pending.attempts || 0) + 1;
      if (pending.attempts >= MAX_CONFIRM_ATTEMPTS) {
        delete pendingActions[chatId];
        auditTelegram({
          action: 'TELEGRAM_DEVOPS_CONFIRM_ABANDONED',
          status: 'failure',
          riskLevel: 'medium',
          details: { chatId: String(chatId), fromId: fromId === null ? null : String(fromId), operationId: pending.operationId, path: pending.filePath }
        });
        await telegramAPI('sendMessage', {
          chat_id: chatId,
          text: '🚫 বারবার অস্পষ্ট জবাব — অনুরোধটি বাতিল করা হলো, কোনো পরিবর্তন হয়নি।'
        });
        return;
      }
      await telegramAPI('sendMessage', {
        chat_id: chatId,
        text: `⏳ *${pending.filePath}*-এর পরিবর্তন এখনো নিশ্চিত হয়নি। "হ্যাঁ" বা "না" লেখো।`,
        parse_mode: 'Markdown'
      });
      return;
    }
  }

  if (!conversations[chatId]) conversations[chatId] = [];

  await telegramAPI('sendChatAction', { chat_id: chatId, action: 'typing' });

  try {
    conversations[chatId].push({ role: 'user', content: userMessage });

    if (conversations[chatId].length > 10) {
      conversations[chatId] = conversations[chatId].slice(-10);
    }

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: conversations[chatId]
    });

    const assistantMessage = extractText(response);
    if (!assistantMessage) {
      conversations[chatId].pop();
      await telegramAPI('sendMessage', { chat_id: chatId, text: '❌ কোনো উত্তর পাওয়া যায়নি, আবার চেষ্টা করো।' });
      return;
    }
    conversations[chatId].push({ role: 'assistant', content: assistantMessage });

    await processGithubAction(assistantMessage, chatId, fromId);

  } catch (error) {
    console.error('Error:', error);
    await telegramAPI('sendMessage', {
      chat_id: chatId,
      text: '❌ সমস্যা হয়েছে, আবার চেষ্টা করো।'
    });
  }
}

// টেস্টে বা webhook secret ছাড়া বুট করলে Telegram-এ কোনো নেটওয়ার্ক কল যাবে না।
if (process.env.NODE_ENV !== 'test') setWebhook();

module.exports = {
  handleMessage,
  verifyWebhookSecret,
  sanitizeRepoPath,
  isWritableRepoPath,
  isAuthorizedSender,
  isDuplicateUpdate,
  extractText
};
