import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { getUserUsageSummary, getUserTotalUsage } from '../services/tokenTracker.js';

const router = Router();
router.use(authMiddleware);

// GET /api/usage — Token usage summary
router.get('/', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { from, to } = req.query;

  const summary = getUserUsageSummary(
    userId,
    from as string | undefined,
    to as string | undefined,
  );

  const total = getUserTotalUsage(userId);

  res.json({ summary, total });
});

// GET /api/usage/daily — Daily breakdown for current month
router.get('/daily', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const now = new Date();
  const firstOfMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

  const daily = getUserUsageSummary(userId, firstOfMonth);
  res.json(daily);
});

export default router;
