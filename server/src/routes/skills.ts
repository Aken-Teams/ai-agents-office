import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { loadSkills } from '../skills/loader.js';

const router = Router();
router.use(authMiddleware);

// GET /api/skills — List available skills (public metadata only, no system prompts)
router.get('/', (_req: Request, res: Response) => {
  const skills = loadSkills();

  const publicSkills = skills.map(s => ({
    id: s.id,
    name: s.name,
    description: s.description,
    fileType: s.fileType || null,
    role: s.role || 'worker',
  }));

  res.json(publicSkills);
});

export default router;
