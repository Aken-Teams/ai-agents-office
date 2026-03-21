import { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';

const requestCounts = new Map<string, { count: number; resetTime: number }>();

// Cleanup old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of requestCounts) {
    if (now > value.resetTime) {
      requestCounts.delete(key);
    }
  }
}, 5 * 60_000);

export function rateLimit(req: Request, res: Response, next: NextFunction): void {
  const key = req.user?.userId || req.ip || 'unknown';
  const now = Date.now();

  let entry = requestCounts.get(key);
  if (!entry || now > entry.resetTime) {
    entry = { count: 0, resetTime: now + config.rateLimitWindowMs };
    requestCounts.set(key, entry);
  }

  entry.count++;

  if (entry.count > config.rateLimitMaxRequests) {
    res.status(429).json({ error: 'Too many requests. Please try again later.' });
    return;
  }

  next();
}
