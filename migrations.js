const { pool } = require('./db');

async function runMigrations() {
  try {
    console.log("🚀 Running database migrations...");

    // ==================== মূল টেবিল (আগে হাতে বানানো ছিল, এখানে কখনো ছিল না) ====================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        email TEXT UNIQUE,
        phone TEXT UNIQUE,
        password TEXT NOT NULL,
        full_name TEXT,
        avatar TEXT,
        role VARCHAR(20) DEFAULT 'user',
        coins NUMERIC(14,2) DEFAULT 0,
        total_deposited NUMERIC(14,2) DEFAULT 0,
        total_turnover NUMERIC(14,2) DEFAULT 0,
        total_points NUMERIC(14,2) DEFAULT 0,
        loyalty_points NUMERIC(14,2) DEFAULT 0,
        vip_level INTEGER DEFAULT 0,
        win_streak INTEGER DEFAULT 0,
        best_streak INTEGER DEFAULT 0,
        referral_code VARCHAR(20) UNIQUE,
        referred_by_id INTEGER REFERENCES users(id),
        is_banned BOOLEAN DEFAULT false,
        admin_note TEXT,
        kyc_status VARCHAR(20) DEFAULT 'none',
        daily_deposit_limit NUMERIC(14,2),
        self_exclude_until TIMESTAMP,
        last_login TIMESTAMP,
        last_ip TEXT,
        last_device TEXT,
        login_count INTEGER DEFAULT 0,
        reset_token TEXT,
        reset_token_expiry TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_referral ON users(referral_code);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by_id);`);

    // ==================== ইমেইল ভেরিফিকেশন ====================
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT false;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_token TEXT;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_token_expiry TIMESTAMP;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_verification_sent_at TIMESTAMP;`);
    await pool.query(`UPDATE users SET email_verified = true WHERE email IS NULL AND email_verified = false;`);
    await pool.query(`UPDATE users SET email_verified = true WHERE email_verified = false AND verification_token IS NULL;`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_verification_token ON users(verification_token);`);

    // ==================== Google Sign-In (OAuth 2.0 / OpenID Connect) ====================
    // google_id = Google-এর 'sub' (স্থায়ী, ইউনিক আইডেন্টিফায়ার) — কখনো Google পাসওয়ার্ড স্টোর করা হয় না।
    // auth_provider শুধু তথ্যমূলক (কোন মাধ্যমে অ্যাকাউন্ট তৈরি হয়েছিল), লগইন-যোগ্যতা নির্ধারণ করে না —
    // Google দিয়ে সাইন-ইন করা অ্যাকাউন্টও পরে চাইলে ইমেইল/ফোন+পাসওয়ার্ড দিয়ে লগইন করতে পারবে (password কলাম
    // তখনও পূরণ থাকে, শুধু একটা র‍্যান্ডম আনইউজেবল ভ্যালু দিয়ে — ইউজার কখনো সেটা জানে না/ব্যবহার করতে পারে না)।
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT UNIQUE;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider VARCHAR(20) DEFAULT 'local';`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id);`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS matches (
        id SERIAL PRIMARY KEY,
        title TEXT,
        sport VARCHAR(30) NOT NULL,
        team_a TEXT,
        team_b TEXT,
        status VARCHAR(20) DEFAULT 'upcoming',
        score_a TEXT,
        score_b TEXT,
        overs TEXT,
        start_time TIMESTAMP,
        league TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_matches_sport ON matches(sport);`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS payment_requests (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        type VARCHAR(20) NOT NULL,
        method VARCHAR(20),
        amount NUMERIC(14,2) NOT NULL,
        transaction_id TEXT,
        account_number TEXT,
        status VARCHAR(20) DEFAULT 'pending',
        want_bonus BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_pr_user ON payment_requests(user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_pr_status ON payment_requests(status);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_pr_type_method_created ON payment_requests(type, method, created_at);`);

    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pr_deposit_trxid_unique
      ON payment_requests (method, transaction_id)
      WHERE type = 'deposit' AND status != 'rejected';
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        title TEXT,
        message TEXT,
        type VARCHAR(20) DEFAULT 'info',
        is_read BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_notif_user_unread ON notifications(user_id) WHERE is_read = false;`);

    // অ্যাডমিন ব্রডকাস্ট নোটিফিকেশনের আলাদা অডিট লগ (কে কখন কী পাঠিয়েছে, কতজনকে)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS notification_broadcasts (
        id SERIAL PRIMARY KEY,
        admin_id INTEGER REFERENCES users(id),
        admin_username VARCHAR(100),
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        type VARCHAR(20) DEFAULT 'announcement',
        recipient_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS markets (
        id SERIAL PRIMARY KEY,
        match_id INTEGER REFERENCES matches(id) ON DELETE CASCADE,
        type VARCHAR(50) NOT NULL,
        name TEXT NOT NULL,
        odds JSONB DEFAULT '{}',
        status VARCHAR(20) DEFAULT 'open',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS bets (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        match_id INTEGER REFERENCES matches(id),
        market_id INTEGER REFERENCES markets(id),
        market_type VARCHAR(50),
        runner TEXT,
        odd NUMERIC(10,2),
        stake INTEGER NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id SERIAL PRIMARY KEY,
        sender_id INTEGER,
        receiver_id INTEGER,
        message TEXT,
        is_admin BOOLEAN DEFAULT false,
        file_url TEXT,
        file_type VARCHAR(20),
        is_read BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`
      ALTER TABLE chat_messages
      ADD COLUMN IF NOT EXISTS is_bot BOOLEAN DEFAULT false;
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_chat_sender ON chat_messages(sender_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_chat_receiver ON chat_messages(receiver_id);`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS news (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT,
        image_url TEXT,
        sport VARCHAR(50),
        author_id INTEGER,
        views INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS kyc_requests (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        full_name TEXT NOT NULL,
        document_type VARCHAR(50),
        document_number TEXT,
        document_url TEXT,
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS error_logs (
        id SERIAL PRIMARY KEY,
        message TEXT,
        stack TEXT,
        url TEXT,
        method VARCHAR(10),
        user_id INTEGER,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS login_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        ip TEXT,
        user_agent TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_login_user ON login_logs(user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_login_ip ON login_logs(ip);`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS bonuses (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        bonus_type VARCHAR(20) NOT NULL,
        bonus_amount INTEGER NOT NULL,
        sports_required NUMERIC(12,2) DEFAULT 0,
        sports_done NUMERIC(12,2) DEFAULT 0,
        casino_required NUMERIC(12,2) DEFAULT 0,
        casino_done NUMERIC(12,2) DEFAULT 0,
        status VARCHAR(20) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bonus_user ON bonuses(user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bonus_status ON bonuses(status);`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS daily_reward_tiers (
        id SERIAL PRIMARY KEY,
        min_turnover NUMERIC(14,2) NOT NULL,
        bonus_amount INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    const tierCount = await pool.query(`SELECT COUNT(*) FROM daily_reward_tiers`);
    if (parseInt(tierCount.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO daily_reward_tiers (min_turnover, bonus_amount) VALUES
        (5000, 150),
        (10000, 300),
        (20000, 600),
        (50000, 1500);
      `);
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_daily_rewards (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        reward_date DATE NOT NULL,
        sports_turnover NUMERIC(14,2) DEFAULT 0,
        claimed BOOLEAN DEFAULT false,
        claimed_amount INTEGER DEFAULT 0,
        claimed_at TIMESTAMP,
        UNIQUE (user_id, reward_date)
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_udr_user_date ON user_daily_rewards(user_id, reward_date);`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS referrals (
        id SERIAL PRIMARY KEY,
        referrer_id INTEGER REFERENCES users(id),
        referred_id INTEGER REFERENCES users(id),
        first_deposit_done BOOLEAN DEFAULT false,
        signup_bonus_paid BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE (referred_id)
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ref_referrer ON referrals(referrer_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ref_referred ON referrals(referred_id);`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS referral_commissions (
        id SERIAL PRIMARY KEY,
        earner_id INTEGER REFERENCES users(id),
        from_user_id INTEGER REFERENCES users(id),
        level INTEGER DEFAULT 1,
        amount NUMERIC(12,2) NOT NULL,
        reason VARCHAR(40),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_refcom_earner ON referral_commissions(earner_id);`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS daily_losses (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        loss_date DATE NOT NULL,
        total_bet NUMERIC(14,2) DEFAULT 0,
        total_win NUMERIC(14,2) DEFAULT 0,
        cashback_claimed BOOLEAN DEFAULT false,
        UNIQUE (user_id, loss_date)
      );
    `);
    await pool.query(`ALTER TABLE daily_losses ADD COLUMN IF NOT EXISTS category VARCHAR(20) NOT NULL DEFAULT 'sports';`);
    await pool.query(`ALTER TABLE daily_losses DROP CONSTRAINT IF EXISTS daily_losses_user_id_loss_date_key;`);
    await pool.query(`ALTER TABLE daily_losses DROP CONSTRAINT IF EXISTS daily_losses_user_id_loss_date_category_key;`);
    await pool.query(`ALTER TABLE daily_losses ADD CONSTRAINT daily_losses_user_id_loss_date_category_key UNIQUE (user_id, loss_date, category);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_loss_user_date ON daily_losses(user_id, loss_date);`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS vip_levels (
        id SERIAL PRIMARY KEY,
        level INTEGER NOT NULL,
        name VARCHAR(40) NOT NULL,
        min_turnover NUMERIC(16,2) NOT NULL,
        upgrade_bonus INTEGER DEFAULT 0,
        weekly_bonus INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    const vipCount = await pool.query(`SELECT COUNT(*) FROM vip_levels`);
    if (parseInt(vipCount.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO vip_levels (level, name, min_turnover, upgrade_bonus, weekly_bonus) VALUES
        (0, 'Bronze', 0, 0, 0),
        (1, 'Silver', 50000, 200, 50),
        (2, 'Gold', 200000, 800, 200),
        (3, 'Platinum', 500000, 2000, 500),
        (4, 'Diamond', 1500000, 6000, 1500),
        (5, 'Elite', 5000000, 20000, 5000);
      `);
    }

    // ==================== VIP SYSTEM UPGRADE (Premium) ====================
    // নিচের সব ALTER/CREATE সম্পূর্ণ additive — বিদ্যমান vip_levels টেবিল, কলাম বা ডেটা
    // মোছা বা পরিবর্তন হয় না, শুধু নতুন কলাম/টেবিল যোগ হয়। পুরনো সব ফিচার (addVipTurnover,
    // getVipStatus, /profile/vip পেজ) অপরিবর্তিত থাকে ও আগের মতোই চলবে।
    await pool.query(`ALTER TABLE vip_levels ADD COLUMN IF NOT EXISTS icon VARCHAR(10) DEFAULT '👑';`);
    await pool.query(`ALTER TABLE vip_levels ADD COLUMN IF NOT EXISTS cashback_percent NUMERIC(5,2) DEFAULT 0;`); // % পয়েন্ট, দৈনিক ক্যাশব্যাক রেটের সাথে যোগ হয়
    await pool.query(`ALTER TABLE vip_levels ADD COLUMN IF NOT EXISTS daily_bonus NUMERIC(12,2) DEFAULT 0;`);
    await pool.query(`ALTER TABLE vip_levels ADD COLUMN IF NOT EXISTS monthly_bonus NUMERIC(12,2) DEFAULT 0;`);
    await pool.query(`ALTER TABLE vip_levels ADD COLUMN IF NOT EXISTS withdrawal_limit NUMERIC(14,2) DEFAULT 0;`); // 0 = সীমাহীন
    await pool.query(`ALTER TABLE vip_levels ADD COLUMN IF NOT EXISTS deposit_bonus_percent NUMERIC(5,2) DEFAULT 0;`);
    await pool.query(`ALTER TABLE vip_levels ADD COLUMN IF NOT EXISTS birthday_bonus NUMERIC(12,2) DEFAULT 0;`);
    await pool.query(`ALTER TABLE vip_levels ADD COLUMN IF NOT EXISTS priority_support BOOLEAN DEFAULT false;`);
    await pool.query(`ALTER TABLE vip_levels ADD COLUMN IF NOT EXISTS exclusive_events TEXT DEFAULT '';`);
    await pool.query(`ALTER TABLE vip_levels ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;`);
    await pool.query(`ALTER TABLE vip_levels ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_vip_levels_level ON vip_levels(level);`);

    // প্রথমবার এই আপগ্রেডের পর ডিফল্ট প্রিমিয়াম ভ্যালু বসানো — শুধু যেসব রো এখনো
    // touch করা হয়নি (cashback_percent ও daily_bonus উভয়ই ডিফল্ট 0) তাদের জন্যই,
    // যাতে অ্যাডমিন পরে যা কাস্টমাইজ করবে তা কখনো ওভাররাইট না হয়।
    await pool.query(`
      UPDATE vip_levels SET
        icon = CASE level WHEN 0 THEN '🥉' WHEN 1 THEN '🥈' WHEN 2 THEN '🥇' WHEN 3 THEN '💎' WHEN 4 THEN '👑' ELSE '🏆' END,
        cashback_percent = CASE level WHEN 0 THEN 0 WHEN 1 THEN 1 WHEN 2 THEN 2 WHEN 3 THEN 3 WHEN 4 THEN 5 ELSE 8 END,
        daily_bonus = CASE level WHEN 0 THEN 0 WHEN 1 THEN 20 WHEN 2 THEN 60 WHEN 3 THEN 150 WHEN 4 THEN 400 ELSE 1000 END,
        monthly_bonus = CASE level WHEN 0 THEN 0 WHEN 1 THEN 300 WHEN 2 THEN 1000 WHEN 3 THEN 3000 WHEN 4 THEN 8000 ELSE 20000 END,
        withdrawal_limit = CASE level WHEN 0 THEN 20000 WHEN 1 THEN 50000 WHEN 2 THEN 150000 WHEN 3 THEN 400000 WHEN 4 THEN 1000000 ELSE 0 END,
        deposit_bonus_percent = CASE level WHEN 0 THEN 0 WHEN 1 THEN 2 WHEN 2 THEN 5 WHEN 3 THEN 8 WHEN 4 THEN 12 ELSE 20 END,
        birthday_bonus = CASE level WHEN 0 THEN 0 WHEN 1 THEN 100 WHEN 2 THEN 300 WHEN 3 THEN 800 WHEN 4 THEN 2000 ELSE 5000 END,
        priority_support = CASE WHEN level >= 2 THEN true ELSE false END,
        exclusive_events = CASE WHEN level >= 3 THEN 'এক্সক্লুসিভ VIP ইভেন্ট ও টুর্নামেন্টে অগ্রাধিকার প্রবেশ' ELSE '' END
      WHERE cashback_percent = 0 AND daily_bonus = 0;
    `);

    // ==================== VIP Reward History (সব ধরনের VIP বোনাস/ক্যাশব্যাক ক্লেইমের একীভূত হিস্ট্রি) ====================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vip_reward_history (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        vip_level INTEGER NOT NULL DEFAULT 0,
        reward_type VARCHAR(30) NOT NULL, -- upgrade_bonus | daily_bonus | weekly_bonus | monthly_bonus | cashback | birthday_bonus
        amount NUMERIC(14,2) NOT NULL DEFAULT 0,
        description TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_vip_reward_history_user ON vip_reward_history(user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_vip_reward_history_type ON vip_reward_history(reward_type);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_vip_reward_history_created ON vip_reward_history(created_at DESC);`);

    // ==================== VIP Upgrade History (লেভেল পরিবর্তনের আলাদা লগ — from → to) ====================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vip_upgrade_history (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        from_level INTEGER NOT NULL DEFAULT 0,
        to_level INTEGER NOT NULL,
        bonus NUMERIC(14,2) NOT NULL DEFAULT 0,
        total_turnover_at_upgrade NUMERIC(16,2) DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_vip_upgrade_history_user ON vip_upgrade_history(user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_vip_upgrade_history_created ON vip_upgrade_history(created_at DESC);`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS mission_defs (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        target_type VARCHAR(20) NOT NULL,
        target_value NUMERIC(14,2) NOT NULL,
        reward INTEGER NOT NULL,
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`ALTER TABLE mission_defs ADD COLUMN IF NOT EXISTS period VARCHAR(10) NOT NULL DEFAULT 'daily';`);
    await pool.query(`ALTER TABLE mission_defs ADD COLUMN IF NOT EXISTS start_date DATE;`);
    await pool.query(`ALTER TABLE mission_defs ADD COLUMN IF NOT EXISTS end_date DATE;`);
    // ডেইলি মিশন **শুধু প্রথমবার** সিড করা হয়।
    //
    // আগে প্রতিটা স্টার্টআপে গোনা হতো: ঠিক ৪টা মিশন আর মোট রিওয়ার্ড ১২৫ না
    // হলে `DELETE FROM mission_defs WHERE period = 'daily'` চালিয়ে ডিফল্ট
    // আবার বসানো হতো। অর্থাৎ অ্যাডমিন প্যানেল থেকে একটা মিশনের রিওয়ার্ড
    // বদলালে, নতুন মিশন যোগ করলে, বা পুরনো একটা নিষ্ক্রিয় করলে — পরের
    // ডিপ্লয় বা রিস্টার্টেই সেই কাজ নিঃশব্দে মুছে যেত।
    //
    // মাইগ্রেশনের কাজ স্কিমা ও প্রথম ডেটা তৈরি করা, অ্যাডমিনের কনফিগারেশন
    // ফিরিয়ে নেওয়া নয়। টেবিল খালি থাকলেই কেবল সিড হয় — অন্য সব সিডিংয়ের
    // (weekly, special) মতোই।
    const dailyCount = await pool.query(`SELECT COUNT(*) AS c FROM mission_defs WHERE period = 'daily'`);
    if (parseInt(dailyCount.rows[0].c) === 0) {
      await pool.query(`
        INSERT INTO mission_defs (title, target_type, target_value, reward, period) VALUES
        ('আজ ৩টি বাজি ধরুন', 'bet_count', 3, 10, 'daily'),
        ('আজ ৫,০০০ টাকা টার্নওভার করুন', 'turnover', 5000, 20, 'daily'),
        ('আজ ১০টি বাজি ধরুন', 'bet_count', 10, 35, 'daily'),
        ('আজ ১৫,০০০ টাকা টার্নওভার করুন', 'turnover', 15000, 60, 'daily');
      `);
    }
    const weeklyCount = await pool.query(`SELECT COUNT(*) AS c FROM mission_defs WHERE period = 'weekly'`);
    if (parseInt(weeklyCount.rows[0].c) === 0) {
      await pool.query(`
        INSERT INTO mission_defs (title, target_type, target_value, reward, period) VALUES
        ('এই সপ্তাহে ২০টি বাজি ধরুন', 'bet_count', 20, 400, 'weekly'),
        ('এই সপ্তাহে ৫০,০০০ টাকা টার্নওভার করুন', 'turnover', 50000, 800, 'weekly');
      `);
    }
    const specialCount = await pool.query(`SELECT COUNT(*) AS c FROM mission_defs WHERE period = 'special'`);
    if (parseInt(specialCount.rows[0].c) === 0) {
      await pool.query(`
        INSERT INTO mission_defs (title, target_type, target_value, reward, period, start_date, end_date) VALUES
        ('স্পেশাল: এই মাসে ১০০টি বাজি ধরুন', 'bet_count', 100, 2000, 'special', date_trunc('month', CURRENT_DATE), (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month - 1 day'));
      `);
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_missions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        mission_date DATE NOT NULL,
        bet_count INTEGER DEFAULT 0,
        turnover NUMERIC(14,2) DEFAULT 0,
        claimed_ids INTEGER[] DEFAULT '{}',
        UNIQUE (user_id, mission_date)
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_umission_user_date ON user_missions(user_id, mission_date);`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS mission_claims (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        mission_id INTEGER REFERENCES mission_defs(id),
        period_key VARCHAR(20) NOT NULL,
        claimed_at TIMESTAMP DEFAULT NOW(),
        UNIQUE (user_id, mission_id, period_key)
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS wheel_spins (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        spin_date DATE NOT NULL,
        prize INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE (user_id, spin_date)
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_wheel_user_date ON wheel_spins(user_id, spin_date);`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS loyalty_ledger (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        points INTEGER NOT NULL,
        reason VARCHAR(40),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_loyalty_user ON loyalty_ledger(user_id);`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_badges (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        badge_code VARCHAR(40) NOT NULL,
        earned_at TIMESTAMP DEFAULT NOW(),
        UNIQUE (user_id, badge_code)
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_badge_user ON user_badges(user_id);`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS free_bets (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        amount INTEGER NOT NULL,
        reason VARCHAR(40),
        status VARCHAR(20) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT NOW(),
        used_at TIMESTAMP
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_freebet_user ON free_bets(user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_freebet_status ON free_bets(status);`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS periodic_claims (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        claim_type VARCHAR(20) NOT NULL,
        period_key VARCHAR(20) NOT NULL,
        amount INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE (user_id, claim_type, period_key)
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS daily_rewards (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        reward_type VARCHAR(20) NOT NULL,
        amount DECIMAL(12,2) NOT NULL,
        claim_date DATE NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE (user_id, reward_type, claim_date)
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_dr_user_date ON daily_rewards(user_id, claim_date);`);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_periodic_user ON periodic_claims(user_id);`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS social_shares (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        share_date DATE NOT NULL,
        bonus INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE (user_id, share_date)
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_social_user ON social_shares(user_id);`);

    await pool.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS kyc_status VARCHAR(20) DEFAULT 'none',
      ADD COLUMN IF NOT EXISTS last_login TIMESTAMP,
      ADD COLUMN IF NOT EXISTS last_ip TEXT,
      ADD COLUMN IF NOT EXISTS last_device TEXT,
      ADD COLUMN IF NOT EXISTS login_count INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS admin_note TEXT,
      ADD COLUMN IF NOT EXISTS last_reward_date DATE,
      ADD COLUMN IF NOT EXISTS first_deposit_done BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS total_deposited NUMERIC(14,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS total_turnover NUMERIC(16,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS vip_level INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS daily_deposit_limit NUMERIC(14,2),
      ADD COLUMN IF NOT EXISTS self_exclude_until TIMESTAMP,
      ADD COLUMN IF NOT EXISTS loyalty_points INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS win_streak INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS best_streak INTEGER DEFAULT 0;
    `);

    await pool.query(`
      ALTER TABLE payment_requests
      ADD COLUMN IF NOT EXISTS want_bonus BOOLEAN DEFAULT false;
    `);

    await pool.query(`
      ALTER TABLE matches
      ADD COLUMN IF NOT EXISTS start_time TIMESTAMP,
      ADD COLUMN IF NOT EXISTS league TEXT;
    `);

    // ==================== ম্যাচ আইডেন্টিটি (provider + external_id) ====================
    // সমস্যা: matches টেবিলে কোনো UNIQUE কনস্ট্রেইন্ট ছিল না, অথচ services/matchUpdater.js
    // `INSERT ... ON CONFLICT DO NOTHING` ব্যবহার করত। কনস্ট্রেইন্ট না থাকায় কোনো কনফ্লিক্টই
    // কখনো ঘটত না — প্রতি ১৫ মিনিটের প্রতিটা পোলে একই ম্যাচের জন্য নতুন রো ঢুকত
    // (দিনে ৯৬ বার × প্রতিটা ম্যাচ)। এখন প্রতিটা এক্সটার্নাল ম্যাচের স্থায়ী পরিচয়
    // (provider, external_id) — টিমের নাম নয়, কারণ নামের বানান/সংক্ষেপ প্রোভাইডারভেদে বদলায়।
    // provider কলামটা আইডেন্টিটির অংশ, তাই দুটো ভিন্ন প্রোভাইডার একই external_id দিলেও
    // সেগুলো আলাদা রো থাকে, সংঘর্ষ হয় না।
    await pool.query(`
      ALTER TABLE matches
      ADD COLUMN IF NOT EXISTS provider VARCHAR(40),
      ADD COLUMN IF NOT EXISTS external_id TEXT,
      ADD COLUMN IF NOT EXISTS provider_metadata JSONB,
      ADD COLUMN IF NOT EXISTS synced_at TIMESTAMP;
    `);

    // PARTIAL unique index — শুধু সেই রোগুলোর উপর যেগুলোর provider ও external_id দুটোই আছে।
    // এটা ইচ্ছাকৃত ও প্রোডাকশন-সেফ: পুরনো (legacy) রোগুলোতে এই দুটো কলাম NULL, তাই
    // ইনডেক্স তৈরির সময় বিদ্যমান ডুপ্লিকেটে মাইগ্রেশন ব্যর্থ হয় না এবং কোনো ঐতিহাসিক
    // রেকর্ড মুছতে হয় না। অ্যাডমিনের হাতে তৈরি ম্যাচেও (provider NULL) কোনো বাধা আসে না।
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_matches_provider_external
      ON matches(provider, external_id)
      WHERE provider IS NOT NULL AND external_id IS NOT NULL;
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_matches_provider ON matches(provider);`);
    console.log("✅ Match provider identity columns ready");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS bank_cards (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        bank_name TEXT,
        account_number TEXT,
        holder_name TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      ALTER TABLE payment_requests
      ADD COLUMN IF NOT EXISTS gateway TEXT,
      ADD COLUMN IF NOT EXISTS gateway_tran_id TEXT,
      ADD COLUMN IF NOT EXISTS gateway_val_id TEXT,
      ADD COLUMN IF NOT EXISTS gateway_response JSONB;
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pr_gateway_tran ON payment_requests(gateway_tran_id) WHERE gateway_tran_id IS NOT NULL;`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS site_settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`
      INSERT INTO site_settings (key, value) VALUES
      ('min_bet', '10'),
      ('max_bet', '50000'),
      ('turnover_multiplier', '3'),
      ('deposit_commission_percent', '0'),
      ('withdraw_commission_percent', '0')
      ON CONFLICT (key) DO NOTHING;
    `);

    // maintenance_mode আগে প্রতিটা স্টার্টআপে জোর করে 'false' করা হতো
    // (`DO UPDATE SET value = 'false'`)। ফলে অ্যাডমিন মেইনটেন্যান্স চালু করার
    // পর সার্ভার রিস্টার্ট হলেই — ডিপ্লয়, ক্র্যাশ রিকভারি বা Render-এর
    // অটো-রিস্টার্টে — সাইট নিঃশব্দে আবার লাইভ হয়ে যেত, ঠিক যে মুহূর্তে
    // অ্যাডমিন সেটা বন্ধ রাখতে চেয়েছিলেন।
    //
    // সিডিং শুধু প্রথমবারের জন্য; বিদ্যমান মান অ্যাডমিনের সিদ্ধান্ত, মাইগ্রেশনের নয়।
    await pool.query(`
      INSERT INTO site_settings (key, value, updated_at) VALUES ('maintenance_mode', 'false', NOW())
      ON CONFLICT (key) DO NOTHING;
    `);

    await pool.query(`
      INSERT INTO site_settings (key, value) VALUES
      ('maintenance_message', 'আমরা সেবার মান উন্নত করার কাজ করছি। অনুগ্রহ করে কিছুক্ষণ পর আবার চেষ্টা করুন।'),
      ('maintenance_eta', ''),
      ('maintenance_allowed_ips', ''),
      ('maintenance_bypass_token', '')
      ON CONFLICT (key) DO NOTHING;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS promotions (
        id SERIAL PRIMARY KEY,
        title TEXT,
        image_url TEXT NOT NULL,
        link_url TEXT,
        position INTEGER DEFAULT 0,
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS tournaments (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        sport VARCHAR(30),
        description TEXT,
        entry_fee INTEGER DEFAULT 0,
        prize_pool INTEGER DEFAULT 0,
        max_participants INTEGER DEFAULT 100,
        start_date TIMESTAMP,
        end_date TIMESTAMP,
        status VARCHAR(20) DEFAULT 'upcoming',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tournament_participants (
        id SERIAL PRIMARY KEY,
        tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id),
        points NUMERIC(12,2) DEFAULT 0,
        joined_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(tournament_id, user_id)
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin_logs (
        id SERIAL PRIMARY KEY,
        admin_id INTEGER REFERENCES users(id),
        admin_username VARCHAR(100),
        action_type VARCHAR(100) NOT NULL,
        details TEXT,
        ip_address VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS coin_transactions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        amount NUMERIC(14,2) NOT NULL,
        type VARCHAR(50),
        description TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_coin_tx_user ON coin_transactions(user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_coin_tx_type ON coin_transactions(type);`);

    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS demo_balance NUMERIC(14,2) DEFAULT 1000`);
    await pool.query(`ALTER TABLE bets ADD COLUMN IF NOT EXISTS is_demo BOOLEAN DEFAULT false`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS demo_transactions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        category VARCHAR(20) NOT NULL,
        type VARCHAR(20) NOT NULL,
        amount NUMERIC(14,2) NOT NULL,
        description TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS totp_secret TEXT,
      ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS totp_backup_codes TEXT,
      ADD COLUMN IF NOT EXISTS backup_codes_viewed BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS permissions JSONB DEFAULT '{}'::jsonb;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS games (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        emoji TEXT,
        category TEXT NOT NULL,
        provider TEXT,
        badge TEXT,
        is_active BOOLEAN DEFAULT true,
        sort_order INT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    const gamesCount = await pool.query('SELECT COUNT(*) AS cnt FROM games');
    if (parseInt(gamesCount.rows[0].cnt) === 0) {
      const seedGames = [
        { name: 'Online Ludo', slug: 'ludo', emoji: '🎯', category: 'sports', provider: 'Jili', badge: null },
        { name: 'Fortune Tiger', slug: 'fortune-tiger', emoji: '🐯', category: 'slots', provider: 'PG Soft', badge: 'hot' },
        { name: 'Aviator', slug: 'aviator', emoji: '✈️', category: 'slots', provider: 'Spribe', badge: 'hot' },
        { name: 'Crazy Time', slug: 'crazy-time', emoji: '🎡', category: 'live', provider: 'Pragmatic Play', badge: 'hot' }
      ];
      for (let i = 0; i < seedGames.length; i++) {
        const g = seedGames[i];
        await pool.query(
          `INSERT INTO games (name, slug, emoji, category, provider, badge, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (slug) DO NOTHING`,
          [g.name, g.slug, g.emoji, g.category, g.provider, g.badge, i]
        );
      }
    }

    await pool.query(`ALTER TABLE kyc_requests ADD COLUMN IF NOT EXISTS reject_reason TEXT`);

    // একজন ইউজারের একসাথে একটাই pending KYC রিকোয়েস্ট থাকতে পারে।
    //
    // routes/extra.js-এ আগে শুধু SELECT করে দেখা হতো pending আছে কি না, তারপর
    // INSERT — দুটোর মাঝে কোনো লক ছিল না। দুটো রিকোয়েস্ট একসাথে এলে দুটোই
    // SELECT-এ খালি পেত এবং দুটোই ঢুকে যেত। ফলে একজনের দুটো pending KYC
    // থাকত; অ্যাডমিন পুরনোটা approve করলে ইউজার approved হয়ে যেত অথচ নতুন
    // (হয়তো ভিন্ন ডকুমেন্টের) রিকোয়েস্ট তখনো pending — স্ট্যাটাস মিথ্যা বলত।
    //
    // partial index — শুধু pending সারিতে প্রযোজ্য, তাই একই ইউজারের অনেক
    // approved/rejected ইতিহাস আগের মতোই থাকতে পারে।
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_kyc_pending_per_user
      ON kyc_requests (user_id) WHERE status = 'pending'
    `).catch(e => console.error('kyc pending unique index:', e.message));

    await pool.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS withdraw_pin_hash TEXT,
      ADD COLUMN IF NOT EXISTS withdraw_pin_created_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS withdraw_pin_updated_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS withdraw_pin_failed_attempts INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS withdraw_pin_locked_until TIMESTAMP;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS withdraw_pin_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        action_type VARCHAR(30) NOT NULL,
        actor_type VARCHAR(10) NOT NULL DEFAULT 'user',
        actor_id INTEGER,
        actor_username VARCHAR(100),
        ip_address VARCHAR(50),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_wpl_user ON withdraw_pin_logs(user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_wpl_action ON withdraw_pin_logs(action_type);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_wpl_created ON withdraw_pin_logs(created_at);`);

    await pool.query(`ALTER TABLE login_logs ADD COLUMN IF NOT EXISTS device_fingerprint TEXT`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_login_device ON login_logs(device_fingerprint);`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS fraud_flags (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        risk_level VARCHAR(10) NOT NULL CHECK (risk_level IN ('low','medium','high')),
        signal_types TEXT[] NOT NULL DEFAULT '{}',
        reason TEXT NOT NULL,
        related_user_ids INTEGER[] NOT NULL DEFAULT '{}',
        details JSONB,
        status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewed','dismissed')),
        reviewed_by INTEGER REFERENCES users(id),
        reviewed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_fraud_flags_user ON fraud_flags(user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_fraud_flags_risk ON fraud_flags(risk_level);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_fraud_flags_status ON fraud_flags(status);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_fraud_flags_created ON fraud_flags(created_at);`);

    // ==================== Background Queue System (BullMQ + Redis) সাপোর্ট টেবিল ====================
    // এই টেবিলগুলো Queue-এর সাথে সম্পর্কিত ডেটা persist করার জন্য — Redis অনুপলব্ধ/রিস্টার্ট হলেও
    // ইতিহাস হারিয়ে যায় না, এবং অ্যাডমিন প্যানেল Postgres থেকে সরাসরি রিপোর্ট বানাতে পারে।

    // Activity Log — সাধারণ ইউজার/সিস্টেম অ্যাক্টিভিটি (লগইন, বেট, প্রোফাইল আপডেট ইত্যাদি)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS activity_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        username TEXT,
        action_type VARCHAR(50) NOT NULL,
        details TEXT,
        ip_address TEXT,
        user_agent TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_activity_logs_user ON activity_logs(user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_activity_logs_created ON activity_logs(created_at DESC);`);

    // API Log — প্রতিটা API রিকোয়েস্টের মেথড/পাথ/স্ট্যাটাস/রেসপন্স টাইম
    await pool.query(`
      CREATE TABLE IF NOT EXISTS api_logs (
        id SERIAL PRIMARY KEY,
        method VARCHAR(10),
        path TEXT,
        status_code INTEGER,
        response_time_ms INTEGER,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        ip_address TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_api_logs_created ON api_logs(created_at DESC);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_api_logs_status ON api_logs(status_code);`);

    // Fraud Scan Log — heuristic fraud detection স্ক্যানের ফলাফল
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fraud_scan_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        risk_score INTEGER DEFAULT 0,
        risk_level VARCHAR(10) DEFAULT 'low',
        flags JSONB DEFAULT '[]',
        triggered_by VARCHAR(30) DEFAULT 'system',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_fraud_logs_user ON fraud_scan_logs(user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_fraud_logs_risk ON fraud_scan_logs(risk_level);`);

    // Dead Letter Queue — সব রিট্রাই শেষ হয়ে যাওয়া ব্যর্থ জব স্থায়ীভাবে সেভ থাকে এখানে
    await pool.query(`
      CREATE TABLE IF NOT EXISTS queue_dead_letter (
        id SERIAL PRIMARY KEY,
        queue_name VARCHAR(50) NOT NULL,
        job_id TEXT NOT NULL,
        job_name TEXT,
        job_data JSONB,
        failed_reason TEXT,
        attempts_made INTEGER DEFAULT 0,
        stacktrace TEXT,
        status VARCHAR(20) DEFAULT 'dead',
        retried_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(queue_name, job_id)
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_dead_letter_queue ON queue_dead_letter(queue_name);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_dead_letter_status ON queue_dead_letter(status);`);

    // ==================== Announcement / Broadcast সিস্টেম ====================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS announcements (
        id SERIAL PRIMARY KEY,
        type VARCHAR(20) NOT NULL DEFAULT 'banner',
        title_bn TEXT, title_en TEXT,
        message_bn TEXT NOT NULL, message_en TEXT,
        target_type VARCHAR(20) NOT NULL DEFAULT 'all',
        target_role VARCHAR(20),
        target_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        active BOOLEAN DEFAULT true,
        starts_at TIMESTAMP DEFAULT NOW(),
        expires_at TIMESTAMP,
        created_by INTEGER,
        created_by_username TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_announcements_active ON announcements(active, starts_at, expires_at);`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS announcement_dismissals (
        id SERIAL PRIMARY KEY,
        announcement_id INTEGER REFERENCES announcements(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        dismissed_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(announcement_id, user_id)
      );
    `);

    console.log("✅ All tables migration completed successfully");

    await pool.query(`ALTER TABLE login_logs ADD COLUMN IF NOT EXISTS device_signature VARCHAR(64)`);
    await pool.query(`ALTER TABLE login_logs ADD COLUMN IF NOT EXISTS is_new_device BOOLEAN DEFAULT FALSE`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_login_signature ON login_logs(user_id, device_signature);`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS device_sessions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        sid VARCHAR(255) UNIQUE NOT NULL,
        device_signature VARCHAR(64),
        device_name VARCHAR(100),
        browser VARCHAR(50),
        os VARCHAR(50),
        device_type VARCHAR(20),
        ip VARCHAR(45),
        user_agent TEXT,
        is_new_device BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW(),
        last_activity TIMESTAMP DEFAULT NOW(),
        revoked_at TIMESTAMP
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_device_sessions_user ON device_sessions(user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_device_sessions_active ON device_sessions(user_id, revoked_at);`);

    await pool.query(`ALTER TABLE login_logs ADD COLUMN IF NOT EXISTS location VARCHAR(120)`);
    await pool.query(`ALTER TABLE device_sessions ADD COLUMN IF NOT EXISTS location VARCHAR(120)`);

    // ==================== Trusted Devices Management ====================
    // is_trusted/trusted_at — ইউজার নিজে কোনো ডিভাইসকে "Trusted" মার্ক করলে সেট হয়;
    // device_label — ইউজারের নিজের দেওয়া নাম (রিনেম), সেট থাকলে অটো-ডিটেক্টেড device_name-এর
    // বদলে এটাই দেখানো হয়, যাতে অটো-ডিটেকশন লজিক/কলাম অপরিবর্তিত থাকে (backward compatible)
    await pool.query(`
      ALTER TABLE device_sessions
      ADD COLUMN IF NOT EXISTS is_trusted BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS trusted_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS device_label VARCHAR(100);
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_device_sessions_trusted ON device_sessions(user_id, is_trusted);`);

    console.log("✅ Device tracking tables ready");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS job_queue (
        id SERIAL PRIMARY KEY,
        type VARCHAR(50) NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}',
        status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        last_error TEXT,
        available_at TIMESTAMP NOT NULL DEFAULT NOW(),
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        started_at TIMESTAMP,
        completed_at TIMESTAMP
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_job_queue_poll ON job_queue(status, available_at);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_job_queue_type ON job_queue(type);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_job_queue_created ON job_queue(created_at);`);
    // Add missing duration_ms column if not present
    await pool.query(`ALTER TABLE job_queue ADD COLUMN IF NOT EXISTS duration_ms INTEGER;`);

    // ==================== Dead Letter Queue (services/queue.js) ====================
    // max_attempts শেষ হয়ে স্থায়ীভাবে ব্যর্থ হওয়া জব এখানে আর্কাইভ হয়, যাতে পরে
    // পরীক্ষা করে requeue বা purge করা যায়। এই টেবিলটা আগে কোথাও তৈরি করা হতো না,
    // ফলে (ক) প্রতিটা স্থায়ীভাবে ব্যর্থ জবের পেলোড হারিয়ে যেত এবং (খ) getQueueStats()
    // এর COUNT কোয়েরি ব্যর্থ হয়ে queue-এর সব Prometheus মেট্রিক আপডেট বন্ধ হয়ে যেত।
    // কলামগুলো services/queue.js এর moveToDeadLetter/getDeadLetterJobs/requeueDeadLetter/
    // purgeAllDeadLetter কোয়েরির সাথে হুবহু মিলিয়ে রাখা হয়েছে।
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dead_letter_jobs (
        id SERIAL PRIMARY KEY,
        original_job_id INTEGER,
        type VARCHAR(50) NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}',
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        last_error TEXT,
        job_created_at TIMESTAMP,
        dead_lettered_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_dead_letter_jobs_type ON dead_letter_jobs(type);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_dead_letter_jobs_at ON dead_letter_jobs(dead_lettered_at);`);

    console.log("✅ Job queue table ready");

    // ==================== Accumulator (multi-selection বাজি) ====================
    // services/accumulator.js ও routes/accumulator.js (app.js-এ /accumulator পাথে মাউন্ট করা)
    // এই দুইটা টেবিলে INSERT/SELECT/UPDATE করে, কিন্তু কোথাও টেবিল তৈরি করা হতো না —
    // ফলে অ্যাকুমুলেটর ফিচারের প্রতিটা কোয়েরি "relation does not exist" এরর দিত।
    // কলামগুলো ওই ফাইলের কোয়েরির সাথে হুবহু মিলিয়ে রাখা হয়েছে।
    await pool.query(`
      CREATE TABLE IF NOT EXISTS accumulators (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        stake NUMERIC(14,2) NOT NULL,
        total_odd NUMERIC(12,4) NOT NULL,
        boost_percent NUMERIC(6,2) DEFAULT 0,
        potential_win NUMERIC(14,2) NOT NULL,
        selection_count INTEGER NOT NULL DEFAULT 0,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        settled_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS accumulator_selections (
        id SERIAL PRIMARY KEY,
        acca_id INTEGER NOT NULL REFERENCES accumulators(id) ON DELETE CASCADE,
        match_id INTEGER,
        market_id INTEGER,
        market_name VARCHAR(120),
        runner VARCHAR(120),
        odd NUMERIC(12,4) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_accumulators_user ON accumulators(user_id, created_at DESC);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_acca_sel_acca ON accumulator_selections(acca_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_acca_sel_market ON accumulator_selections(market_id, status);`);

    console.log("✅ Accumulator tables ready");

    // ==================== Web Push সাবস্ক্রিপশন ====================
    // services/push.js (queues/processors/notification.js থেকে ব্যবহৃত) এই টেবিলে
    // INSERT ... ON CONFLICT (endpoint) করে, তাই endpoint-এ UNIQUE থাকা আবশ্যক।
    // টেবিলটা আগে কোথাও তৈরি হতো না, ফলে সব পুশ-সাবস্ক্রিপশন অপারেশন ব্যর্থ হতো।
    await pool.query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);`);

    console.log("✅ Push subscription table ready");

    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMP;`);

    // routes/coins.js-এর POST /coins/daily-bonus এই কলামটা SET ও WHERE দুই জায়গাতেই ব্যবহার করে
    // ("দিনে একবার" গার্ড হিসেবে), কিন্তু কলামটা কোথাও তৈরি করা হতো না — ফলে ডেইলি বোনাস
    // ক্লেইম করতে গেলেই "column last_bonus_date does not exist" এরর হতো।
    // ADD COLUMN IF NOT EXISTS — বিদ্যমান ডেটা অপরিবর্তিত থাকে (নতুন কলাম NULL)।
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_bonus_date TIMESTAMP;`);

    console.log("✅ Security Center columns ready");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS failed_login_attempts (
        id SERIAL PRIMARY KEY,
        identifier TEXT,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        ip VARCHAR(45),
        user_agent TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_failed_login_user ON failed_login_attempts(user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_failed_login_ip ON failed_login_attempts(ip);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_failed_login_created ON failed_login_attempts(created_at);`);

    console.log("✅ Fraud detection tables ready");

    await pool.query(`ALTER TABLE login_logs ADD COLUMN IF NOT EXISTS is_vpn BOOLEAN DEFAULT FALSE`);
    await pool.query(`ALTER TABLE login_logs ADD COLUMN IF NOT EXISTS is_proxy BOOLEAN DEFAULT FALSE`);
    await pool.query(`ALTER TABLE login_logs ADD COLUMN IF NOT EXISTS is_tor BOOLEAN DEFAULT FALSE`);
    await pool.query(`ALTER TABLE login_logs ADD COLUMN IF NOT EXISTS is_hosting BOOLEAN DEFAULT FALSE`);
    await pool.query(`ALTER TABLE login_logs ADD COLUMN IF NOT EXISTS ip_risk_score INTEGER DEFAULT 0`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS step_up_verifications (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        code VARCHAR(10) NOT NULL,
        purpose VARCHAR(30) NOT NULL DEFAULT 'vpn_login',
        ip VARCHAR(45),
        attempts INTEGER NOT NULL DEFAULT 0,
        verified_at TIMESTAMP,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_step_up_user ON step_up_verifications(user_id);`);

    console.log("✅ VPN & Proxy Detection tables ready");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS bot_activity_logs (
        id SERIAL PRIMARY KEY,
        ip VARCHAR(45),
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        endpoint VARCHAR(60),
        signal_types TEXT[] NOT NULL DEFAULT '{}',
        risk_level VARCHAR(10) NOT NULL CHECK (risk_level IN ('low','medium','high')),
        reason TEXT NOT NULL,
        user_agent TEXT,
        blocked BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bot_logs_ip ON bot_activity_logs(ip);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bot_logs_risk ON bot_activity_logs(risk_level);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bot_logs_created ON bot_activity_logs(created_at);`);
    // Request Fingerprinting — একই ব্রাউজার/হেডার-প্রোফাইল একাধিক IP থেকে এলে ধরার জন্য
    await pool.query(`ALTER TABLE bot_activity_logs ADD COLUMN IF NOT EXISTS fingerprint VARCHAR(32);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bot_logs_fingerprint ON bot_activity_logs(fingerprint);`);

    console.log("✅ Bot Detection tables ready");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS duplicate_account_flags (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        matched_user_ids INTEGER[] NOT NULL DEFAULT '{}',
        match_types TEXT[] NOT NULL DEFAULT '{}',
        risk_score INTEGER NOT NULL DEFAULT 0,
        reason TEXT NOT NULL,
        details JSONB,
        status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewed','dismissed')),
        reviewed_by INTEGER REFERENCES users(id),
        reviewed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_dup_flags_user ON duplicate_account_flags(user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_dup_flags_score ON duplicate_account_flags(risk_score);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_dup_flags_status ON duplicate_account_flags(status);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_dup_flags_created ON duplicate_account_flags(created_at);`);

    console.log("✅ Duplicate Account Detection tables ready");

    // ==================== API KEY MANAGEMENT ====================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id SERIAL PRIMARY KEY,
        key_hash TEXT UNIQUE NOT NULL,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        scopes TEXT[] DEFAULT '{}',
        enabled BOOLEAN DEFAULT true,
        expires_at TIMESTAMP,
        last_used TIMESTAMP,
        created_by INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_api_keys_enabled ON api_keys(enabled);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_api_keys_expires ON api_keys(expires_at);`);

    // ==================== API USAGE LOGS & ANALYTICS ====================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS api_usage_logs (
        id SERIAL PRIMARY KEY,
        api_key_id INTEGER REFERENCES api_keys(id) ON DELETE SET NULL,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        ip VARCHAR(45),
        endpoint TEXT NOT NULL,
        method VARCHAR(10) NOT NULL,
        status_code INTEGER,
        response_time_ms INTEGER,
        user_agent TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_api_usage_key ON api_usage_logs(api_key_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_api_usage_user ON api_usage_logs(user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_api_usage_endpoint ON api_usage_logs(endpoint);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_api_usage_created ON api_usage_logs(created_at);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_api_usage_status ON api_usage_logs(status_code);`);

    console.log("✅ API Keys and API Usage Logs tables ready");

    // ==================== Fraud Detection Engine — numeric Risk Score (Feature: Fraud Monitoring Dashboard) ====================
    // বিদ্যমান risk_level (low/medium/high) এর পাশাপাশি একটা numeric 0-100 স্কোর যোগ করা হচ্ছে,
    // পুরনো রো-গুলোর জন্য 0 ডিফল্ট (backward compatible, কিছু ভাঙে না)।
    await pool.query(`ALTER TABLE fraud_flags ADD COLUMN IF NOT EXISTS risk_score INTEGER NOT NULL DEFAULT 0`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_fraud_flags_score ON fraud_flags(risk_score);`);

    console.log("✅ Fraud Detection risk_score column ready");

    // ==================== Bot Detection — IP Block/Whitelist ====================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ip_rules (
        id SERIAL PRIMARY KEY,
        ip TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL CHECK (type IN ('block', 'whitelist')),
        reason TEXT,
        created_by TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ip_rules_ip ON ip_rules(ip);`);

    console.log("✅ IP Block/Whitelist table ready");

    // ==================== Cron / Scheduler System (Production-Ready) ====================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cron_jobs (
        key TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        description TEXT,
        interval_ms BIGINT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT true,
        max_retries INTEGER NOT NULL DEFAULT 1,
        last_run_at TIMESTAMPTZ,
        last_finished_at TIMESTAMPTZ,
        last_status TEXT,
        last_message TEXT,
        last_attempts INTEGER,
        next_run_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    // পুরনো ইনস্টলেশনে টেবিল আগে থেকে থাকলেও max_retries/last_attempts কলাম যোগ করা হচ্ছে (additive)
    await pool.query(`ALTER TABLE cron_jobs ADD COLUMN IF NOT EXISTS max_retries INTEGER NOT NULL DEFAULT 1;`);
    await pool.query(`ALTER TABLE cron_jobs ADD COLUMN IF NOT EXISTS last_attempts INTEGER;`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS cron_job_logs (
        id SERIAL PRIMARY KEY,
        job_key TEXT NOT NULL,
        started_at TIMESTAMPTZ NOT NULL,
        finished_at TIMESTAMPTZ,
        duration_ms INTEGER,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 1,
        message TEXT,
        triggered_by TEXT DEFAULT 'schedule'
      );
    `);
    await pool.query(`ALTER TABLE cron_job_logs ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 1;`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_cron_job_logs_key ON cron_job_logs(job_key, started_at DESC);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_cron_job_logs_status ON cron_job_logs(status);`);

    console.log("✅ Cron/Scheduler tables ready");

    // ==================== Backup & Restore System ====================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS backup_history (
        id SERIAL PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('database', 'uploads', 'config')),
        filename TEXT NOT NULL,
        size_bytes BIGINT DEFAULT 0,
        encrypted BOOLEAN NOT NULL DEFAULT FALSE,
        compressed BOOLEAN NOT NULL DEFAULT TRUE,
        checksum TEXT,
        status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'failed')),
        error_message TEXT,
        source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'scheduled')),
        created_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_by_username TEXT,
        restored_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_backup_history_type ON backup_history(type);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_backup_history_created ON backup_history(created_at DESC);`);

    console.log("✅ Backup & Restore System table ready");

    // ==================== Advanced Audit Log System ====================
    // বিদ্যমান admin_logs টেবিলের পাশাপাশি (সেটা অপরিবর্তিত থাকছে, backward compatible) —
    // এই টেবিলে ইউজার/অ্যাডমিন/সিস্টেম তিন ধরনের actor-এর সব গুরুত্বপূর্ণ action সমৃদ্ধ মেটাডেটাসহ (IP,
    // ডিভাইস, ব্রাউজার, লোকেশন, রিকোয়েস্ট ID, ঝুঁকির মাত্রা) সংরক্ষিত হয়।
    await pool.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id BIGSERIAL PRIMARY KEY,
        actor_type VARCHAR(10) NOT NULL DEFAULT 'system' CHECK (actor_type IN ('user', 'admin', 'system')),
        actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        actor_username VARCHAR(100),
        action VARCHAR(100) NOT NULL,
        category VARCHAR(30) NOT NULL DEFAULT 'other' CHECK (category IN (
          'auth', 'financial', 'settings', 'role', 'security', 'maintenance',
          'backup', 'restore', 'cron', 'queue', 'cache', 'api', 'other'
        )),
        status VARCHAR(10) NOT NULL DEFAULT 'success' CHECK (status IN ('success', 'failure')),
        risk_level VARCHAR(10) NOT NULL DEFAULT 'low' CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
        details JSONB DEFAULT '{}',
        ip_address VARCHAR(45),
        device_name VARCHAR(150),
        browser VARCHAR(50),
        os VARCHAR(50),
        location VARCHAR(150),
        request_id VARCHAR(64),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_type, actor_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_category ON audit_logs(category);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_risk ON audit_logs(risk_level);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_status ON audit_logs(status);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_request_id ON audit_logs(request_id);`);

    console.log("✅ Advanced Audit Log System table ready");

    // ==================== Feature Flags & Configuration Management ====================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS feature_flags (
        id SERIAL PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        category TEXT NOT NULL CHECK (category IN ('feature', 'maintenance', 'beta', 'security', 'api')),
        enabled BOOLEAN NOT NULL DEFAULT FALSE,
        description TEXT,
        updated_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_by_username TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_feature_flags_category ON feature_flags(category);`);
    await pool.query(`
      INSERT INTO feature_flags (key, label, category, enabled, description) VALUES
      ('beta_new_dashboard', 'New Dashboard UI', 'beta', false, 'নতুন ড্যাশবোর্ড ডিজাইন (টেস্টিং)'),
      ('security_force_2fa_admin', 'Force 2FA for Admins', 'security', false, 'সব অ্যাডমিনের জন্য 2FA বাধ্যতামূলক করবে'),
      ('api_public_stats', 'Public Stats API', 'api', true, 'পাবলিক /api/stats এন্ডপয়েন্ট চালু/বন্ধ')
      ON CONFLICT (key) DO NOTHING;
    `);
    console.log("✅ Feature Flags table ready");

    // ==================== Notification Template Management ====================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS notification_templates (
        id SERIAL PRIMARY KEY,
        template_key TEXT NOT NULL,
        channel TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'in_app')),
        lang TEXT NOT NULL DEFAULT 'bn' CHECK (lang IN ('bn', 'en')),
        name TEXT NOT NULL,
        subject TEXT,
        body TEXT NOT NULL,
        variables JSONB DEFAULT '[]',
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_by_username TEXT,
        updated_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_by_username TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(template_key, channel, lang)
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_notif_tmpl_key ON notification_templates(template_key);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_notif_tmpl_channel ON notification_templates(channel);`);
    await pool.query(`
      INSERT INTO notification_templates (template_key, channel, lang, name, subject, body, variables) VALUES
      ('otp_verification', 'email', 'bn', 'OTP ভেরিফিকেশন (ইমেইল)', 'LIVO - আপনার OTP কোড', '<div style="font-family:sans-serif;max-width:400px;margin:auto;padding:20px;border:1px solid #eee;border-radius:10px"><h2 style="color:#e53e3e">LIVO</h2><p>হ্যালো {{name}},</p><p>আপনার OTP কোড:</p><h1 style="color:#e53e3e;letter-spacing:10px">{{otp}}</h1><p>এই কোড ৫ মিনিটের মধ্যে ব্যবহার করুন।</p></div>', '["name","otp"]'),
      ('otp_verification', 'email', 'en', 'OTP Verification (Email)', 'LIVO - Your OTP Code', '<div style="font-family:sans-serif;max-width:400px;margin:auto;padding:20px;border:1px solid #eee;border-radius:10px"><h2 style="color:#e53e3e">LIVO</h2><p>Hello {{name}},</p><p>Your OTP code:</p><h1 style="color:#e53e3e;letter-spacing:10px">{{otp}}</h1><p>This code expires in 5 minutes.</p></div>', '["name","otp"]'),
      ('deposit_success', 'in_app', 'bn', 'ডিপোজিট সফল (ইন-অ্যাপ)', NULL, 'আপনার {{amount}} টাকা ডিপোজিট সফলভাবে সম্পন্ন হয়েছে।', '["amount"]'),
      ('deposit_success', 'in_app', 'en', 'Deposit Successful (In-app)', NULL, 'Your deposit of {{amount}} BDT has been completed successfully.', '["amount"]'),
      ('withdraw_success', 'sms', 'bn', 'উইথড্র সফল (SMS)', NULL, 'প্রিয় {{name}}, আপনার {{amount}} টাকা উইথড্র সফল হয়েছে। - Livo', '["name","amount"]'),
      ('withdraw_success', 'sms', 'en', 'Withdraw Successful (SMS)', NULL, 'Dear {{name}}, your withdrawal of {{amount}} BDT was successful. - Livo', '["name","amount"]')
      ON CONFLICT (template_key, channel, lang) DO NOTHING;
    `);
    console.log("✅ Notification Templates table ready");

    // ==================== Role & Permission Management (RBAC) ====================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS roles (
        id SERIAL PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        description TEXT,
        is_system BOOLEAN NOT NULL DEFAULT false,
        permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    // users.role (TEXT: 'admin'/'user') বিদ্যমান সব isAdmin/গেট লজিক অপরিবর্তিত রাখতে স্পর্শ করা হয়নি।
    // role_key নতুন, ঐচ্ছিক, granular permission layer — role_key না থাকলে (NULL) সেই admin
    // আগের মতোই পূর্ণ অ্যাক্সেস পাবে (backward compatible, super_admin-এর সমতুল্য আচরণ)।
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS role_key TEXT REFERENCES roles(key) ON DELETE SET NULL;`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_role_key ON users(role_key);`);

    const ALL_PERMISSIONS_TRUE = {
      dashboard_view: true, users_view: true, users_edit: true, users_ban: true, users_delete: true,
      payments_view: true, payments_approve: true, payments_reject: true,
      kyc_view: true, kyc_approve: true, kyc_reject: true,
      support_view: true, support_reply: true,
      games_manage: true, matches_manage: true,
      settings_view: true, settings_edit: true,
      roles_manage: true, activity_log_view: true,
      bot_monitoring_manage: true, backups_manage: true, cron_jobs_manage: true, reports_view: true
    };

    const DEFAULT_ROLES = [
      { key: 'super_admin', name: 'Super Admin', description: 'সব পারমিশন — কোনো রেস্ট্রিকশন ওভাররাইড করতে পারে', is_system: true, permissions: ALL_PERMISSIONS_TRUE },
      { key: 'admin', name: 'Admin', description: 'roles_manage বাদে প্রায় সব পারমিশন', is_system: true, permissions: { ...ALL_PERMISSIONS_TRUE, roles_manage: false } },
      { key: 'moderator', name: 'Moderator', description: 'ইউজার/সাপোর্ট/KYC মডারেশন', is_system: true, permissions: {
        dashboard_view: true, users_view: true, users_ban: true, support_view: true, support_reply: true,
        kyc_view: true, kyc_approve: true, kyc_reject: true, activity_log_view: true
      } },
      { key: 'support', name: 'Support', description: 'শুধু সাপোর্ট টিকিট ও ইউজার তথ্য দেখা', is_system: true, permissions: {
        dashboard_view: true, users_view: true, support_view: true, support_reply: true
      } },
      { key: 'finance', name: 'Finance', description: 'ডিপোজিট/উইথড্র অনুমোদন ও রিপোর্ট', is_system: true, permissions: {
        dashboard_view: true, payments_view: true, payments_approve: true, payments_reject: true,
        users_view: true, reports_view: true
      } }
    ];

    for (const role of DEFAULT_ROLES) {
      await pool.query(
        `INSERT INTO roles (key, name, description, is_system, permissions)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (key) DO NOTHING`,
        [role.key, role.name, role.description, role.is_system, JSON.stringify(role.permissions)]
      );
    }

    console.log("✅ RBAC (Role & Permission) tables ready");

    // ==================== Telegram Integration Settings ====================
    // এক-সারির কনফিগ টেবিল (id সবসময় 1)। bot_token_enc-এ টোকেন AES-256-GCM দিয়ে
    // এনক্রিপ্ট করে রাখা হয় (services/telegramConfig.js) — plaintext কখনো লেখা হয় না।
    // সারি না থাকলে services/telegramConfig.js .env-ভিত্তিক আগের আচরণেই চলে,
    // তাই বিদ্যমান ডিপ্লয়মেন্টে কোনো নোটিফিকেশন বন্ধ হয় না।
    await pool.query(`
      CREATE TABLE IF NOT EXISTS telegram_settings (
        id SMALLINT PRIMARY KEY DEFAULT 1,
        enabled BOOLEAN NOT NULL DEFAULT true,
        chat_id TEXT,
        bot_token_enc TEXT,
        categories JSONB NOT NULL DEFAULT '{"deposit":true,"withdraw":true,"support":true,"security":true,"system":true}'::jsonb,
        last_test_at TIMESTAMPTZ,
        last_test_status TEXT,
        last_test_error TEXT,
        last_test_bot TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        updated_by INTEGER,
        updated_by_username TEXT,
        CONSTRAINT telegram_settings_single_row CHECK (id = 1)
      );
    `);
    console.log("✅ Telegram Settings table ready");

    // ==================== Referral Contest Payout Tracking ====================
    // মাসিক রেফারেল কনটেস্টের (services/contest.js) টপ ৫ বিজয়ীর প্রাইজ ম্যানুয়ালি
    // (নগদ/মোবাইল ব্যাংকিং ইত্যাদি) দেওয়া হয় — এই টেবিল শুধু কে/কবে/কোন অ্যাডমিন
    // পেমেন্ট মার্ক করেছে তার হিসাব রাখে (routes/adminLeaderboard.js)। username স্ন্যাপশট
    // হিসেবে রাখা হয়, যাতে ইউজার নাম বদলালে/ডিলিট হলেও হিস্ট্রি পড়া যায়।
    await pool.query(`
      CREATE TABLE IF NOT EXISTS referral_contest_payouts (
        id SERIAL PRIMARY KEY,
        contest_month TEXT NOT NULL,
        rank SMALLINT NOT NULL,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        username TEXT,
        referrals_count INTEGER NOT NULL DEFAULT 0,
        prize_label TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid')),
        paid_at TIMESTAMPTZ,
        paid_by INTEGER,
        paid_by_username TEXT,
        notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT referral_contest_payouts_month_rank UNIQUE (contest_month, rank)
      );
    `);
    console.log("✅ Referral Contest Payout Tracking table ready");

    // ==================== হট-পাথ ইনডেক্স ====================
    // `bets` টেবিলে এতদিন একটাও ইনডেক্স ছিল না, অথচ এটাই সবচেয়ে ব্যস্ত ও টাকা-সংক্রান্ত
    // টেবিলগুলোর একটা। যেসব কোয়েরি প্রতিবার পুরো টেবিল স্ক্যান করত:
    //   • routes/profile.js — ইউজারের বেট হিস্ট্রি/স্ট্যাট (user_id + created_at ফিল্টার)
    //   • routes/api.js     — লিডারবোর্ডে প্রতি ইউজারের জন্য COUNT(*) সাবকোয়েরি (user_id, status)
    //   • routes/admin.js   — ড্যাশবোর্ড স্ট্যাট (status, created_at)
    //   • মার্কেট সেটলমেন্ট  — match_id/market_id দিয়ে বেট খোঁজা
    // রো সংখ্যা বাড়ার সাথে সাথে এগুলোর খরচ লিনিয়ারলি বাড়ত। ইনডেক্সগুলো কোনো আচরণ
    // বদলায় না, শুধু প্ল্যানারকে seq-scan-এর বদলে index-scan বেছে নিতে দেয়।
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bets_user_created ON bets(user_id, created_at DESC);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bets_user_status ON bets(user_id, status);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bets_match_id ON bets(match_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bets_market_id ON bets(market_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bets_status ON bets(status);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bets_created_at ON bets(created_at DESC);`);

    // error_logs-এও কোনো ইনডেক্স ছিল না। services/scheduler.js-এর log_cleanup জব
    // প্রতি ঘণ্টায় `DELETE ... WHERE created_at < NOW() - INTERVAL '90 days'` চালায়, আর
    // অ্যাডমিন লগ পেজ created_at DESC-এ সাজায় — দুটোই ফুল স্ক্যান করত।
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_error_logs_created_at ON error_logs(created_at DESC);`);

    // payment_requests-এ (status) ও (type, method, created_at) আছে, কিন্তু অ্যাডমিনের
    // ডিপোজিট/উইথড্র পেজ সবসময় type + status একসাথে ফিল্টার করে পেন্ডিং তালিকা দেখায়।
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_payment_requests_type_status ON payment_requests(type, status, created_at DESC);`);
    console.log("✅ Hot-path indexes ready");

    // ==================== রেফারেনশিয়াল ইন্টিগ্রিটি ====================
    // নিচের কলামগুলো কোডে অন্য টেবিলের প্রাইমারি কী হিসেবে ব্যবহৃত হয়, কিন্তু ডাটাবেজে
    // কোনো ফরেন কী ছিল না। ফলে ভুল/মুছে যাওয়া আইডি নীরবে বসে যেত এবং অরফান রেকর্ড
    // তৈরি হতো — বিশেষ করে accumulator_selections, যেখানে ম্যাচ/মার্কেট আইডি দিয়ে
    // সেটলমেন্ট হয় (services/accumulator.js:103, 195)।
    //
    // প্রোডাকশন-সেফটি: বিদ্যমান ডেটায় অরফান থাকলে কনস্ট্রেইন্ট যোগ করতে গিয়ে মাইগ্রেশন
    // ব্যর্থ হবে এবং অ্যাপ বুট আটকে যাবে। তাই প্রতিটা কনস্ট্রেইন্ট যোগ করার আগে অরফান
    // গোনা হয়। অরফান থাকলে সেগুলো মুছে ফেলা হয় না (ঐতিহাসিক ডেটা নষ্ট করা যাবে না);
    // বরং কনস্ট্রেইন্টটা NOT VALID হিসেবে যোগ করা হয় — নতুন কোনো অরফান আর ঢুকতে পারে
    // না, পুরনোগুলো লগে রিপোর্ট হয় এবং অ্যাডমিন হাতে সিদ্ধান্ত নিতে পারেন।
    //
    // ON DELETE নীতি:
    //   • accumulator_selections → matches/markets : NO ACTION (bets টেবিলের হুবহু একই
    //     নীতি) — ম্যাচ মুছে ফেলে বাজি/সিলেকশন অরফান করা যাবে না।
    //   • লগ/অডিট টেবিল (login_logs, error_logs, chat_messages, news, withdraw_pin_logs)
    //     : SET NULL — ইউজার মুছলেও অডিট ট্রেইল থেকে যায়, আবার ডিলিটও আটকায় না।
    const addFk = async (table, column, refTable, refColumn, onDelete, constraintName) => {
      // ইতিমধ্যে থাকলে কিছু করার নেই — মাইগ্রেশন বারবার চালানো নিরাপদ (idempotent)
      const exists = await pool.query(
        `SELECT 1 FROM pg_constraint WHERE conname = $1 AND conrelid = $2::regclass`,
        [constraintName, table]
      );
      if (exists.rows.length > 0) return;

      // টেবিল/কলাম না থাকলে চুপচাপ বাদ (পুরনো ডাটাবেজে কলামটা নাও থাকতে পারে)
      const col = await pool.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name=$2`,
        [table, column]
      );
      if (col.rows.length === 0) return;

      const orphans = await pool.query(
        `SELECT COUNT(*)::int AS c FROM ${table} t
         WHERE t.${column} IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM ${refTable} r WHERE r.${refColumn} = t.${column})`
      );
      const orphanCount = orphans.rows[0].c;

      if (orphanCount > 0) {
        console.warn(
          `⚠️ ${table}.${column} → ${refTable}.${refColumn}: ${orphanCount}টি অরফান রেকর্ড পাওয়া গেছে। ` +
          `ঐতিহাসিক ডেটা নষ্ট না করতে কনস্ট্রেইন্টটা NOT VALID হিসেবে যোগ করা হচ্ছে — ` +
          `নতুন অরফান আর ঢুকবে না। পুরনোগুলো পর্যালোচনার পর VALIDATE CONSTRAINT চালানো যাবে।`
        );
        await pool.query(
          `ALTER TABLE ${table} ADD CONSTRAINT ${constraintName}
           FOREIGN KEY (${column}) REFERENCES ${refTable}(${refColumn}) ON DELETE ${onDelete} NOT VALID`
        );
      } else {
        await pool.query(
          `ALTER TABLE ${table} ADD CONSTRAINT ${constraintName}
           FOREIGN KEY (${column}) REFERENCES ${refTable}(${refColumn}) ON DELETE ${onDelete}`
        );
      }
    };

    await addFk('accumulator_selections', 'match_id', 'matches', 'id', 'NO ACTION', 'fk_acca_sel_match');
    await addFk('accumulator_selections', 'market_id', 'markets', 'id', 'NO ACTION', 'fk_acca_sel_market');
    await addFk('login_logs', 'user_id', 'users', 'id', 'SET NULL', 'fk_login_logs_user');
    await addFk('error_logs', 'user_id', 'users', 'id', 'SET NULL', 'fk_error_logs_user');
    await addFk('chat_messages', 'sender_id', 'users', 'id', 'SET NULL', 'fk_chat_sender');
    await addFk('chat_messages', 'receiver_id', 'users', 'id', 'SET NULL', 'fk_chat_receiver');
    await addFk('news', 'author_id', 'users', 'id', 'SET NULL', 'fk_news_author');
    await addFk('withdraw_pin_logs', 'actor_id', 'users', 'id', 'SET NULL', 'fk_withdraw_pin_actor');
    console.log("✅ Referential integrity constraints ready");

    // ==================== অরফান login_logs মেরামত ও FK ভ্যালিডেশন ====================
    // login_logs.user_id-এ ফরেন কী যোগ হওয়ার আগে ইউজার হার্ড-ডিলিট হলে লগ সারিগুলো
    // অরফান হয়ে যেত — user_id এমন একটা আইডি দেখাত যার কোনো ইউজার আর নেই।
    //
    // ওই আইডি দিয়ে আর কিছুই resolve করা যায় না, কিন্তু ফরেনসিক দিক থেকে এটুকু জানা
    // মূল্যবান যে "এই কয়টা লগইন একই (মুছে যাওয়া) অ্যাকাউন্টের"। তাই সারি মুছে ফেলা বা
    // আইডি নিঃশব্দে হারিয়ে ফেলা — কোনোটাই করা হয় না। বদলে:
    //   ১. মূল আইডিটা deleted_user_id কলামে সরিয়ে রাখা হয় (কিছুই হারায় না);
    //   ২. user_id NULL করা হয় — ঠিক যা ON DELETE SET NULL করত যদি FK আগে থাকত;
    //   ৩. তারপর কনস্ট্রেইন্ট VALIDATE করা হয়।
    // ip, user_agent, device fingerprint, timestamp — অডিট রেকর্ডের সবকিছু অক্ষত থাকে।
    await pool.query(`ALTER TABLE login_logs ADD COLUMN IF NOT EXISTS deleted_user_id INTEGER;`);

    const loginFk = await pool.query(
      `SELECT convalidated FROM pg_constraint WHERE conname = 'fk_login_logs_user'`
    );
    if (loginFk.rows.length > 0 && loginFk.rows[0].convalidated === false) {
      const repaired = await pool.query(
        `UPDATE login_logs l
            SET deleted_user_id = COALESCE(l.deleted_user_id, l.user_id),
                user_id = NULL
          WHERE l.user_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = l.user_id)`
      );
      if (repaired.rowCount > 0) {
        console.log(
          `🔧 ${repaired.rowCount}টি অরফান login_logs সারি মেরামত করা হয়েছে ` +
          `(মূল user_id → deleted_user_id-এ সংরক্ষিত, কোনো সারি মোছা হয়নি)।`
        );
      }
      // এখন আর অরফান নেই, তাই কনস্ট্রেইন্টটা নিরাপদে ভ্যালিডেট করা যায়।
      // VALIDATE ব্যর্থ হলেও বুট আটকাবে না — কনস্ট্রেইন্ট NOT VALID অবস্থায় থেকে যাবে
      // এবং নতুন অরফান তখনও আটকাবে।
      try {
        await pool.query(`ALTER TABLE login_logs VALIDATE CONSTRAINT fk_login_logs_user;`);
        console.log("✅ fk_login_logs_user validated");
      } catch (e) {
        console.warn(`⚠️ fk_login_logs_user ভ্যালিডেট করা যায়নি: ${e.message}`);
      }
    }
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_login_logs_deleted_user ON login_logs(deleted_user_id) WHERE deleted_user_id IS NOT NULL;`);

    // ==================== সফট-ডিলিট / অ্যানোনিমাইজেশন ====================
    // অ্যাডমিন কোনো ইউজার ডিলিট করতে চাইলে ডাটাবেজ আর্থিক ইতিহাস রক্ষা করে (payment_requests,
    // bets, referral_commissions ইত্যাদির FK RESTRICT), ফলে হার্ড ডিলিট ব্যর্থ হয়। ওই ক্ষেত্রে
    // অ্যাকাউন্ট অ্যানোনিমাইজ করে নিষ্ক্রিয় করা হয় — deleted_at দিয়ে সেটা চিহ্নিত থাকে।
    // is_banned আলাদাভাবেও true করা হয়, যাতে Phase 01-এর isAuth এনফোর্সমেন্ট (middleware/auth.js)
    // পুনর্ব্যবহার হয় এবং দ্বিতীয় কোনো auth-চেক মেকানিজম তৈরি করতে না হয়।
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_deleted_at ON users(deleted_at) WHERE deleted_at IS NOT NULL;`);

    // ==================== আর্থিক ডেটা CHECK কনস্ট্রেইন্ট ====================
    // payment_requests-এ এতদিন একটাও CHECK কনস্ট্রেইন্ট ছিল না — শুধু PK আর user_id FK।
    // অর্থাৎ অ্যাপ্লিকেশন-লেভেল ভ্যালিডেশন (parseAmount, VALID_METHODS, স্ট্যাটাস গার্ড)
    // ফাঁকি দিয়ে বা ভবিষ্যতের কোনো নতুন কোডপাথ দিয়ে amount = -5000 বা
    // status = 'anything' ডাটাবেজে বসানো সম্ভব ছিল। টাকার টেবিলে শেষ প্রতিরক্ষা
    // ডাটাবেজেই থাকা উচিত, কারণ অ্যাপের প্রতিটা পথ ভুল করতে পারে।
    //
    // যোগ করার আগে বাস্তব ডেটা যাচাই করা হয়; নিয়মভঙ্গকারী সারি থাকলে কনস্ট্রেইন্ট
    // NOT VALID হিসেবে যোগ হয় — নতুন খারাপ সারি আটকায়, কিন্তু কোনো আর্থিক ইতিহাস
    // মুছে ফেলা হয় না এবং মাইগ্রেশন ব্যর্থ হয়ে অ্যাপ বুট আটকে দেয় না।
    const addCheck = async (table, constraintName, definition, violationQuery) => {
      const exists = await pool.query(
        `SELECT 1 FROM pg_constraint WHERE conname = $1 AND conrelid = $2::regclass`,
        [constraintName, table]
      );
      if (exists.rows.length > 0) return;

      const bad = await pool.query(violationQuery);
      const badCount = bad.rows[0] ? Number(bad.rows[0].c) : 0;

      if (badCount > 0) {
        console.warn(
          `⚠️ ${table}: ${constraintName} — ${badCount}টি সারি নিয়ম মানছে না। ` +
          `আর্থিক ইতিহাস অক্ষত রাখতে কনস্ট্রেইন্টটা NOT VALID হিসেবে যোগ করা হচ্ছে; ` +
          `পর্যালোচনার পর VALIDATE CONSTRAINT চালানো যাবে।`
        );
        await pool.query(`ALTER TABLE ${table} ADD CONSTRAINT ${constraintName} CHECK (${definition}) NOT VALID`);
      } else {
        await pool.query(`ALTER TABLE ${table} ADD CONSTRAINT ${constraintName} CHECK (${definition})`);
      }
    };

    await addCheck(
      'payment_requests', 'payment_requests_amount_positive', 'amount > 0',
      `SELECT COUNT(*)::int AS c FROM payment_requests WHERE amount IS NULL OR amount <= 0`
    );
    await addCheck(
      'payment_requests', 'payment_requests_status_valid',
      `status IN ('pending','approved','rejected')`,
      `SELECT COUNT(*)::int AS c FROM payment_requests WHERE status NOT IN ('pending','approved','rejected')`
    );
    await addCheck(
      'payment_requests', 'payment_requests_type_valid',
      `type IN ('deposit','withdraw')`,
      `SELECT COUNT(*)::int AS c FROM payment_requests WHERE type NOT IN ('deposit','withdraw')`
    );
    // ইউজারের ব্যালেন্স কখনো ঋণাত্মক হওয়ার কথা নয় — সব ডেবিট `AND coins >= $1` গার্ড
    // দিয়ে atomic ভাবে হয়। এটা সেই invariant-এর ডাটাবেজ-স্তরের নিশ্চয়তা।
    await addCheck(
      'users', 'users_coins_non_negative', 'coins IS NULL OR coins >= 0',
      `SELECT COUNT(*)::int AS c FROM users WHERE coins < 0`
    );
    console.log("✅ Financial CHECK constraints ready");


    // accumulator_selections.match_id-এ ফরেন কী যোগ হলো, কিন্তু PostgreSQL রেফারেন্সিং
    // কলামে স্বয়ংক্রিয় ইনডেক্স বানায় না। ম্যাচ ডিলিট/আপডেটের সময় FK যাচাই এবং
    // ম্যাচভিত্তিক সেটলমেন্ট কোয়েরি — দুটোতেই এই ইনডেক্স লাগে।
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_acca_sel_match ON accumulator_selections(match_id);`);

    // পাসওয়ার্ড রিসেটের প্রতিটা রিকোয়েস্টে users.reset_token দিয়ে খোঁজা হয়
    // (routes/auth.js — SELECT ... WHERE reset_token = $1, এবং টোকেন single-use করার
    // atomic UPDATE ... WHERE reset_token = $1)। কোনো ইনডেক্স ছিল না, তাই প্রতিবার
    // পুরো users টেবিল স্ক্যান হতো। partial — শুধু সক্রিয় টোকেনওয়ালা সারি ইনডেক্সে থাকে।
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_reset_token ON users(reset_token) WHERE reset_token IS NOT NULL;`);

    // হুবহু ডুপ্লিকেট ইনডেক্স সরানো: users.google_id ও users.referral_code — দুটোতেই
    // UNIQUE কনস্ট্রেইন্ট আছে, আর UNIQUE কনস্ট্রেইন্ট নিজেই একটা ইনডেক্স তৈরি করে
    // (users_google_id_key, users_referral_code_key)। অতিরিক্ত non-unique ইনডেক্সগুলো
    // একই কলামে দ্বিতীয় কপি — প্রতিটা INSERT/UPDATE-এ বাড়তি লেখার খরচ, কোনো লাভ নেই।
    await pool.query(`DROP INDEX IF EXISTS idx_users_google_id;`);
    await pool.query(`DROP INDEX IF EXISTS idx_users_referral;`);
    console.log("✅ Index integrity ready");

    // ==================== Phase 06: হট-পাথ সিকুয়েনশিয়াল স্ক্যান ====================
    // দুটোই EXPLAIN দিয়ে যাচাই করা — আন্দাজে যোগ করা হয়নি।
    //
    // users.last_ip: services/fraudDetection.js প্রতিটা লগইনে
    // `SELECT COUNT(*) FROM users WHERE last_ip = $1 AND created_at > NOW() - INTERVAL ...`
    // চালায় (rapid-registration যাচাই)। কোনো ইনডেক্স না থাকায় EXPLAIN দেখাত
    // `Seq Scan on users` — অর্থাৎ প্রতি লগইনে পুরো users টেবিল স্ক্যান, আর ইউজার
    // বাড়ার সাথে সাথে প্রতিটা লগইন ধীর হতে থাকত। একই কলাম
    // routes/admin.js-এর same-IP অ্যাকাউন্ট তালিকা ও ডুপ্লিকেট-স্ক্যানেও ব্যবহৃত।
    // partial — last_ip NULL হওয়া সারি (যারা কখনো লগইন করেনি) ইনডেক্সে রাখার দরকার নেই।
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_last_ip ON users(last_ip) WHERE last_ip IS NOT NULL;`);

    // bank_cards.user_id: টেবিলটায় প্রাইমারি কী ছাড়া কোনো ইনডেক্সই ছিল না, অথচ
    // প্রতিটা কোয়েরিই user_id দিয়ে ফিল্টার করে — ডিপোজিট পেজ (routes/payment.js),
    // উইথড্র পেজ, প্রোফাইলের কার্ড তালিকা। EXPLAIN দেখাত `Seq Scan on bank_cards`।
    // account_number-এ ডুপ্লিকেট-অ্যাকাউন্ট সনাক্তকরণ (services/duplicateDetection.js)
    // লুকআপ করে, সেটাও ইনডেক্সবিহীন ছিল।
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bank_cards_user ON bank_cards(user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bank_cards_account ON bank_cards(account_number);`);
    console.log("✅ Phase 06 hot-path indexes ready");

    // ==================== Phase 07: পোস্ট-মাস্টার-অডিট কোয়েরি পারফরম্যান্স ====================
    // প্রতিটা EXPLAIN দিয়ে যাচাই করা (tests/integration/dbQueryPerformance.test.js), আন্দাজে যোগ করা হয়নি।
    //
    // users/bets — routes/admin.js-এর ড্যাশবোর্ড ও services/analytics.js প্রতিটাতেই
    // `WHERE created_at::date = CURRENT_DATE` (বা `= d::date`) প্যাটার্নে চলে, অন্য কোনো
    // ফিল্টার ছাড়াই। কলামের ওপর ::date cast করায় সাধারণ btree(created_at) ইনডেক্স (যেটা
    // bets-এ আগে থেকেই আছে) ব্যবহার করা যায় না — planner পুরো টেবিল স্ক্যান করে প্রতিটা
    // সারির created_at cast করে তুলনা করত। এই expression ইনডেক্স ঠিক একই cast প্যাটার্ন
    // ধরে রাখে বলে planner সরাসরি ব্যবহার করতে পারে। users-এ এখন পর্যন্ত created_at-এ
    // কোনো ইনডেক্সই ছিল না (এমনকি সাধারণ btree-ও না)।
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_created_date ON users((created_at::date));`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bets_created_date ON bets((created_at::date));`);

    // payment_requests.account_number: bank_cards.account_number ইনডেক্স করা হলেও (Phase 06),
    // services/duplicateDetection.js ও services/fraudDetection.js-এর "একই পেমেন্ট অ্যাকাউন্ট
    // অন্য কোনো ইউজার ব্যবহার করেছে কিনা" চেক payment_requests.account_number-ও লুকআপ করে
    // (প্রতিটা ডিপোজিট/উইথড্র রিকোয়েস্টে) — এটা ইনডেক্সবিহীন ছিল।
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_pr_account_number ON payment_requests(account_number);`);

    // payment_requests.created_at: routes/admin.js-এর /transactions পেজ কোনো type/status
    // ফিল্টার ছাড়াই `ORDER BY created_at DESC LIMIT/OFFSET` চালায় — বিদ্যমান কম্পোজিট
    // ইনডেক্সগুলো (type, status, created_at) leading কলাম হিসেবে type/status চায়, তাই
    // ফিল্টারবিহীন এই সর্টে ব্যবহার হয় না।
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_pr_created_at ON payment_requests(created_at DESC);`);

    // device_sessions.device_signature / (browser, os): services/duplicateDetection.js-এর
    // evaluateDuplicateAccount() প্রতিটা রেজিস্ট্রেশন/ডিপোজিটে এই দুটো প্যাটার্নে ডুপ্লিকেট-
    // অ্যাকাউন্ট স্ক্যান চালায় — device_sessions টেবিলে user_id ছাড়া অন্য কোনো ইনডেক্স ছিল না।
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_device_sessions_signature ON device_sessions(device_signature);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_device_sessions_browser_os ON device_sessions(browser, os);`);
    console.log("✅ Phase 07 কোয়েরি পারফরম্যান্স ইনডেক্স ready");

    // ==================== Phase 08: মাস্টার অডিট — Aviator/Crash রাউন্ড অখণ্ডতা ====================
    // BUG-001: routes/games.js-এ cashout শুধু session-এর gameState-এর ওপর নির্ভর করত।
    // (ক) কোনো elapsed-time যাচাই ছিল না — বেট বসানোর সাথে সাথেই ক্লায়েন্ট যেকোনো
    //     multiplier দাবি করে ক্যাশআউট করতে পারত (crashPoint uniform(1,10) হওয়ায়
    //     প্রায় সবসময় জিতে যাওয়া যেত — পুনরুৎপাদন করা হয়েছে, ৪০ রাউন্ডে ৩৬ জয়)।
    // (খ) session-ভিত্তিক single-use স্টেট concurrent request-এর বিরুদ্ধে atomic নয় —
    //     resave:false হওয়ায় একাধিক সমান্তরাল অনুরোধ একই gameState পড়ে ফেলতে পারে,
    //     একই রাউন্ড একাধিকবার ক্যাশআউট হয় (পুনরুৎপাদন: ১০টা সমান্তরাল রিকোয়েস্টে ৯টা সফল)।
    // এই টেবিল রাউন্ডের crash_point/bet_amount/started_at DB-তে রাখে এবং settled_at
    // atomic `UPDATE ... WHERE settled_at IS NULL RETURNING` দিয়ে একবারই claim করা যায় —
    // Postgres-এর row-level lock স্বাভাবিকভাবেই সমান্তরাল claim সিরিয়ালাইজ করে।
    await pool.query(`
      CREATE TABLE IF NOT EXISTS game_rounds (
        id BIGSERIAL PRIMARY KEY,
        round_token UUID NOT NULL UNIQUE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        game_slug VARCHAR(50) NOT NULL,
        bet_amount NUMERIC(14,2) NOT NULL,
        crash_point NUMERIC(6,2) NOT NULL,
        is_demo BOOLEAN NOT NULL DEFAULT false,
        started_at TIMESTAMP NOT NULL DEFAULT NOW(),
        settled_at TIMESTAMP
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_game_rounds_user ON game_rounds(user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_game_rounds_token ON game_rounds(round_token);`);
    console.log("✅ Phase 08 game_rounds টেবিল ready");

    // ==================== Phase 08: মাস্টার অডিট — BUG-002 casino_bet লেজার সাইন ====================
    // routes/games.js-এ 'casino_bet' এন্ট্রি সবসময় ধনাত্মক betAmount হিসেবে লেখা হতো, অথচ
    // এটা প্রকৃতপক্ষে ব্যালেন্স থেকে টাকা কাটার (debit) এন্ট্রি — অন্য সব ফ্লোতে (withdraw,
    // admin add/remove — দেখুন tests/integration/financialLedgerIntegrity.test.js) এই কোডবেসের
    // মূল ইনভেরিয়েন্ট হলো balance == starting_balance + SUM(coin_transactions.amount)। ধনাত্মক
    // casino_bet এই ইনভেরিয়েন্ট ভাঙত: প্রতিটা ক্যাসিনো বাজিতে SUM(amount) আসল ব্যালেন্স-পরিবর্তনের
    // চেয়ে betAmount বেশি দেখাত (aviator/crash-এ ২×betAmount, বাকি ইনস্ট্যান্ট গেমে ১×betAmount,
    // কারণ সেখানে game_play এন্ট্রিও আলাদাভাবে লেখা হয়)। কোড-সাইন এখন ঠিক করা হলো (নিচে
    // routes/games.js দেখুন); এই ব্যাকফিল পুরনো সারিগুলোকেও সঙ্গতিপূর্ণ করে — শুধু ledger-এর
    // amount কলাম বদলায়, users.coins বা কোনো বাস্তব ব্যালেন্সে হাত দেয় না, তাই idempotent ও নিরাপদ।
    const casinoBetBackfill = await pool.query(
      `UPDATE coin_transactions SET amount = -amount WHERE type = 'casino_bet' AND amount > 0`
    );
    console.log(`✅ Phase 08 casino_bet ledger sign backfill: ${casinoBetBackfill.rowCount} সারি ঠিক করা হলো`);

  } catch (err) {
    console.error("❌ Migration error:", err.message);
  }
}

module.exports = runMigrations;
