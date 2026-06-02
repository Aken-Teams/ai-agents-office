import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { OAuth2Client } from 'google-auth-library';
import { dbGet, dbRun, dbAll } from '../db.js';
import { config } from '../config.js';
import { authMiddleware } from '../middleware/auth.js';
import { checkUserUsageLimit } from '../services/usageLimit.js';
import { isEmailEnabled, sendVerificationCode, sendPasswordResetEmail } from '../services/email.js';
import type { User } from '../types.js';

const OAUTH_NO_PASSWORD = 'OAUTH_NO_PASSWORD';
const googleClient = config.googleClientId ? new OAuth2Client(config.googleClientId) : null;

const router = Router();

/* ============================================================
   Auth Rate Limiting (stricter than general API)
   ============================================================ */
const authAttempts = new Map<string, { count: number; resetTime: number }>();
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
   Login Lockout
   ============================================================ */
const loginFailures = new Map<string, { count: number; lockedUntil: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of loginFailures) {
    if (now > entry.lockedUntil && entry.count === 0) loginFailures.delete(key);
  }
}, 10 * 60_000);

const MAX_LOGIN_FAILURES = 5;
const LOCKOUT_DURATION_MS = 15 * 60_000;

function checkLoginLockout(email: string): { locked: boolean; remainingMs: number } {
  const entry = loginFailures.get(email);
  if (!entry) return { locked: false, remainingMs: 0 };
  const now = Date.now();
  if (entry.count >= MAX_LOGIN_FAILURES && now < entry.lockedUntil) {
    return { locked: true, remainingMs: entry.lockedUntil - now };
  }
  if (now >= entry.lockedUntil) loginFailures.delete(email);
  return { locked: false, remainingMs: 0 };
}

function recordLoginFailure(email: string): void {
  const entry = loginFailures.get(email) || { count: 0, lockedUntil: 0 };
  entry.count++;
  if (entry.count >= MAX_LOGIN_FAILURES) entry.lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
  loginFailures.set(email, entry);
}

function clearLoginFailures(email: string): void { loginFailures.delete(email); }

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isValidEmail(email: string): boolean { return EMAIL_REGEX.test(email) && email.length <= 255; }
function generateVerificationCode(): string { return String(Math.floor(100000 + Math.random() * 900000)); }

/* ============================================================
   GET /api/auth/invite-code-required
   Public endpoint — tells frontend whether invite code is needed
   ============================================================ */
router.get('/invite-code-required', (_req: Request, res: Response) => {
  res.json({ required: config.deployMode === 'pro-out' });
});

/* ============================================================
   POST /api/auth/register
   Step 1: Create user + send verification code (if email enabled)
   ============================================================ */
