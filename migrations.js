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

    // ==================== অ্যাডমিন টু-ফ্যাক্টর অথেন্টিকেশন (2FA) ====================
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN DEFAULT false;`);

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

    // একই ট্রানজেকশন আইডি দিয়ে বারবার ডিপোজিট আটকানো (ইউজার নিজে বাতিল করলে TrxID আবার ব্যবহার করা যাবে)
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pr_deposit_trx_unique
      ON payment_requests (transaction_id)
      WHERE type = 'deposit' AND transaction_id IS NOT NULL AND status <> 'cancelled';
    `);
    // কেস-ইনসেনসিটিভ ভার্সন: "ABC123" আর "abc123" কে একই ট্রানজেকশন আইডি হিসেবে ধরা (স্পেস ট্রিম করেও)
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pr_deposit_trx_unique_ci
      ON payment_requests (LOWER(TRIM(transaction_id)))
      WHERE type = 'deposit' AND transaction_id IS NOT NULL AND status <> 'cancelled';
    `);

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

    // ==================== ওয়েব পুশ সাবস্ক্রিপশন (ফোন লক/ব্যাকগ্রাউন্ডেও নোটিফিকেশন) ====================
    // অ্যাডমিন ব্রাউজার থেকে যে push subscription তৈরি হয় সেটা এখানে সেভ থাকে।
    // ডিপোজিট/উইথড্র/চ্যাট আসলে এই সাবস্ক্রিপশনগুলোতে push পাঠানো হয়।
    await pool.query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);`);

    // ==================== গেম ক্যাটালগ (games) — Admin Panel থেকে Full CRUD ====================
    // আগে গেমগুলো শুধু হোমপেজের JS কোডে হার্ডকোড করা ছিল। এখন games টেবিলে সেভ হয়,
    // অ্যাডমিন প্যানেল থেকে Add/Edit/Delete/Enable-Disable করা যাবে।
    await pool.query(`
      CREATE TABLE IF NOT EXISTS games (
        id SERIAL PRIMARY KEY,
        name VARCHAR(150) NOT NULL,
        slug VARCHAR(150) UNIQUE NOT NULL,
        emoji VARCHAR(10) DEFAULT '🎮',
        category VARCHAR(20) NOT NULL,
        provider VARCHAR(100) NOT NULL,
        badge VARCHAR(10),
        is_active BOOLEAN DEFAULT true,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_games_category ON games(category);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_games_provider ON games(provider);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_games_active ON games(is_active);`);

    // প্রথমবার টেবিল খালি থাকলে হোমপেজের পুরনো ১১৮টি গেম দিয়ে সিড করা হয়
    const gameCountRes = await pool.query('SELECT COUNT(*)::int AS count FROM games');
    if (gameCountRes.rows[0].count === 0) {
      const seedGames = [
        { name: 'Aviator', slug: 'aviator', emoji: '🎰', category: 'hot', provider: 'Spribe', badge: 'hot' },
        { name: 'Slots', slug: 'slots', emoji: '💎', category: 'slots', provider: 'Playtech', badge: 'pop' },
        { name: 'Roulette', slug: 'roulette', emoji: '🍭', category: 'live', provider: 'Playtech', badge: 'new' },
        { name: 'Andar Bahar', slug: 'andar-bahar', emoji: '⚡', category: 'live', provider: 'Jili', badge: null },
        { name: 'Teen Patti', slug: 'teen-patti', emoji: '🔥', category: 'hot', provider: 'Jili', badge: 'hot' },
        { name: 'Blackjack', slug: 'blackjack', emoji: '🐉', category: 'live', provider: 'Playtech', badge: 'hot' },
        { name: 'Poker', slug: 'poker', emoji: '🎴', category: 'poker', provider: 'Playtech', badge: 'pop' },
        { name: 'Baccarat', slug: 'baccarat', emoji: '🃏', category: 'live', provider: 'Playtech', badge: 'new' },
        { name: 'Crash Game', slug: 'crash-game', emoji: '🎲', category: 'slots', provider: 'Playtech', badge: null },
        { name: 'Starburst', slug: 'starburst', emoji: '🎯', category: 'hot', provider: 'NetEnt', badge: 'hot' },
        { name: 'Book of Dead', slug: 'book-of-dead', emoji: '🎡', category: 'hot', provider: 'Play\'n GO', badge: 'hot' },
        { name: 'Gonzo\'s Quest', slug: 'gonzos-quest', emoji: '🚀', category: 'slots', provider: 'NetEnt', badge: 'pop' },
        { name: 'Mega Moolah', slug: 'mega-moolah', emoji: '👑', category: 'hot', provider: 'Microgaming', badge: 'hot' },
        { name: 'Gates of Olympus', slug: 'gates-of-olympus', emoji: '🦁', category: 'hot', provider: 'Pragmatic Play', badge: 'hot' },
        { name: 'Sweet Bonanza', slug: 'sweet-bonanza', emoji: '🐯', category: 'hot', provider: 'Pragmatic Play', badge: 'hot' },
        { name: 'Legacy of Dead', slug: 'legacy-of-dead', emoji: '🌊', category: 'slots', provider: 'Play\'n GO', badge: 'hot' },
        { name: 'Crazy Time', slug: 'crazy-time', emoji: '⚓', category: 'hot', provider: 'Evolution', badge: 'hot' },
        { name: 'Lightning Roulette', slug: 'lightning-roulette', emoji: '🥷', category: 'live', provider: 'Evolution', badge: 'new' },
        { name: 'Monopoly Live', slug: 'monopoly-live', emoji: '🀄', category: 'live', provider: 'Evolution', badge: null },
        { name: 'Mega Ball', slug: 'mega-ball', emoji: '🐺', category: 'live', provider: 'Evolution', badge: null },
        { name: 'Dream Catcher', slug: 'dream-catcher', emoji: '🍀', category: 'live', provider: 'Evolution', badge: 'hot' },
        { name: 'Super Sic Bo', slug: 'super-sic-bo', emoji: '💰', category: 'live', provider: 'Evolution', badge: 'pop' },
        { name: 'Fan Tan', slug: 'fan-tan', emoji: '🏆', category: 'live', provider: 'Evolution', badge: 'new' },
        { name: 'Bac Bo', slug: 'bac-bo', emoji: '🎪', category: 'live', provider: 'Evolution', badge: null },
        { name: 'Rummy', slug: 'rummy', emoji: '🌟', category: 'poker', provider: 'Jili', badge: null },
        { name: 'Call Break', slug: 'call-break', emoji: '🎆', category: 'poker', provider: 'Jili', badge: 'hot' },
        { name: 'Dragon Tiger', slug: 'dragon-tiger', emoji: '❄️', category: 'hot', provider: 'Jili', badge: 'hot' },
        { name: 'JetX', slug: 'jetx', emoji: '⛩️', category: 'hot', provider: 'Spribe', badge: 'hot' },
        { name: 'Plinko', slug: 'plinko', emoji: '🍬', category: 'slots', provider: 'Spribe', badge: null },
        { name: 'Keno', slug: 'keno', emoji: '🦍', category: 'slots', provider: 'Spribe', badge: null },
        { name: 'Bingo', slug: 'bingo', emoji: '🎰', category: 'slots', provider: 'JDB', badge: 'hot' },
        { name: '5D Lottery', slug: '5d-lottery', emoji: '💎', category: 'slots', provider: 'JDB', badge: 'pop' },
        { name: 'Win Go', slug: 'win-go', emoji: '🍭', category: 'slots', provider: 'JDB', badge: 'new' },
        { name: 'Coin Flip', slug: 'coin-flip', emoji: '⚡', category: 'slots', provider: 'JDB', badge: null },
        { name: 'Dice', slug: 'dice', emoji: '🔥', category: 'slots', provider: 'Spribe', badge: null },
        { name: 'Fortune Gems', slug: 'fortune-gems', emoji: '🐉', category: 'hot', provider: 'Jili', badge: 'hot' },
        { name: 'Golden Empire', slug: 'golden-empire', emoji: '🎴', category: 'slots', provider: 'Jili', badge: 'pop' },
        { name: 'Sugar Rush', slug: 'sugar-rush', emoji: '🃏', category: 'slots', provider: 'Pragmatic Play', badge: 'new' },
        { name: 'K3 Lottery', slug: 'k3-lottery', emoji: '🎲', category: 'slots', provider: 'JDB', badge: null },
        { name: 'Spaceman', slug: 'spaceman', emoji: '🎯', category: 'hot', provider: 'Spribe', badge: 'hot' },
        { name: 'Sic Bo', slug: 'sic-bo', emoji: '🎡', category: 'live', provider: 'Microgaming', badge: 'hot' },
        { name: 'Fish Prawn Crab', slug: 'fish-prawn-crab', emoji: '🚀', category: 'slots', provider: 'Jili', badge: 'pop' },
        { name: 'Fruit Slot', slug: 'fruit-slot', emoji: '👑', category: 'slots', provider: 'Playson', badge: 'new' },
        { name: 'Diamond Slot', slug: 'diamond-slot', emoji: '🦁', category: 'slots', provider: 'Wazdan', badge: null },
        { name: '7up 7down', slug: '7up-7down', emoji: '🐯', category: 'slots', provider: 'Jili', badge: null },
        { name: 'Triple Card', slug: 'triple-card', emoji: '🌊', category: 'poker', provider: 'Jili', badge: 'hot' },
        { name: 'Jhandi Munda', slug: 'jhandi-munda', emoji: '⚓', category: 'poker', provider: 'Jili', badge: 'pop' },
        { name: 'Cricket War', slug: 'cricket-war', emoji: '🥷', category: 'sports', provider: 'Jili', badge: 'new' },
        { name: 'Football War', slug: 'football-war', emoji: '🀄', category: 'sports', provider: 'Jili', badge: null },
        { name: 'Minesweeper Pro', slug: 'minesweeper-pro', emoji: '🐺', category: 'slots', provider: 'Jili', badge: null },
        { name: 'Tower Game', slug: 'tower-game', emoji: '🍀', category: 'slots', provider: 'Jili', badge: 'hot' },
        { name: 'Limbo', slug: 'limbo', emoji: '💰', category: 'slots', provider: 'Spribe', badge: 'pop' },
        { name: 'Wheel Pro', slug: 'wheel-pro', emoji: '🏆', category: 'slots', provider: 'Jili', badge: 'new' },
        { name: 'Panda Slot', slug: 'panda-slot', emoji: '🎪', category: 'slots', provider: 'Jili', badge: null },
        { name: 'Tiger Slot', slug: 'tiger-slot', emoji: '🌟', category: 'slots', provider: 'Jili', badge: null },
        { name: 'Dragon Slot', slug: 'dragon-slot', emoji: '🎆', category: 'slots', provider: 'Jili', badge: 'hot' },
        { name: 'Phoenix Slot', slug: 'phoenix-slot', emoji: '❄️', category: 'slots', provider: 'Red Tiger', badge: 'pop' },
        { name: 'Lion Slot', slug: 'lion-slot', emoji: '⛩️', category: 'slots', provider: 'Red Tiger', badge: 'new' },
        { name: 'Coin Master', slug: 'coin-master', emoji: '🍬', category: 'slots', provider: 'Jili', badge: null },
        { name: 'Gold Rush', slug: 'gold-rush', emoji: '🦍', category: 'slots', provider: 'Red Tiger', badge: null },
        { name: 'Treasure Hunt', slug: 'treasure-hunt', emoji: '🎰', category: 'slots', provider: 'Betsoft', badge: 'hot' },
        { name: 'Pirate Gold', slug: 'pirate-gold', emoji: '💎', category: 'slots', provider: 'Red Tiger', badge: 'pop' },
        { name: 'Ninja Game', slug: 'ninja-game', emoji: '🍭', category: 'slots', provider: 'Betsoft', badge: 'new' },
        { name: 'Samurai Slot', slug: 'samurai-slot', emoji: '⚡', category: 'slots', provider: 'Hacksaw Gaming', badge: null },
        { name: 'Mahjong Ways', slug: 'mahjong-ways', emoji: '🔥', category: 'slots', provider: 'Big Time Gaming', badge: null },
        { name: 'Thai Paradise', slug: 'thai-paradise', emoji: '🐉', category: 'slots', provider: 'Big Time Gaming', badge: 'hot' },
        { name: 'Monkey King', slug: 'monkey-king', emoji: '🎴', category: 'slots', provider: 'Hacksaw Gaming', badge: 'pop' },
        { name: 'Wild West', slug: 'wild-west', emoji: '🃏', category: 'slots', provider: 'Pragmatic Play', badge: 'new' },
        { name: 'Space Wars', slug: 'space-wars', emoji: '🎲', category: 'slots', provider: 'Spinomenal', badge: null },
        { name: 'Ocean King', slug: 'ocean-king', emoji: '🎯', category: 'slots', provider: 'Jili', badge: null },
        { name: 'Fire Dice', slug: 'fire-dice', emoji: '🎡', category: 'slots', provider: 'Wazdan', badge: 'hot' },
        { name: 'Ice Slot', slug: 'ice-slot', emoji: '🚀', category: 'slots', provider: 'Wazdan', badge: 'pop' },
        { name: 'Storm Slot', slug: 'storm-slot', emoji: '👑', category: 'slots', provider: 'PG Soft', badge: 'new' },
        { name: 'Royal Flush', slug: 'royal-flush', emoji: '🦁', category: 'poker', provider: 'Spinomenal', badge: null },
        { name: 'Lucky 7', slug: 'lucky-7', emoji: '🐯', category: 'slots', provider: 'NetEnt', badge: null },
        { name: 'Magic Ball', slug: 'magic-ball', emoji: '🌊', category: 'slots', provider: 'Playson', badge: 'hot' },
        { name: 'Neon Slots', slug: 'neon-slots', emoji: '⚓', category: 'slots', provider: 'Playson', badge: 'pop' },
        { name: 'Cash Burst', slug: 'cash-burst', emoji: '🥷', category: 'slots', provider: 'PG Soft', badge: 'new' },
        { name: 'Live Blackjack', slug: 'live-blackjack', emoji: '🀄', category: 'live', provider: 'Evolution', badge: null },
        { name: 'Live Roulette', slug: 'live-roulette', emoji: '🐺', category: 'live', provider: 'Evolution', badge: null },
        { name: 'Live Baccarat', slug: 'live-baccarat', emoji: '🍀', category: 'live', provider: 'Evolution', badge: 'hot' },
        { name: 'Live Poker', slug: 'live-poker', emoji: '💰', category: 'live', provider: 'Evolution', badge: 'pop' },
        { name: 'Mines', slug: 'mines', emoji: '🏆', category: 'slots', provider: 'Spribe', badge: 'new' },
        { name: 'Football Studio', slug: 'football-studio', emoji: '🎪', category: 'live', provider: 'Evolution', badge: null },
        { name: 'Cash or Crash', slug: 'cash-or-crash', emoji: '🌟', category: 'slots', provider: 'Spribe', badge: null },
        { name: 'Extra Chilli', slug: 'extra-chill', emoji: '🎆', category: 'slots', provider: 'Big Time Gaming', badge: 'hot' },
        { name: 'Fire in the Hole', slug: 'fire-in-the-hole', emoji: '❄️', category: 'slots', provider: 'Nolimit City', badge: 'pop' },
        { name: 'Wanted Dead or Wild', slug: 'wanted-dead-or-a-wild', emoji: '⛩️', category: 'hot', provider: 'Hacksaw Gaming', badge: 'hot' },
        { name: 'Mental', slug: 'mental', emoji: '🍬', category: 'slots', provider: 'Nolimit City', badge: null },
        { name: 'Razor Shark', slug: 'razor-shark', emoji: '🦍', category: 'slots', provider: 'Relax Gaming', badge: null },
        { name: 'Jammin Jars', slug: 'jammin-jars', emoji: '🎰', category: 'slots', provider: 'Relax Gaming', badge: 'hot' },
        { name: 'San Quentin', slug: 'san-quentin', emoji: '💎', category: 'hot', provider: 'Nolimit City', badge: 'hot' },
        { name: 'Aviator Pro', slug: 'aviator-pro', emoji: '🍭', category: 'slots', provider: 'Spribe', badge: 'new' },
        { name: 'JetX Pro', slug: 'jetx-pro', emoji: '⚡', category: 'slots', provider: 'Spribe', badge: null },
        { name: 'Spaceman Pro', slug: 'spaceman-pro', emoji: '🔥', category: 'slots', provider: 'Spribe', badge: null },
        { name: 'Aviatrix', slug: 'aviatrix', emoji: '🐉', category: 'slots', provider: 'Spribe', badge: 'hot' },
        { name: 'Balloon', slug: 'balloon', emoji: '🎴', category: 'slots', provider: 'Spribe', badge: 'pop' },
        { name: 'Minesweeper', slug: 'minesweeper', emoji: '🃏', category: 'slots', provider: 'Jili', badge: 'new' },
        { name: 'Football X', slug: 'football-x', emoji: '🎲', category: 'sports', provider: 'Spribe', badge: null },
        { name: 'Online Ludo', slug: 'ludo', emoji: '🎯', category: 'sports', provider: 'Jili', badge: null },
        { name: 'Color Prediction', slug: 'color-prediction', emoji: '🎡', category: 'slots', provider: 'Jili', badge: 'hot' },
        { name: 'Mine Game', slug: 'mine', emoji: '🚀', category: 'slots', provider: 'Jili', badge: 'pop' },
        { name: 'Hi-Lo', slug: 'hilo', emoji: '👑', category: 'slots', provider: 'Jili', badge: 'new' },
        { name: 'Card War', slug: 'card-war', emoji: '🦁', category: 'poker', provider: 'Jili', badge: null },
        { name: 'Lucky Spin', slug: 'lucky-spin', emoji: '🐯', category: 'slots', provider: 'Jili', badge: null },
        { name: 'Number Guess', slug: 'number-guess', emoji: '🌊', category: 'slots', provider: 'Jili', badge: 'hot' },
        { name: 'Age of the Gods', slug: 'age-of-the-gods', emoji: '⚓', category: 'slots', provider: 'Playtech', badge: 'pop' },
        { name: 'Buffalo Blitz', slug: 'buffalo-blitz', emoji: '🥷', category: 'slots', provider: 'Playtech', badge: 'new' },
        { name: 'Immortal Romance', slug: 'immortal-romance', emoji: '🀄', category: 'slots', provider: 'Microgaming', badge: null },
        { name: 'Thunderstruck II', slug: 'thunderstruck-2', emoji: '🐺', category: 'slots', provider: 'Microgaming', badge: null },
        { name: 'Sugar Pop', slug: 'sugar-pop', emoji: '🍀', category: 'slots', provider: 'Spinomenal', badge: 'hot' },
        { name: 'The Slotfather', slug: 'slotfather', emoji: '💰', category: 'slots', provider: 'Betsoft', badge: 'pop' },
        { name: 'Valley of the Gods', slug: 'valley-of-the-gods', emoji: '🏆', category: 'slots', provider: 'Yggdrasil', badge: 'new' },
        { name: 'Vikings Go Berzerk', slug: 'vikings-go-berzerk', emoji: '🎪', category: 'slots', provider: 'Yggdrasil', badge: null },
        { name: 'Gonzo\'s Quest Megaways', slug: 'gonzos-quest-megaways', emoji: '🌟', category: 'slots', provider: 'NetEnt', badge: null },
        { name: 'Piggy Riches Megaways', slug: 'piggy-riches-megaways', emoji: '🎆', category: 'slots', provider: 'NetEnt', badge: 'hot' },
        { name: 'Big Bad Wolf', slug: 'big-bad-wolf', emoji: '❄️', category: 'slots', provider: 'Quickspin', badge: 'pop' },
        { name: 'Sakura Fortune', slug: 'sakura-fortune', emoji: '⛩️', category: 'slots', provider: 'Quickspin', badge: 'new' }
      ];
      let seedOrder = 0;
      for (const g of seedGames) {
        seedOrder += 1;
        await pool.query(
          `INSERT INTO games (name, slug, emoji, category, provider, badge, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (slug) DO NOTHING`,
          [g.name, g.slug, g.emoji, g.category, g.provider, g.badge, seedOrder]
        );
      }
      console.log(`✅ ${seedGames.length}টি ডিফল্ট গেম সিড করা হয়েছে`);
    }

    // একই গেম একাধিকবার (ভিন্ন ভিন্ন slug দিয়ে) যোগ হয়ে থাকলে ডুপ্লিকেট পরিষ্কার করা —
    // প্রতিটা নামের সবচেয়ে পুরনো (সবচেয়ে ছোট id) এন্ট্রিটা রেখে বাকিগুলো মুছে ফেলা হয়
    const dedupResult = await pool.query(`
      DELETE FROM games
      WHERE id NOT IN (
        SELECT MIN(id) FROM games GROUP BY LOWER(TRIM(name))
      )
    `);
    if (dedupResult.rowCount > 0) {
      console.log(`✅ ${dedupResult.rowCount}টি ডুপ্লিকেট গেম মুছে ফেলা হয়েছে`);
    }

    // পুরনো ডেটায় কিছু গেম category='hot' হিসেবে সেভ ছিল (আসল ক্যাটাগরি slots/live/poker
    // থেকে সরিয়ে) — এর ফলে সেই প্রোভাইডারের গেম Slots/Live/Poker ট্যাবে দেখা যাচ্ছিল না।
    // badge='hot' রেখেই (হট ট্যাবেও দেখাবে) আসল ক্যাটাগরিতে ফিরিয়ে দেওয়া হলো।
    const hotCategoryFix = {
      slots: ['aviator', 'gates-of-olympus', 'sweet-bonanza', 'fortune-gems', 'starburst',
        'mega-moolah', 'book-of-dead', 'jetx', 'spaceman', 'wanted-dead-or-a-wild', 'san-quentin'],
      live: ['crazy-time', 'dragon-tiger'],
      poker: ['teen-patti'],
    };
    for (const [cat, slugs] of Object.entries(hotCategoryFix)) {
      const r = await pool.query(
        `UPDATE games SET category = $1, badge = 'hot', updated_at = NOW()
         WHERE category = 'hot' AND slug = ANY($2::text[])`,
        [cat, slugs]
      );
      if (r.rowCount > 0) console.log(`✅ ${r.rowCount}টি গেম '${cat}' ক্যাটাগরিতে ফিরিয়ে আনা হলো (badge=hot বজায় থাকলো)`);
    }
    // এই তালিকার বাইরে category='hot' হয়ে থাকলে (অজানা গেম) ডিফল্টভাবে slots-এ ফেলা হলো
    const leftoverHot = await pool.query(
      `UPDATE games SET category = 'slots', badge = 'hot', updated_at = NOW() WHERE category = 'hot'`
    );
    if (leftoverHot.rowCount > 0) console.log(`✅ বাকি ${leftoverHot.rowCount}টি 'hot' ক্যাটাগরির গেম slots-এ সরানো হলো`);

    // প্রতিটা প্রোভাইডারের অন্তত ১টা করে 'slots' গেম থাকা নিশ্চিত করা — Evolution-এর সবগুলো
    // গেম আসলে 'live' ক্যাটাগরির ছিল, তাই Slots ট্যাবে গেলে Evolution-এ কিছুই দেখাচ্ছিল না
    await pool.query(`
      INSERT INTO games (name, slug, emoji, category, provider, badge, sort_order)
      VALUES ('Divine Fortune', 'divine-fortune', '💎', 'slots', 'Evolution', 'hot', 119)
      ON CONFLICT (slug) DO NOTHING
    `);

    console.log("✅ All tables migration completed successfully");
  } catch (err) {
    console.error("❌ Migration error:", err.message);
  }
}

module.exports = runMigrations;
