/**
 * Public, unauthenticated read-only shares.
 *
 * Mounted at /api/public WITHOUT auth middleware. Only resolves opaque share
 * tokens to read-only snapshots — never exposes anything writable.
 */

import { Router, Request, Response } from 'express';
import { dbGet } from '../db.js';
import { readScheduledDoc, isDocFormat } from '../services/teamDocument.js';

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

// GET /api/public/team-run/:token/document — download the document a scheduled run
// produced (Word/PPT/PDF/HTML). Public via the same opaque share token; 404 if the
// run has no document or the file is gone.
router.get('/team-run/:token/document', async (req: Request, res: Response) => {
  const run = await dbGet<{ id: string; user_id: string; doc_format: string | null; team_title: string }>(
    `SELECT tr.id, tr.user_id, tr.doc_format, t.title AS team_title
     FROM team_runs tr JOIN agent_teams t ON t.id = tr.team_id
     WHERE tr.share_token = ?`,
    req.params.token,
  );
  if (!run || !isDocFormat(run.doc_format)) { res.status(404).json({ error: 'Not found' }); return; }
  const doc = readScheduledDoc(run.user_id, run.id, run.doc_format, run.team_title);
  if (!doc) { res.status(404).json({ error: '檔案不存在或已過期' }); return; }
  res.setHeader('Content-Type', doc.mime);
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(doc.filename)}"; filename*=UTF-8''${encodeURIComponent(doc.filename)}`);
  res.send(doc.buffer);
});

export default router;
