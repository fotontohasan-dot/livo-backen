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
    // যাদের ইমেইল নেই (শুধু ফোন দিয়ে রেজিস্টার করেছে) তাদের জন্য ভেরিফিকেশন গেট প্রযোজ্য না
    await pool.query(`UPDATE users SET email_verified = true WHERE email IS NULL AND email_verified = false;`);
    // এই ফিচার চালুর আগে থেকে থাকা ইউজারদের (কখনো ভেরিফিকেশন টোকেন ইস্যু হয়নি) "verified" হিসেবে
    // গ্র্যান্ডফাদার করা হলো — নাহলে সবার withdraw/সংবেদনশীল ফিচার হঠাৎ বন্ধ হয়ে যেত।
    // নতুন রেজিস্ট্রেশন থেকেই শুধু ভেরিফিকেশন বাধ্যতামূলক থাকবে (তাদের টোকেন ইস্যু হবে)।
    await pool.query(`UPDATE users SET email_verified = true WHERE email_verified = false AND verification_token IS NULL;`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_verification_token ON users(verification_token);`);

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

    // একই মেথডে একই TrxID দিয়ে একাধিকবার (rejected বাদে) ডিপোজিট আটকাতে partial unique index —
    // rejected বাদ রাখা হয়েছে যাতে ভুল/টাইপো করে reject হওয়া ট্রানজেকশন আইডি আবার বৈধভাবে সাবমিট করা যায়
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
    // ============================================================================================

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
    // মিশন তালিকা (ব্যালেন্সড ৪টি) — সঠিক সেট না থকলে রিসিড
    const missionVer = await pool.query(`SELECT COALESCE(SUM(reward),0) AS s, COUNT(*) AS c FROM mission_defs WHERE period = 'daily'`);
    const missionOk = parseInt(missionVer.rows[0].c) === 4 && parseInt(missionVer.rows[0].s) === 125;
    if (!missionOk) {
      await pool.query(`DELETE FROM mission_defs WHERE period = 'daily'`);
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

    // সাপ্তাহিক/স্পেশাল মিশনের ক্লেইম ট্র্যাক করার টেবিল
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

    // লাকি হুইল
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

    // লয়্যালটি পয়েন্ট
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

    // ব্যাজ ও অর্জন
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

    // ফ্রি বেট
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

    // সাপ্তাহিক/মাসিক কইম রেকর্ড
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

    // লাল প্যাকেট + সোনার ডিম দৈনিক রিওয়ার্ড
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

    // সোশ্যাল শেয়ার
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
    // লাল প্যাকেট + সোনার ডিম দৈনিক রিওয়ার্ড
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

    // জরুরি ফিক্স: maintenance_mode জোর করে বন্ধ — settings পেজে এরর থাকায়
    // টগল দিয়ে অফ করা যাচ্ছিল না, তাই এখানে unconditionally 'false' সেট করা হলো
    // (ON CONFLICT ... DO UPDATE, DO NOTHING না)।
    await pool.query(`
      INSERT INTO site_settings (key, value, updated_at) VALUES ('maintenance_mode', 'false', NOW())
      ON CONFLICT (key) DO UPDATE SET value = 'false', updated_at = NOW();
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

    // ==================== কয়েন লেনদেন লগ (coin_transactions) ====================
    // এই টেবিলটা পুরো অ্যাপে (গেম, বেট, রেফারেল, মিশন, VIP, ক্যাশব্যাক, অ্যাডমিন
    // কয়েন অ্যাডজাস্টমেন্ট ইত্যাদি) ব্যবহার হয়, কিন্তু আগে migrations.js-এ ছিল না —
    // ফলে এই টেবিল না থাকলে রিয়েল-মানি গেম/বেট খেলাই ব্যর্থ হয়ে যেত।
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

    // ==================== ডেমো (প্র্যাকটিস) কারেন্সি সিস্টেম ====================
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

    // ==================== অ্যাডমিন 2FA (TOTP) ====================
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

    // KYC রিজেক্ট করার সময় কারণ ইউজারকে দেখানোর জন্য (অ্যাডমিন প্যানেলে আগে থেকেই
    // "কারণ লিখুন (ইউজারকে দেখানো হবে)" বলা ছিল, কিন্তু কলামই ছিল না)
    await pool.query(`ALTER TABLE kyc_requests ADD COLUMN IF NOT EXISTS reject_reason TEXT`);

    // ==================== Withdraw PIN নিরাপত্তা সিস্টেম ====================
    // ৬-সংখ্যার Withdraw PIN কখনো plain text এ রাখা হয় না — শুধু bcrypt হ্যাশ স্টোর হয়
    // (users.totp_secret এর মতোই প্যাটার্ন — বিদ্যমান 2FA সিস্টেমের সাথে সামঞ্জস্যপূর্ণ)
    await pool.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS withdraw_pin_hash TEXT,
      ADD COLUMN IF NOT EXISTS withdraw_pin_created_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS withdraw_pin_updated_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS withdraw_pin_failed_attempts INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS withdraw_pin_locked_until TIMESTAMP;
    `);

    // Withdraw PIN সম্পর্কিত সব ইভেন্টের (create/change/reset/verify/admin-reset) অডিট ট্রেইল —
    // admin_logs থেকে আলাদা রাখা হয়েছে কারণ বেশিরভাগ ইভেন্ট user-initiated, admin-initiated না
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

    // ==================== ফ্রড ডিটেকশন (Fraud Detection Foundation) ====================
    // শুধু ফ্ল্যাগ করা হয়, কখনো অটোমেটিক ব্লক করা হয় না — সিদ্ধান্ত সবসময় অ্যাডমিন নেয়
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

    console.log("✅ All tables migration completed successfully");

    // ==================== ডিভাইস ট্র্যাকিং ও লগইন হিস্ট্রি (Feature 05) ====================
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

    // ==================== আনুমানিক লোকেশন (Feature 06 — geoip-lite দিয়ে, অফলাইন, কোনো API key লাগে না) ====================
    await pool.query(`ALTER TABLE login_logs ADD COLUMN IF NOT EXISTS location VARCHAR(120)`);
    await pool.query(`ALTER TABLE device_sessions ADD COLUMN IF NOT EXISTS location VARCHAR(120)`);

    console.log("✅ Device tracking tables ready");
  } catch (err) {
    console.error("❌ Migration error:", err.message);
  }
}

module.exports = runMigrations;
