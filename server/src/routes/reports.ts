/**
 * Report / ticket system. Users file reports (問題回報) from the app; admins
 * triage them. All ticket data lives in the independent db_Ops schema so a future
 * centralized ops system can own it. Images reuse the existing upload pipeline
 * (virus-scanned); we store the resulting file path in db_Ops.
 */

import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { authMiddleware } from '../middleware/auth.js';
import { adminMiddleware } from '../middleware/adminAuth.js';
import { dbGet } from '../db.js';
import { opsGet, opsAll, opsRun, OPS_TICKET_STATUSES } from '../opsDb.js';
import { config } from '../config.js';

// Issue types — ids are stable; labels are localized on the client.
export const REPORT_TYPES = ['bug', 'generation', 'feature', 'account', 'other'] as const;

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const MAX_IMAGES = 6;

interface OpsImage { id: string; ticket_id: string; role: string; file_path: string; mime_type: string | null }

/** Pull the storage paths of the given uploaded images (owned by `userId`) into a ticket. */
async function attachUploadImages(ticketId: string, userId: string, uploadIds: unknown, role: 'report' | 'resolution'): Promise<void> {
  if (!Array.isArray(uploadIds)) return;
  for (const uid of uploadIds.slice(0, MAX_IMAGES)) {
    if (typeof uid !== 'string') continue;
    const up = await dbGet<{ storage_path: string; mime_type: string | null; file_type: string }>(
      "SELECT storage_path, mime_type, file_type FROM user_uploads WHERE id = ? AND user_id = ? AND scan_status != 'rejected'",
      uid, userId,
    );
    if (!up) continue;
    if (!IMAGE_EXTS.has((up.file_type || '').toLowerCase())) continue;
    await opsRun(
      'INSERT INTO ops_ticket_images (id, ticket_id, role, file_path, mime_type) VALUES (?, ?, ?, ?, ?)',
      uuidv4(), ticketId, role, up.storage_path, up.mime_type || null,
    );
  }
}

/** Stream a stored ops image, guarding against path traversal outside the workspace. */
function serveOpsImage(res: Response, img: OpsImage): void {
  const abs = path.resolve(path.isAbsolute(img.file_path) ? img.file_path : path.join(config.workspaceRoot, img.file_path));
  if (!abs.startsWith(path.resolve(config.workspaceRoot)) || !fs.existsSync(abs)) { res.status(404).end(); return; }
  res.setHeader('Content-Type', img.mime_type || 'image/png');
  res.setHeader('Content-Disposition', 'inline');
  fs.createReadStream(abs).pipe(res);
}

// ───────────────────────── User router (/api/reports) ─────────────────────────
export const reportsRouter = Router();
reportsRouter.use(authMiddleware);

reportsRouter.get('/config', (_req: Request, res: Response) => {
  res.json({ enabled: config.reportSystemEnabled, types: REPORT_TYPES });
});