router.post('/register', async (req: Request, res: Response) => {
  try {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (!checkAuthRate(ip, 'reg', 5, 15 * 60_000)) {
      res.status(429).json({ error: '註冊請求過於頻繁，請 15 分鐘後再試' }); return;
    }

    const { email, password, displayName, inviteCode } = req.body;
    if (req.body.website || req.body.phone_number) {
      res.status(201).json({ pending: true, message: '帳號已建立，請等待管理者審核通過後即可登入' }); return;
    }

    if (!email || !password) { res.status(400).json({ error: '電子信箱和密碼為必填' }); return; }
    if (!isValidEmail(email)) { res.status(400).json({ error: '電子信箱格式不正確' }); return; }
    if (password.length < 8) { res.status(400).json({ error: '密碼至少需要 8 個字元' }); return; }
    if (password.length > 128) { res.status(400).json({ error: '密碼過長' }); return; }

    const trimmedName = (displayName || '').trim();
    if (trimmedName && trimmedName.length > 50) { res.status(400).json({ error: '顯示名稱最多 50 個字元' }); return; }

    // Invite code validation (pro-out mode only)
    let inviteCodeId: string | null = null;
    if (config.deployMode === 'pro-out') {
      if (!inviteCode || !inviteCode.trim()) {
        res.status(400).json({ error: '邀請碼為必填' }); return;
      }
      const codeRecord = await dbGet<{ id: string; is_active: number }>(
        'SELECT id, is_active FROM invite_codes WHERE code = ?', inviteCode.trim()
      );
      if (!codeRecord) {
        res.status(400).json({ error: '邀請碼無效' }); return;
      }
      if (!codeRecord.is_active) {
        res.status(400).json({ error: '此邀請碼已停用' }); return;
      }
      inviteCodeId = codeRecord.id;
    }

    const normalizedEmail = email.toLowerCase().trim();
    const existing = await dbGet('SELECT id, status FROM users WHERE email = ?', normalizedEmail);
    if (existing) { res.status(409).json({ error: '此電子信箱已被註冊' }); return; }

    const id = uuidv4();
    const passwordHash = await bcrypt.hash(password, config.bcryptRounds);

    // Increment invite code usage counter
    if (inviteCodeId) {
      await dbRun('UPDATE invite_codes SET used_count = used_count + 1 WHERE id = ?', inviteCodeId);
    }

    // If email service is available, send verification code
    if (isEmailEnabled()) {
      // Create user as 'pending_verification' (not yet active)
      await dbRun(
        'INSERT INTO users (id, email, password_hash, display_name, role, status, invite_code_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id, normalizedEmail, passwordHash, trimmedName || null, 'user', 'pending_verification', inviteCodeId
      );

      // Generate and send code
      const code = generateVerificationCode();
      const expiresAt = new Date(Date.now() + 10 * 60_000); // 10 min
      await dbRun(
        'DELETE FROM email_verification_codes WHERE email = ?', normalizedEmail
      );
      await dbRun(
        'INSERT INTO email_verification_codes (id, email, code, expires_at) VALUES (?, ?, ?, ?)',
        uuidv4(), normalizedEmail, code, expiresAt
      );

      const sent = await sendVerificationCode(normalizedEmail, code, 'zh-TW');
      if (sent) {
        res.status(201).json({ needsVerification: true, email: normalizedEmail });
      } else {
        // Email failed — fall back to admin approval
        await dbRun('UPDATE users SET status = ? WHERE id = ?', 'pending', id);
        await dbRun('DELETE FROM email_verification_codes WHERE email = ?', normalizedEmail);
        res.status(201).json({ pending: true, message: '帳號已建立，請等待管理者審核通過後即可登入' });
      }
    } else {
      // No email service — admin approval flow
      await dbRun(
        'INSERT INTO users (id, email, password_hash, display_name, role, status, invite_code_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id, normalizedEmail, passwordHash, trimmedName || null, 'user', 'pending', inviteCodeId
      );
      res.status(201).json({ pending: true, message: '帳號已建立，請等待管理者審核通過後即可登入' });
    }
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: '註冊失敗，請稍後再試' });
  }
});

/* ============================================================
   POST /api/auth/verify-email
   Step 2: Verify the 6-digit code and activate account
   ============================================================ */
