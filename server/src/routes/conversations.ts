import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import db from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import type { Conversation, Message } from '../types.js';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

// GET /api/conversations
router.get('/', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const conversations = db.prepare(
    'SELECT * FROM conversations WHERE user_id = ? ORDER BY created_at DESC'
  ).all(userId) as Conversation[];

  res.json(conversations);
});

// POST /api/conversations
router.post('/', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { title, skillId } = req.body;
  const id = uuidv4();

  const effectiveSkillId = skillId || null;
  const mode = effectiveSkillId ? 'direct' : null;  // null = auto-detect (may use orchestrator)
  db.prepare(
    'INSERT INTO conversations (id, user_id, title, skill_id, mode) VALUES (?, ?, ?, ?, ?)'
  ).run(id, userId, title || 'New Conversation', effectiveSkillId, mode);

  const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Conversation;
  res.status(201).json(conversation);
});

// GET /api/conversations/:id
router.get('/:id', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const conversation = db.prepare(
    'SELECT * FROM conversations WHERE id = ? AND user_id = ?'
  ).get(req.params.id, userId) as Conversation | undefined;

  if (!conversation) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }

  const messages = db.prepare(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC'
  ).all(conversation.id) as Message[];

  res.json({ ...conversation, messages });
});

// PATCH /api/conversations/:id
router.patch('/:id', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { title, status } = req.body;

  const conversation = db.prepare(
    'SELECT * FROM conversations WHERE id = ? AND user_id = ?'
  ).get(req.params.id, userId) as Conversation | undefined;

  if (!conversation) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }

  if (title) {
    db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, conversation.id);
  }
  if (status) {
    db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run(status, conversation.id);
  }

  const updated = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversation.id);
  res.json(updated);
});

// DELETE /api/conversations/:id
router.delete('/:id', (req: Request, res: Response) => {
  const userId = req.user!.userId;

  const conversation = db.prepare(
    'SELECT * FROM conversations WHERE id = ? AND user_id = ?'
  ).get(req.params.id, userId) as Conversation | undefined;

  if (!conversation) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }

  // Delete related DB records
  db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversation.id);
  db.prepare('DELETE FROM task_executions WHERE conversation_id = ?').run(conversation.id);
  db.prepare('DELETE FROM agent_sessions WHERE conversation_id = ?').run(conversation.id);
  db.prepare('DELETE FROM conversations WHERE id = ?').run(conversation.id);

  // Delete workspace folder
  const workspaceDir = path.resolve('workspace', userId, conversation.id);
  if (fs.existsSync(workspaceDir)) {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }

  res.json({ success: true });
});

export default router;
