/**
 * Client-facing deployment configuration.
 *
 * Settings the UI needs in order to draw itself correctly, for a signed-in
 * user rather than an admin. Distinct from /api/admin/settings, which carries
 * quotas, limits and other operational values no ordinary user should read:
 * this endpoint deliberately exposes only what the page is about to render,
 * so adding an admin setting never leaks one by accident.
 */
import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { getPublicAddinInstaller } from '../services/addinInstaller.js';

const router = Router();
router.use(authMiddleware);

// GET /api/app-config
router.get('/', async (_req: Request, res: Response) => {
  res.json({
    // null when no installer is configured — the UI hides the entry entirely
    // rather than showing a download that cannot work.
    addinInstaller: await getPublicAddinInstaller(),
  });
});

export default router;