router.post('/verify-email', async (req: Request, res: Response) => {
  try {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (!checkAuthRate(ip, 'verify', 10, 15 * 60_000)) {
      res.status(429).json({ error: '驗證請求過於頻繁，請稍後再試' }); return;
    }

    const { email, code } = req.body;
    if (!email || !code) { res.status(400).json({ error: '信箱和驗證碼為必填' }); return; }

    const normalizedEmail = email.toLowerCase().trim();
    const record = await dbGet<{ id: string; code: string; attempts: number; expires_at: Date }>(
      'SELECT id, code, attempts, expires_at FROM email_verification_codes WHERE email = ? ORDER BY created_at DESC LIMIT 1',
      normalizedEmail
    );

    if (!record) { res.status(400).json({ error: '找不到驗證碼，請重新註冊' }); return; }

    // Check expiry
    if (new Date(record.expires_at) < new Date()) {
      await dbRun('DELETE FROM email_verification_codes WHERE email = ?', normalizedEmail);
      res.status(400).json({ error: '驗證碼已過期，請重新發送', expired: true }); return;
    }

    // Check max attempts (5)
    if (record.attempts >= 5) {
      await dbRun('DELETE FROM email_verification_codes WHERE email = ?', normalizedEmail);
      res.status(400).json({ error: '驗證碼嘗試次數過多，請重新發送', expired: true }); return;
    }

    // Increment attempts
    await dbRun('UPDATE email_verification_codes SET attempts = attempts + 1 WHERE id = ?', record.id);

    if (record.code !== code.trim()) {
      res.status(400).json({ error: '驗證碼不正確' }); return;
    }

    // Code is correct — activate user
    const user = await dbGet<User>('SELECT * FROM users WHERE email = ?', normalizedEmail);
    if (!user) { res.status(400).json({ error: '找不到對應的帳號' }); return; }

    await dbRun('UPDATE users SET status = ?, updated_at = NOW() WHERE id = ?', 'active', user.id);
    await dbRun('DELETE FROM email_verification_codes WHERE email = ?', normalizedEmail);

    // Auto-login after verification
    const role = user.role || 'user';
    await dbRun('UPDATE users SET last_login_at = NOW() WHERE id = ?', user.id);
    const token = jwt.sign({ userId: user.id, email: user.email, role }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
    res.json({ token, user: { id: user.id, email: user.email, displayName: user.display_name, role } });
  } catch (error) {
    console.error('Email verification error:', error);
    res.status(500).json({ error: '驗證失敗，請稍後再試' });
  }
});

/* ============================================================
   POST /api/auth/resend-code
   Resend verification code for pending_verification users
   ============================================================ */
router.post('/resend-code', async (req: Request, res: Response) => {
  try {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (!checkAuthRate(ip, 'resend', 3, 5 * 60_000)) {
      res.status(429).json({ error: '發送過於頻繁，請稍後再試' }); return;
    }

    const { email } = req.body;
    if (!email) { res.status(400).json({ error: '信箱為必填' }); return; }

    const normalizedEmail = email.toLowerCase().trim();
    const user = await dbGet<{ id: string; status: string }>('SELECT id, status FROM users WHERE email = ?', normalizedEmail);
    if (!user || user.status !== 'pending_verification') {
      // Don't reveal whether the email exists
      res.json({ sent: true }); return;
    }

    if (!isEmailEnabled()) {
      res.status(400).json({ error: '郵件服務暫時不可用' }); return;
    }

    const code = generateVerificationCode();
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    await dbRun('DELETE FROM email_verification_codes WHERE email = ?', normalizedEmail);
    await dbRun(
      'INSERT INTO email_verification_codes (id, email, code, expires_at) VALUES (?, ?, ?, ?)',
      uuidv4(), normalizedEmail, code, expiresAt
    );

    await sendVerificationCode(normalizedEmail, code, 'zh-TW');
    res.json({ sent: true });
  } catch (error) {
    console.error('Resend code error:', error);
    res.status(500).json({ error: '發送失敗，請稍後再試' });
  }
});

/* ============================================================
   POST /api/auth/login
   ============================================================ */
router.post('/login', async (req: Request, res: Response) => {
  try {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (!checkAuthRate(ip, 'login', 10, 15 * 60_000)) {
      res.status(429).json({ error: '登入請求過於頻繁，請 15 分鐘後再試' }); return;
    }

    const { email, password } = req.body;
    if (!email || !password) { res.status(400).json({ error: '電子信箱和密碼為必填' }); return; }

    const lockout = checkLoginLockout(email.toLowerCase().trim());
    if (lockout.locked) {
      const mins = Math.ceil(lockout.remainingMs / 60_000);
      res.status(423).json({ error: `帳號已被暫時鎖定，請 ${mins} 分鐘後再試` }); return;
    }

    const user = await dbGet<User>('SELECT * FROM users WHERE email = ?', email.toLowerCase().trim());
    if (!user) { recordLoginFailure(email.toLowerCase().trim()); res.status(401).json({ error: '電子信箱或密碼錯誤' }); return; }

    if (user.password_hash === OAUTH_NO_PASSWORD) {
      clearLoginFailures(email.toLowerCase().trim());
      res.status(400).json({ error: '此帳號使用 Google 登入，請使用 Google 按鈕登入', code: 'OAUTH_ONLY' }); return;
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) { recordLoginFailure(email.toLowerCase().trim()); res.status(401).json({ error: '電子信箱或密碼錯誤' }); return; }

    const status = user.status || 'active';
    if (status === 'pending_verification') { clearLoginFailures(email.toLowerCase().trim()); res.status(403).json({ error: '您的帳號尚未完成 Email 驗證', code: 'PENDING_VERIFICATION', email: user.email }); return; }
    if (status === 'pending') { clearLoginFailures(email.toLowerCase().trim()); res.status(403).json({ error: '您的帳號尚在審核中，請等待管理者核准後再登入', code: 'PENDING' }); return; }
    if (status === 'suspended') { clearLoginFailures(email.toLowerCase().trim()); res.status(403).json({ error: '您的帳號已被停用，如有疑問請聯繫管理者', code: 'SUSPENDED' }); return; }

    clearLoginFailures(email.toLowerCase().trim());
    const role = user.role || 'user';

    if (role !== 'admin') {
      const usage = await checkUserUsageLimit(user.id);
      if (usage.exceeded) {
        res.status(403).json({ error: `您的帳號已超過用量上限（$${usage.cost.toFixed(2)} / $${usage.limit.toFixed(2)}），請聯繫管理者升級方案`, code: 'USAGE_EXCEEDED', cost: usage.cost, limit: usage.limit }); return;
      }
    }

    await dbRun('UPDATE users SET last_login_at = NOW() WHERE id = ?', user.id);
    const token = jwt.sign({ userId: user.id, email: user.email, role }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
    res.json({ token, user: { id: user.id, email: user.email, displayName: user.display_name, role } });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: '登入失敗，請稍後再試' });
  }
});

