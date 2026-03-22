import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import db from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { config } from '../config.js';
import {
  scanUploadedFile,
  isAllowedExtension,
  isAllowedSize,
  UPLOAD_QUOTA_BYTES,
} from '../services/uploadScanner.js';

const router = Router();
router.use(authMiddleware);

// ---------------------------------------------------------------------------
// Multer config — temp storage, then move to user's upload dir after scan
// ---------------------------------------------------------------------------

const tempDir = path.join(config.workspaceRoot, '_tmp_uploads');
fs.mkdirSync(tempDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, tempDir),
  filename: (_req, file, cb) => {
    const uniqueName = `${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (_req, file, cb) => {
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

function getUserUploadSize(userId: string): number {
  const row = db.prepare(
    "SELECT COALESCE(SUM(file_size), 0) AS total FROM user_uploads WHERE user_id = ? AND scan_status != 'rejected'"
  ).get(userId) as { total: number };
  return row.total;
}

// ---------------------------------------------------------------------------
// POST /api/uploads — Upload file(s)
// ---------------------------------------------------------------------------

router.post('/', upload.array('files', 10), (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const conversationId = (req.body?.conversationId as string) || null;
  const files = req.files as Express.Multer.File[];

  if (!files || files.length === 0) {
    res.status(400).json({ error: '未選擇檔案' });
    return;
  }

  // Check upload quota
  const currentUsage = getUserUploadSize(userId);
  const incomingSize = files.reduce((sum, f) => sum + f.size, 0);
  if (currentUsage + incomingSize > UPLOAD_QUOTA_BYTES) {
    // Clean up temp files
    for (const f of files) {
      try { fs.unlinkSync(f.path); } catch { /* ignore */ }
    }
    const usedMB = (currentUsage / (1024 * 1024)).toFixed(1);
    const quotaMB = (UPLOAD_QUOTA_BYTES / (1024 * 1024)).toFixed(0);
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
      db.prepare(`
        INSERT INTO user_uploads (id, user_id, conversation_id, filename, original_name, file_type, mime_type, file_size, scan_status, scan_detail, storage_path)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(fileId, userId, conversationId, destName, file.originalname, ext.replace('.', ''), file.mimetype, file.size, 'rejected', scanResult.detail, '');

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
    db.prepare(`
      INSERT INTO user_uploads (id, user_id, conversation_id, filename, original_name, file_type, mime_type, file_size, scan_status, scan_detail, storage_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(fileId, userId, conversationId, destName, file.originalname, ext.replace('.', ''), file.mimetype, file.size, scanResult.status, scanResult.detail, relPath);

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

router.get('/', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const status = req.query.status as string;

  let query = "SELECT * FROM user_uploads WHERE user_id = ?";
  const params: unknown[] = [userId];

  if (status && ['clean', 'suspicious', 'rejected', 'pending'].includes(status)) {
    query += ' AND scan_status = ?';
    params.push(status);
  } else {
    // By default don't show rejected files to user
    query += " AND scan_status != 'rejected'";
  }

  query += ' ORDER BY created_at DESC';

  const uploads = db.prepare(query).all(...params);
  res.json(uploads);
});

// ---------------------------------------------------------------------------
// GET /api/uploads/storage — Upload storage usage
// ---------------------------------------------------------------------------

router.get('/storage', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const used = getUserUploadSize(userId);
  const quota = UPLOAD_QUOTA_BYTES;
  const count = (db.prepare(
    "SELECT COUNT(*) as count FROM user_uploads WHERE user_id = ? AND scan_status != 'rejected'"
  ).get(userId) as any).count;

  res.json({
    used,
    quota,
    count,
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

router.delete('/:id', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const uploadId = req.params.id;

  const upload = db.prepare(
    'SELECT * FROM user_uploads WHERE id = ? AND user_id = ?'
  ).get(uploadId, userId) as any;

  if (!upload) {
    res.status(404).json({ error: '檔案不存在' });
    return;
  }

  // Delete physical file
  if (upload.storage_path) {
    const fullPath = path.join(config.workspaceRoot, upload.storage_path);
    try { fs.unlinkSync(fullPath); } catch { /* already gone */ }
  }

  // Delete DB record
  db.prepare('DELETE FROM user_uploads WHERE id = ?').run(uploadId);

  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// GET /api/uploads/:id/download — Download an upload
// ---------------------------------------------------------------------------

router.get('/:id/download', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const uploadId = req.params.id;

  const upload = db.prepare(
    'SELECT * FROM user_uploads WHERE id = ? AND user_id = ?'
  ).get(uploadId, userId) as any;

  if (!upload || !upload.storage_path) {
    res.status(404).json({ error: '檔案不存在' });
    return;
  }

  const fullPath = path.join(config.workspaceRoot, upload.storage_path);
  if (!fs.existsSync(fullPath)) {
    res.status(404).json({ error: '檔案不存在' });
    return;
  }

  res.download(fullPath, upload.original_name);
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
