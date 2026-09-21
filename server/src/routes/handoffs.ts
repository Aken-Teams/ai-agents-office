/**
 * 跨增益集交接包 — Excel → PowerPoint / Word. PRD 3.5, AC-44/45/46.
 *
 * ── The constraint this works around ──
 * The Office add-in platform does not let one host drive another. Excel's task
 * pane cannot open PowerPoint, and PowerPoint's pane cannot reach back into a
 * workbook that is not the document it was loaded for. So 「turn this analysis
 * into a deck」 cannot be one action; it has to be two, with somewhere to put
 * the work in between.
 *
 * That somewhere is here. Excel packs the conclusions, the figures and the cell
 * references into a parcel; the person opens PowerPoint themselves; that pane
 * asks whether anything is waiting and offers it.
 *
 * ── Why the target app generates, rather than the server ──
 * PRD 3.4 requires generated slides to inherit the deck's existing layouts and
 * theme colours, and 3.3 requires Word's changes to arrive as tracked changes.
 * Neither is possible from a server, which has no open document. So the parcel
 * carries CONTENT, never a finished file: the receiving add-in builds it with
 * its own native tools, in the document that is actually open.
 *
 * ── Owner-only, and short-lived ──
 * Every query filters on the caller's id, exactly as prompt templates do, and
 * `mine()` is the only way a row is fetched by id (AC-46). Expiry is 24 hours
 * and enforced by deletion rather than a flag: a parcel holds real figures out
 * of somebody's workbook, and one nobody collected is data with no remaining
 * purpose.
 */
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { authMiddleware } from '../middleware/auth.js';
import { dbAll, dbGet, dbRun } from '../db.js';
import { logSecurityEvent } from '../services/inputGuard.js';

const router = Router();
router.use(authMiddleware);

/** PRD 3.5: 有效期 24 小時，逾期自動清除。 */
const TTL_HOURS = 24;
/** Generous — this is a summary plus a table, not a document. */
const MAX_PAYLOAD = 60_000;
/** One person cannot leave parcels lying around indefinitely. */
const MAX_PENDING = 20;

/** Which add-in a parcel is FOR. 'excel' is here because Word may hand back. */
export const HANDOFF_TARGETS = new Set(['ppt', 'word', 'excel']);