/* ============================================================
   POST /api/auth/demo-login
   One-click demo entry. No password — issues a JWT for the seeded
   `demo@theaken.com` user. Rate limited so a single IP can't spam
   the demo account.
   ============================================================ */
const DEMO_EMAIL = 'demo@theaken.com';
router.post('/demo-login', async (req: Request, res: Response) => {
  try {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (!checkAuthRate(ip, 'demo', 5, 60 * 60_000)) {
      res.status(429).json({ error: 'Demo 試用次數過多，請 1 小時後再試' });
      return;
    }

    const user = await dbGet<User>('SELECT * FROM users WHERE email = ?', DEMO_EMAIL);
    if (!user) {
      res.status(503).json({ error: 'Demo 帳號尚未啟用，請聯繫管理者' });
      return;
    }
    if ((user.status || 'active') !== 'active') {
      res.status(403).json({ error: 'Demo 帳號目前不可用' });
      return;
    }

    const role = user.role || 'user';
    if (role !== 'admin') {
      const usage = await checkUserUsageLimit(user.id);
      if (usage.exceeded) {
        res.status(403).json({ error: 'Demo 帳號今日用量已達上限，請稍後再試', code: 'USAGE_EXCEEDED' });
        return;
      }
    }

    await dbRun('UPDATE users SET last_login_at = NOW() WHERE id = ?', user.id);
    const token = jwt.sign({ userId: user.id, email: user.email, role }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
    res.json({ token, user: { id: user.id, email: user.email, displayName: user.display_name, role } });
  } catch (error) {
    console.error('Demo login error:', error);
    res.status(500).json({ error: '進入 Demo 失敗，請稍後再試' });
  }
});

/* ============================================================
   POST /api/auth/google
   ============================================================ */
router.post('/google', async (req: Request, res: Response) => {
  try {
    if (!googleClient || !config.googleClientId) { res.status(501).json({ error: 'Google OAuth is not configured' }); return; }

    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (!checkAuthRate(ip, 'google', 10, 15 * 60_000)) { res.status(429).json({ error: '請求過於頻繁，請稍後再試' }); return; }

    const { credential, access_token } = req.body;
    if (!credential && !access_token) { res.status(400).json({ error: 'Missing Google credential or access_token' }); return; }

    let email: string, name: string, googleId: string;

    if (credential) {
      const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: config.googleClientId });
      const payload = ticket.getPayload();
      if (!payload || !payload.email) { res.status(400).json({ error: 'Invalid Google token' }); return; }
      email = payload.email.toLowerCase().trim(); name = payload.name || ''; googleId = payload.sub;
    } else {
      const userinfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${access_token}` } });
      if (!userinfoRes.ok) { res.status(400).json({ error: 'Invalid Google access token' }); return; }
      const userinfo = await userinfoRes.json() as { email?: string; name?: string; sub?: string };
      if (!userinfo.email) { res.status(400).json({ error: 'Failed to get email from Google' }); return; }
      email = userinfo.email.toLowerCase().trim(); name = userinfo.name || ''; googleId = userinfo.sub || '';
    }

    let user = await dbGet<User>('SELECT * FROM users WHERE email = ?', email);

    if (user) {
      if (!user.oauth_provider) {
        await dbRun("UPDATE users SET oauth_provider = 'google', oauth_id = ?, updated_at = NOW() WHERE id = ?", googleId, user.id);
      }
      const status = user.status || 'active';
      if (status === 'pending_verification') {
        // Resend verification code for pending users
        if (isEmailEnabled()) {
          const code = generateVerificationCode();
          const expiresAt = new Date(Date.now() + 10 * 60_000);
          await dbRun('DELETE FROM email_verification_codes WHERE email = ?', email);
          await dbRun('INSERT INTO email_verification_codes (id, email, code, expires_at) VALUES (?, ?, ?, ?)', uuidv4(), email, code, expiresAt);
          await sendVerificationCode(email, code, 'zh-TW');
        }
        res.status(403).json({ error: '您的帳號尚未完成 Email 驗證', code: 'PENDING_VERIFICATION', needsVerification: true, email: user.email }); return;
      }
      if (status === 'pending') { res.status(403).json({ error: '您的帳號正在等待管理者審核', code: 'PENDING' }); return; }
      if (status === 'suspended') { res.status(403).json({ error: '您的帳號已被停用，如有疑問請聯繫管理者', code: 'SUSPENDED' }); return; }
    } else {
      // New Google user — same verification flow as email registration
      const id = uuidv4();
      if (isEmailEnabled()) {
        await dbRun(
          "INSERT INTO users (id, email, password_hash, display_name, role, status, oauth_provider, oauth_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          id, email, OAUTH_NO_PASSWORD, name || null, 'user', 'pending_verification', 'google', googleId
        );
        const code = generateVerificationCode();
        const expiresAt = new Date(Date.now() + 10 * 60_000);
        await dbRun('INSERT INTO email_verification_codes (id, email, code, expires_at) VALUES (?, ?, ?, ?)', uuidv4(), email, code, expiresAt);
        await sendVerificationCode(email, code, 'zh-TW');
        res.status(403).json({ needsVerification: true, email, code: 'PENDING_VERIFICATION' }); return;
      } else {
        // No email service — fallback to admin approval
        await dbRun(
          "INSERT INTO users (id, email, password_hash, display_name, role, status, oauth_provider, oauth_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          id, email, OAUTH_NO_PASSWORD, name || null, 'user', 'pending', 'google', googleId
        );
        res.status(403).json({ error: '帳號已建立，請等待管理者審核後即可登入', code: 'PENDING' }); return;
      }
    }

    const role = user.role || 'user';
    if (role !== 'admin') {
      const usage = await checkUserUsageLimit(user.id);
      if (usage.exceeded) {
        res.status(403).json({ error: `您的帳號已超過用量上限（$${usage.cost.toFixed(2)} / $${usage.limit.toFixed(2)}），請聯繫管理者升級方案`, code: 'USAGE_EXCEEDED' }); return;
      }
    }

    await dbRun('UPDATE users SET last_login_at = NOW() WHERE id = ?', user.id);
    const token = jwt.sign({ userId: user.id, email: user.email, role }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
    res.json({ token, user: { id: user.id, email: user.email, displayName: user.display_name, role } });
  } catch (error) {
    console.error('Google OAuth error:', error);
    res.status(401).json({ error: 'Google 登入驗證失敗' });
  }
});

/* ============================================================
   GET /api/auth/me
   ============================================================ */
router.get('/me', authMiddleware, async (req: Request, res: Response) => {
  const user = await dbGet<User>(
    'SELECT id, email, password_hash, display_name, role, status, locale, theme, oauth_provider, company, onboarding_completed, created_at FROM users WHERE id = ?',
    req.user!.userId
  );
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }

  res.json({
    id: user.id, email: user.email, displayName: user.display_name,
    role: user.role || 'user', status: user.status || 'active',
    locale: user.locale || 'zh-TW', theme: user.theme || 'light',
    oauthProvider: user.oauth_provider || null,
    hasPassword: user.password_hash !== OAUTH_NO_PASSWORD,
    createdAt: user.created_at,
    company: user.company || null,
    // LINE-provisioned accounts always need onboarding regardless of deploy
    // mode — their email is a placeholder (`line:<id>@bot.local`) and the
    // display name was copied straight from LINE.
    onboardingRequired:
      !user.onboarding_completed && (
        config.deployMode === 'pro-out'
        || (typeof user.email === 'string' && user.email.startsWith('line:'))
      ),
  });
});

/* ============================================================
   POST /api/auth/onboarding
   ============================================================ */
router.post('/onboarding', authMiddleware, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const rawDisplayName = typeof req.body?.displayName === 'string' ? req.body.displayName.trim() : '';
  const rawEmail = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
  const rawCompany = typeof req.body?.company === 'string' ? req.body.company.trim() : '';

  // Validation — fail fast with the *specific* field name so the client can
  // surface inline errors instead of a generic toast.
  if (!rawDisplayName) { res.status(400).json({ error: 'displayName required', field: 'displayName' }); return; }
  if (rawDisplayName.length > 50) { res.status(400).json({ error: 'displayName too long (max 50)', field: 'displayName' }); return; }

  if (!rawEmail) { res.status(400).json({ error: 'email required', field: 'email' }); return; }
  // Loose RFC-ish check — covers everything the bcrypt/lowercase-normalised
  // login flow can later verify.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail) || rawEmail.length > 255) {
    res.status(400).json({ error: 'invalid email', field: 'email' }); return;
  }

  if (!rawCompany) { res.status(400).json({ error: 'company required', field: 'company' }); return; }
  if (rawCompany.length > 100) { res.status(400).json({ error: 'company too long (max 100)', field: 'company' }); return; }

  const normalizedEmail = rawEmail.toLowerCase();

  // Uniqueness — block if another user already owns this email. LINE users
  // who try to claim an email already used by their web account end up here;
  // the right move is to surface the conflict so they know to log in via the
  // existing path instead.
  const conflict = await dbGet<{ id: string }>(
    'SELECT id FROM users WHERE email = ? AND id != ?',
    normalizedEmail, userId,
  );
  if (conflict) {
    res.status(409).json({ error: 'email already in use', field: 'email' });
    return;
  }

  await dbRun(
    `UPDATE users
       SET display_name = ?, email = ?, company = ?,
           onboarding_completed = 1, updated_at = NOW()
     WHERE id = ?`,
    rawDisplayName, normalizedEmail, rawCompany, userId,
  );
  res.json({ success: true });
});

/* ============================================================
   PATCH /api/auth/preferences
   ============================================================ */
router.patch('/preferences', authMiddleware, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { locale, theme } = req.body;

  if (locale && !['zh-TW', 'zh-CN', 'en'].includes(locale)) { res.status(400).json({ error: 'Invalid locale' }); return; }
  if (theme && !['dark', 'light'].includes(theme)) { res.status(400).json({ error: 'Invalid theme' }); return; }

  if (locale) await dbRun("UPDATE users SET locale = ?, updated_at = NOW() WHERE id = ?", locale, userId);
  if (theme) await dbRun("UPDATE users SET theme = ?, updated_at = NOW() WHERE id = ?", theme, userId);

  const updated = await dbGet<{ locale: string; theme: string }>('SELECT locale, theme FROM users WHERE id = ?', userId);
  res.json({ locale: updated?.locale, theme: updated?.theme });
});

/* ============================================================
   PATCH /api/auth/profile
   ============================================================ */
router.patch('/profile', authMiddleware, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { displayName } = req.body;
  if (typeof displayName !== 'string') { res.status(400).json({ error: 'displayName is required' }); return; }
  const trimmed = displayName.trim();
  if (trimmed.length > 50) { res.status(400).json({ error: 'Display name must be at most 50 characters' }); return; }

  await dbRun("UPDATE users SET display_name = ?, updated_at = NOW() WHERE id = ?", trimmed || null, userId);
  res.json({ success: true, displayName: trimmed || null });
});

/* ============================================================
   PATCH /api/auth/password
   ============================================================ */
router.patch('/password', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { currentPassword, newPassword } = req.body;

    if (!newPassword) { res.status(400).json({ error: 'newPassword is required' }); return; }
    if (newPassword.length < 8) { res.status(400).json({ error: 'New password must be at least 8 characters' }); return; }
    if (newPassword.length > 128) { res.status(400).json({ error: 'New password is too long' }); return; }

    const user = await dbGet<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', userId);
    if (!user) { res.status(404).json({ error: 'User not found' }); return; }

    const isOAuthOnly = user.password_hash === OAUTH_NO_PASSWORD;
    if (!isOAuthOnly) {
      if (!currentPassword) { res.status(400).json({ error: 'currentPassword is required' }); return; }
      const valid = await bcrypt.compare(currentPassword, user.password_hash);
      if (!valid) { res.status(401).json({ error: 'Current password is incorrect' }); return; }
    }

    const newHash = await bcrypt.hash(newPassword, config.bcryptRounds);
    await dbRun("UPDATE users SET password_hash = ?, updated_at = NOW() WHERE id = ?", newHash, userId);
    res.json({ success: true });
  } catch (error) {
    console.error('Password change error:', error);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

/* ============================================================
   POST /api/auth/forgot-password
   Send a password reset email
   ============================================================ */
router.post('/forgot-password', async (req: Request, res: Response) => {
  try {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (!checkAuthRate(ip, 'forgot', 3, 15 * 60_000)) {
      res.status(429).json({ error: '請求過於頻繁，請稍後再試' }); return;
    }

    const { email } = req.body;
    if (!email) { res.status(400).json({ error: '請輸入電子信箱' }); return; }

    // Always respond with success to prevent email enumeration
    const normalizedEmail = email.toLowerCase().trim();
    const user = await dbGet<{ id: string; status: string; locale: string; password_hash: string }>('SELECT id, status, locale, password_hash FROM users WHERE email = ?', normalizedEmail);

    if (user && user.password_hash !== OAUTH_NO_PASSWORD && isEmailEnabled()) {
      // Generate token
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 30 * 60_000); // 30 min

      // Clean up old tokens for this user
      await dbRun('DELETE FROM password_reset_tokens WHERE user_id = ?', user.id);
      await dbRun(
        'INSERT INTO password_reset_tokens (id, user_id, token, expires_at) VALUES (?, ?, ?, ?)',
        uuidv4(), user.id, token, expiresAt
      );

      // Build reset URL (use Origin header or fallback)
      const origin = req.headers.origin || `http://localhost:${config.port - 1}`;
      const resetUrl = `${origin}/reset-password?token=${token}`;

      await sendPasswordResetEmail(normalizedEmail, resetUrl, user.locale || 'zh-TW');
    }

    res.json({ sent: true });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: '操作失敗，請稍後再試' });
  }
});

