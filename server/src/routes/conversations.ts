import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { dbGet, dbAll, dbRun } from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { config } from '../config.js';
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
  const { title, skillId, category, system_prompt, icon } = req.body;
  const id = uuidv4();

  const effectiveSkillId = skillId || null;
  const mode = effectiveSkillId ? 'direct' : null;
  const effectiveCategory = category === 'assistant' ? 'assistant' : 'document';
  await dbRun(
    'INSERT INTO conversations (id, user_id, title, skill_id, mode, category, system_prompt, icon) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id, userId, title || 'New Conversation', effectiveSkillId, mode, effectiveCategory,
    system_prompt || null, icon || null
  );

  const conversation = await dbGet<Conversation>('SELECT * FROM conversations WHERE id = ? AND user_id = ?', id, userId);
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
  const { title, status, system_prompt, icon, skill_id } = req.body;

  const conversation = await dbGet<Conversation>(
    'SELECT * FROM conversations WHERE id = ? AND user_id = ?',
    req.params.id, userId
  );

  if (!conversation) { res.status(404).json({ error: 'Conversation not found' }); return; }

  if (title) await dbRun('UPDATE conversations SET title = ? WHERE id = ? AND user_id = ?', title, conversation.id, userId);
  if (status) await dbRun('UPDATE conversations SET status = ? WHERE id = ? AND user_id = ?', status, conversation.id, userId);
  if (system_prompt !== undefined) await dbRun('UPDATE conversations SET system_prompt = ? WHERE id = ? AND user_id = ?', system_prompt || null, conversation.id, userId);
  if (icon !== undefined) await dbRun('UPDATE conversations SET icon = ? WHERE id = ? AND user_id = ?', icon || null, conversation.id, userId);
  if (skill_id !== undefined) {
    await dbRun('UPDATE conversations SET skill_id = ? WHERE id = ? AND user_id = ?', skill_id || null, conversation.id, userId);
    // When skill is bound, set mode to direct; when unbound, allow orchestrator
    await dbRun('UPDATE conversations SET mode = ? WHERE id = ? AND user_id = ?', skill_id ? 'direct' : null, conversation.id, userId);
  }

  const updated = await dbGet('SELECT * FROM conversations WHERE id = ? AND user_id = ?', conversation.id, userId);
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

  await dbRun('DELETE FROM messages WHERE conversation_id = ? AND conversation_id IN (SELECT id FROM conversations WHERE user_id = ?)', conversation.id, userId);
  await dbRun('DELETE FROM task_executions WHERE conversation_id = ? AND conversation_id IN (SELECT id FROM conversations WHERE user_id = ?)', conversation.id, userId);
  await dbRun('DELETE FROM agent_sessions WHERE conversation_id = ? AND conversation_id IN (SELECT id FROM conversations WHERE user_id = ?)', conversation.id, userId);
  await dbRun('DELETE FROM conversations WHERE id = ? AND user_id = ?', conversation.id, userId);

  res.json({ success: true });
});

// POST /api/conversations/generate-role — generate role description via DeepSeek
router.post('/generate-role', async (req: Request, res: Response) => {
  if (!config.deepseekApiKey) {
    res.status(503).json({ error: 'AI service not configured' });
    return;
  }

  const { name, skillId, locale, currentPrompt } = req.body;
  if (!name) { res.status(400).json({ error: 'name is required' }); return; }

  const langHint = locale === 'en' ? 'Respond in English.' : locale === 'zh-CN' ? '用简体中文回覆。' : '用繁體中文回覆。';
  const skillHint = skillId ? `此助手綁定了「${skillId}」技能，請根據此技能的特性來描述角色。` : '';
  const existingHint = currentPrompt
    ? `\n用戶已寫了以下草稿描述，請以此為基礎來優化和擴展，保留用戶的核心意圖：\n「${currentPrompt}」\n`
    : '';

  const prompt = `你是一個 AI 助手角色描述產生器。根據以下資訊，產生一段簡潔、專業的角色描述（system prompt），用來設定 AI 助手的行為和風格。

助手名稱：${name}
${skillHint}${existingHint}
要求：
- 直接輸出角色描述文字，不要加標題或引號
- 描述長度在 80-200 字之間
- 包含：角色定位、專長領域、回答風格
- 語氣專業但友善
- ${langHint}`;

  try {
    const dsRes = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.deepseekApiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: 500,
      }),
    });

    if (!dsRes.ok) {
      console.error('DeepSeek error:', await dsRes.text());
      res.status(502).json({ error: 'AI service error' });
      return;
    }

    const data = await dsRes.json() as { choices: Array<{ message: { content: string } }> };
    const text = data.choices?.[0]?.message?.content?.trim() || '';
    res.json({ text });
  } catch (err) {
    console.error('DeepSeek request failed:', err);
    res.status(502).json({ error: 'AI service unavailable' });
  }
});

export default router;
