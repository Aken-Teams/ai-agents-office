import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import db from '../db.js';
import { config } from '../config.js';
import { authMiddleware } from '../middleware/auth.js';
import { checkUserUsageLimit } from '../services/usageLimit.js';
import type { User } from '../types.js';

const router = Router();

/* ============================================================
   Auth Rate Limiting (stricter than general API)
   - Register: 5 attempts per IP per 15 minutes
   - Login:    10 attempts per IP per 15 minutes
   ============================================================ */
const authAttempts = new Map<string, { count: number; resetTime: number }>();

// Clean up every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of authAttempts) {
    if (now > entry.resetTime) authAttempts.delete(key);
  }
}, 10 * 60_000);

function checkAuthRate(ip: string, prefix: string, maxAttempts: number, windowMs: number): boolean {
  const key = `${prefix}:${ip}`;
  const now = Date.now();
  let entry = authAttempts.get(key);
  if (!entry || now > entry.resetTime) {
    entry = { count: 0, resetTime: now + windowMs };
    authAttempts.set(key, entry);
  }
  entry.count++;
  return entry.count <= maxAttempts;
}

/* ============================================================
   Login Lockout (per email, after 5 consecutive failures)
   ============================================================ */
const loginFailures = new Map<string, { count: number; lockedUntil: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of loginFailures) {
    if (now > entry.lockedUntil && entry.count === 0) loginFailures.delete(key);
  }
}, 10 * 60_000);

const MAX_LOGIN_FAILURES = 5;
const LOCKOUT_DURATION_MS = 15 * 60_000; // 15 minutes

function checkLoginLockout(email: string): { locked: boolean; remainingMs: number } {
  const entry = loginFailures.get(email);
  if (!entry) return { locked: false, remainingMs: 0 };
  const now = Date.now();
  if (entry.count >= MAX_LOGIN_FAILURES && now < entry.lockedUntil) {
    return { locked: true, remainingMs: entry.lockedUntil - now };
  }
  if (now >= entry.lockedUntil) {
    // Reset after lockout period
    loginFailures.delete(email);
  }
  return { locked: false, remainingMs: 0 };
}

function recordLoginFailure(email: string): void {
  const entry = loginFailures.get(email) || { count: 0, lockedUntil: 0 };
  entry.count++;
  if (entry.count >= MAX_LOGIN_FAILURES) {
    entry.lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
  }
  loginFailures.set(email, entry);
}

function clearLoginFailures(email: string): void {
  loginFailures.delete(email);
}

/* ============================================================
   Input Validation Helpers
   ============================================================ */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(email: string): boolean {
  return EMAIL_REGEX.test(email) && email.length <= 255;
}

/* ============================================================
   POST /api/auth/register
   ============================================================ */
router.post('/register', async (req: Request, res: Response) => {
  try {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';

    // Rate limit: 5 registrations per IP per 15 minutes
    if (!checkAuthRate(ip, 'reg', 5, 15 * 60_000)) {
      res.status(429).json({ error: '註冊請求過於頻繁，請 15 分鐘後再試' });
      return;
    }

    const { email, password, displayName } = req.body;

    // Honeypot: if hidden field is filled, it's a bot
    if (req.body.website || req.body.phone_number) {
      // Silently accept but don't create account (deceive bots)
      res.status(201).json({ pending: true, message: '帳號已建立，請等待管理者審核通過後即可登入' });
      return;
    }

    // Validate inputs
    if (!email || !password) {
      res.status(400).json({ error: '電子信箱和密碼為必填' });
      return;
    }

    if (!isValidEmail(email)) {
      res.status(400).json({ error: '電子信箱格式不正確' });
      return;
    }

    if (password.length < 8) {
      res.status(400).json({ error: '密碼至少需要 8 個字元' });
      return;
    }

    if (password.length > 128) {
      res.status(400).json({ error: '密碼過長' });
      return;
    }

    const trimmedName = (displayName || '').trim();
    if (trimmedName && trimmedName.length > 50) {
      res.status(400).json({ error: '顯示名稱最多 50 個字元' });
      return;
    }

    // Check duplicate
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) {
      res.status(409).json({ error: '此電子信箱已被註冊' });
      return;
    }

    const id = uuidv4();
    const passwordHash = await bcrypt.hash(password, config.bcryptRounds);

    // New users default to 'pending' — must be approved by admin
    db.prepare(
      'INSERT INTO users (id, email, password_hash, display_name, role, status) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, email.toLowerCase().trim(), passwordHash, trimmedName || null, 'user', 'pending');

    // Do NOT issue token — user must wait for admin approval
    res.status(201).json({
      pending: true,
      message: '帳號已建立，請等待管理者審核通過後即可登入',
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: '註冊失敗，請稍後再試' });
  }
});

/* ============================================================
   POST /api/auth/login
   ============================================================ */
router.post('/login', async (req: Request, res: Response) => {
  try {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';

    // Rate limit: 10 login attempts per IP per 15 minutes
    if (!checkAuthRate(ip, 'login', 10, 15 * 60_000)) {
      res.status(429).json({ error: '登入請求過於頻繁，請 15 分鐘後再試' });
      return;
    }

    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: '電子信箱和密碼為必填' });
      return;
    }

    // Check account lockout
    const lockout = checkLoginLockout(email.toLowerCase().trim());
    if (lockout.locked) {
      const mins = Math.ceil(lockout.remainingMs / 60_000);
      res.status(423).json({ error: `帳號已被暫時鎖定，請 ${mins} 分鐘後再試` });
      return;
    }

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim()) as User | undefined;
    if (!user) {
      recordLoginFailure(email.toLowerCase().trim());
      res.status(401).json({ error: '電子信箱或密碼錯誤' });
      return;
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      recordLoginFailure(email.toLowerCase().trim());
      res.status(401).json({ error: '電子信箱或密碼錯誤' });
      return;
    }

    // Check user status
    const status = user.status || 'active';
    if (status === 'pending') {
      clearLoginFailures(email.toLowerCase().trim());
      res.status(403).json({ error: '您的帳號尚在審核中，請等待管理者核准後再登入', code: 'PENDING' });
      return;
    }
    if (status === 'suspended') {
      clearLoginFailures(email.toLowerCase().trim());
      res.status(403).json({ error: '您的帳號已被停用，如有疑問請聯繫管理者', code: 'SUSPENDED' });
      return;
    }

    // Success — clear failure counter
    clearLoginFailures(email.toLowerCase().trim());

    const role = user.role || 'user';

    // Check usage limit for non-admin users
    if (role !== 'admin') {
      const usage = checkUserUsageLimit(user.id);
      if (usage.exceeded) {
        res.status(403).json({
          error: `您的帳號已超過用量上限（$${usage.cost.toFixed(2)} / $${usage.limit.toFixed(2)}），請聯繫管理者升級方案`,
          code: 'USAGE_EXCEEDED',
          cost: usage.cost,
          limit: usage.limit,
        });
        return;
      }
    }

    const token = jwt.sign({ userId: user.id, email: user.email, role }, config.jwtSecret, {
      expiresIn: config.jwtExpiresIn,
    });

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        role,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: '登入失敗，請稍後再試' });
  }
});

/* ============================================================
   GET /api/auth/me
   ============================================================ */
router.get('/me', authMiddleware, (req: Request, res: Response) => {
  const user = db.prepare(
    'SELECT id, email, display_name, role, status, created_at FROM users WHERE id = ?'
  ).get(req.user!.userId) as User | undefined;

  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  res.json({
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    role: user.role || 'user',
    status: user.status || 'active',
    createdAt: user.created_at,
  });
});

export default router;
