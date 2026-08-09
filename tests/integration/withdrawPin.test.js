const { pool } = require('../../db');
const {
  PIN_LENGTH,
  MAX_FAILED_ATTEMPTS,
  LOCK_DURATION_MS,
  isWeakPin,
  createPin,
  updatePin,
  verifyPin,
  adminResetPin,
  getPinStatus,
  isLocked
} = require('../../services/withdrawPin');

// services/withdrawPin.js — bcrypt-হ্যাশড PIN + ব্রুট-ফোর্স লক-আউট + অডিট লগ।
// শুধু বিদ্যমান আচরণ যাচাই করা হচ্ছে, কোনো সুরক্ষা লজিক পরিবর্তন করা হয়নি।
describe('Withdraw PIN (services/withdrawPin.js)', () => {
  const createdUserIds = [];

  async function makeUser() {
    const username = `pin_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`.slice(0, 20);
    const res = await pool.query(
      `INSERT INTO users (username, password, role, coins) VALUES ($1, $2, 'user', 0) RETURNING id`,
      [username, 'x']
    );
    const id = res.rows[0].id;
    createdUserIds.push(id);
    return id;
  }

  afterAll(async () => {
    if (createdUserIds.length) {
      await pool.query('DELETE FROM withdraw_pin_logs WHERE user_id = ANY($1)', [createdUserIds]);
      await pool.query('DELETE FROM users WHERE id = ANY($1)', [createdUserIds]);
    }
  });

  describe('isWeakPin() — দুর্বল PIN শনাক্তকরণ', () => {
    test('সব ডিজিট একই হলে দুর্বল', () => {
      ['000000', '111111', '999999'].forEach((p) => expect(isWeakPin(p)).toBe(true));
    });

    test('ক্রমিক আরোহী প্যাটার্ন দুর্বল', () => {
      ['123456', '234567', '456789'].forEach((p) => expect(isWeakPin(p)).toBe(true));
    });

    test('ক্রমিক অবরোহী প্যাটার্ন দুর্বল', () => {
      ['654321', '987654', '543210'].forEach((p) => expect(isWeakPin(p)).toBe(true));
    });

    test('ভুল দৈর্ঘ্য বা অ-সংখ্যা দুর্বল হিসেবে গণ্য', () => {
      ['12345', '1234567', 'abcdef', '12345a', '', '  '].forEach((p) => expect(isWeakPin(p)).toBe(true));
    });

    test('string ছাড়া অন্য টাইপে throw না করে true দেয়', () => {
      [null, undefined, 123456, {}, []].forEach((p) => expect(isWeakPin(p)).toBe(true));
    });

    test('শক্তিশালী PIN গ্রহণযোগ্য', () => {
      ['135790', '284617', '907341'].forEach((p) => expect(isWeakPin(p)).toBe(false));
    });

    test('PIN_LENGTH ধ্রুবক ৬', () => {
      expect(PIN_LENGTH).toBe(6);
    });
  });

  describe('createPin() ও getPinStatus()', () => {
    test('PIN তৈরির আগে configured=false থাকে', async () => {
      const userId = await makeUser();
      const status = await getPinStatus(userId);
      expect(status.configured).toBe(false);
      expect(status.locked).toBe(false);
    });

    test('PIN তৈরির পর configured=true হয় এবং টাইমস্ট্যাম্প বসে', async () => {
      const userId = await makeUser();
      await createPin(userId, '284617', '10.0.0.1');
      const status = await getPinStatus(userId);
      expect(status.configured).toBe(true);
      expect(status.createdAt).toBeTruthy();
      expect(status.updatedAt).toBeTruthy();
    });

    test('PIN কখনো plain text-এ সংরক্ষিত হয় না (শুধু bcrypt হ্যাশ)', async () => {
      const userId = await makeUser();
      await createPin(userId, '284617', '10.0.0.1');
      const res = await pool.query('SELECT withdraw_pin_hash FROM users WHERE id=$1', [userId]);
      const hash = res.rows[0].withdraw_pin_hash;
      expect(hash).toBeTruthy();
      expect(hash).not.toBe('284617');
      expect(hash).not.toContain('284617');
      expect(hash).toMatch(/^\$2[aby]\$/); // bcrypt হ্যাশ ফরম্যাট
    });

    test('PIN তৈরি অডিট লগে "created" হিসেবে রেকর্ড হয়', async () => {
      const userId = await makeUser();
      await createPin(userId, '284617', '10.0.0.1');
      const logs = await pool.query(
        `SELECT action_type FROM withdraw_pin_logs WHERE user_id=$1 ORDER BY id`,
        [userId]
      );
      expect(logs.rows.map((r) => r.action_type)).toContain('created');
    });
  });

  describe('verifyPin() — সঠিক/ভুল যাচাই', () => {
    test('PIN সেট না থাকলে notConfigured ফেরত দেয়', async () => {
      const userId = await makeUser();
      const result = await verifyPin(userId, '284617', '10.0.0.1');
      expect(result.success).toBe(false);
      expect(result.notConfigured).toBe(true);
    });

    test('সঠিক PIN গ্রহণ করে', async () => {
      const userId = await makeUser();
      await createPin(userId, '284617', '10.0.0.1');
      const result = await verifyPin(userId, '284617', '10.0.0.1');
      expect(result.success).toBe(true);
    });

    test('ভুল PIN প্রত্যাখ্যান করে ও attemptsLeft জানায়', async () => {
      const userId = await makeUser();
      await createPin(userId, '284617', '10.0.0.1');
      const result = await verifyPin(userId, '999888', '10.0.0.1');
      expect(result.success).toBe(false);
      expect(result.attemptsLeft).toBe(MAX_FAILED_ATTEMPTS - 1);
    });

    test('সফল যাচাইয়ের পর ব্যর্থ-চেষ্টার কাউন্টার রিসেট হয়', async () => {
      const userId = await makeUser();
      await createPin(userId, '284617', '10.0.0.1');
      await verifyPin(userId, '999888', '10.0.0.1'); // ১টা ব্যর্থ
      await verifyPin(userId, '284617', '10.0.0.1'); // সফল
      const res = await pool.query('SELECT withdraw_pin_failed_attempts FROM users WHERE id=$1', [userId]);
      expect(res.rows[0].withdraw_pin_failed_attempts).toBe(0);
    });

    test('সফল ও ব্যর্থ যাচাই অডিট লগে রেকর্ড হয়', async () => {
      const userId = await makeUser();
      await createPin(userId, '284617', '10.0.0.1');
      await verifyPin(userId, '999888', '10.0.0.1');
      await verifyPin(userId, '284617', '10.0.0.1');
      const logs = await pool.query(
        `SELECT action_type FROM withdraw_pin_logs WHERE user_id=$1`,
        [userId]
      );
      const types = logs.rows.map((r) => r.action_type);
      expect(types).toContain('verify_failed');
      expect(types).toContain('verify_success');
    });
  });

  describe('ব্রুট-ফোর্স লক-আউট', () => {
    test(`${MAX_FAILED_ATTEMPTS} বার ভুল হলে অ্যাকাউন্ট লক হয়`, async () => {
      const userId = await makeUser();
      await createPin(userId, '284617', '10.0.0.1');

      let last;
      for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
        last = await verifyPin(userId, '999888', '10.0.0.1');
      }
      expect(last.success).toBe(false);
      expect(last.locked).toBe(true);
      expect(last.remainingMs).toBe(LOCK_DURATION_MS);
    });

    test('লক থাকা অবস্থায় সঠিক PIN দিলেও প্রত্যাখ্যাত হয়', async () => {
      const userId = await makeUser();
      await createPin(userId, '284617', '10.0.0.1');
      for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
        await verifyPin(userId, '999888', '10.0.0.1');
      }
      const result = await verifyPin(userId, '284617', '10.0.0.1');
      expect(result.success).toBe(false);
      expect(result.locked).toBe(true);
    });

    test('লক হলে getPinStatus-এ locked=true দেখায়', async () => {
      const userId = await makeUser();
      await createPin(userId, '284617', '10.0.0.1');
      for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
        await verifyPin(userId, '999888', '10.0.0.1');
      }
      const status = await getPinStatus(userId);
      expect(status.locked).toBe(true);
      expect(status.remainingMs).toBeGreaterThan(0);
    });

    test('লক হওয়ার ঘটনা অডিট লগে "locked" হিসেবে রেকর্ড হয়', async () => {
      const userId = await makeUser();
      await createPin(userId, '284617', '10.0.0.1');
      for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
        await verifyPin(userId, '999888', '10.0.0.1');
      }
      const logs = await pool.query(
        `SELECT action_type FROM withdraw_pin_logs WHERE user_id=$1`,
        [userId]
      );
      expect(logs.rows.map((r) => r.action_type)).toContain('locked');
    });

    test('লকের মেয়াদ শেষ হলে আবার যাচাই করা যায়', async () => {
      const userId = await makeUser();
      await createPin(userId, '284617', '10.0.0.1');
      for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
        await verifyPin(userId, '999888', '10.0.0.1');
      }
      // লকের মেয়াদ অতীতে সরিয়ে দেওয়া হচ্ছে (সময় এগোনোর সিমুলেশন)
      await pool.query(
        `UPDATE users SET withdraw_pin_locked_until = NOW() - INTERVAL '1 minute' WHERE id=$1`,
        [userId]
      );
      const result = await verifyPin(userId, '284617', '10.0.0.1');
      expect(result.success).toBe(true);
    });

    test('isLocked() ভবিষ্যৎ/অতীত টাইমস্ট্যাম্প সঠিকভাবে বিচার করে', () => {
      expect(isLocked({ withdraw_pin_locked_until: new Date(Date.now() + 60000) })).toBe(true);
      expect(isLocked({ withdraw_pin_locked_until: new Date(Date.now() - 60000) })).toBe(false);
      expect(isLocked({ withdraw_pin_locked_until: null })).toBe(false);
      expect(isLocked(null)).toBe(false);
    });
  });

  describe('updatePin()', () => {
    test('PIN পরিবর্তনের পর পুরোনো PIN আর কাজ করে না', async () => {
      const userId = await makeUser();
      await createPin(userId, '284617', '10.0.0.1');
      await updatePin(userId, '907341', '10.0.0.1', 'changed');

      expect((await verifyPin(userId, '284617', '10.0.0.1')).success).toBe(false);
      expect((await verifyPin(userId, '907341', '10.0.0.1')).success).toBe(true);
    });

    test('PIN পরিবর্তন লক-আউট অবস্থা মুছে দেয়', async () => {
      const userId = await makeUser();
      await createPin(userId, '284617', '10.0.0.1');
      for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
        await verifyPin(userId, '999888', '10.0.0.1');
      }
      await updatePin(userId, '907341', '10.0.0.1', 'changed');
      const status = await getPinStatus(userId);
      expect(status.locked).toBe(false);
    });
  });

  describe('adminResetPin()', () => {
    test('অ্যাডমিন রিসেটের পর PIN আর কনফিগার করা থাকে না', async () => {
      const userId = await makeUser();
      await createPin(userId, '284617', '10.0.0.1');
      await adminResetPin(userId, 1, 'admin', '10.0.0.9');

      const status = await getPinStatus(userId);
      expect(status.configured).toBe(false);
      expect((await verifyPin(userId, '284617', '10.0.0.1')).notConfigured).toBe(true);
    });

    test('অ্যাডমিন রিসেট লক-আউটও মুছে দেয়', async () => {
      const userId = await makeUser();
      await createPin(userId, '284617', '10.0.0.1');
      for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
        await verifyPin(userId, '999888', '10.0.0.1');
      }
      await adminResetPin(userId, 1, 'admin', '10.0.0.9');
      const status = await getPinStatus(userId);
      expect(status.locked).toBe(false);
    });

    test('অ্যাডমিন রিসেট actor_type=admin সহ অডিট লগে রেকর্ড হয়', async () => {
      const userId = await makeUser();
      await createPin(userId, '284617', '10.0.0.1');
      await adminResetPin(userId, 1, 'admin_user', '10.0.0.9');
      const logs = await pool.query(
        `SELECT action_type, actor_type, actor_username FROM withdraw_pin_logs
         WHERE user_id=$1 AND action_type='admin_reset'`,
        [userId]
      );
      expect(logs.rows).toHaveLength(1);
      expect(logs.rows[0].actor_type).toBe('admin');
      expect(logs.rows[0].actor_username).toBe('admin_user');
    });
  });
});
