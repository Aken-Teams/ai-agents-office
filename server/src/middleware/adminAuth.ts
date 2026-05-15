import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import type { AuthPayload } from '../types.js';
import { getRolePermissions } from '../services/rolePermissions.js';

// Map admin API route prefixes to permission page keys
const ROUTE_TO_PAGE_KEY: Record<string, string> = {
  '/overview': 'overview',
  '/users': 'users',
  '/conversations': 'conversations',
  '/quota-groups': 'quota-groups',
  '/quota-requests': 'quota-requests',
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
    const payload = jwt.verify(token, config.jwtSecret) as AuthPayload;
    if (payload.role !== 'admin' && payload.role !== 'readonly') {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }
    if (payload.role === 'readonly' && req.method !== 'GET') {
      // Check if this route is in readonlyOperate
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
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
