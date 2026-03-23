import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import db from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { getFileDownloadPath, deleteFile, getFileVersions } from '../services/fileManager.js';
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
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp',
  tiff: 'image/tiff', tif: 'image/tiff', ico: 'image/x-icon',
  txt: 'text/plain', csv: 'text/plain', md: 'text/plain',
  json: 'application/json', xml: 'text/xml', yaml: 'text/plain', yml: 'text/plain',
  html: 'text/html', htm: 'text/html',
};

const OFFICE_EXTENSIONS = new Set(['docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt']);

const router = Router();
router.use(authMiddleware);

// GET /api/files — returns only the LATEST version of each file
router.get('/', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { type, conversationId } = req.query;

  // Build WHERE clause for filters
  let where = 'WHERE gf.user_id = ?';
  const params: unknown[] = [userId];

  if (type) {
    where += ' AND gf.file_type = ?';
    params.push(type);
  }
  if (conversationId) {
    where += ' AND gf.conversation_id = ?';
    params.push(conversationId);
  }

  // Only return the latest version per (file_path, conversation_id)
  const query = `
    SELECT gf.* FROM generated_files gf
    INNER JOIN (
      SELECT file_path, conversation_id, MAX(version) AS max_ver
      FROM generated_files
      WHERE user_id = ?
      GROUP BY file_path, conversation_id
    ) latest ON gf.file_path = latest.file_path
      AND gf.conversation_id = latest.conversation_id
      AND gf.version = latest.max_ver
    ${where}
    ORDER BY gf.created_at DESC
  `;

  const files = db.prepare(query).all(userId, ...params) as GeneratedFile[];
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
    // Apply watermark for PDF previews too
    if (ext === 'pdf') {
      try {
        const watermarked = await applyWatermark(filePath);
        if (watermarked) {
          res.setHeader('Content-Type', mime);
          res.setHeader('Content-Disposition', 'inline');
          res.setHeader('Content-Length', watermarked.length);
          res.end(watermarked);
          return;
        }
      } catch (err) {
        console.warn('[Preview] PDF watermark failed, serving original:', err);
      }
    }
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

// GET /api/files/:id/versions — list all versions of a file
router.get('/:id/versions', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const versions = getFileVersions(userId, req.params.id as string);
  res.json(versions);
});

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
