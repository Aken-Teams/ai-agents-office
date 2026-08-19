import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { OAuth2Client } from 'google-auth-library';
import { dbGet, dbRun, dbAll } from '../db.js';
import { config } from '../config.js';
import { authMiddleware } from '../middleware/auth.js';
import { checkUserUsageLimit, getUserUsageLimitUsd, getStorageQuotaGb, getUploadQuotaMb } from '../services/usageLimit.js';
import { getRolePermissions } from '../services/rolePermissions.js';
import { isEmailEnabled, sendVerificationCode, sendPasswordResetEmail } from '../services/email.js';
import type { User } from '../types.js';

const OAUTH_NO_PASSWORD = 'OAUTH_NO_PASSWORD';
const googleClient = config.googleClientId ? new OAuth2Client(config.googleClientId) : null;

const router = Router();

/* ============================================================
   Demo guest login (pro-out only)
   One-time, 36h, $30 quota. No password — the user just types a name. Every
   demo account is grouped under one "訪客 Demo" quota group so they can be found
   and deleted as a group (manual cleanup). The JWT expires in 36h and there's no
   password, so the account can't be used after that. Skips onboarding/terms so
   the guest lands straight on the home page.
   ============================================================ */
const DEMO_GROUP_NAME = '訪客 Demo';
const DEMO_QUOTA_USD = 30;

async function getOrCreateDemoGroup(): Promise<string> {
  const existing = await dbGet<{ id: string }>('SELECT id FROM quota_groups WHERE name = ?', DEMO_GROUP_NAME);
  if (existing) return existing.id;
  const id = uuidv4();
  await dbRun(
    'INSERT INTO quota_groups (id, name, limit_usd, description) VALUES (?, ?, ?, ?)',
    id, DEMO_GROUP_NAME, DEMO_QUOTA_USD, '訪客一次性測試帳號（建立後 36 小時、可整組手動刪除）',
  );
  return id;
}

/**
 * GET /api/auth/mode — which sign-in methods this deployment offers. Public.
 *
 * The web client reads this from NEXT_PUBLIC_DEPLOY_MODE at build time, but the
 * Excel add-in is served from its own host and has to ask at runtime — otherwise
 * it shows a PANJIT employee an email/password form that pro-panjit will reject
 * with a bare "帳號或密碼錯誤". Exposes nothing sensitive: which login form to
 * draw, and where the web app lives for first-time AD setup.
 */
router.get('/mode', (_req: Request, res: Response) => {
  res.json({
    deployMode: config.deployMode,
    adLogin: config.deployMode === 'pro-panjit',
    // Always offered, but pro-panjit restricts it to the whitelist — so the
    // add-in shows it as the secondary tab rather than the default.
    emailLogin: true,
    webUrl: config.publicWebUrl,
  });
});

router.post('/demo', async (req: Request, res: Response) => {
  if (config.deployMode !== 'pro-out') { res.status(403).json({ error: '此功能未開放' }); return; }
  const rawName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!rawName) { res.status(400).json({ error: '請輸入名字' }); return; }
  const name = rawName.slice(0, 50);

  // Login-or-create by name: if a non-expired demo account with the same name
  // exists, log back into it (this is how a returning guest "logs in"). The
  // token only lasts until the account's ORIGINAL expiry, so re-entering the
  // name can't extend the 36h window.
  const existing = await dbGet<{ id: string; email: string; demo_expires_at: string }>(
    "SELECT id, email, demo_expires_at FROM users WHERE is_demo = 1 AND display_name = ? AND demo_expires_at > NOW() ORDER BY created_at DESC LIMIT 1",
    name,
  );
  if (existing) {
    const remainingSec = Math.max(60, Math.floor((new Date(existing.demo_expires_at).getTime() - Date.now()) / 1000));
    const token = jwt.sign({ userId: existing.id, email: existing.email, role: 'user' }, config.jwtSecret, { expiresIn: remainingSec });
    res.json({ token, user: { id: existing.id, email: existing.email, displayName: name, role: 'user' } });
    return;
  }

  const groupId = await getOrCreateDemoGroup();
  const id = uuidv4();
  const email = `demo-${id.slice(0, 8)}@demo.local`;
  // Random, unusable password — demo accounts only authenticate via this route.
  const hash = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 12);

  await dbRun(
    `INSERT INTO users
       (id, email, password_hash, display_name, role, status, locale, company,
        quota_group_id, is_demo, demo_expires_at, onboarding_completed, terms_accepted_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'user', 'active', 'zh-TW', '訪客 Demo', ?, 1, DATE_ADD(NOW(), INTERVAL 36 HOUR), 1, NOW(), NOW(), NOW())`,
    id, email, hash, name, groupId,
  );

  // 36h token — after it expires the demo account can no longer be used.
  const token = jwt.sign({ userId: id, email, role: 'user' }, config.jwtSecret, { expiresIn: '36h' });
  res.json({ token, user: { id, email, displayName: name, role: 'user' } });
});

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
    // Prune any entry whose rolling window has elapsed (works for both
    // in-progress counters and expired lockouts), keeping the map bounded.
    if (now > entry.lockedUntil) loginFailures.delete(key);
  }
}, 10 * 60_000);

