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

    console.log("✅ Job queue table ready");

    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMP;`);

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

  } catch (err) {
    console.error("❌ Migration error:", err.message);
  }
}

module.exports = runMigrations;
