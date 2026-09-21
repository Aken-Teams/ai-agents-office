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
import { analyzeInput, logSecurityEvent } from '../services/inputGuard.js';

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
  host: string;
  created_at: string;
  updated_at: string;
}

/**
 * Which product a template is for.
 *
 * ── Why this is not just a tag ──
 * The add-ins share one account and one store, so without a scope a person
 * editing a deck is shown 「把這份活頁簿裡的廠區欄位…」 — an instruction that
 * cannot possibly run here. One wrong row is enough to make the whole list read
 * as not-for-me, and a list nobody trusts is a list nobody opens.
 *
 * 'all' is a real choice, not a fallback: 「用條列式回我，每點一句」 is worth
 * having everywhere. It is also what rows created before this column existed
 * became, because we did not record where they came from and inventing an answer
 * would be worse than admitting it.
 */
const HOSTS = new Set(['excel', 'word', 'ppt', 'web', 'all']);
const hostOf = (v: unknown, fallback = 'all') => {
  const h = String(v ?? '').trim().toLowerCase();
  return HOSTS.has(h) ? h : fallback;
};

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

/**
 * Scan a template before it is stored.
 *
 * ── The risk this closes, which is about PERSISTENCE ──
 * Text injected into a workbook by an outsider is normally a one-shot: it
 * influences a single turn, the confirmation gate stops the damage, and it is
 * gone. Saving a template breaks that. The intended way to make one is to ask
 * the agent to write up the procedure it just carried out and save its reply —
 * and the agent producing that reply has been reading the workbook. Adversarial
 * text in the file can shape what it writes, the person skims it and saves it
 * because they believe they authored it, and a one-shot becomes something that
 * replays every month with their trust attached.
 *
 * So the same scanner that guards uploaded files guards this. analyzeInput
 * rather than the file variant: this is prose, capped well below the length
 * limit, and there is no filename to judge.
 *
 * ── Why blocking here does not fight legitimate use ──
 * The detectors look for injection MECHANICS — <system> tags, 「ignore previous
 * instructions」, unicode obfuscation, base64 payloads, path traversal, and the
 * =CMD/=EXEC formula family. None of them fire on 「幫我刪掉重複的列」, which is a
 * destructive request and a perfectly ordinary thing to save. A template that
 * trips this is not a blunt instruction; it is one carrying machinery.
 */
function screen(userId: string, name: string, content: string): string | null {
  const r = analyzeInput(content);
  if (r.blocked) {
    logSecurityEvent(userId, 'prompt_injection', 'high',
      `常用指令「${name}」被判定為注入嘗試（${r.flags.join(', ')}）`, content.slice(0, 2000));
    return '這則常用指令裡有看起來像是要操控 AI 的內容，沒有存起來。'
      + '如果這是你從對話裡複製下來的，請先確認那段文字不是從檔案內容來的。';
  }
  // Below the block threshold but above the warning one: worth a record, not
  // worth refusing. A person's own saved text is theirs to write.
  if (!r.safe) {
    logSecurityEvent(userId, 'prompt_injection', 'low',
      `常用指令「${name}」有可疑樣式但未達阻擋門檻（${r.flags.join(', ')}）`);
  }
  return null;
}

/**
 * GET /api/prompt-templates — the caller's own, newest first.
 *
 * `?host=ppt` narrows to what can actually run in PowerPoint: that product's own
 * templates plus the ones marked 'all'. Without the parameter everything comes
 * back, which is what the web app wants — it is the one surface where every
 * template is legible, because it is where they can all be managed.
 */
router.get('/', async (req: Request, res: Response) => {
  const want = String(req.query.host ?? '').trim().toLowerCase();
  const scoped = HOSTS.has(want) && want !== 'all';
  const rows = await dbAll<PromptTemplate>(
    `SELECT id, name, content, host, created_at, updated_at
       FROM prompt_templates
      WHERE user_id = ?${scoped ? " AND (host = ? OR host = 'all')" : ''}
      ORDER BY updated_at DESC`,
    ...(scoped ? [req.user!.userId, want] : [req.user!.userId]));
  res.json({ templates: rows, max: await limitFor(req.user!.userId) });
});

/** POST /api/prompt-templates — create one. */
router.post('/', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const name = clean(req.body?.name, MAX_NAME);
  const content = clean(req.body?.content, MAX_CONTENT);
  if (!name) { res.status(400).json({ error: '請給這則常用指令一個名稱。' }); return; }
  if (!content) { res.status(400).json({ error: '常用指令的內容不能是空的。' }); return; }
  const refused = screen(userId, name, content);
  if (refused) { res.status(400).json({ error: refused }); return; }

  const max = await limitFor(userId);
  const count = await dbGet<{ n: number }>(
    'SELECT COUNT(*) AS n FROM prompt_templates WHERE user_id = ?', userId);
  if ((count?.n ?? 0) >= max) {
    res.status(409).json({ error: `常用指令最多 ${max} 則，請先刪掉用不到的。` });
    return;
  }

  const id = uuidv4();
  // Defaults to 'all' rather than to the caller's product: a template created
  // through an API that did not say where it came from is, as far as we know,
  // general. Every add-in does say.
  const host = hostOf(req.body?.host);
  await dbRun(
    `INSERT INTO prompt_templates (id, user_id, name, content, host, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NOW(), NOW())`,
    id, userId, name, content, host);
  res.status(201).json({ id, name, content, host });
});

/** PATCH /api/prompt-templates/:id — rename or rewrite. */
router.patch('/:id', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const row = await mine(userId, String(req.params.id));
  if (!row) { res.status(404).json({ error: '找不到這則常用指令。' }); return; }

  const name = req.body?.name === undefined ? row.name : clean(req.body.name, MAX_NAME);
  const content = req.body?.content === undefined ? row.content : clean(req.body.content, MAX_CONTENT);
  if (!name || !content) { res.status(400).json({ error: '名稱和內容都不能是空的。' }); return; }
  // Re-scanned on edit, not only on create: the content can be replaced
  // wholesale here, and a check that only runs at birth is a check with a
  // documented way round it.
  const refusedEdit = screen(userId, name, content);
  if (refusedEdit) { res.status(400).json({ error: refusedEdit }); return; }

  // Re-scoping is an edit like any other — it is how somebody fixes a row that
  // predates the column, or promotes an Excel procedure to a general one.
  const host = req.body?.host === undefined ? row.host : hostOf(req.body.host, row.host);
  await dbRun(
    `UPDATE prompt_templates SET name = ?, content = ?, host = ?, updated_at = NOW()
      WHERE id = ? AND user_id = ?`,
    name, content, host, row.id, userId);
  res.json({ id: row.id, name, content, host });
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
