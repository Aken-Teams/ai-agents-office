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
      req.user = payload;
      next();
    })
    .catch(() => { req.user = payload; next(); });
}