/* ============================================================
   POST /api/auth/reset-password
   Reset password using token
   ============================================================ */
router.post('/reset-password', async (req: Request, res: Response) => {
  try {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (!checkAuthRate(ip, 'reset', 5, 15 * 60_000)) {
      res.status(429).json({ error: '請求過於頻繁，請稍後再試' }); return;
    }

    const { token, newPassword } = req.body;
    if (!token || !newPassword) { res.status(400).json({ error: '缺少必填欄位' }); return; }
    if (newPassword.length < 8) { res.status(400).json({ error: '密碼至少需要 8 個字元' }); return; }
    if (newPassword.length > 128) { res.status(400).json({ error: '密碼過長' }); return; }

    const record = await dbGet<{ id: string; user_id: string; used: number; expires_at: Date }>(
      'SELECT id, user_id, used, expires_at FROM password_reset_tokens WHERE token = ?',
      token
    );

    if (!record) { res.status(400).json({ error: '無效的重設連結' }); return; }
    if (record.used) { res.status(400).json({ error: '此重設連結已被使用' }); return; }
    if (new Date(record.expires_at) < new Date()) {
      res.status(400).json({ error: '重設連結已過期，請重新申請' }); return;
    }

    const newHash = await bcrypt.hash(newPassword, config.bcryptRounds);
    await dbRun('UPDATE users SET password_hash = ?, updated_at = NOW() WHERE id = ?', newHash, record.user_id);
    await dbRun('UPDATE password_reset_tokens SET used = 1 WHERE id = ?', record.id);

    res.json({ success: true });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: '重設密碼失敗，請稍後再試' });
  }
});

