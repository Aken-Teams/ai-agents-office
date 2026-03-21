import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import db from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { getFileDownloadPath, deleteFile } from '../services/fileManager.js';
import type { GeneratedFile } from '../types.js';

const MIME_MAP: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml',
  txt: 'text/plain', csv: 'text/plain', md: 'text/plain', html: 'text/html', htm: 'text/html',
};

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
router.get('/:id/download', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const filePath = getFileDownloadPath(userId, req.params.id);

  if (!filePath) {
    res.status(404).json({ error: 'File not found' });
    return;
  }

  const filename = path.basename(filePath);
  res.download(filePath, filename);
});

// GET /api/files/:id/preview — serve file inline for preview
router.get('/:id/preview', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const filePath = getFileDownloadPath(userId, req.params.id);

  if (!filePath) {
    res.status(404).json({ error: 'File not found' });
    return;
  }

  const ext = path.extname(filePath).slice(1).toLowerCase();
  const mime = MIME_MAP[ext];

  if (!mime) {
    // Office files etc. — return text extraction or unsupported
    res.status(415).json({ error: 'Preview not supported for this file type', file_type: ext });
    return;
  }

  const stat = fs.statSync(filePath);
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Content-Length', stat.size);
  fs.createReadStream(filePath).pipe(res);
});

// DELETE /api/files/:id
router.delete('/:id', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const success = deleteFile(userId, req.params.id);

  if (!success) {
    res.status(404).json({ error: 'File not found' });
    return;
  }

  res.json({ success: true });
});

export default router;
