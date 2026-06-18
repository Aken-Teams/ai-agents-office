import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { dbGet, dbAll } from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { getFileDownloadPath, deleteFile, getFileVersions, extractPptxShapes, registerNewFiles, snapshotExistingFiles, getExistingFilePaths } from '../services/fileManager.js';
import { convertOfficeFile } from '../services/filePreview.js';
import { applyWatermark, getWatermarkSettings } from '../services/watermark.js';
import { config } from '../config.js';
import { getSandboxPath } from '../services/sandbox.js';
import { isGeminiEnabled } from '../services/geminiApi.js';
import { compositeRegionMask, regionEditToFile } from '../services/infographicService.js';
import { recordTokenUsage } from '../services/tokenTracker.js';
import { getStorageQuotaGb } from '../services/usageLimit.js';
import { findValidShare, bumpDownloadCount } from '../services/line/fileShare.js';
import type { GeneratedFile } from '../types.js';

const OFFICE_MIME: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt: 'application/vnd.ms-powerpoint',
};

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

// GET /api/files/share/:token — PUBLIC download for files delivered via LINE
// (no JWT in chat). Defined BEFORE authMiddleware so it stays open. Serves
// inline by default (view); ?dl=1 forces a download. Validates the opaque
// token (expiry + download cap) instead of a user session.
router.get('/share/:token', async (req: Request, res: Response) => {
  const token = String(req.params.token);
  const share = await findValidShare(token);
  if (!share) { res.status(404).json({ error: '連結已失效或已達下載上限' }); return; }

  const filePath = await getFileDownloadPath(share.user_id, share.file_id);
  if (!filePath || !fs.existsSync(filePath)) { res.status(404).json({ error: 'File not found' }); return; }

  bumpDownloadCount(token).catch(() => { /* best-effort */ });

  const filename = path.basename(filePath);
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const wantDownload = req.query.dl === '1';
  const disposition = wantDownload
    ? `attachment; filename="${encodeURIComponent(filename)}"`
    : 'inline';

  // Watermark PDFs (mirrors the authed download); office files are served raw so
  // the Microsoft Office online viewer can render them from the public URL.
  if (ext === 'pdf') {
    try {
      const wm = await applyWatermark(filePath);
      if (wm) {
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', disposition);
        res.setHeader('Content-Length', wm.length);
        res.end(wm); return;
      }
    } catch (err) { console.warn('[FileShare] watermark failed, serving original:', err); }
  }

  const mime = OFFICE_MIME[ext] || MIME_MAP[ext] || 'application/octet-stream';
  const stat = fs.statSync(filePath);
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', disposition);
  res.setHeader('Content-Length', stat.size);
  fs.createReadStream(filePath).pipe(res);
});

// GET /api/files/share/:token/info — PUBLIC metadata for the share page (name,
// type, size). Doesn't count as a download; the raw file route enforces the cap.
router.get('/share/:token/info', async (req: Request, res: Response) => {
  const token = String(req.params.token);
  const row = await dbGet<{ filename: string; file_type: string; file_size: number | null }>(
    `SELECT gf.filename, gf.file_type, gf.file_size
     FROM file_shares fs JOIN generated_files gf ON gf.id = fs.file_id
     WHERE fs.token = ? AND fs.expires_at > NOW() LIMIT 1`,
    token,
  );
  if (!row) { res.status(404).json({ error: '連結已失效或不存在' }); return; }
  res.json({ filename: row.filename, fileType: (row.file_type || '').toLowerCase(), fileSize: row.file_size });
});

router.use(authMiddleware);

// GET /api/files/watermark-config — the watermark on/off + text, so the preview
// viewer can render it as a frontend overlay. Authed (any logged-in user); the
// admin-only PATCH lives in routes/admin.ts.
router.get('/watermark-config', async (_req: Request, res: Response) => {
  try {
    const { enabled, text } = await getWatermarkSettings();
    res.json({ enabled, text });
  } catch {
    res.json({ enabled: false, text: '' });
  }
});

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
  const fileId = req.params.id as string;
  const filePath = await getFileDownloadPath(userId, fileId);

  if (!filePath) {
    console.warn(`[Preview] File not found: id=${fileId}, userId=${userId}`);
    res.status(404).json({ error: 'File not found' });
    return;
  }

  const ext = path.extname(filePath).slice(1).toLowerCase();
  const mime = MIME_MAP[ext];
  if (mime) {
    // Previews are served clean; the watermark is a frontend overlay over the
    // viewer (see /watermark-config). Downloads/shares embed a real watermark.
    const stat = fs.statSync(filePath);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Content-Length', stat.size);
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  if (OFFICE_EXTENSIONS.has(ext)) {
    try {
      // Serve the clean converted preview (PDF via LibreOffice, or HTML fallback).
      // The watermark is drawn as a frontend overlay over the preview viewer (see
      // /api/files/watermark-config + files/page.tsx) — reliable across every
      // preview type and renders CJK natively. Downloads/shares still embed a
      // real watermark into the delivered file.
      const result = await convertOfficeFile(filePath, ext);
      res.setHeader('Content-Type', result.mime);
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      if (Buffer.isBuffer(result.content)) {
        res.setHeader('Content-Length', result.content.length);
        res.end(result.content);
      } else {
        res.send(result.content);
      }
    } catch (err) {
      console.error(`[Preview] Conversion error for ${path.basename(filePath)} (${ext}):`, err);
      res.status(500).json({ error: 'Preview conversion failed' });
    }
    return;
  }

  res.status(415).json({ error: 'Preview not supported for this file type', file_type: ext });
});

