// deprecated দৈনিক backup টাইমার শাটডাউনে সত্যিই বন্ধ হয় এবং আবার schedule করা যায়।
const backup = require('../../services/backup');

describe('stopDailyBackup', () => {
  afterEach(() => backup.stopDailyBackup());

  test('বারবার ডাকা নিরাপদ, schedule না থাকলেও', () => {
    expect(() => { backup.stopDailyBackup(); backup.stopDailyBackup(); }).not.toThrow();
  });

  test('schedule → stop → আবার schedule করলে নতুন interval বসে', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = jest.spyOn(global, 'setInterval');
    try {
      backup.scheduleDailyBackup();
      backup.scheduleDailyBackup(); // গার্ড: দ্বিতীয় interval নয়
      expect(spy).toHaveBeenCalledTimes(1);
      backup.stopDailyBackup();
      backup.scheduleDailyBackup();
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }
  });
});
