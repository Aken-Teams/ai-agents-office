import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { dbGet, dbAll } from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { getFileDownloadPath, deleteFile, getFileVersions } from '../services/fileManager.js';
import { convertOfficeFile } from '../services/filePreview.js';
import { applyWatermark } from '../services/watermark.js';
import { config } from '../config.js';
import { getStorageQuotaGb } from '../services/usageLimit.js';
import { findValidShare, bumpDownloadCount } from '../services/line/fileShare.js';
import type { GeneratedFile } from '../types.js';

/** Sum file_size for a given user from generated_files table */
export async function getUserStorageUsed(userId: string): Promise<number> {
  const row = await dbGet<{ total: number }>(
    'SELECT COALESCE(SUM(file_size), 0) AS total FROM generated_files WHERE user_id = ?',
    userId
  );
  return row?.total ?? 0;
}

const MIME_MAP: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp',
  tiff: 'image/tiff', tif: 'image/tiff', ico: 'image/x-icon',
  txt: 'text/plain', csv: 'text/plain', md: 'text/plain',
  json: 'application/json', xml: 'text/xml', yaml: 'text/plain', yml: 'text/plain',
  html: 'text/html', htm: 'text/html',
};

const OFFICE_EXTENSIONS = new Set(['docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt']);

const router = Router();

// ─── Public download via file_shares token (NO auth) ─────────────
// Declared BEFORE the authMiddleware so LINE recipients can tap a share URL
// without holding a JWT. Token + expiry + download-cap enforced inside.
router.get('/share/:token', async (req: Request, res: Response) => {
  const token = String(req.params.token || '');
  if (!/^[A-Za-z0-9]{8}$/.test(token)) {
    res.status(400).json({ error: 'Invalid token format' });
    return;
  }

  const share = await findValidShare(token);
  if (!share) {
    res.status(404).json({ error: 'Share link not found, expired, or exhausted' });
    return;
  }

  const filePath = await getFileDownloadPath(share.user_id, share.file_id);
  if (!filePath) {
    res.status(404).json({ error: 'File not found' });
    return;
  }

  const filename = path.basename(filePath);

  // PDFs and images can be viewed in-browser/LINE (inline); everything else
  // (Office docs, etc.) forces a download. `?dl=1` forces download even for
  // previewable types (used by the "下載" button alongside "觀看").
  const ext = path.extname(filename).slice(1).toLowerCase();
  const mime = MIME_MAP[ext];
  const previewable = ext === 'pdf' || (!!mime && mime.startsWith('image/'));
  const disposition = previewable && req.query.dl !== '1' ? 'inline' : 'attachment';
  const cd = `${disposition}; filename="${encodeURIComponent(filename)}"`;

  // Count the download as it begins — if the response stream errors out, the
  // count still bumps so a leaked URL can't infinitely retry past the cap.
  await bumpDownloadCount(token);

  try {
    const watermarked = await applyWatermark(filePath);
    if (watermarked) {
      if (mime) res.setHeader('Content-Type', mime);
      res.setHeader('Content-Disposition', cd);
      res.setHeader('Content-Length', watermarked.length);
      res.end(watermarked);
      return;
    }
  } catch (err) {
    console.warn('[Share] Watermark failed, serving original:', err);
  }

  // sendFile sets Content-Type from the real file extension; we set the
  // disposition explicitly so previewable types open inline.
  res.setHeader('Content-Disposition', cd);
  res.sendFile(path.resolve(filePath));
});

router.use(authMiddleware);

// GET /api/files — returns only the LATEST version of each file
router.get('/', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { type, conversationId } = req.query;

  let where = 'WHERE gf.user_id = ?';
  const params: unknown[] = [userId];

  if (type) { where += ' AND gf.file_type = ?'; params.push(type); }
  if (conversationId) { where += ' AND gf.conversation_id = ?'; params.push(conversationId); }

  const query = `
    SELECT gf.* FROM generated_files gf
    INNER JOIN (
      SELECT file_path, conversation_id, MAX(version) AS max_ver
      FROM generated_files
      WHERE user_id = ?
      GROUP BY file_path, conversation_id
    ) latest ON gf.file_path = latest.file_path
      AND (gf.conversation_id = latest.conversation_id OR (gf.conversation_id IS NULL AND latest.conversation_id IS NULL))
      AND gf.version = latest.max_ver
    ${where}
    ORDER BY gf.created_at DESC
  `;

  const rows = await dbAll(query, userId, ...params);
  res.json(rows);
});

// GET /api/files/:id/download
router.get('/:id/download', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const filePath = await getFileDownloadPath(userId, req.params.id as string);

  if (!filePath) { res.status(404).json({ error: 'File not found' }); return; }

  const filename = path.basename(filePath);

  try {
    const watermarked = await applyWatermark(filePath);
    if (watermarked) {
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
      res.setHeader('Content-Length', watermarked.length);
      res.end(watermarked); return;
    }
  } catch (err) { console.warn('[Download] Watermark failed, serving original:', err); }

  res.download(filePath, filename);
});

// GET /api/files/:id/preview
router.get('/:id/preview', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const filePath = await getFileDownloadPath(userId, req.params.id as string);

  if (!filePath) { res.status(404).json({ error: 'File not found' }); return; }

  const ext = path.extname(filePath).slice(1).toLowerCase();
  const mime = MIME_MAP[ext];
  if (mime) {
    if (ext === 'pdf' || ext === 'html' || ext === 'htm') {
      try {
        const watermarked = await applyWatermark(filePath);
        if (watermarked) {
          res.setHeader('Content-Type', mime);
          res.setHeader('Content-Disposition', 'inline');
          res.setHeader('Content-Length', watermarked.length);
          res.end(watermarked); return;
        }
      } catch (err) { console.warn('[Preview] Watermark failed, serving original:', err); }
    }
    const stat = fs.statSync(filePath);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Content-Length', stat.size);
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  if (OFFICE_EXTENSIONS.has(ext)) {
    try {
      const result = await convertOfficeFile(filePath, ext);
      res.setHeader('Content-Type', result.mime);
      res.setHeader('Content-Disposition', 'inline');
      if (Buffer.isBuffer(result.content)) {
        res.setHeader('Content-Length', result.content.length);
        res.end(result.content);
      } else {
        res.send(result.content);
      }
    } catch (err) {
      console.error('[Preview] Conversion error:', err);
      res.status(500).json({ error: 'Preview conversion failed' });
    }
    return;
  }

  res.status(415).json({ error: 'Preview not supported for this file type', file_type: ext });
});

// GET /api/files/storage
router.get('/storage', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const used = await getUserStorageUsed(userId);
  const quota = (await getStorageQuotaGb()) * 1024 * 1024 * 1024;
  const percentage = quota > 0 ? used / quota : 0;

  res.json({
    used, quota, percentage,
    warning: percentage >= config.storageWarningThreshold,
    formatted: { used: formatBytes(used), quota: formatBytes(quota) },
  });
});

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// GET /api/files/:id/versions
router.get('/:id/versions', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const versions = await getFileVersions(userId, req.params.id as string);
  res.json(versions);
});

// DELETE /api/files/:id
router.delete('/:id', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const success = await deleteFile(userId, req.params.id as string);
  if (!success) { res.status(404).json({ error: 'File not found' }); return; }
  res.json({ success: true });
});

export default router;