const MAX_LOGIN_FAILURES = 5;
const LOCKOUT_DURATION_MS = 15 * 60_000;

function checkLoginLockout(email: string): { locked: boolean; remainingMs: number } {
  const entry = loginFailures.get(email);
  if (!entry) return { locked: false, remainingMs: 0 };
  const now = Date.now();
  // Window elapsed → reset the counter (also clears any expired lockout).
  if (now >= entry.lockedUntil) { loginFailures.delete(email); return { locked: false, remainingMs: 0 }; }
  // Within the window and at/over the threshold → locked.
  if (entry.count >= MAX_LOGIN_FAILURES) return { locked: true, remainingMs: entry.lockedUntil - now };
  // Within the window but under threshold → keep counting (must NOT delete here,
  // otherwise the counter resets every attempt and lockout never engages).
  return { locked: false, remainingMs: 0 };
}

function recordLoginFailure(email: string): void {
  const entry = loginFailures.get(email) || { count: 0, lockedUntil: 0 };
  entry.count++;
  // Stamp/extend a rolling window on every failure so counts persist between
  // attempts, expire after inactivity, and trip the lockout once at threshold.
  entry.lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
  loginFailures.set(email, entry);
}

function clearLoginFailures(email: string): void { loginFailures.delete(email); }

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isValidEmail(email: string): boolean { return EMAIL_REGEX.test(email) && email.length <= 255; }
// Cryptographically-secure 6-digit code (crypto.randomInt, not Math.random).
function generateVerificationCode(): string { return String(crypto.randomInt(100000, 1000000)); }

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

    const { email, password } = req.body;
    if (!email || !password) { res.status(400).json({ error: '電子信箱和密碼為必填' }); return; }

    // Rate-limit per ACCOUNT (＋source IP), NOT per IP alone — otherwise many users
    // behind one shared/NAT IP (e.g. a whole office) share a single counter and one
    // person's logins lock out everyone. Per-account brute force is still covered by
    // checkLoginLockout below.
    const acct = email.toLowerCase().trim();
    if (!checkAuthRate(`${ip}:${acct}`, 'login', 10, 15 * 60_000)) {
      res.status(429).json({ error: '此帳號登入請求過於頻繁，請 15 分鐘後再試' }); return;
    }

    const lockout = checkLoginLockout(acct);
    if (lockout.locked) {
      const mins = Math.ceil(lockout.remainingMs / 60_000);
      res.status(423).json({ error: `帳號已被暫時鎖定，請 ${mins} 分鐘後再試` }); return;
    }

    // Accept EITHER a full email OR a bare account (no @). A bare account resolves to
    // the matching email by its local-part — so a student can log in with just
    // "pe115001" instead of "pe115001@houe6.tw". SUBSTRING_INDEX matches the exact
    // local-part (no LIKE wildcards → no wildcard-injection).
    let user = await dbGet<User>('SELECT * FROM users WHERE email = ?', acct);
    if (!user && !acct.includes('@')) {
      user = await dbGet<User>(
        'SELECT * FROM users WHERE SUBSTRING_INDEX(email, "@", 1) = ? ORDER BY created_at ASC LIMIT 1', acct,
      );
    }
    if (!user) { recordLoginFailure(acct); res.status(401).json({ error: '帳號或密碼錯誤' }); return; }

    if (user.password_hash === OAUTH_NO_PASSWORD) {
      clearLoginFailures(email.toLowerCase().trim());
      res.status(400).json({ error: '此帳號使用 Google 登入，請使用 Google 按鈕登入', code: 'OAUTH_ONLY' }); return;
    }

    // pro-panjit mode: only whitelisted emails can use email/password login
    if (config.deployMode === 'pro-panjit' && !config.emailLoginWhitelist.includes(email.toLowerCase().trim())) {
      res.status(403).json({ error: '此帳號需使用 AD 工號登入', code: 'AD_LOGIN_REQUIRED' }); return;
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

    // pro-panjit mode: only whitelisted emails can use Google login
    if (config.deployMode === 'pro-panjit' && !config.emailLoginWhitelist.includes(email)) {
      res.status(403).json({ error: '此 Google 帳號未獲授權登入，請聯繫管理者', code: 'GOOGLE_NOT_WHITELISTED' });
      return;
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
    'SELECT id, email, password_hash, display_name, role, status, locale, theme, oauth_provider, company, onboarding_completed, terms_accepted_at, is_demo, demo_expires_at, created_at FROM users WHERE id = ?',
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
    isDemo: !!(user as any).is_demo,
    demoExpiresAt: (user as any).demo_expires_at || null,
    onboardingRequired: !user.onboarding_completed && config.deployMode === 'pro-out',
    termsRequired: !(user as any).terms_accepted_at && config.deployMode === 'pro-panjit',
  });
});

