import type { NextApiRequest, NextApiResponse } from 'next';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { pool } from '../../../db';
import { createReferral } from '../../../services/referral';

const USERNAME_RE = /^[A-Za-z0-9_.]{3,20}$/;
const EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;

// ইউজারনেমের প্রথম ৪ অক্ষর + র‍্যান্ডম সাফিক্স — routes/auth.js-এর জেনারেশন লজিকের সাথে সামঞ্জস্যপূর্ণ
const REFERRAL_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const REFERRAL_CODE_SUFFIX_LEN = 6;
const REFERRAL_CODE_MAX_ATTEMPTS = 5;

function generateReferralCode(username: string) {
  const prefix = String(username || 'USER').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) || 'USER';
  const bytes = crypto.randomBytes(REFERRAL_CODE_SUFFIX_LEN);
  let suffix = '';
  for (let i = 0; i < REFERRAL_CODE_SUFFIX_LEN; i++) {
    suffix += REFERRAL_CODE_ALPHABET[bytes[i] % REFERRAL_CODE_ALPHABET.length];
  }
  return prefix + suffix;
}

type RegisterBody = {
  username?: string;
  email?: string;
  password?: string;
  confirmPassword?: string;
  referralCode?: string;
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ errors: { general: 'শুধুমাত্র POST মেথড সাপোর্টেড।' } });
  }

  const { username, email, password, confirmPassword, referralCode } = (req.body || {}) as RegisterBody;
  const errors: Record<string, string> = {};

  const trimmedUsername = (username || '').trim();
  const trimmedEmail = (email || '').trim();
  const trimmedReferralCode = (referralCode || '').trim();

  if (!trimmedUsername) {
    errors.username = 'ইউজারনেম আবশ্যক।';
  } else if (!USERNAME_RE.test(trimmedUsername)) {
    errors.username = 'ইউজারনেমে শুধু লেটার, সংখ্যা, আন্ডারস্কোর, ডট ব্যবহার করা যাবে (৩-২০ ক্যারেক্টার)।';
  }

  if (!trimmedEmail) {
    errors.email = 'ইমেইল আবশ্যক।';
  } else if (!EMAIL_RE.test(trimmedEmail)) {
    errors.email = 'সঠিক ইমেইল ফরম্যাট দিন।';
  }

  if (!password || password.length < 8) {
    errors.password = 'পাসওয়ার্ড কমপক্ষে ৮ অক্ষর হতে হবে।';
  }

  if (!confirmPassword) {
    errors.confirmPassword = 'কনফার্ম পাসওয়ার্ড দিতে হবে।';
  } else if (password !== confirmPassword) {
    errors.confirmPassword = 'পাসওয়ার্ড মিলছে না।';
  }

  if (Object.keys(errors).length > 0) {
    return res.status(400).json({ errors });
  }

  try {
    const existingUsername = await pool.query('SELECT id FROM users WHERE username = $1', [trimmedUsername]);
    if (existingUsername.rows.length > 0) {
      return res.status(409).json({ errors: { username: 'এই ইউজারনেম আগেই নিবন্ধিত।' } });
    }

    const existingEmail = await pool.query('SELECT id FROM users WHERE email = $1', [trimmedEmail]);
    if (existingEmail.rows.length > 0) {
      return res.status(409).json({ errors: { email: 'এই ইমেইল আগেই নিবন্ধিত।' } });
    }

    let referredById: number | null = null;
    if (trimmedReferralCode) {
      const referrer = await pool.query('SELECT id FROM users WHERE referral_code = $1', [trimmedReferralCode]);
      if (referrer.rows.length === 0) {
        return res.status(400).json({ errors: { referralCode: 'রেফারেল কোডটি সঠিক নয়।' } });
      }
      referredById = referrer.rows[0].id;
    }

    const hashed = await bcrypt.hash(password as string, 10);

    let newUser = null;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < REFERRAL_CODE_MAX_ATTEMPTS; attempt++) {
      const code = generateReferralCode(trimmedUsername);
      try {
        const result = await pool.query(
          `INSERT INTO users (username, email, password, role, coins, referral_code, referred_by_id, created_at)
           VALUES ($1, $2, $3, 'user', 0, $4, $5, NOW()) RETURNING id, username, email, referral_code`,
          [trimmedUsername, trimmedEmail, hashed, code, referredById]
        );
        newUser = result.rows[0];
        break;
      } catch (err: any) {
        const isReferralCollision = err && err.code === '23505' && err.constraint === 'users_referral_code_key';
        if (!isReferralCollision) throw err;
        lastErr = err;
      }
    }

    if (!newUser) throw lastErr;

    if (referredById) {
      await createReferral(null, referredById, newUser.id);
    }

    return res.status(201).json({
      success: true,
      user: { id: newUser.id, username: newUser.username, email: newUser.email, referralCode: newUser.referral_code },
    });
  } catch (err) {
    console.error('register API error:', err);
    return res.status(500).json({ errors: { general: 'রেজিস্ট্রেশন ব্যর্থ হয়েছে। পরে আবার চেষ্টা করুন।' } });
  }
}
