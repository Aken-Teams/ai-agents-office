/**
 * Public, unauthenticated read-only shares.
 *
 * Mounted at /api/public WITHOUT auth middleware. Only resolves opaque share
 * tokens to read-only snapshots — never exposes anything writable.
 */

import { Router, Request, Response } from 'express';
import { dbGet } from '../db.js';

const router = Router();

interface SharedRunRow {
  question: string;
  result: string | null;
  member_outputs: string | null;
  input_tokens: number;
  output_tokens: number;
  created_at: string;
  team_title: string;
  team_icon: string | null;
}

// GET /api/public/team-run/:token — read-only snapshot of one team run.
router.get('/team-run/:token', async (req: Request, res: Response) => {
  const run = await dbGet<SharedRunRow>(
    `SELECT tr.question, tr.result, tr.member_outputs, tr.input_tokens, tr.output_tokens, tr.created_at,
            t.title AS team_title, t.icon AS team_icon
     FROM team_runs tr JOIN agent_teams t ON t.id = tr.team_id
     WHERE tr.share_token = ?`,
    req.params.token,
  );
  if (!run) { res.status(404).json({ error: 'Not found' }); return; }

  let memberOutputs: Array<{ memberId: string; name: string; icon: string | null; text: string }> = [];
  try { memberOutputs = JSON.parse(run.member_outputs || '[]'); } catch { /* ignore */ }

  res.json({
    teamTitle: run.team_title,
    teamIcon: run.team_icon,
    question: run.question,
    result: run.result,
    memberOutputs,
    createdAt: run.created_at,
  });
});

export default router;