/* ============================================================
   GET /api/auth/permissions — get effective permissions for current user
   ============================================================ */
router.get('/permissions', authMiddleware, async (req: Request, res: Response) => {
  const user = await dbGet<{ role: string }>('SELECT role FROM users WHERE id = ?', req.user!.userId);
  const role = user?.role || 'user';

  // Admin gets full access
  if (role === 'admin') {
    res.json({ adminSidebar: ['*'], adminSidebarOperate: ['*'], frontendNav: ['*'], features: ['*'] });
    return;
  }

  const perms = await getRolePermissions();

  if (role === 'readonly') {
    res.json({
      adminSidebar: perms.adminSidebar.readonly || [],
      adminSidebarOperate: perms.adminSidebar.readonlyOperate || [],
      frontendNav: perms.frontendNav.readonly || [],
      features: perms.features.readonly || [],
    });
    return;
  }

  // Regular user
  res.json({
    adminSidebar: [],
    adminSidebarOperate: [],
    frontendNav: perms.frontendNav.user || [],
    features: perms.features.user || [],
  });
});

/* ============================================================
   GET /api/auth/terms — get TOS content with placeholders resolved
   ============================================================ */
router.get('/terms', authMiddleware, async (_req: Request, res: Response) => {
  const tosRow = await dbGet<{ value: string }>("SELECT value FROM system_settings WHERE `key` = 'tos_content'");
  if (!tosRow) { res.status(404).json({ error: 'TOS not configured' }); return; }

  const usageLimitUsd = await getUserUsageLimitUsd();
  const storageQuotaGb = await getStorageQuotaGb();
  const uploadQuotaMb = await getUploadQuotaMb();

  let content = tosRow.value;
  content = content.replace(/\{\{usage_limit_usd\}\}/g, String(usageLimitUsd));
  content = content.replace(/\{\{storage_quota_gb\}\}/g, String(storageQuotaGb));
  content = content.replace(/\{\{upload_quota_mb\}\}/g, String(uploadQuotaMb));

  const versionRow = await dbGet<{ value: string }>("SELECT value FROM system_settings WHERE `key` = 'tos_version'");
  res.json({ content, version: versionRow?.value || '1' });
});

/* ============================================================
   POST /api/auth/accept-terms — mark TOS as accepted
   ============================================================ */
router.post('/accept-terms', authMiddleware, async (req: Request, res: Response) => {
  await dbRun('UPDATE users SET terms_accepted_at = NOW(), updated_at = NOW() WHERE id = ?', req.user!.userId);
  res.json({ success: true });
});

/* ============================================================
   POST /api/auth/onboarding
   ============================================================ */
