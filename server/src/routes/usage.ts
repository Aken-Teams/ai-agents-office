import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { getUserUsageSummary, getUserTotalUsage } from '../services/tokenTracker.js';
import { getEffectiveUserLimit } from '../services/usageLimit.js';

const router = Router();
router.use(authMiddleware);

// GET /api/usage — Token usage summary
router.get('/', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { from, to } = req.query;

  const summary = await getUserUsageSummary(
    userId,
    from as string | undefined,
    to as string | undefined,
  );

  const total = await getUserTotalUsage(userId);
  const limit = await getEffectiveUserLimit(userId);

  res.json({ summary, total, limit });
});

// GET /api/usage/daily — Daily breakdown for current month
router.get('/daily', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const now = new Date();
  const firstOfMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

  const daily = await getUserUsageSummary(userId, firstOfMonth);
  res.json(daily);
});

export default router;
