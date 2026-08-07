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

  // These six queries are independent, so they run concurrently rather than as six
  // serial round trips — measured 19.8ms sequential vs 5.2ms parallel, and this is
  // the slowest endpoint in the app (it dominated a 100-concurrency load test at
  // 410ms p50 while every other route sat between 60 and 180ms).
  const [summary, byCategory, total, categoryCounts, records, limit] = await Promise.all([
    getUserUsageSummary(
      userId,
      from as string | undefined,
      to as string | undefined,
    ),
    // Per-surface breakdown (文件產生 / AI 團隊 / 信件助手) for the usage-detail tabs.
    getUserUsageSummaryByCategory(
      userId,
      from as string | undefined,
      to as string | undefined,
    ),
    // Official mode: total reflects current month only (monthly quota reset)
    getUserTotalUsage(userId, !config.isBeta),
    // Per-surface invocation counts (this month in official mode) for the dashboard's
    // "文件生成" stat + its hover breakdown (文件 / AI 團隊 / 信件).
    getUserCategoryCounts(userId, !config.isBeta),
    // Per-record ledger (one row per generation) for the detailed "by record" view.
    getUserUsageRecords(
      userId,
      from as string | undefined,
      to as string | undefined,
    ),
    getEffectiveUserLimit(userId),
  ]);

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
