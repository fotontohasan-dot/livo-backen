#!/usr/bin/env node
/**
 * scripts/scanSecrets.js
 *
 * Working tree এবং (চাইলে) সম্পূর্ণ git history-তে credential খোঁজে।
 *
 *   node scripts/scanSecrets.js            # শুধু working tree (দ্রুত)
 *   node scripts/scanSecrets.js --history  # পুরো git history-ও (ধীর)
 *
 * গুরুত্বপূর্ণ: এই script কখনো secret-এর প্রকৃত মান ছাপে না — শুধু কোথায়
 * পাওয়া গেছে এবং কী ধরনের, সেটুকু জানায়। ফলে CI log নিজেই leak হয়ে যায় না।
 *
 * নোট: shallow clone-এ history scan অর্থহীন। CI-তে চালালে
 * actions/checkout@v4-এ `fetch-depth: 0` দিতে হবে, নাহলে এই script
 * সতর্কবার্তা দেবে।
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

const PATTERNS = [
  { name: 'AWS access key',        re: /AKIA[0-9A-Z]{16}/g },
  { name: 'GitHub token',          re: /gh[pousr]_[A-Za-z0-9]{30,}/g },
  { name: 'OpenAI key',            re: /sk-[A-Za-z0-9]{40,}/g },
  { name: 'Anthropic key',         re: /sk-ant-[A-Za-z0-9\-_]{20,}/g },
  { name: 'Telegram bot token',    re: /\b\d{8,10}:AA[A-Za-z0-9_\-]{30,}/g },
  { name: 'Slack token',           re: /xox[baprs]-[A-Za-z0-9\-]{10,}/g },
  { name: 'Private key block',     re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { name: 'JWT',                   re: /eyJ[A-Za-z0-9_\-]{20,}\.eyJ[A-Za-z0-9_\-]{20,}\./g },
  { name: 'DB URL with password',  re: /postgres(?:ql)?:\/\/[^\s:/@]+:[^\s@'"]{4,}@[^\s'"]+/g },
];

// পরিচিত নিরাপদ মান — placeholder, test fixture, local dev
const SAFE_MARKERS = [
  'localhost', '127.0.0.1', 'postgres:postgres', 'example.com',
  'test_secret', 'YOUR_', 'your_', 'placeholder', 'changeme', 'CHANGEME',
  '<user>', '<password>', 'DBuser:secret', 'xxxxx', 'XXXXX',
  'abcdefghijklmnopqrstuvwxyz',   // test fixture গুলোতে ব্যবহৃত
  'zyxwvutsrqponmlkjihgfedcba',
];

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'coverage', 'test-results', 'dist', 'build',
  '.next', 'android', 'playwright-report',
]);

const isSafe = (value) => SAFE_MARKERS.some((m) => value.includes(m));

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function scanText(text, label, findings) {
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (isSafe(m[0])) continue;
      findings.push({ kind: name, where: label });
    }
  }
}

// এই ফাইলগুলো নিজেরাই pattern নিয়ে আলোচনা করে, প্রকৃত secret ধারণ করে না
const DOC_ALLOWLIST = new Set([
  'SECURITY_INCIDENT.md',
  path.join('scripts', 'scanSecrets.js'),
]);

function scanWorkingTree() {
  const findings = [];
  for (const file of walk(ROOT)) {
    if (/\.(png|jpe?g|webp|ico|gz|zip|pdf|mp4|woff2?|ttf)$/i.test(file)) continue;
    if (DOC_ALLOWLIST.has(path.relative(ROOT, file))) continue;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
    scanText(text, path.relative(ROOT, file), findings);
  }
  return findings;
}

function scanHistory() {
  const findings = [];
  const shallow = fs.existsSync(path.join(ROOT, '.git', 'shallow'));
  if (shallow) {
    console.warn('  WARNING: shallow clone সনাক্ত হয়েছে — history scan অসম্পূর্ণ।');
    console.warn('   পূর্ণ scan-এর জন্য: git fetch --unshallow  (CI-তে fetch-depth: 0)');
  }
  const diff = execSync('git log --all -p --no-color', {
    cwd: ROOT, maxBuffer: 512 * 1024 * 1024, encoding: 'utf8',
  });
  scanText(diff, 'git history', findings);
  return findings;
}

function report(title, findings) {
  const grouped = new Map();
  for (const f of findings) {
    const key = `${f.kind} :: ${f.where}`;
    grouped.set(key, (grouped.get(key) || 0) + 1);
  }
  console.log(`\n=== ${title} ===`);
  if (grouped.size === 0) {
    console.log('  পরিষ্কার — কোনো credential পাওয়া যায়নি।');
    return 0;
  }
  for (const [key, count] of grouped) {
    console.log(`  ${key}  (${count}x)`);
  }
  return grouped.size;
}

function main() {
  const withHistory = process.argv.includes('--history');

  const treeIssues = report('WORKING TREE', scanWorkingTree());
  let historyIssues = 0;
  if (withHistory) historyIssues = report('GIT HISTORY', scanHistory());

  console.log('');
  if (treeIssues > 0) {
    console.error(' Working tree-তে credential আছে — commit করার আগে সরান।');
    process.exit(1);
  }
  if (historyIssues > 0) {
    console.error(' Git history-তে credential আছে। SECURITY_INCIDENT.md দেখুন —');
    console.error('   প্রথম কাজ rotation, history rewrite নয়।');
    process.exit(2);
  }
  console.log(' কোনো credential পাওয়া যায়নি।');
}

main();
