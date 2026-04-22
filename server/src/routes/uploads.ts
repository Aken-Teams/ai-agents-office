import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { dbGet, dbAll, dbRun } from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { config } from '../config.js';
import {
  scanUploadedFile,
  isAllowedExtension,
  isAllowedSize,
} from '../services/uploadScanner.js';
import { getUploadQuotaMb } from '../services/usageLimit.js';
import { applyWatermark } from '../services/watermark.js';

const router = Router();
router.use(authMiddleware);

// ---------------------------------------------------------------------------
// Multer config — temp storage, then move to user's upload dir after scan
// ---------------------------------------------------------------------------

const tempDir = path.join(config.workspaceRoot, '_tmp_uploads');
fs.mkdirSync(tempDir, { recursive: true });

/**
 * Fix multer's latin1 filename encoding.
 * Multer/busboy parses multipart filenames as latin1 by default,
 * which mangles non-ASCII characters (e.g. Chinese).
 *
 * However, some busboy versions or browser configurations already provide
 * valid Unicode filenames. We detect whether conversion is actually needed
 * by checking if all characters are in the latin1 range (0–255).
 * Characters above 255 mean the string is already proper Unicode.
 */
function fixFilename(name: string): string {
  try {
    // ASCII-only names don't need fixing
    if (/^[\x00-\x7F]*$/.test(name)) return name;

    // If any character code > 255, the string is already valid Unicode
    // (latin1-encoded strings can only have char codes 0–255)
    for (let i = 0; i < name.length; i++) {
      if (name.charCodeAt(i) > 255) return name;
    }

    // All chars are 0–255 with some > 127 → likely latin1-encoded UTF-8
    const fixed = Buffer.from(name, 'latin1').toString('utf8');

    // Verify the conversion didn't produce replacement characters
    if (fixed.includes('\uFFFD')) return name;

    return fixed;
  } catch {
    return name;
  }
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, tempDir),
  filename: (_req, file, cb) => {
    file.originalname = fixFilename(file.originalname);
    const uniqueName = `${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (_req, file, cb) => {
    // Note: fixFilename is applied in storage.filename callback, not here,
    // to avoid double-conversion which corrupts the name.
    // Extension check works on ASCII extensions, so no fix needed here.
    if (!isAllowedExtension(file.originalname)) {
      cb(new Error(`不允許的檔案類型: ${path.extname(file.originalname)}`));
      return;
    }
    cb(null, true);
  },
});

// ---------------------------------------------------------------------------
// Helper: get user's upload directory
// ---------------------------------------------------------------------------

function getUserUploadDir(userId: string): string {
  const dir = path.join(config.workspaceRoot, userId, '_uploads');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Helper: get user's total upload size
// ---------------------------------------------------------------------------

async function getUserUploadSize(userId: string): Promise<number> {
  const row = await dbGet<{ total: number }>(
    "SELECT COALESCE(SUM(file_size), 0) AS total FROM user_uploads WHERE user_id = ? AND scan_status != 'rejected'",
    userId
  );
  return row?.total ?? 0;
}

// ---------------------------------------------------------------------------
// POST /api/uploads — Upload file(s)
// ---------------------------------------------------------------------------

router.post('/', upload.array('files', 10), async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const conversationId = (req.body?.conversationId as string) || null;
  const files = req.files as Express.Multer.File[];

  if (!files || files.length === 0) {
    res.status(400).json({ error: '未選擇檔案' });
    return;
  }

  // Check upload quota
  const currentUsage = await getUserUploadSize(userId);
  const incomingSize = files.reduce((sum, f) => sum + f.size, 0);
  const uploadQuotaBytes = (await getUploadQuotaMb()) * 1024 * 1024;
  if (currentUsage + incomingSize > uploadQuotaBytes) {
    // Clean up temp files
    for (const f of files) {
      try { fs.unlinkSync(f.path); } catch { /* ignore */ }
    }
    const usedMB = (currentUsage / (1024 * 1024)).toFixed(1);
    const quotaMB = (uploadQuotaBytes / (1024 * 1024)).toFixed(0);
    res.status(413).json({
      error: `上傳空間不足（已使用 ${usedMB} MB / ${quotaMB} MB）`,
      code: 'UPLOAD_QUOTA_EXCEEDED',
    });
    return;
  }

  const uploadDir = getUserUploadDir(userId);
  const results: Array<{
    id: string;
    filename: string;
    originalName: string;
    fileType: string;
    fileSize: number;
    scanStatus: string;
    scanDetail: string;
  }> = [];

  for (const file of files) {
    const ext = path.extname(file.originalname).toLowerCase();
    const fileId = uuidv4();
    const destName = `${fileId}${ext}`;
    const destPath = path.join(uploadDir, destName);
    const relPath = path.relative(config.workspaceRoot, destPath);

    // Run security scan on temp file
    const scanResult = scanUploadedFile(file.path, file.originalname, file.mimetype, userId);

    if (scanResult.status === 'rejected') {
      // Delete temp file, don't save
      try { fs.unlinkSync(file.path); } catch { /* ignore */ }

      // Still record in DB for audit trail
      await dbRun(
        `INSERT INTO user_uploads (id, user_id, conversation_id, filename, original_name, file_type, mime_type, file_size, scan_status, scan_detail, storage_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        fileId, userId, conversationId, destName, file.originalname, ext.replace('.', ''), file.mimetype, file.size, 'rejected', scanResult.detail, ''
      );

      results.push({
        id: fileId,
        filename: destName,
        originalName: file.originalname,
        fileType: ext.replace('.', ''),
        fileSize: file.size,
        scanStatus: 'rejected',
        scanDetail: scanResult.detail,
      });
      continue;
    }

    // Move temp file to user's upload dir
    try {
      fs.renameSync(file.path, destPath);
    } catch {
      // Cross-device fallback: copy then delete
      fs.copyFileSync(file.path, destPath);
      try { fs.unlinkSync(file.path); } catch { /* ignore */ }
    }

    // Save to DB
    await dbRun(
      `INSERT INTO user_uploads (id, user_id, conversation_id, filename, original_name, file_type, mime_type, file_size, scan_status, scan_detail, storage_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      fileId, userId, conversationId, destName, file.originalname, ext.replace('.', ''), file.mimetype, file.size, scanResult.status, scanResult.detail, relPath
    );

    results.push({
      id: fileId,
      filename: destName,
      originalName: file.originalname,
      fileType: ext.replace('.', ''),
      fileSize: file.size,
      scanStatus: scanResult.status,
      scanDetail: scanResult.detail,
    });
  }

  res.json({ uploads: results });
});

// ---------------------------------------------------------------------------
// GET /api/uploads — List user's uploads
// ---------------------------------------------------------------------------

router.get('/', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const status = req.query.status as string;
  const conversationId = req.query.conversationId as string;

  let query = "SELECT * FROM user_uploads WHERE user_id = ?";
  const params: unknown[] = [userId];

  // Filter by conversation
  if (conversationId) {
    query += ' AND conversation_id = ?';
    params.push(conversationId);
  }

  if (status && ['clean', 'suspicious', 'rejected', 'pending'].includes(status)) {
    query += ' AND scan_status = ?';
    params.push(status);
  } else {
    // By default don't show rejected files to user
    query += " AND scan_status != 'rejected'";
  }

  query += ' ORDER BY created_at DESC';

  const uploads = await dbAll(query, ...params);
  res.json(uploads);
});

// ---------------------------------------------------------------------------
// GET /api/uploads/storage — Upload storage usage
// ---------------------------------------------------------------------------

router.get('/storage', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const used = await getUserUploadSize(userId);
  const quota = (await getUploadQuotaMb()) * 1024 * 1024;
  const countRow = await dbGet<{ count: number }>(
    "SELECT COUNT(*) as count FROM user_uploads WHERE user_id = ? AND scan_status != 'rejected'",
    userId
  );

  res.json({
    used,
    quota,
    count: countRow?.count ?? 0,
    percentage: quota > 0 ? used / quota : 0,
    formatted: {
      used: formatBytes(used),
      quota: formatBytes(quota),
    },
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/uploads/:id — Delete an upload
// ---------------------------------------------------------------------------

router.delete('/:id', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const uploadId = req.params.id;

  const uploadRow = await dbGet<any>(
    'SELECT * FROM user_uploads WHERE id = ? AND user_id = ?',
    uploadId, userId
  );

  if (!uploadRow) {
    res.status(404).json({ error: '檔案不存在' });
    return;
  }

  // Delete physical file
  if (uploadRow.storage_path) {
    const fullPath = path.join(config.workspaceRoot, uploadRow.storage_path);
    try { fs.unlinkSync(fullPath); } catch { /* already gone */ }
  }

  // Delete DB record
  await dbRun('DELETE FROM user_uploads WHERE id = ?', uploadId);

  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// GET /api/uploads/:id/download — Download an upload
// ---------------------------------------------------------------------------

router.get('/:id/download', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const uploadId = req.params.id;

  const uploadRow = await dbGet<any>(
    'SELECT * FROM user_uploads WHERE id = ? AND user_id = ?',
    uploadId, userId
  );

  if (!uploadRow || !uploadRow.storage_path) {
    res.status(404).json({ error: '檔案不存在' });
    return;
  }

  const fullPath = path.join(config.workspaceRoot, uploadRow.storage_path);
  if (!fs.existsSync(fullPath)) {
    res.status(404).json({ error: '檔案不存在' });
    return;
  }

  try {
    const watermarked = await applyWatermark(fullPath);
    if (watermarked) {
      const filename = uploadRow.original_name;
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
      res.setHeader('Content-Length', watermarked.length);
      res.end(watermarked);
      return;
    }
  } catch (err) {
    console.warn('[Download] Watermark failed, serving original:', err);
  }

  res.download(fullPath, uploadRow.original_name);
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export default router;