// POST /api/files/:id/region-edit — brush/mask region editing for infographic
// images. Body: { mask: base64 PNG (transparent bg, red strokes over the area to
// change, at the image's native size), instruction: string }. Composites the
// mask onto the original, asks Gemini to edit only the marked area, and saves
// the result as a new version of the same file.
router.post('/:id/region-edit', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const fileId = req.params.id as string;
  const { mask, instruction } = req.body as { mask?: string; instruction?: string };

  if (!isGeminiEnabled()) { res.status(503).json({ error: '圖片編輯功能尚未設定（缺少 GEMINI_API_KEY）' }); return; }
  if (!mask || typeof mask !== 'string') { res.status(400).json({ error: '缺少標記範圍' }); return; }
  if (!instruction || !instruction.trim()) { res.status(400).json({ error: '請說明這個區域要改成什麼' }); return; }

  const file = await dbGet<GeneratedFile>(
    'SELECT * FROM generated_files WHERE id = ? AND user_id = ? ORDER BY version DESC LIMIT 1',
    fileId, userId,
  );
  if (!file) { res.status(404).json({ error: 'File not found' }); return; }
  const ext = path.extname(file.file_path).slice(1).toLowerCase();
  if (!['png', 'jpg', 'jpeg', 'webp'].includes(ext)) { res.status(400).json({ error: '只支援圖片檔的局部編輯' }); return; }

  const conversationId = file.conversation_id;
  if (!conversationId) { res.status(400).json({ error: '此檔案無法局部編輯' }); return; }

  const fullPath = path.join(config.workspaceRoot, file.file_path);
  if (!fs.existsSync(fullPath)) { res.status(404).json({ error: 'File missing on disk' }); return; }

  try {
    // Composite the brush mask onto the original (resized to match exactly).
    const marked = await compositeRegionMask(fullPath, mask);

    // Save as a new version using the same machinery as the generate flow.
    const existingFiles = await getExistingFilePaths(conversationId);
    await snapshotExistingFiles(userId, conversationId);
    const { usage } = await regionEditToFile(marked, instruction, fullPath);
    const sandboxPath = getSandboxPath(userId, conversationId);
    const newFiles = await registerNewFiles(userId, conversationId, sandboxPath, existingFiles, new Set([ext]));
    const newFile = newFiles.find(f => f.file_path === file.file_path) || newFiles[0];

    // Fold the Gemini cost into usage (equivalent tokens at the $15/M output rate).
    const geminiTokens = Math.round((usage.costUsd * 1_000_000) / 15);
    if (geminiTokens > 0) {
      await recordTokenUsage({ userId, conversationId, inputTokens: 0, outputTokens: geminiTokens, model: usage.model });
    }

    res.json({ file: newFile, costUsd: usage.costUsd });
  } catch (err) {
    console.error('[RegionEdit] failed:', err);
    res.status(500).json({ error: `局部編輯失敗：${(err as Error).message}` });
  }
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

// GET /api/files/:id/shapes — extract shape bounding boxes from PPTX
router.get('/:id/shapes', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const filePath = await getFileDownloadPath(userId, req.params.id as string);
  if (!filePath) { res.status(404).json({ error: 'File not found' }); return; }

  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (ext !== 'pptx') { res.status(400).json({ error: 'Only PPTX files supported' }); return; }

  try {
    const shapes = await extractPptxShapes(filePath);
    res.json({ slides: shapes });
  } catch (err) {
    console.error('[Shapes] Extraction error:', err);
    res.status(500).json({ error: 'Shape extraction failed' });
  }
});

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
