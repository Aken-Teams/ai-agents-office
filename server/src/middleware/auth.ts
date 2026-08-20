import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { dbGet } from '../db.js';
import type { AuthPayload } from '../types.js';

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'No token provided' });
    return;
  }

  const token = authHeader.substring(7);

  let payload: AuthPayload;
  try {
    // Pin the algorithm so a token can't be smuggled in with `alg: none`/RS256.
    payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as AuthPayload;
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  // Re-check live account status so a suspended account's still-valid token stops
  // working immediately (the JWT itself is stateless and can't be revoked). DB
  // errors fail OPEN — a transient DB hiccup must not lock out every user.
  dbGet<{ status: string | null }>('SELECT status FROM users WHERE id = ?', payload.userId)
    .then(user => {
      if (user && (user.status || 'active') === 'suspended') {
        res.status(403).json({ error: '您的帳號已被停用，如有疑問請聯繫管理者', code: 'SUSPENDED' });
        return;
      }
      // A query that succeeded and found nothing is not a DB hiccup — the
      // account was deleted. Falling through used to let the request continue on
      // a token whose user no longer exists, and it died further downstream as
      // "伺服器發生錯誤", which reads as our fault rather than as the answer.
      if (!user) {
        res.status(401).json({ error: '這個帳號已經不存在了，請聯繫管理者', code: 'ACCOUNT_GONE' });
        return;
      }
      req.user = payload;
      next();
    })
    .catch(() => { req.user = payload; next(); });
}