/* ============================================================
   GET /api/auth/memories
   List current user's AI memories
   ============================================================ */
router.get('/memories', authMiddleware, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const memories = await dbAll(
    'SELECT id, content, category, memory_type, source_conversation_id, created_at FROM user_memories WHERE user_id = ? ORDER BY created_at DESC',
    userId
  );
  res.json(memories);
});

/* ============================================================
   DELETE /api/auth/memories/:id
   Delete a specific memory (ownership check)
   ============================================================ */
router.delete('/memories/:id', authMiddleware, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const memoryId = req.params.id;

  const memory = await dbGet('SELECT id FROM user_memories WHERE id = ? AND user_id = ?', memoryId, userId);
  if (!memory) { res.status(404).json({ error: 'Memory not found' }); return; }

  await dbRun('DELETE FROM user_memories WHERE id = ?', memoryId);
  res.json({ success: true });
});

/* ============================================================
   DELETE /api/auth/memories
   Clear ALL memories for current user
   ============================================================ */
router.delete('/memories', authMiddleware, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  await dbRun('DELETE FROM user_memories WHERE user_id = ?', userId);
  res.json({ success: true });
});

/**
 * GET /api/auth/line-qr
 * Public — no auth. Mints a single-use invite code, builds the LINE deep
 * link, returns the QR as a base64 data URL. Rate-limited to 5/min per IP.
 *
 * Front-end shows the QR on the login & register pages; the user opens
 * LINE, scans it, taps Send on the pre-filled `/link <code>` message, the
 * bot binds them and pushes a magic-link URL. They tap that URL and land
 * back in /auto-login → /dashboard.
 */
