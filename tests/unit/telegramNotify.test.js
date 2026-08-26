// tests/unit/telegramNotify.test.js
// নোটিফিকেশন ফ্লো: Admin প্যানেলের enabled/category টগল আসলেই sendMessage আটকায় কিনা,
// এবং কনফিগার করা না থাকলে আগের মতোই চুপচাপ স্কিপ করে (কোনো ফ্লো ভাঙে না) — যাচাই।
// telegramConfig মক করা হয়েছে, তাই DB/pg ছাড়াই চলে।

jest.mock('../../services/telegramConfig', () => {
  const actual = jest.requireActual('../../services/telegramConfig');
  return { ...actual, getConfig: jest.fn() };
});

const telegramConfig = require('../../services/telegramConfig');
const { notifyTelegram } = require('../../services/telegramNotify');

const TOKEN = '123456789:AAF-abcdefghijklmnopqrstuvwxyz012345';

function config(overrides = {}) {
  return {
    enabled: true,
    botToken: TOKEN,
    chatId: '123456789',
    categories: { ...telegramConfig.DEFAULT_CATEGORIES },
    ...overrides
  };
}

describe('telegramNotify: notifyTelegram', () => {
  let fetchMock;
  let errorSpy;

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue({ ok: true, text: async () => '' });
    global.fetch = fetchMock;
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.clearAllMocks();
    errorSpy.mockRestore();
  });

  test('কনফিগার করা থাকলে Telegram sendMessage কল করে', async () => {
    telegramConfig.getConfig.mockResolvedValue(config());
    const result = await notifyTelegram('হ্যালো', { category: 'deposit' });

    expect(result).toEqual({ sent: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    const body = JSON.parse(opts.body);
    expect(body).toMatchObject({ chat_id: '123456789', text: 'হ্যালো', parse_mode: 'HTML' });
  });

  test('ইন্টিগ্রেশন বন্ধ থাকলে কোনো API কল হয় না', async () => {
    telegramConfig.getConfig.mockResolvedValue(config({ enabled: false }));
    const result = await notifyTelegram('হ্যালো', { category: 'deposit' });

    expect(result).toEqual({ sent: false, reason: 'disabled' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('নির্দিষ্ট ক্যাটাগরি বন্ধ থাকলে শুধু সেটাই আটকায়', async () => {
    telegramConfig.getConfig.mockResolvedValue(
      config({ categories: { ...telegramConfig.DEFAULT_CATEGORIES, withdraw: false } })
    );

    expect(await notifyTelegram('উইথড্র', { category: 'withdraw' })).toEqual({ sent: false, reason: 'category_disabled' });
    expect(fetchMock).not.toHaveBeenCalled();

    expect(await notifyTelegram('ডিপোজিট', { category: 'deposit' })).toEqual({ sent: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('token/chat id না থাকলে চুপচাপ স্কিপ করে (throw করে না)', async () => {
    telegramConfig.getConfig.mockResolvedValue(config({ botToken: null }));
    expect(await notifyTelegram('হ্যালো')).toEqual({ sent: false, reason: 'not_configured' });

    telegramConfig.getConfig.mockResolvedValue(config({ chatId: null }));
    expect(await notifyTelegram('হ্যালো')).toEqual({ sent: false, reason: 'not_configured' });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('category ছাড়া legacy কল আগের মতোই কাজ করে', async () => {
    telegramConfig.getConfig.mockResolvedValue(config());
    expect(await notifyTelegram('legacy কল')).toEqual({ sent: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('Telegram API এরর দিলে caller-এর ফ্লো ভাঙে না', async () => {
    telegramConfig.getConfig.mockResolvedValue(config());
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'Unauthorized' });

    await expect(notifyTelegram('হ্যালো')).resolves.toEqual({ sent: false, reason: 'api_error' });
  });

  test('নেটওয়ার্ক এরর হলেও throw করে না', async () => {
    telegramConfig.getConfig.mockResolvedValue(config());
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(notifyTelegram('হ্যালো')).resolves.toEqual({ sent: false, reason: 'network_error' });
  });

  test('কনফিগ লোড ব্যর্থ হলেও throw করে না', async () => {
    telegramConfig.getConfig.mockRejectedValue(new Error('DB down'));
    await expect(notifyTelegram('হ্যালো')).resolves.toEqual({ sent: false, reason: 'config_error' });
  });

  test('এরর লগে bot token কখনো যায় না', async () => {
    telegramConfig.getConfig.mockResolvedValue(config());
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'Unauthorized' });

    await notifyTelegram('হ্যালো');

    const logged = errorSpy.mock.calls.flat().map(String).join(' ');
    expect(logged).not.toContain(TOKEN);
  });
});
