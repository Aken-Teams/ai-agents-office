import { Router, Request, Response } from 'express';
import path from 'path';
import db from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { getFileDownloadPath, deleteFile } from '../services/fileManager.js';
import type { GeneratedFile } from '../types.js';

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
