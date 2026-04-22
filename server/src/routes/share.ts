import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { dbGet, dbAll, dbRun } from '../db.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();

// ── Authenticated endpoints ──────────────────────────────────

// GET /api/share/:conversationId/status — check if conversation is shared
router.get('/:conversationId/status', authMiddleware, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { conversationId } = req.params;

  // Verify ownership
  const conv = await dbGet('SELECT id FROM conversations WHERE id = ? AND user_id = ?', conversationId, userId);
  if (!conv) { res.status(404).json({ error: 'Conversation not found' }); return; }

  const share = await dbGet<{ token: string }>('SELECT token FROM conversation_shares WHERE conversation_id = ? AND user_id = ?', conversationId, userId);
  res.json({ shared: !!share, token: share?.token || null });
});

// POST /api/share/:conversationId — create share link
router.post('/:conversationId', authMiddleware, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { conversationId } = req.params;

  // Verify ownership
  const conv = await dbGet('SELECT id FROM conversations WHERE id = ? AND user_id = ?', conversationId, userId);
  if (!conv) { res.status(404).json({ error: 'Conversation not found' }); return; }

  // Check if already shared
  const existing = await dbGet<{ token: string }>('SELECT token FROM conversation_shares WHERE conversation_id = ? AND user_id = ?', conversationId, userId);
  if (existing) {
    res.json({ token: existing.token });
    return;
  }

  // Short URL-friendly token: 8 chars base62 (62^8 ≈ 218 trillion combinations)
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(8);
  const token = Array.from(bytes).map(b => chars[b % chars.length]).join('');
  await dbRun(
    'INSERT INTO conversation_shares (id, conversation_id, user_id, token) VALUES (?, ?, ?, ?)',
    uuidv4(), conversationId, userId, token
  );

  res.status(201).json({ token });
});

// DELETE /api/share/:conversationId — remove share link
router.delete('/:conversationId', authMiddleware, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { conversationId } = req.params;

  const conv = await dbGet('SELECT id FROM conversations WHERE id = ? AND user_id = ?', conversationId, userId);
  if (!conv) { res.status(404).json({ error: 'Conversation not found' }); return; }

  await dbRun('DELETE FROM conversation_shares WHERE conversation_id = ? AND user_id = ?', conversationId, userId);
  res.json({ success: true });
});

// ── Public endpoint (no auth) ────────────────────────────────

// GET /api/share/view/:token — view shared conversation
router.get('/view/:token', async (req: Request, res: Response) => {
  const { token } = req.params;

  const share = await dbGet<{ conversation_id: string; user_id: string }>(
    'SELECT conversation_id, user_id FROM conversation_shares WHERE token = ?',
    token
  );

  if (!share) {
    res.status(404).json({ error: 'Shared conversation not found or has been removed' });
    return;
  }

  const conversation = await dbGet<{ id: string; title: string; skill_id: string | null; created_at: string }>(
    'SELECT id, title, skill_id, created_at FROM conversations WHERE id = ?',
    share.conversation_id
  );

  if (!conversation) {
    res.status(404).json({ error: 'Conversation no longer exists' });
    return;
  }

  const messages = await dbAll<{ id: string; role: string; content: string; created_at: string }>(
    'SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC',
    share.conversation_id
  );

  const user = await dbGet<{ display_name: string | null; email: string }>(
    'SELECT display_name, email FROM users WHERE id = ?',
    share.user_id
  );

  res.json({
    conversation,
    messages,
    sharedBy: user?.display_name || user?.email || 'Unknown',
  });
});

export default router;
