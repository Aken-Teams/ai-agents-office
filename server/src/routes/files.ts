import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import db from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { getFileDownloadPath, deleteFile } from '../services/fileManager.js';
import { convertOfficeFile } from '../services/filePreview.js';
import { applyWatermark } from '../services/watermark.js';
import { config } from '../config.js';
import { getStorageQuotaGb } from '../services/usageLimit.js';
import type { GeneratedFile } from '../types.js';

/** Sum file_size for a given user from generated_files table */
export function getUserStorageUsed(userId: string): number {
  const row = db.prepare(
    'SELECT COALESCE(SUM(file_size), 0) AS total FROM generated_files WHERE user_id = ?'
  ).get(userId) as { total: number };
  return row.total;
}

const MIME_MAP: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml',
  txt: 'text/plain', csv: 'text/plain', md: 'text/plain', html: 'text/html', htm: 'text/html',
};

const OFFICE_EXTENSIONS = new Set(['docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt']);

const router = Router();
router.use(authMiddleware);

// GET /api/files
router.get('/', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { type, conversationId } = req.query;

  let query = 'SELECT * FROM generated_files WHERE user_id = ?';
  const params: unknown[] = [userId];

  if (type) {
    query += ' AND file_type = ?';
    params.push(type);
  }
  if (conversationId) {
    query += ' AND conversation_id = ?';
    params.push(conversationId);
  }

  query += ' ORDER BY created_at DESC';

  const files = db.prepare(query).all(...params) as GeneratedFile[];
  res.json(files);
});

// GET /api/files/:id/download
router.get('/:id/download', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const filePath = getFileDownloadPath(userId, req.params.id as string);

  if (!filePath) {
    res.status(404).json({ error: 'File not found' });
    return;
  }

  const filename = path.basename(filePath);

  try {
    const watermarked = await applyWatermark(filePath);
    if (watermarked) {
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
      res.setHeader('Content-Length', watermarked.length);
      res.end(watermarked);
      return;
    }
  } catch (err) {
    console.warn('[Download] Watermark failed, serving original:', err);
  }

  res.download(filePath, filename);
});

// GET /api/files/:id/preview — serve file inline for preview
router.get('/:id/preview', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const filePath = getFileDownloadPath(userId, req.params.id as string);

  if (!filePath) {
    res.status(404).json({ error: 'File not found' });
    return;
  }

  const ext = path.extname(filePath).slice(1).toLowerCase();

  // Direct-serve for natively previewable types
  const mime = MIME_MAP[ext];
  if (mime) {
    const stat = fs.statSync(filePath);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Content-Length', stat.size);
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  // Office files: convert via LibreOffice (preferred) or JS fallback
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

// GET /api/files/storage — Return user's storage usage + quota
router.get('/storage', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const used = getUserStorageUsed(userId);
  const quota = getStorageQuotaGb() * 1024 * 1024 * 1024;
  const percentage = quota > 0 ? used / quota : 0;

  res.json({
    used,
    quota,
    percentage,
    warning: percentage >= config.storageWarningThreshold,
    formatted: {
      used: formatBytes(used),
      quota: formatBytes(quota),
    },
  });
});

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// DELETE /api/files/:id
router.delete('/:id', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const success = deleteFile(userId, req.params.id as string);

  if (!success) {
    res.status(404).json({ error: 'File not found' });
    return;
  }

  res.json({ success: true });
});

export default router;