router.post('/onboarding', authMiddleware, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { company } = req.body;

  if (!company || typeof company !== 'string' || company.trim().length === 0) {
    res.status(400).json({ error: 'Company name is required' });
    return;
  }
  if (company.trim().length > 100) {
    res.status(400).json({ error: 'Company name must be 100 characters or less' });
    return;
  }

  await dbRun(
    'UPDATE users SET company = ?, onboarding_completed = 1, updated_at = NOW() WHERE id = ?',
    company.trim(), userId
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

/* ============================================================
   AD Login Routes (pro-panjit only)
   ============================================================ */

interface AdUser {
  username: string;
  displayName: string;
  mail: string | null;
  department: string | null;
  telephoneNumber: string | null;
  domain: string;
}

async function callAdAuth(username: string, password: string, domain?: string): Promise<AdUser | null> {
  try {
    const body: Record<string, string> = { username, password };
    if (domain) body.domain = domain;
    const res = await fetch(`${config.adApiUrl}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { success?: boolean; user?: AdUser };
    if (!data.success || !data.user) return null;
    return data.user;
  } catch {
    return null;
  }
}

async function fetchAdUserDetail(username: string, domain: string): Promise<Partial<AdUser>> {
  if (!config.adApiKey) return {};
  try {
    const res = await fetch(`${config.adApiUrl}/users/${encodeURIComponent(username)}?domain=${encodeURIComponent(domain)}`, {
      headers: { 'X-API-Key': config.adApiKey },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return {};
    // Gateway nests the record under `user` ({success, message, user:{mail,...}});
    // tolerate a flat shape too. Reading the top level returns undefined mail,
    // which falls back to a synthetic *.panjit.local email — the bug behind
    // accounts like 90001@panjit.panjit.local.
    const data = await res.json() as { user?: Partial<AdUser> } & Partial<AdUser>;
    return data.user ?? data;
  } catch {
    return {};
  }
}

/* POST /api/auth/ad/login */
router.post('/ad/login', async (req: Request, res: Response) => {
  try {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';

    const { username, password, domain } = req.body;
    if (!username || !password) {
      res.status(400).json({ error: '工號和密碼為必填' }); return;
    }

    // Rate-limit per AD account (＋source IP), NOT per IP alone — the whole company
    // shares one corporate/NAT IP, so an IP-only limit lets one person's logins
    // lock out everyone. Per-account keeps each employee's throttle independent.
    const adKey = `${ip}:${String(username).trim().toLowerCase()}:${String(domain || '').trim().toLowerCase()}`;
    if (!checkAuthRate(adKey, 'adlogin', 10, 15 * 60_000)) {
      res.status(429).json({ error: '此帳號登入請求過於頻繁，請 15 分鐘後再試' }); return;
    }

    // Call AD API
    const adUser = await callAdAuth(username.trim(), password, domain?.trim() || undefined);
    if (!adUser) {
      res.status(401).json({ error: '工號或密碼錯誤，請確認後重試' }); return;
    }

    const adUsername = adUser.username || username.trim();
    const adDomain = adUser.domain || domain?.trim() || 'PANJIT';

    // Try to fetch detailed info (for mail) if not already returned
    let mail = adUser.mail || null;
    if (!mail && config.adApiKey) {
      const detail = await fetchAdUserDetail(adUsername, adDomain);
      mail = detail.mail || null;
    }

    const fullAdUser: AdUser = { ...adUser, username: adUsername, domain: adDomain, mail };

    // Check if user already exists in DB
    const existing = await dbGet<{ id: string; role: string; status: string; display_name: string | null }>(
      'SELECT id, role, status, display_name FROM users WHERE ad_username = ? AND ad_domain = ?',
      adUsername, adDomain
    );

    if (existing) {
      // Returning AD user
      const status = existing.status || 'active';
      if (status === 'suspended') {
        res.status(403).json({ error: '您的帳號已被停用，如有疑問請聯繫管理者', code: 'SUSPENDED' }); return;
      }
      // Update display name from AD if changed
      if (fullAdUser.displayName && fullAdUser.displayName !== existing.display_name) {
        await dbRun('UPDATE users SET display_name = ?, updated_at = NOW() WHERE id = ?', fullAdUser.displayName, existing.id);
      }
      await dbRun('UPDATE users SET last_login_at = NOW() WHERE id = ?', existing.id);
      // Cache Outlook mail_token for email reading (fire-and-forget)
      console.log('[Outlook] AD login check — deployMode:', config.deployMode, 'adApiKey:', config.adApiKey ? 'SET' : 'EMPTY');
      if (config.deployMode === 'pro-panjit' && config.adApiKey) {
        import('../services/outlookApi.js').then(({ authenticateOutlook }) =>
          authenticateOutlook(existing.id, username.trim(), password)
        ).catch(err => console.warn('[Outlook] Token acquisition failed:', err));
      }
      const user = await dbGet<{ email: string }>('SELECT email FROM users WHERE id = ?', existing.id);
      const token = jwt.sign({ userId: existing.id, email: user?.email || '', role: existing.role || 'user' }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
      res.json({ token, user: { id: existing.id, email: user?.email || '', displayName: fullAdUser.displayName || existing.display_name, role: existing.role || 'user' } });
      return;
    }

    // First-time AD login — issue a short-lived session token for the wizard
    const adSessionToken = jwt.sign(
      { adUsername, adDomain, displayName: fullAdUser.displayName, mail, department: fullAdUser.department, type: 'ad_session' },
      config.jwtSecret,
      { expiresIn: '30m' }
    );

    res.json({ firstLogin: true, adSessionToken, adUser: fullAdUser });
  } catch (error) {
    console.error('AD login error:', error);
    res.status(500).json({ error: '登入失敗，請稍後再試' });
  }
});

/* POST /api/auth/ad/register — complete first-time AD user setup (no inheritance) */
router.post('/ad/register', async (req: Request, res: Response) => {
  try {
    const { adSessionToken, displayName: customDisplayName } = req.body;
    if (!adSessionToken) { res.status(400).json({ error: '缺少必要參數' }); return; }

    let payload: { adUsername: string; adDomain: string; displayName: string; mail: string | null; department: string | null; type: string };
    try {
      payload = jwt.verify(adSessionToken, config.jwtSecret) as typeof payload;
    } catch {
      res.status(401).json({ error: '登入憑證已過期，請重新登入' }); return;
    }
    if (payload.type !== 'ad_session') { res.status(401).json({ error: '無效的登入憑證' }); return; }

    const { adUsername, adDomain, displayName: adDisplayName, mail } = payload;

    // Check again (race condition guard)
    const existing = await dbGet('SELECT id FROM users WHERE ad_username = ? AND ad_domain = ?', adUsername, adDomain);
    if (existing) { res.status(409).json({ error: '此 AD 帳號已完成註冊' }); return; }

    const finalDisplayName = (customDisplayName || adDisplayName || adUsername).trim();
    // Use AD mail or synthetic email
    const email = mail ? mail.toLowerCase().trim() : `${adUsername.toLowerCase()}@${adDomain.toLowerCase()}.panjit.local`;

    // Check if email already used (could be taken by another user)
    const emailConflict = await dbGet('SELECT id, ad_username FROM users WHERE email = ?', email);
    if (emailConflict) {
      if (emailConflict.ad_username) {
        res.status(409).json({ error: '此帳號已被其他 AD 使用者繼承' }); return;
      }
      // Email exists but no AD — suggest inheritance
      res.status(409).json({ error: '此信箱已有帳號，請選擇繼承流程', code: 'USE_CLAIM_FLOW' }); return;
    }

    const id = uuidv4();
    await dbRun(
      'INSERT INTO users (id, email, password_hash, display_name, role, status, auth_provider, ad_username, ad_domain, onboarding_completed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, email, 'AD_NO_PASSWORD', finalDisplayName, 'user', 'active', 'ad', adUsername, adDomain, 1
    );
    await dbRun('UPDATE users SET last_login_at = NOW() WHERE id = ?', id);

    const token = jwt.sign({ userId: id, email, role: 'user' }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
    res.json({ token, user: { id, email, displayName: finalDisplayName, role: 'user' } });
  } catch (error) {
    console.error('AD register error:', error);
    res.status(500).json({ error: '註冊失敗，請稍後再試' });
  }
});

/* POST /api/auth/ad/claim/request — send inheritance claim code to old email */
router.post('/ad/claim/request', async (req: Request, res: Response) => {
  try {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (!checkAuthRate(ip, 'adclaim', 5, 15 * 60_000)) {
      res.status(429).json({ error: '請求過於頻繁，請稍後再試' }); return;
    }

    const { adSessionToken, claimEmail } = req.body;
    if (!adSessionToken || !claimEmail) { res.status(400).json({ error: '缺少必要參數' }); return; }
    if (!isValidEmail(claimEmail)) { res.status(400).json({ error: '電子信箱格式不正確' }); return; }

    let payload: { adUsername: string; adDomain: string; type: string };
    try {
      payload = jwt.verify(adSessionToken, config.jwtSecret) as typeof payload;
    } catch {
      res.status(401).json({ error: '登入憑證已過期，請重新登入' }); return;
    }
    if (payload.type !== 'ad_session') { res.status(401).json({ error: '無效的登入憑證' }); return; }

    const { adUsername, adDomain } = payload;
    const normalizedEmail = claimEmail.toLowerCase().trim();

    // Check target email account exists and is not already linked to AD
    const targetUser = await dbGet<{ id: string; ad_username: string | null }>(
      'SELECT id, ad_username FROM users WHERE email = ?', normalizedEmail
    );
    if (!targetUser) { res.status(404).json({ error: '找不到此電子信箱的帳號' }); return; }
    if (targetUser.ad_username) { res.status(409).json({ error: '此帳號已被其他 AD 使用者繼承' }); return; }

    // Check email service
    if (!isEmailEnabled()) {
      res.status(400).json({ error: '郵件服務暫時不可用，請聯繫管理者' }); return;
    }

    // Generate code and store in ad_claim_tokens
    const code = generateVerificationCode();
    const expiresAt = new Date(Date.now() + 15 * 60_000); // 15 min
    await dbRun('DELETE FROM ad_claim_tokens WHERE ad_username = ? AND ad_domain = ?', adUsername, adDomain);
    await dbRun(
      'INSERT INTO ad_claim_tokens (id, ad_username, ad_domain, claim_email, code, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      uuidv4(), adUsername, adDomain, normalizedEmail, code, expiresAt
    );

    await sendVerificationCode(normalizedEmail, code, 'zh-TW');
    res.json({ sent: true });
  } catch (error) {
    console.error('AD claim request error:', error);
    res.status(500).json({ error: '發送失敗，請稍後再試' });
  }
});

/* POST /api/auth/ad/claim/verify — verify claim code and link AD to existing account */
router.post('/ad/claim/verify', async (req: Request, res: Response) => {
  try {
    const { adSessionToken, claimEmail, code } = req.body;
    if (!adSessionToken || !claimEmail || !code) { res.status(400).json({ error: '缺少必要參數' }); return; }

    let payload: { adUsername: string; adDomain: string; displayName: string; mail: string | null; type: string };
    try {
      payload = jwt.verify(adSessionToken, config.jwtSecret) as typeof payload;
    } catch {
      res.status(401).json({ error: '登入憑證已過期，請重新登入' }); return;
    }
    if (payload.type !== 'ad_session') { res.status(401).json({ error: '無效的登入憑證' }); return; }

    const { adUsername, adDomain, displayName, mail: adMail } = payload;
    const normalizedEmail = claimEmail.toLowerCase().trim();

    // Look up claim token
    const record = await dbGet<{ id: string; code: string; attempts: number; expires_at: Date; claim_email: string }>(
      'SELECT id, code, attempts, expires_at, claim_email FROM ad_claim_tokens WHERE ad_username = ? AND ad_domain = ?',
      adUsername, adDomain
    );

    if (!record) { res.status(400).json({ error: '找不到驗證碼，請重新申請' }); return; }
    if (record.claim_email !== normalizedEmail) { res.status(400).json({ error: '信箱不一致，請重新申請' }); return; }
    if (new Date(record.expires_at) < new Date()) {
      await dbRun('DELETE FROM ad_claim_tokens WHERE id = ?', record.id);
      res.status(400).json({ error: '驗證碼已過期，請重新申請', expired: true }); return;
    }
    if (record.attempts >= 5) {
      await dbRun('DELETE FROM ad_claim_tokens WHERE id = ?', record.id);
      res.status(400).json({ error: '驗證碼嘗試次數過多，請重新申請', expired: true }); return;
    }

    await dbRun('UPDATE ad_claim_tokens SET attempts = attempts + 1 WHERE id = ?', record.id);

    if (record.code !== code.trim()) {
      res.status(400).json({ error: '驗證碼不正確' }); return;
    }

    // Code correct — link AD to existing account
    const user = await dbGet<{ id: string; role: string; status: string; ad_username: string | null }>(
      'SELECT id, role, status, ad_username FROM users WHERE email = ?', normalizedEmail
    );
    if (!user) { res.status(404).json({ error: '找不到對應的帳號' }); return; }
    if (user.ad_username) { res.status(409).json({ error: '此帳號已被繼承' }); return; }

    // Use AD mail as the new email if available, otherwise keep old email
    const newEmail = adMail ? adMail.toLowerCase().trim() : normalizedEmail;

    await dbRun(
      'UPDATE users SET ad_username = ?, ad_domain = ?, auth_provider = ?, display_name = ?, email = ?, onboarding_completed = 1, last_login_at = NOW(), updated_at = NOW() WHERE id = ?',
      adUsername, adDomain, 'ad', displayName || null, newEmail, user.id
    );
    await dbRun('DELETE FROM ad_claim_tokens WHERE id = ?', record.id);

    const token = jwt.sign({ userId: user.id, email: newEmail, role: user.role || 'user' }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
    res.json({ token, user: { id: user.id, email: newEmail, displayName: displayName || null, role: user.role || 'user' } });
  } catch (error) {
    console.error('AD claim verify error:', error);
    res.status(500).json({ error: '驗證失敗，請稍後再試' });
  }
});

/**
 * GET /api/auth/line-bind-qr
 * Authenticated. Mints a one-shot bind token tied to the logged-in user and
 * returns a LINE deep-link QR. Scanning it sends `/link <token>` which binds
 * the user's LINE account to THIS existing account (no new account created).
 * If the account is already bound, returns { alreadyLinked: true } instead.
 */
router.get('/line-bind-qr', authMiddleware, async (req: Request, res: Response) => {
  if (!config.line.enabled || !config.line.botBasicId) {
    res.status(404).json({ error: 'LINE binding not available' });
    return;
  }

  const userId = req.user!.userId;

  // Already bound? Surface the linked state so the UI can show "已綁定".
  const bound = await dbGet<{ line_user_id: string; display_name: string | null }>(
    'SELECT line_user_id, display_name FROM line_users WHERE internal_user_id = ?',
    userId,
  );
  if (bound) {
    res.json({ alreadyLinked: true, displayName: bound.display_name });
    return;
  }

  const { mintBindQrCode, checkQrRateLimit } = await import('../services/line/qrAuth.js');
  const ip = (req.headers['x-forwarded-for']?.toString().split(',')[0].trim()) || req.ip || 'unknown';
  if (!checkQrRateLimit(ip)) {
    res.status(429).json({ error: 'Too many requests, please wait a minute and try again.' });
    return;
  }

  try {
    const result = await mintBindQrCode(userId);
    res.json({ alreadyLinked: false, ...result });
  } catch (err) {
    console.error('[Auth] line-bind-qr mint failed:', err);
    res.status(500).json({ error: 'QR generation failed' });
  }
});

/**
 * GET /api/auth/line-link-status
 * Authenticated. Lightweight poll target for the bind UI — returns whether the
 * current user's LINE account is bound yet (the binding happens asynchronously
 * when they send the `/link` message inside LINE).
 */
router.get('/line-link-status', authMiddleware, async (req: Request, res: Response) => {
  // `available` mirrors the bind-qr gate so the client can decide whether to
  // surface LINE binding at all (e.g. the post-login prompt) without a second
  // round-trip or a side-effecting QR mint.
  const available = config.line.enabled && !!config.line.botBasicId;
  const bound = await dbGet<{ display_name: string | null }>(
    'SELECT display_name FROM line_users WHERE internal_user_id = ?',
    req.user!.userId,
  );
  if (bound) { res.json({ available, linked: true, displayName: bound.display_name ?? null }); return; }
  // Not bound yet — surface a conflict if the most recent QR was scanned by a
  // LINE that's already bound to another account.
  const latest = await dbGet<{ result: string | null }>(
    'SELECT result FROM line_link_tokens WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
    req.user!.userId,
  );
  res.json({ available, linked: false, displayName: null, conflict: latest?.result === 'conflict' });
});

export default router;
