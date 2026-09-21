/**
 * 個人常用指令 — a person's own saved prompts. PRD 3.5, AC-42/43/43b.
 *
 * ── What this is for ──
 * Working out a good instruction is the expensive part. Somebody spends twenty
 * minutes getting a cross-file comparison to say exactly what they want — which
 * sheets, which key columns, what the output sheet should be called — and then
 * has to reconstruct it from memory next month. Saving that text turns it into
 * one sentence: 「用我的『月結比對』流程跑一次」.
 *
 * ── Why it is safe to let anyone create these ──
 * A template is TEXT and nothing else. It carries no tools, no connectors, no
 * data scope, no skip-confirmation flag — so applying one can do nothing its
 * owner could not already do by typing the same words (AC-43b). That is the
 * whole reason ordinary users may create them while skills stay with IT.
 *
 * ── Owner-only ──
 * Every query filters on the caller's own user id, and `mine()` is the only way
 * a row is ever fetched. A request naming someone else's id gets a 404 — not a
 * 403, which would confirm the id exists — and is recorded as a security event,
 * which is what AC-43 asks to see in the audit log.
 */
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { authMiddleware } from '../middleware/auth.js';
import { dbAll, dbGet, dbRun } from '../db.js';
import { logSecurityEvent } from '../services/inputGuard.js';

const router = Router();
router.use(authMiddleware);

/** PRD 3.5: 預設每人 50 則，可由管理員於後台依帳號調整。 */
const DEFAULT_MAX = 50;
/** Long enough for a worked-out procedure, short enough not to be a document. */
const MAX_CONTENT = 4000;
const MAX_NAME = 60;

export interface PromptTemplate {
  id: string;
  user_id: string;
  name: string;
  content: string;
  created_at: string;
  updated_at: string;
}

async function limitFor(userId: string): Promise<number> {
  const row = await dbGet<{ prompt_template_limit: number | null }>(
    'SELECT prompt_template_limit FROM users WHERE id = ?', userId);
  const n = row?.prompt_template_limit;
  return typeof n === 'number' && n > 0 ? n : DEFAULT_MAX;
}

/**
 * Fetch one template, but only if it belongs to the caller.
 *
 * The single choke point for reading a row by id. A miss is answered the same
 * way whether the row does not exist or belongs to somebody else, so the API
 * cannot be used to probe for other people's ids.
 */
async function mine(userId: string, id: string): Promise<PromptTemplate | undefined> {
  const row = await dbGet<PromptTemplate>(
    'SELECT * FROM prompt_templates WHERE id = ? AND user_id = ?', id, userId);
  if (!row) {
    // Only log when the row exists and is someone else's — a plain typo or a
    // template the person deleted themselves is not a security event, and a log
    // full of those is a log nobody reads.
    const exists = await dbGet<{ user_id: string }>(
      'SELECT user_id FROM prompt_templates WHERE id = ?', id);
    if (exists && exists.user_id !== userId) {
      logSecurityEvent(userId, 'blocked_request', 'medium',
        `嘗試存取他人的常用指令（template ${id}，擁有者 ${exists.user_id}）`);
    }
  }
  return row;
}

const clean = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);

/** GET /api/prompt-templates — the caller's own, newest first. */
router.get('/', async (req: Request, res: Response) => {
  const rows = await dbAll<PromptTemplate>(
    `SELECT id, name, content, created_at, updated_at
       FROM prompt_templates WHERE user_id = ?
      ORDER BY updated_at DESC`,
    req.user!.userId);
  res.json({ templates: rows, max: await limitFor(req.user!.userId) });
});

/** POST /api/prompt-templates — create one. */
router.post('/', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const name = clean(req.body?.name, MAX_NAME);
  const content = clean(req.body?.content, MAX_CONTENT);
  if (!name) { res.status(400).json({ error: '請給這則常用指令一個名稱。' }); return; }
  if (!content) { res.status(400).json({ error: '常用指令的內容不能是空的。' }); return; }

  const max = await limitFor(userId);
  const count = await dbGet<{ n: number }>(
    'SELECT COUNT(*) AS n FROM prompt_templates WHERE user_id = ?', userId);
  if ((count?.n ?? 0) >= max) {
    res.status(409).json({ error: `常用指令最多 ${max} 則，請先刪掉用不到的。` });
    return;
  }

  const id = uuidv4();
  await dbRun(
    `INSERT INTO prompt_templates (id, user_id, name, content, created_at, updated_at)
     VALUES (?, ?, ?, ?, NOW(), NOW())`,
    id, userId, name, content);
  res.status(201).json({ id, name, content });
});

/** PATCH /api/prompt-templates/:id — rename or rewrite. */
router.patch('/:id', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const row = await mine(userId, String(req.params.id));
  if (!row) { res.status(404).json({ error: '找不到這則常用指令。' }); return; }

  const name = req.body?.name === undefined ? row.name : clean(req.body.name, MAX_NAME);
  const content = req.body?.content === undefined ? row.content : clean(req.body.content, MAX_CONTENT);
  if (!name || !content) { res.status(400).json({ error: '名稱和內容都不能是空的。' }); return; }

  await dbRun(
    'UPDATE prompt_templates SET name = ?, content = ?, updated_at = NOW() WHERE id = ? AND user_id = ?',
    name, content, row.id, userId);
  res.json({ id: row.id, name, content });
});

/** DELETE /api/prompt-templates/:id */
router.delete('/:id', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const row = await mine(userId, String(req.params.id));
  if (!row) { res.status(404).json({ error: '找不到這則常用指令。' }); return; }
  await dbRun('DELETE FROM prompt_templates WHERE id = ? AND user_id = ?', row.id, userId);
  res.json({ ok: true });
});

/**
 * Resolve a template id for audit, from whichever surface applied it.
 *
 * Exported rather than kept private because all four entry points — the web app
 * and the three add-ins — record the same thing, and PRD 3.5 asks the audit log
 * to name the template a turn was started from. Returns null for an id that is
 * not this user's, so a forged id in a chat request records nothing rather than
 * attributing the turn to a stranger's template.
 */
export async function templateForAudit(userId: string, id: unknown): Promise<string | null> {
  const wanted = String(id ?? '').trim();
  if (!wanted) return null;
  const row = await mine(userId, wanted);
  return row ? row.id : null;
}

export default router;