export interface Handoff {
  id: string;
  user_id: string;
  source_host: string;
  source_name: string;
  target: string;
  title: string;
  payload: string;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

/**
 * Drop what nobody collected.
 *
 * Deletion, not a status column: an expired parcel that still exists is still
 * somebody's figures sitting in a table. Run on every read, which is often
 * enough for a 24-hour window and costs one indexed delete.
 */
async function sweep(): Promise<void> {
  await dbRun('DELETE FROM handoffs WHERE expires_at < NOW()').catch(() => {});
}

/** Fetch one, only if it belongs to the caller. The single choke point (AC-46). */
async function mine(userId: string, id: string): Promise<Handoff | undefined> {
  const row = await dbGet<Handoff>(
    'SELECT * FROM handoffs WHERE id = ? AND user_id = ?', id, userId);
  if (!row) {
    const exists = await dbGet<{ user_id: string }>(
      'SELECT user_id FROM handoffs WHERE id = ?', id);
    if (exists && exists.user_id !== userId) {
      logSecurityEvent(userId, 'blocked_request', 'medium',
        `嘗試存取他人的交接包（handoff ${id}，擁有者 ${exists.user_id}）`);
    }
  }
  return row;
}

/**
 * Create one. Called by the bridge when the agent uses excel_create_handoff,
 * not by a browser — but it lives on the same auth as everything else so a
 * person could equally well create one from the web app later.
 */
export async function createHandoff(opts: {
  userId: string;
  sourceHost: string;
  sourceName: string;
  target: string;
  title: string;
  payload: string;
}): Promise<{ ok: true; id: string; expiresAt: string } | { ok: false; error: string }> {
  const target = String(opts.target || '').toLowerCase();
  if (!HANDOFF_TARGETS.has(target)) {
    return { ok: false, error: `target 只能是 ${[...HANDOFF_TARGETS].join(' / ')}。` };
  }
  const payload = String(opts.payload || '').trim();
  if (!payload) return { ok: false, error: '交接包的內容不能是空的。' };
  if (payload.length > MAX_PAYLOAD) {
    return { ok: false, error: `交接包最多 ${MAX_PAYLOAD} 字，請把內容濃縮成結論與關鍵數據。` };
  }

  await sweep();
  const pending = await dbGet<{ n: number }>(
    'SELECT COUNT(*) AS n FROM handoffs WHERE user_id = ? AND consumed_at IS NULL',
    opts.userId);
  if ((pending?.n ?? 0) >= MAX_PENDING) {
    return { ok: false, error: `還有 ${pending!.n} 個交接包沒有被接收，請先處理掉再產生新的。` };
  }

  const id = uuidv4();
  await dbRun(
    `INSERT INTO handoffs (id, user_id, source_host, source_name, target, title, payload, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL ? HOUR))`,
    id, opts.userId, opts.sourceHost, String(opts.sourceName || '').slice(0, 255),
    target, String(opts.title || '').slice(0, 255) || '分析結果', payload, TTL_HOURS);

  // Carries the owner even though the id was minted two lines ago and cannot be
  // anyone else's. The rule 「every query against this table names its owner」 is
  // worth more as an invariant with no exceptions than as one with a good one:
  // exceptions are what the next person copies.
  const row = await dbGet<{ expires_at: string }>(
    'SELECT expires_at FROM handoffs WHERE id = ? AND user_id = ?', id, opts.userId);
  return { ok: true, id, expiresAt: String(row?.expires_at || '') };
}

/**
 * GET /api/handoffs?target=ppt — what is waiting for THIS app.
 *
 * Metadata only: the title, where it came from, when it expires. The payload
 * stays here until the person accepts, so opening a pane never pulls somebody
 * else's figures into a document they had no intention of using them in.
 */
router.get('/', async (req: Request, res: Response) => {
  await sweep();
  const target = String(req.query.target || '').toLowerCase();
  if (!HANDOFF_TARGETS.has(target)) { res.json({ handoffs: [] }); return; }
  const rows = await dbAll<Handoff>(
    `SELECT id, source_host, source_name, title, created_at, expires_at
       FROM handoffs
      WHERE user_id = ? AND target = ? AND consumed_at IS NULL
      ORDER BY created_at DESC LIMIT 10`,
    req.user!.userId, target).catch(() => []);
  res.json({ handoffs: rows });
});

/**
 * POST /api/handoffs/:id/accept — hand the payload over and mark it collected.
 *
 * Marked rather than deleted, so re-opening the pane does not offer the same
 * parcel again while the generation it started is still running. The row goes
 * at expiry like every other.
 */
router.post('/:id/accept', async (req: Request, res: Response) => {
  const row = await mine(req.user!.userId, String(req.params.id));
  // Expired parcels are swept on read, so 「not found」 covers gone-and-expired
  // as well as never-yours. AC-46 asks for a message, and the pane writes it.
  if (!row) { res.status(404).json({ error: '這個交接包已經失效或不存在了。' }); return; }
  if (row.consumed_at) { res.status(409).json({ error: '這個交接包已經被接收過了。' }); return; }

  await dbRun('UPDATE handoffs SET consumed_at = NOW() WHERE id = ? AND user_id = ?',
    row.id, req.user!.userId);
  res.json({
    id: row.id,
    sourceHost: row.source_host,
    sourceName: row.source_name,
    title: row.title,
    payload: row.payload,
  });
});

/** DELETE /api/handoffs/:id — 「忽略」. PRD 3.5 step 4 offers it alongside accept. */
router.delete('/:id', async (req: Request, res: Response) => {
  const row = await mine(req.user!.userId, String(req.params.id));
  if (!row) { res.status(404).json({ error: '這個交接包已經失效或不存在了。' }); return; }
  await dbRun('DELETE FROM handoffs WHERE id = ? AND user_id = ?', row.id, req.user!.userId);
  res.json({ ok: true });
});

export default router;
