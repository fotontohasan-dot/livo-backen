// tests/setup/env.js
// ---------------------------------------------------------------------------
// টেস্ট চালানোর আগে প্রয়োজনীয় environment variable সেট করে দেয়। CI
// (GitHub Actions)-এ এই ভ্যারিয়েবলগুলো workflow-এর `env:` ব্লক থেকে আগেই
// সেট করা থাকে, তাই সেগুলোর অগ্রাধিকার বেশি (override হয় না)। লোকালি চালানোর
// জন্য .env.test থেকে ডিফল্ট মান লোড করা হয়।
// ---------------------------------------------------------------------------

const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '..', '.env.test') });

process.env.NODE_ENV = 'test';

// প্রোডাকশন সার্ভার সত্যিকার পোর্টে বসাতে চেষ্টা করলে CI-তে সংঘর্ষ হতে পারে —
// PORT=0 দিলে OS নিজে থেকে একটা ফাঁকা পোর্ট বেছে নেয়।
process.env.PORT = process.env.PORT || '0';

// টেস্ট এনভায়রনমেন্টে Redis/Queue System বন্ধ রাখা হয় — প্রতিটা সার্ভিস
// (cache.js, queues/connection.js) নিজেই gracefully fallback করে, তাই এটা
// অ্যাপ ক্র্যাশ করে না, শুধু টেস্ট দ্রুত ও ডিটারমিনিস্টিক করে তোলে।
process.env.REDIS_ENABLED = process.env.REDIS_ENABLED || 'false';

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-do-not-use-in-production';
process.env.DB_SSL = process.env.DB_SSL || 'false';
process.env.SSLCZ_IS_LIVE = 'false';
process.env.SSLCZ_STORE_ID = process.env.SSLCZ_STORE_ID || 'test-store';
process.env.SSLCZ_STORE_PASSWD = process.env.SSLCZ_STORE_PASSWD || 'test-pass';

if (!process.env.DATABASE_URL) {
  // ডিফল্ট: docker-compose.test.yml দিয়ে চালানো লোকাল টেস্ট PostgreSQL
  process.env.DATABASE_URL = 'postgresql://livo_test:livo_test@127.0.0.1:5433/livo_test';
}
