// K10 — "Cannot set headers after they are sent" (internalEndpointAuth.test.js মাঝেমধ্যে ফেল করত, তার আসল কারণ)।
//
// ঘটনাক্রম (ডায়াগনস্টিক স্ট্যাক থেকে প্রমাণিত, অনুমান নয়):
//   ১) route res.redirect() ডাকে (যেমন routes/auth.js POST /register → res.redirect('/'))
//   ২) express-session-এর wrapped end() সেশন বদলানো থাকলে আগে হেডার ফ্লাশ করে (writetop), তারপর সেশন স্টোরে (PG) সেভ শুরু করে
//   ৩) সেভ ব্যর্থ হলে (DB কানেকশন ফুরানো/ব্যর্থ) express-session next(err) ডাকে — হেডার তখন আগেই চলে গেছে
//   ৪) গ্লোবাল error handler আবার res.status(500).render('error') করত → async render-callback-এ send() throw → uncaughtException
//      (jest-এ "Test suite failed to run"; প্রোডাকশনে server.js uncaughtException-এ প্রসেস বন্ধ করে দেয়)।
// ফিক্স: handler-এ headersSent গার্ড (Express-এর নিজস্ব সুপারিশ) — ত্রুটি লগ হয়, কিন্তু দ্বিতীয় রেসপন্স চেষ্টা হয় না।
const { pool } = require('../../db');
const { expressApp: app, getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');

// গ্লোবাল error handler (৪-আর্গুমেন্ট, স্ট্যাকের শেষ ৪-আর্গ লেয়ার) সরাসরি বের করা
function globalErrorHandler() {
  const layers = (app.router || app._router).stack.filter((l) => l.handle && l.handle.length === 4);
  return layers[layers.length - 1].handle;
}

describe('গ্লোবাল error handler — হেডার চলে যাওয়ার পরের ত্রুটি', () => {
  test('headersSent=true হলে দ্বিতীয় রেসপন্স/রেন্ডার চেষ্টা করে না; অসমাপ্ত হলে Express-এ ফেরত দেয়', () => {
    const h = globalErrorHandler();
    const err = new Error('session save failed');
    const mk = (over) => ({
      headersSent: true, writableEnded: false, locals: {}, statusCode: 200,
      status: jest.fn().mockReturnThis(), render: jest.fn(), json: jest.fn(), type: jest.fn().mockReturnThis(), send: jest.fn(),
      ...over
    });
    const req = { method: 'POST', originalUrl: '/register', path: '/register', headers: {}, session: null };
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    // রেসপন্স এখনো শেষ হয়নি: Express-এর ডিফল্ট হ্যান্ডলারে ছাড়ো (সে সংযোগ বন্ধ করে, ঝুলে থাকে না)
    const open = mk({ writableEnded: false });
    const next1 = jest.fn();
    h(err, req, open, next1);
    expect(open.status).not.toHaveBeenCalled();
    expect(open.render).not.toHaveBeenCalled();
    expect(open.json).not.toHaveBeenCalled();
    expect(next1).toHaveBeenCalledWith(err);

    // রেসপন্স ইতিমধ্যে শেষ: আর কিছু করার নেই, কিছু পাঠায়ও না
    const done = mk({ writableEnded: true });
    const next2 = jest.fn();
    h(err, req, done, next2);
    expect(done.status).not.toHaveBeenCalled();
    expect(done.render).not.toHaveBeenCalled();
    expect(next2).not.toHaveBeenCalled();
    console.error.mockRestore(); console.warn.mockRestore();
  });

  test('headersSent=false হলে আগের আচরণ অক্ষত — JSON/HTML 500, ক্লায়েন্টে ত্রুটির বার্তা ফাঁস নেই', () => {
    const h = globalErrorHandler();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = { headersSent: false, locals: {}, status: jest.fn().mockReturnThis(), json: jest.fn(), render: jest.fn() };
    h(new Error('db password=hunter2'), { method: 'GET', originalUrl: '/api/x', path: '/api/x', headers: { accept: 'application/json' }, session: null }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(500);
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('hunter2');
    console.error.mockRestore();
  });
});

describe('আসল পথ: রেসপন্সের পরে সেশন-সেভ ব্যর্থ (DB কানেকশন সমস্যা) → প্রসেস/সার্ভার টেকে', () => {
  const realQuery = pool.query.bind(pool);
  afterEach(() => jest.restoreAllMocks());

  test('POST /register-এর redirect-এর পর সেশন INSERT/UPDATE ব্যর্থ হলে uncaught exception হয় না, সার্ভার পরের রিকোয়েস্ট দেয়', async () => {
    const { agent, token } = await getCsrfAgent('/register'); // CSRF সেশন আগে সেভ হয়ে যাক
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    // শুধু সেশন-টেবিলে লেখা ব্যর্থ — অন্য সব কোয়েরি স্বাভাবিক
    jest.spyOn(pool, 'query').mockImplementation((...a) => {
      const sql = typeof a[0] === 'string' ? a[0] : (a[0] && a[0].text) || '';
      if (/user_sessions/i.test(sql) && /^\s*(INSERT|UPDATE)/i.test(sql)) {
        return Promise.reject(Object.assign(new Error('sorry, too many clients already'), { code: '53300' }));
      }
      return realQuery(...a);
    });

    // অবৈধ ইনপুট → flash + redirect (সেশন বদলায় → সেভ লাগে → ব্যর্থ)
    const res = await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form').send({
      username: uniqueUsername(), email: 'not-an-email', phone: uniquePhone(),
      password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token
    });
    // ক্লায়েন্ট redirect-ই পেয়েছে (হেডার সেভের আগেই গেছে) — দ্বিতীয় 500 রেসপন্স নয়
    expect([302, 303]).toContain(res.status);

    // সব async কলব্যাক শেষ হওয়ার সুযোগ দেই — আগে এখানেই "Cannot set headers" uncaught exception হতো
    await new Promise((r) => setTimeout(r, 300));

    // সার্ভার সচল — পরের সাধারণ রিকোয়েস্ট ঠিকঠাক
    jest.restoreAllMocks();
    const next = await agent.get('/login').set('User-Agent', REALISTIC_UA);
    expect(next.status).toBe(200);
  });
});
