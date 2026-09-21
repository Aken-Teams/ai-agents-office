import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { loadSkills, skillsForHost } from '../skills/loader.js';
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
//
// `?host=excel|word|ppt` narrows the list to skills that declare that surface.
// Without it the answer is every skill, which is what the web app wants and
// what this route always returned. See skillsForHost for why a skill has to opt
// in rather than out.
router.get('/', (req: Request, res: Response) => {
  const host = String(req.query.host || '').toLowerCase();
  const skills = host ? skillsForHost(host) : loadSkills();

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
