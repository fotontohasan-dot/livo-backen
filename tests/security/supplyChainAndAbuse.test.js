// tests/security/supplyChainAndAbuse.test.js
// ---------------------------------------------------------------------------
// PHASE 10 (SECRETS) + 11 (CI/CD) + 12 (DEPENDENCIES) + 13 (RESOURCE ABUSE)
//
//   MEDIUM-9  : GitHub Actions workflow-এ কোনো permissions block ছিল না,
//               ফলে GITHUB_TOKEN repository-র default (প্রায়ই write) পেত
//   MEDIUM-10 : /csp-report unauthenticated, global rate limiter-এর আগে
//               mount করা, এবং প্রতিটি unique key unbounded Map-এ জমা হত
//               → remote memory exhaustion
//
//   বাকিগুলো regression lock: secret leak নেই, token masked, lockfile আছে
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

describe('Secrets, CI/CD, dependencies and resource abuse (PHASE 10-13)', () => {
  describe('PHASE 10: secrets', () => {
    const SECRET_PATTERNS = [
      { name: 'AWS access key', re: /AKIA[0-9A-Z]{16}/ },
      { name: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9]{30,}/ },
      { name: 'Anthropic key', re: /sk-ant-[A-Za-z0-9\-_]{20,}/ },
      { name: 'private key', re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
    ];

    const collectSourceFiles = () => {
      const skip = new Set(['node_modules', '.git', 'coverage', 'test-results', 'dist', 'build', '.next', 'android']);
      const out = [];
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (skip.has(entry.name)) continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (/\.(js|ejs|ts|tsx|json|yml|yaml|sh|md|env\w*)$/.test(entry.name) || entry.name.startsWith('.env')) {
            out.push(full);
          }
        }
      };
      walk(ROOT);
      return out;
    };

    test('কোনো tracked ফাইলে live credential নেই', () => {
      const offenders = [];
      for (const file of collectSourceFiles()) {
        let text;
        try { text = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
        for (const { name, re } of SECRET_PATTERNS) {
          if (re.test(text)) offenders.push(`${path.relative(ROOT, file)}: ${name}`);
        }
      }
      expect(offenders).toEqual([]);
    });

    test('.env.test-এ শুধু local/test মান আছে', () => {
      const env = read('.env.test');
      expect(env).toMatch(/localhost/);
      expect(env).toMatch(/NODE_ENV=test/);
      //   host   credential   
      expect(env).not.toMatch(/amazonaws\.com|\.render\.com|\.supabase\.co/);
    });

    test('Telegram bot token response/log-এ masked হয়', () => {
      const cfg = read('services', 'telegramConfig.js');
      expect(cfg).toMatch(/function maskToken/);
      const adminTg = read('routes', 'adminTelegram.js');
      expect(adminTg).toMatch(/maskToken\(/);
      //     token   
      expect(adminTg).not.toMatch(/details:\s*`[^`]*\$\{token\}/);
    });

    test('Cloudinary/email secret কখনো view-তে পাঠানো হয় না', () => {
      const chat = read('routes', 'chat.js');
      //  config-  ,  render/json payload- 
      expect(chat).toMatch(/api_secret: process\.env\.CLOUDINARY_API_SECRET/);
      expect(chat).not.toMatch(/res\.(json|render)\([^)]*CLOUDINARY_API_SECRET/);
    });
  });

  describe('PHASE 11: CI/CD', () => {
    const wf = read('.github', 'workflows', 'node.js.yml');

    test('MEDIUM-9: workflow least-privilege permissions ঘোষণা করে', () => {
      expect(wf).toMatch(/^permissions:/m);
      expect(wf).toMatch(/contents:\s*read/);
    });

    test('workflow write permission চায় না', () => {
      expect(wf).not.toMatch(/contents:\s*write/);
      expect(wf).not.toMatch(/packages:\s*write/);
      expect(wf).not.toMatch(/id-token:\s*write/);
    });

    test('pull_request_target ব্যবহার করা হয় না (fork PR secret exposure নেই)', () => {
      expect(wf).not.toMatch(/pull_request_target/);
    });

    test('workflow-এ কোনো secret hardcode করা নেই', () => {
      expect(wf).not.toMatch(/AKIA[0-9A-Z]{16}/);
      expect(wf).not.toMatch(/gh[pousr]_[A-Za-z0-9]{30,}/);
      //  CI-only test credential  
      expect(wf).toMatch(/test_secret_key_for_ci_only/);
    });
  });

  describe('PHASE 12: dependencies', () => {
    test('lockfile আছে এবং আধুনিক ফরম্যাট', () => {
      const lock = JSON.parse(read('package-lock.json'));
      expect(lock.lockfileVersion).toBeGreaterThanOrEqual(2);
      expect(Object.keys(lock.packages || {}).length).toBeGreaterThan(100);
    });

    test('install script চালায় এমন package সীমিত ও পরিচিত', () => {
      const lock = JSON.parse(read('package-lock.json'));
      const withScripts = Object.entries(lock.packages || {})
        .filter(([, v]) => v.hasInstallScript)
        .map(([k]) => k.replace('node_modules/', ''));
      //          
      for (const pkg of withScripts) {
        expect(['@scarf/scarf', '@sentry/cli', 'msgpackr-extract']).toContain(pkg);
      }
    });
  });

  describe('PHASE 13: resource abuse', () => {
    const appSrc = read('app.js');

    test('MEDIUM-10: /csp-report-এর নিজস্ব rate limiter আছে', () => {
      expect(appSrc).toMatch(/cspReportLimiter/);
      const idx = appSrc.indexOf("app.post('/csp-report'");
      expect(appSrc.slice(idx, idx + 200)).toMatch(/cspReportLimiter/);
    });

    test('MEDIUM-10: /csp-report body limit নির্ধারিত', () => {
      const idx = appSrc.indexOf("app.post('/csp-report'");
      expect(appSrc.slice(idx, idx + 300)).toMatch(/limit:\s*'16kb'/);
    });

    test('MEDIUM-10: violation Map-এর সর্বোচ্চ আকার আছে', () => {
      expect(appSrc).toMatch(/CSP_REPORT_MAX_KEYS/);
      expect(appSrc).toMatch(/cspViolationCounts\.size >= CSP_REPORT_MAX_KEYS/);
    });

    test('সব sensitive endpoint global limiter-এর পিছনে (regression)', () => {
      const lines = appSrc.split('\n');
      const generalIdx = lines.findIndex((l) => l.includes('app.use(generalLimiter)'));
      expect(generalIdx).toBeGreaterThan(-1);

      //  /csp-report ()  limiter-  mount   
      const before = lines.slice(0, generalIdx)
        .filter((l) => /app\.(get|post|put|delete)\(\s*['"]\//.test(l));
      for (const line of before) {
        expect(line).toMatch(/csp-report/);
      }
    });

    test('login/register/admin-login ও financial limiter বহাল আছে', () => {
      expect(appSrc).toMatch(/app\.use\('\/login', loginLimiter\)/);
      expect(appSrc).toMatch(/app\.use\('\/register', loginLimiter\)/);
      expect(appSrc).toMatch(/app\.use\('\/admin\/login', loginLimiter\)/);
      expect(appSrc).toMatch(/app\.use\('\/payment\/deposit', financialLimiter\)/);
      expect(appSrc).toMatch(/app\.use\('\/payment\/withdraw', financialLimiter\)/);
    });
  });
});
