// tests/appLifecycle.test.js
// ---------------------------------------------------------------------------
// রিগ্রেশন গার্ড — অ্যাপ্লিকেশন অবজেক্ট আর সার্ভার লাইফসাইকেল আলাদা থাকা চাই।
//
// আগে app.js-এর শেষ লাইনে `startServer();` কল করা ছিল। ফলে শুধু
// `require('../../app.js')` করলেই (প্রতিটা টেস্ট হেল্পার যা করে) DB কানেকশন,
// মাইগ্রেশন ও startup টাস্ক চালু হয়ে যেত। এর সরাসরি ফল:
//   • Jest teardown-এর পরেও async কাজ চলত ("Cannot log after tests are done")
//   • প্রতিটা টেস্ট ফাইল আবার মাইগ্রেশন চালাত → রেস ও কানেকশন contention
//   • সমান্তরাল রিকোয়েস্টের টেস্টে ECONNRESET
//
// এই টেস্ট নিশ্চিত করে ওই আচরণ ফিরে আসতে পারবে না।
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');

describe('অ্যাপ্লিকেশন লাইফসাইকেল — require(app) কোনো I/O শুরু করে না', () => {
  test('অ্যাপ ইম্পোর্ট করলে HTTP listener চালু হয় না', () => {
    jest.resetModules();
    const listenSpy = jest.spyOn(http.Server.prototype, 'listen');
    try {
      const app = require('../app');
      expect(listenSpy).not.toHaveBeenCalled();
      // অ্যাপের সাথে একটা http.Server অবজেক্ট আছে (socket.io-র জন্য দরকার),
      // কিন্তু সেটা কোনো পোর্টে শোনে না।
      expect(app.httpServer.listening).toBe(false);
      expect(app.httpServer.address()).toBeNull();
    } finally {
      listenSpy.mockRestore();
    }
  });

  test('অ্যাপ ইম্পোর্ট করলে মাইগ্রেশন চলে না', () => {
    jest.resetModules();
    jest.doMock('../migrations', () => jest.fn(async () => {
      throw new Error('মাইগ্রেশন অ্যাপ ইম্পোর্টে চলা যাবে না');
    }));
    const migrations = require('../migrations');
    require('../app');
    expect(migrations).not.toHaveBeenCalled();
    jest.dontMock('../migrations');
  });

  test('অ্যাপ ইম্পোর্ট করলে scheduler, queue worker বা backup টাইমার চালু হয় না', () => {
    jest.resetModules();
    const scheduler = require('../services/scheduler');
    const queue = require('../services/queue');
    const backup = require('../services/backup');
    const backupManager = require('../services/backupManager');

    const spies = [
      jest.spyOn(scheduler, 'start'),
      jest.spyOn(queue, 'startWorker'),
      jest.spyOn(backup, 'scheduleDailyBackup'),
      jest.spyOn(backupManager, 'scheduleAutoBackup')
    ];
    try {
      require('../app');
      spies.forEach((s) => expect(s).not.toHaveBeenCalled());
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });

  test('app.js সোর্সে startServer()/listen() ফিরে আসেনি', () => {
    const src = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
    expect(src).not.toMatch(/^\s*startServer\(\);/m);
    expect(src).not.toMatch(/server\.listen\(/);
    expect(src).not.toMatch(/runMigrations\(\)/);
    expect(src).not.toMatch(/connectDB\(\)/);
  });

  test('server.js require করলেও সার্ভার চালু হয় না, কিন্তু startServer এক্সপোর্ট করে', () => {
    jest.resetModules();
    const listenSpy = jest.spyOn(http.Server.prototype, 'listen');
    try {
      const serverModule = require('../server');
      expect(typeof serverModule.startServer).toBe('function');
      expect(listenSpy).not.toHaveBeenCalled();
      expect(serverModule.server.listening).toBe(false);
    } finally {
      listenSpy.mockRestore();
    }
  });

  test('server.js-ই প্রোডাকশন বুট পাথ — listen, মাইগ্রেশন ও ব্যাকগ্রাউন্ড কাজ সেখানেই আছে', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    expect(src).toMatch(/server\.listen\(PORT/);
    expect(src).toMatch(/await connectDB\(\)/);
    expect(src).toMatch(/await runMigrations\(\)/);
    expect(src).toMatch(/scheduler'\)\.start\(\)/);
    expect(src).toMatch(/queueService\.startWorker\(\)/);
    // require.main গার্ড ছাড়া server.js ইম্পোর্ট করলেই সার্ভার উঠে যেত
    expect(src).toMatch(/require\.main === module/);
    // টেস্ট-স্পেসিফিক শর্ট-সার্কিট প্রোডাকশন বুট পাথে থাকা চলবে না
    expect(src).not.toMatch(/NODE_ENV === 'test'/);
  });

  test('প্রোডাকশন এন্ট্রিপয়েন্ট (package.json / Dockerfile) server.js দেখায়', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts.start).toBe('node server.js');
    const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(/CMD \["node", "server\.js"\]/);
  });
});