router.get('/line-qr', async (req: Request, res: Response) => {
  const { mintQrCode, checkQrRateLimit } = await import('../services/line/qrAuth.js');

  if (!config.line.enabled || !config.line.botBasicId) {
    res.status(404).json({ error: 'LINE login not available' });
    return;
  }

  // Express's req.ip uses the configured trust-proxy setting; behind
  // Cloudflare we just take the X-Forwarded-For first hop as a best effort.
  const ip = (req.headers['x-forwarded-for']?.toString().split(',')[0].trim()) || req.ip || 'unknown';
  if (!checkQrRateLimit(ip)) {
    res.status(429).json({ error: 'Too many requests, please wait a minute and try again.' });
    return;
  }

  try {
    const result = await mintQrCode('LINE QR 註冊');
    res.json(result);
  } catch (err) {
    console.error('[Auth] line-qr mint failed:', err);
    res.status(500).json({ error: 'QR generation failed' });
  }
});

/**
 * POST /api/auth/line-magic
 * Exchanges a single-use, 5-minute LINE magic-link token for a regular
 * 7-day session token. The magic token is minted in services/line/commands.ts
 * `handleWebLink()` when a LINE user taps the rich-menu "open web" tile.
 *
 * The magic token has audience='line-magic-link' so it cannot be used as a
 * normal session token by the auth middleware (which doesn't pass an
 * audience matcher).
 */
