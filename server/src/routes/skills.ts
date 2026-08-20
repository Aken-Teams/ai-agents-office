import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { loadSkills } from '../skills/loader.js';
import { listMcpSources } from '../services/mcpRegistry.js';

const router = Router();
router.use(authMiddleware);

// GET /api/skills/mcp — MCP servers this deployment can mount.
// Separate from the skills list because they are a different kind of thing: a
// skill is an agent with a prompt, an MCP is a set of tools an agent may be
// handed. Which ones exist depends on deployment config only (see mcpRegistry),
// so this stays a plain read with no per-user branching.
router.get('/mcp', (_req: Request, res: Response) => {
  res.json(listMcpSources());
});

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
