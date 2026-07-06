import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { getUserUsageSummary, getUserUsageSummaryByCategory, getUserCategoryCounts, getUserUsageRecords, getUserTotalUsage } from '../services/tokenTracker.js';
import { getEffectiveUserLimit } from '../services/usageLimit.js';
import { config } from '../config.js';

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
  // Per-surface breakdown (文件產生 / AI 團隊 / 信件助手) for the usage-detail tabs.
  const byCategory = await getUserUsageSummaryByCategory(
    userId,
    from as string | undefined,
    to as string | undefined,
  );

  // Official mode: total reflects current month only (monthly quota reset)
  const total = await getUserTotalUsage(userId, !config.isBeta);
  // Per-surface invocation counts (this month in official mode) for the dashboard's
  // "文件生成" stat + its hover breakdown (文件 / AI 團隊 / 信件).
  const categoryCounts = await getUserCategoryCounts(userId, !config.isBeta);
  // Per-record ledger (one row per generation) for the detailed "by record" view.
  const records = await getUserUsageRecords(
    userId,
    from as string | undefined,
    to as string | undefined,
  );
  const limit = await getEffectiveUserLimit(userId);

  res.json({ summary, byCategory, categoryCounts, records, total, limit, isBeta: config.isBeta });
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