router.post('/line-magic', async (req: Request, res: Response) => {
  const raw = typeof req.body?.token === 'string' ? req.body.token : '';
  if (!raw) { res.status(400).json({ error: 'token required' }); return; }

  let payload: { userId: string; email: string; role: string; magic?: boolean };
  try {
    payload = jwt.verify(raw, config.jwtSecret, { audience: 'line-magic-link' }) as typeof payload;
  } catch {
    res.status(401).json({ error: 'Invalid or expired link' });
    return;
  }
  if (!payload.magic) { res.status(401).json({ error: 'Not a magic-link token' }); return; }

  const user = await dbGet<{ id: string; email: string; role: string; status: string; display_name: string | null }>(
    'SELECT id, email, role, status, display_name FROM users WHERE id = ?',
    payload.userId,
  );
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }
  if (user.status !== 'active') { res.status(403).json({ error: 'Account inactive' }); return; }

  const session = jwt.sign(
    { userId: user.id, email: user.email, role: user.role },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn },
  );
  res.json({
    token: session,
    user: { id: user.id, email: user.email, role: user.role, displayName: user.display_name },
  });
});

/**
 * POST /api/auth/liff-login
 *
 * Exchange a LIFF ID token (obtained client-side via `liff.getIDToken()`)
 * for a normal 7-day session JWT.
 *
 * Verification: we POST the ID token to LINE's `/oauth2/v2.1/verify` endpoint
 * with the LINE Login channel ID as `client_id`. LINE rejects forged or
 * expired tokens, so we don't need to fetch JWKs ourselves. The verified
 * `sub` claim is the user's stable LINE userId — we look that up in the
 * `line_users` mapping table to find the corresponding internal account.
 *
 * If the LINE user hasn't completed `/link <inviteCode>` yet, this returns
 * 404 with `error: 'unlinked'` so the client can show binding instructions
 * instead of a generic login failure.
 *
 * The LINE Login channel ID is the prefix of LINE_LIFF_ID (format
 * `{channelId}-{liffAppId}`). Override via LINE_LOGIN_CHANNEL_ID if you need
 * to point this at a separate channel.
 */
router.post('/liff-login', async (req: Request, res: Response) => {
  const idToken = typeof req.body?.idToken === 'string' ? req.body.idToken.trim() : '';
  if (!idToken) { res.status(400).json({ error: 'idToken required' }); return; }

  const channelId =
    process.env.LINE_LOGIN_CHANNEL_ID
    || (config.line.liffId ? config.line.liffId.split('-')[0] : '');
  if (!channelId) {
    res.status(503).json({ error: 'LIFF not configured' });
    return;
  }

  let verified: { sub?: string; aud?: string; iss?: string; exp?: number };
  try {
    const verifyRes = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: idToken, client_id: channelId }),
    });
    if (!verifyRes.ok) {
      res.status(401).json({ error: 'invalid_id_token' });
      return;
    }
    verified = (await verifyRes.json()) as typeof verified;
  } catch (err) {
    console.error('[liff-login] LINE verify call failed:', err);
    res.status(502).json({ error: 'verify_failed' });
    return;
  }

  const lineUserId = verified.sub || '';
  if (!lineUserId) {
    res.status(401).json({ error: 'invalid_id_token' });
    return;
  }

  const mapping = await dbGet<{ internal_user_id: string }>(
    'SELECT internal_user_id FROM line_users WHERE line_user_id = ?',
    lineUserId,
  );
  if (!mapping) {
    res.status(404).json({ error: 'unlinked' });
    return;
  }

  const user = await dbGet<{ id: string; email: string; role: string; status: string; display_name: string | null }>(
    'SELECT id, email, role, status, display_name FROM users WHERE id = ?',
    mapping.internal_user_id,
  );
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }
  if (user.status !== 'active') { res.status(403).json({ error: 'Account inactive' }); return; }

  const session = jwt.sign(
    { userId: user.id, email: user.email, role: user.role },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn },
  );
  res.json({
    token: session,
    user: { id: user.id, email: user.email, role: user.role, displayName: user.display_name },
  });
});

export default router;
