// D14: /api/* রিকোয়েস্ট লগে কোয়েরি-স্ট্রিং (টোকেন/কোড) যেন না যায়
const request = require('supertest');
const { app } = require('../helpers/app');

describe('API gateway লগ', () => {
  test('কোয়েরি-স্ট্রিং লগে আসে না, শুধু পাথ আসে', async () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await request(app).get('/api/__no_such_route__?token=SECRET123&code=ABC');
      await new Promise((r) => setTimeout(r, 50));
      const lines = spy.mock.calls.map((c) => c.join(' ')).filter((l) => l.startsWith('[API]'));
      expect(lines.length).toBeGreaterThan(0);
      for (const l of lines) {
        expect(l).not.toMatch(/SECRET123|token=|code=|\?/);
      }
      expect(lines.some((l) => l.includes('/api/__no_such_route__'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
