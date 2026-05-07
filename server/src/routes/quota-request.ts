import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { dbGet, dbAll, dbRun } from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { getEffectiveUserLimit, getUserDisplayCost } from '../services/usageLimit.js';

const router = Router();
router.use(authMiddleware);

// POST /api/quota-request — Submit a quota increase request
router.post('/', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { reason } = req.body;

  if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
    res.status(400).json({ error: 'Reason is required' });
    return;
  }

  // Check if user already has a pending request
  const pending = await dbGet<{ id: string }>(
    "SELECT id FROM quota_requests WHERE user_id = ? AND status = 'pending'",
    userId
  );
  if (pending) {
    res.status(409).json({ error: 'You already have a pending request' });
    return;
  }

  const currentLimit = await getEffectiveUserLimit(userId);
  const currentCost = await getUserDisplayCost(userId);

  const id = uuidv4();
  await dbRun(
    'INSERT INTO quota_requests (id, user_id, current_limit, current_cost, reason) VALUES (?, ?, ?, ?, ?)',
    id, userId, currentLimit, currentCost, reason.trim()
  );

  res.json({ success: true, id, status: 'pending' });
});

// GET /api/quota-request — Get current user's quota requests
router.get('/', async (req: Request, res: Response) => {
  const userId = req.user!.userId;

  const requests = await dbAll<any>(
    `SELECT id, current_limit, current_cost, reason, status, new_limit, admin_notes, created_at, reviewed_at
     FROM quota_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`,
    userId
  );

  // Also include current pending status for quick check
  const hasPending = requests.some((r: any) => r.status === 'pending');

  res.json({ requests, hasPending });
});

export default router;
