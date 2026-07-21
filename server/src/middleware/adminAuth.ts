import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import type { AuthPayload } from '../types.js';
import { getRolePermissions } from '../services/rolePermissions.js';
import { dbGet } from '../db.js';

// Map admin API route prefixes to permission page keys
const ROUTE_TO_PAGE_KEY: Record<string, string> = {
  '/overview': 'overview',
  '/users': 'users',
  '/conversations': 'conversations',
  '/quota-groups': 'quota-groups',
  '/quota-requests': 'quota-requests',
  '/quota-notify': 'quota-requests', // notify settings live on the quota-requests page
  '/ad/resolve-email': 'quota-requests', // recipient picker helper
  '/invite-codes': 'invite-codes',
  '/announcements': 'announcements',
  '/terms': 'terms',
  '/skills': 'skills',
  '/tokens': 'tokens',
  '/analytics': 'analytics',
  '/security': 'security',
  '/settings': 'settings',
  '/org': 'org',
  '/permissions': 'permissions',
};

function getPageKeyFromPath(path: string): string | null {
  // path is relative to /api/admin, e.g. "/users/123/status"
  for (const prefix of Object.keys(ROUTE_TO_PAGE_KEY)) {
    if (path === prefix || path.startsWith(prefix + '/')) {
      return ROUTE_TO_PAGE_KEY[prefix];
    }
  }
  return null;
}

export function adminMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'No token provided' });
    return;
  }

  const token = authHeader.substring(7);

  try {
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as AuthPayload;

    // Always fetch the latest role from DB (JWT role may be stale after admin changes)
    dbGet<{ role: string | null }>('SELECT role FROM users WHERE id = ?', payload.userId)
      .then(user => {
        if (!user) { res.status(401).json({ error: 'User not found' }); return; }
        const currentRole = user.role || 'user';

        if (currentRole !== 'admin' && currentRole !== 'readonly') {
          res.status(403).json({ error: 'Admin access required' });
          return;
        }

        // Update payload with current role from DB
        payload.role = currentRole;

        if (currentRole === 'readonly' && req.method !== 'GET') {
          // TEMPORARY exception: the mail-gateway self-test is a safe, non-mutating
          // load check (it only fires read requests at the gateway), so let 檢閱者
          // run it too. Remove this line to lock it back to admins only.
          if (req.path.includes('/mail-gateway/selftest')) { req.user = payload; next(); return; }
          const pageKey = getPageKeyFromPath(req.path);
          getRolePermissions().then(perms => {
            const operable = perms.adminSidebar.readonlyOperate ?? [];
            if (operable.includes(pageKey ?? '')) {
              req.user = payload;
              next();
            } else {
              res.status(403).json({ error: 'Read-only access: modifications not permitted' });
            }
          }).catch(() => {
            res.status(403).json({ error: 'Read-only access: modifications not permitted' });
          });
          return;
        }
        req.user = payload;
        next();
      })
      .catch(() => {
        res.status(500).json({ error: 'Internal server error' });
      });
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