reportsRouter.post('/', async (req: Request, res: Response) => {
  if (!config.reportSystemEnabled) { res.status(403).json({ error: '回報功能未開啟' }); return; }
  const userId = req.user!.userId;
  const { type, title, content, conversationUrl, imageUploadIds } = req.body as {
    type?: string; title?: string; content?: string; conversationUrl?: string; imageUploadIds?: string[];
  };
  if (!type || !REPORT_TYPES.includes(type as any)) { res.status(400).json({ error: '請選擇問題類型' }); return; }
  if (!title || !title.trim()) { res.status(400).json({ error: '請填寫標題' }); return; }

  const user = await dbGet<{ email: string; display_name: string | null }>('SELECT email, display_name FROM users WHERE id = ?', userId);
  const id = uuidv4();
  await opsRun(
    `INSERT INTO ops_tickets (id, source_system, deploy_mode, user_id, user_email, user_name, type, title, content, conversation_url, status)
     VALUES (?, 'ai-agents-office', ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
    id, config.deployMode, userId, user?.email || null, user?.display_name || null,
    type, title.trim().slice(0, 500), (content || '').slice(0, 5000), (conversationUrl || '').trim().slice(0, 1000) || null,
  );
  await attachUploadImages(id, userId, imageUploadIds, 'report');
  res.json({ id });
});

reportsRouter.get('/', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const tickets = await opsAll<any>('SELECT * FROM ops_tickets WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 50', userId);
  const ids = tickets.map(t => t.id);
  const images = ids.length
    ? await opsAll<OpsImage>(`SELECT id, ticket_id, role, file_path, mime_type FROM ops_ticket_images WHERE ticket_id IN (${ids.map(() => '?').join(',')})`, ...ids)
    : [];
  res.json(tickets.map(t => ({ ...t, images: images.filter(im => im.ticket_id === t.id).map(im => ({ id: im.id, role: im.role })) })));
});

reportsRouter.get('/image/:imgId', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const img = await opsGet<OpsImage & { owner: string }>(
    'SELECT i.id, i.ticket_id, i.role, i.file_path, i.mime_type, t.user_id AS owner FROM ops_ticket_images i JOIN ops_tickets t ON t.id = i.ticket_id WHERE i.id = ?',
    req.params.imgId,
  );
  if (!img || img.owner !== userId) { res.status(404).end(); return; }
  serveOpsImage(res, img);
});

// Withdraw (soft-delete) own report — only while still untouched (open).
reportsRouter.delete('/:id', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const tk = await opsGet<{ status: string }>('SELECT status FROM ops_tickets WHERE id = ? AND user_id = ? AND deleted_at IS NULL', req.params.id, userId);
  if (!tk) { res.status(404).json({ error: 'Not found' }); return; }
  if (tk.status !== 'open') { res.status(400).json({ error: '已開始處理，無法撤回' }); return; }
  await opsRun('UPDATE ops_tickets SET deleted_at = NOW() WHERE id = ?', req.params.id);
  res.json({ ok: true });
});

// ──────────────────── Admin router (/api/admin/reports) ───────────────────────
export const adminReportsRouter = Router();
adminReportsRouter.use(adminMiddleware);

adminReportsRouter.get('/', async (req: Request, res: Response) => {
  const { status, q } = req.query as { status?: string; q?: string };
  let sql = 'SELECT * FROM ops_tickets WHERE deleted_at IS NULL';
  const params: any[] = [];
  if (status && OPS_TICKET_STATUSES.includes(status as any)) { sql += ' AND status = ?'; params.push(status); }
  if (q && q.trim()) { sql += ' AND (title LIKE ? OR content LIKE ? OR user_email LIKE ?)'; const like = `%${q.trim()}%`; params.push(like, like, like); }
  sql += ' ORDER BY (status = \'open\') DESC, created_at DESC LIMIT 300';
  const tickets = await opsAll<any>(sql, ...params);
  const ids = tickets.map(t => t.id);
  const images = ids.length
    ? await opsAll<OpsImage>(`SELECT id, ticket_id, role FROM ops_ticket_images WHERE ticket_id IN (${ids.map(() => '?').join(',')})`, ...ids)
    : [];
  res.json(tickets.map(t => ({ ...t, imageCount: images.filter(im => im.ticket_id === t.id).length })));
});

adminReportsRouter.get('/stats', async (_req: Request, res: Response) => {
  const rows = await opsAll<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM ops_tickets WHERE deleted_at IS NULL GROUP BY status');
  res.json(Object.fromEntries(rows.map(r => [r.status, r.n])));
});

adminReportsRouter.get('/:id', async (req: Request, res: Response) => {
  const ticket = await opsGet<any>('SELECT * FROM ops_tickets WHERE id = ? AND deleted_at IS NULL', req.params.id);
  if (!ticket) { res.status(404).json({ error: 'Not found' }); return; }
  const images = await opsAll<OpsImage>('SELECT id, role FROM ops_ticket_images WHERE ticket_id = ? ORDER BY created_at ASC', req.params.id);
  res.json({ ...ticket, images });
});

adminReportsRouter.patch('/:id', async (req: Request, res: Response) => {
  const { status, resolutionNote } = req.body as { status?: string; resolutionNote?: string };
  const ticket = await opsGet<{ id: string }>('SELECT id FROM ops_tickets WHERE id = ?', req.params.id);
  if (!ticket) { res.status(404).json({ error: 'Not found' }); return; }

  const fields: string[] = [];
  const params: any[] = [];
  if (status && OPS_TICKET_STATUSES.includes(status as any)) {
    fields.push('status = ?'); params.push(status);
    if (status === 'resolved' || status === 'rejected') {
      const admin = await dbGet<{ display_name: string | null; email: string }>('SELECT display_name, email FROM users WHERE id = ?', req.user!.userId);
      fields.push('resolved_at = NOW()', 'resolved_by = ?'); params.push(admin?.display_name || admin?.email || 'admin');
    }
  }
  if (typeof resolutionNote === 'string') { fields.push('resolution_note = ?'); params.push(resolutionNote.slice(0, 5000)); }
  if (!fields.length) { res.status(400).json({ error: 'No changes' }); return; }
  params.push(req.params.id);
  await opsRun(`UPDATE ops_tickets SET ${fields.join(', ')} WHERE id = ?`, ...params);
  res.json({ ok: true });
});

adminReportsRouter.post('/:id/images', async (req: Request, res: Response) => {
  const { imageUploadIds } = req.body as { imageUploadIds?: string[] };
  const ticket = await opsGet<{ id: string }>('SELECT id FROM ops_tickets WHERE id = ?', req.params.id);
  if (!ticket) { res.status(404).json({ error: 'Not found' }); return; }
  await attachUploadImages(String(req.params.id), req.user!.userId, imageUploadIds, 'resolution');
  res.json({ ok: true });
});

adminReportsRouter.get('/image/:imgId', async (req: Request, res: Response) => {
  const img = await opsGet<OpsImage>('SELECT id, ticket_id, role, file_path, mime_type FROM ops_ticket_images WHERE id = ?', req.params.imgId);
  if (!img) { res.status(404).end(); return; }
  serveOpsImage(res, img);
});

// Clear the official reply (resolution note + resolution images) without removing
// the ticket — lets an admin fix a mistaken reply. Status is left untouched so the
// admin can re-set it with the status buttons.
adminReportsRouter.delete('/:id/resolution', async (req: Request, res: Response) => {
  const ticket = await opsGet<{ id: string }>('SELECT id FROM ops_tickets WHERE id = ?', req.params.id);
  if (!ticket) { res.status(404).json({ error: 'Not found' }); return; }
  await opsRun("DELETE FROM ops_ticket_images WHERE ticket_id = ? AND role = 'resolution'", req.params.id);
  await opsRun('UPDATE ops_tickets SET resolution_note = NULL, resolved_by = NULL, resolved_at = NULL WHERE id = ?', req.params.id);
  res.json({ ok: true });
});

// Soft-delete a whole ticket (cleanup spam/test/duplicates). It disappears from
// both the admin queue and the reporter's "my reports"; the row is kept in db_Ops.
adminReportsRouter.delete('/:id', async (req: Request, res: Response) => {
  await opsRun('UPDATE ops_tickets SET deleted_at = NOW() WHERE id = ?', req.params.id);
  res.json({ ok: true });
});
