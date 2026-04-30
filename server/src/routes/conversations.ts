import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { dbGet, dbAll, dbRun } from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import type { Conversation, Message } from '../types.js';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

// GET /api/conversations
router.get('/', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { category } = req.query;
  const conversations = category
    ? await dbAll<Conversation>("SELECT * FROM conversations WHERE user_id = ? AND category = ? AND status != 'deleted' ORDER BY created_at DESC", userId, category)
    : await dbAll<Conversation>("SELECT * FROM conversations WHERE user_id = ? AND status != 'deleted' ORDER BY created_at DESC", userId);
  res.json(conversations);
});

// POST /api/conversations
router.post('/', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { title, skillId, category } = req.body;
  const id = uuidv4();

  const effectiveSkillId = skillId || null;
  const mode = effectiveSkillId ? 'direct' : null;
  const effectiveCategory = category === 'assistant' ? 'assistant' : 'document';
  await dbRun(
    'INSERT INTO conversations (id, user_id, title, skill_id, mode, category) VALUES (?, ?, ?, ?, ?, ?)',
    id, userId, title || 'New Conversation', effectiveSkillId, mode, effectiveCategory
  );

  const conversation = await dbGet<Conversation>('SELECT * FROM conversations WHERE id = ?', id);
  res.status(201).json(conversation);
});

// GET /api/conversations/:id
router.get('/:id', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const conversation = await dbGet<Conversation>(
    'SELECT * FROM conversations WHERE id = ? AND user_id = ?',
    req.params.id, userId
  );

  if (!conversation) { res.status(404).json({ error: 'Conversation not found' }); return; }

  const messages = await dbAll<Message>(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC',
    conversation.id
  );

  res.json({ ...conversation, messages });
});

// PATCH /api/conversations/:id
router.patch('/:id', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { title, status } = req.body;

  const conversation = await dbGet<Conversation>(
    'SELECT * FROM conversations WHERE id = ? AND user_id = ?',
    req.params.id, userId
  );

  if (!conversation) { res.status(404).json({ error: 'Conversation not found' }); return; }

  if (title) await dbRun('UPDATE conversations SET title = ? WHERE id = ?', title, conversation.id);
  if (status) await dbRun('UPDATE conversations SET status = ? WHERE id = ?', status, conversation.id);

  const updated = await dbGet('SELECT * FROM conversations WHERE id = ?', conversation.id);
  res.json(updated);
});

// GET /api/conversations/:id/usage
router.get('/:id/usage', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const conversationId = req.params.id;

  const conversation = await dbGet('SELECT id FROM conversations WHERE id = ? AND user_id = ?', conversationId, userId);
  if (!conversation) { res.status(404).json({ error: 'Conversation not found' }); return; }

  const usage = await dbGet<{ totalInput: number; totalOutput: number; callCount: number }>(`
    SELECT
      COALESCE(SUM(input_tokens), 0) AS totalInput,
      COALESCE(SUM(output_tokens), 0) AS totalOutput,
      COUNT(*) AS callCount
    FROM token_usage
    WHERE conversation_id = ?
  `, conversationId);

  const taskUsage = await dbGet<{ totalInput: number; totalOutput: number }>(`
    SELECT
      COALESCE(SUM(input_tokens), 0) AS totalInput,
      COALESCE(SUM(output_tokens), 0) AS totalOutput
    FROM task_executions
    WHERE conversation_id = ?
  `, conversationId);

  res.json({
    inputTokens: (usage?.totalInput ?? 0) + (taskUsage?.totalInput ?? 0),
    outputTokens: (usage?.totalOutput ?? 0) + (taskUsage?.totalOutput ?? 0),
    callCount: usage?.callCount ?? 0,
  });
});

// DELETE /api/conversations/:id
router.delete('/:id', async (req: Request, res: Response) => {
  const userId = req.user!.userId;

  const conversation = await dbGet<Conversation>(
    'SELECT * FROM conversations WHERE id = ? AND user_id = ?',
    req.params.id, userId
  );

  if (!conversation) { res.status(404).json({ error: 'Conversation not found' }); return; }

  await dbRun('DELETE FROM messages WHERE conversation_id = ?', conversation.id);
  await dbRun('DELETE FROM task_executions WHERE conversation_id = ?', conversation.id);
  await dbRun('DELETE FROM agent_sessions WHERE conversation_id = ?', conversation.id);
  await dbRun('DELETE FROM conversations WHERE id = ?', conversation.id);

  res.json({ success: true });
});

export default router;
