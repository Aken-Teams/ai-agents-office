import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { authMiddleware } from '../middleware/auth.js';
import { dbAll, dbGet } from '../db.js';
import { config } from '../config.js';

const router = Router();
router.use(authMiddleware);

// GET /api/greeting — SSE stream a personalized AI greeting via DeepSeek
router.get('/', async (req: Request, res: Response) => {

  console.log('[Greeting] Request received');
  const userId = req.user!.userId;

  // Fetch user info
  const user = await dbGet<{ display_name: string; email: string; locale: string }>(
    'SELECT display_name, email, locale FROM users WHERE id = ?', userId
  );
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }

  // Fetch recent conversations (last 5 with summary or latest message)
  // Exclude auto-created system conversations (email-agent) so first-login users
  // aren't mistakenly treated as returning users
  const recentConversations = await dbAll<{
    title: string;
    skill_id: string | null;
    created_at: string;
    summary: string | null;
    last_message: string | null;
  }>(
    `SELECT c.title, c.skill_id, c.created_at, c.summary,
       (SELECT content FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user' ORDER BY m.created_at DESC LIMIT 1) AS last_message
     FROM conversations c
     WHERE c.user_id = ? AND (c.category IS NULL OR c.category != 'email-agent')
     ORDER BY c.created_at DESC
     LIMIT 5`,
    userId
  );

  // Fetch user memories for context
  const userMemories = await dbAll<{ content: string }>(
    'SELECT content FROM user_memories WHERE user_id = ? ORDER BY created_at DESC LIMIT 10',
    userId
  );

  // Fetch active announcements (within their start_date ~ end_date window)
  const announcements = await dbAll<{ title: string; content: string }>(
    `SELECT title, content FROM announcements
     WHERE is_active = 1
       AND NOW() BETWEEN start_date AND end_date
     ORDER BY created_at DESC LIMIT 3`
  );

  // Set up SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // No conversations — return a static welcome (no AI call needed)
  if (recentConversations.length === 0) {
    console.log('[Greeting] New/idle user, sending static welcome');
    const welcomeData: Record<string, any> = {
      type: 'welcome',
      userName: user.display_name || user.email.split('@')[0],
    };
    if (announcements.length > 0) {
      welcomeData.announcements = announcements.map(a => a.title);
    }
    res.write(`data: ${JSON.stringify(welcomeData)}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
    return;
  }

  // Build context for the greeting
  const userName = user.display_name || user.email.split('@')[0];
  const locale = user.locale || 'zh-TW';

  console.log(`[Greeting] Found ${recentConversations.length} recent conversations for user ${userName}`);

  const conversationSummary = recentConversations.map((c, i) => {
    const desc = c.summary
      || (c.last_message
        ? (c.last_message.length > 50 ? c.last_message.substring(0, 50) + '...' : c.last_message)
        : '');
    return `${i + 1}. "${c.title}" (${c.skill_id || 'general'}) — ${desc}`;
  }).join('\n');

  const langInstruction = locale === 'en'
    ? 'Respond in English.'
    : locale === 'zh-CN'
      ? 'Respond in Simplified Chinese (简体中文).'
      : 'Respond in Traditional Chinese (繁體中文).';

  const announcementSection = announcements.length > 0
    ? `\n\nNew features/updates to share with the user:\n${announcements.map((a, i) => `${i + 1}. ${a.title}: ${a.content}`).join('\n')}\n- Naturally mention one or two new features in your greeting so the user discovers them\n- Frame it as exciting news, e.g. "By the way, we just added..."`
    : '';

  const memorySection = userMemories.length > 0
    ? `\n\nThings you know about this user from previous conversations:\n${userMemories.map(m => `- ${m.content}`).join('\n')}\nUse this context naturally in your greeting if relevant.`
    : '';

  const prompt = `You are a friendly AI assistant greeting a returning user. ${langInstruction}

The user's name is "${userName}".

SAFETY RULES (CRITICAL — follow strictly):
- ONLY reference work-related conversations (documents, presentations, reports, spreadsheets, data analysis)
- If a conversation title or content seems personal, emotional, negative, or sensitive — skip it entirely, pretend it does not exist
- NEVER mention or ask about anything negative or sensitive: mood, feelings, stress, health, relationships, personal life, resignation, job changes, career plans, complaints, conflicts, salary, or any topic that could embarrass the user in front of colleagues
- If ALL conversations seem personal/sensitive, just give a generic warm professional greeting without referencing any specific work

Their recent conversations:
${conversationSummary}
${memorySection}

Write a warm, concise greeting (2-4 sentences max). Be human, natural, and caring.
- Briefly reference what they've been working on recently
- Ask if they want to continue or need something new
- Keep it short and warm, like a colleague saying hi
- Use line breaks between different ideas for readability (e.g. greeting on one line, project reference on another, question on another)
- Do NOT use markdown formatting (no **, #, -, etc.), just plain text with line breaks
- Do NOT repeat their conversation titles verbatim, paraphrase naturally${announcementSection}`;

  const keepalive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch { /* closed */ }
  }, 10000);

  // Check for API key
  if (!config.deepseekApiKey) {
    console.error('[Greeting] DEEPSEEK_API_KEY not configured');
    clearInterval(keepalive);
    res.write(`data: ${JSON.stringify({ type: 'error', data: 'AI greeting service not configured' })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
    return;
  }

  let aborted = false;
  let abortController: AbortController | null = new AbortController();

  req.on('close', () => {
    aborted = true;
    abortController?.abort();
  });

  // Hard cap: a hung DeepSeek (no response rather than an error) would otherwise
  // hold this request, its socket and its keepalive timer open indefinitely —
  // enough of them pile up into a server-wide problem. Bound it.
  const hardStop = setTimeout(() => abortController?.abort(), 60_000);

  try {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.deepseekApiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        stream: true,
        max_tokens: 300,
        temperature: 0.7,
      }),
      signal: abortController.signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.error(`[Greeting] DeepSeek API error ${response.status}: ${errText}`);
      clearInterval(keepalive);
      res.write(`data: ${JSON.stringify({ type: 'error', data: 'AI 問候服務暫時無法使用' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();
      return;
    }

    const reader = response.body as any;
    if (!reader) throw new Error('No response body');

    // Node fetch returns a ReadableStream; read it as chunks
    let buffer = '';
    for await (const chunk of reader) {
      if (aborted) break;
      buffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            res.write(`data: ${JSON.stringify({ type: 'text_delta', data: delta })}\n\n`);
          }
        } catch { /* skip malformed */ }
      }
    }
  } catch (err: any) {
    if (!aborted) {
      console.error(`[Greeting] DeepSeek call failed: ${err.message}`);
      res.write(`data: ${JSON.stringify({ type: 'error', data: 'AI 問候服務暫時無法使用' })}\n\n`);
    }
  } finally {
    abortController = null;
    clearTimeout(hardStop);
    clearInterval(keepalive);
    if (!aborted) {
      try {
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        res.end();
      } catch { /* already closed */ }
    }
  }
});

export default router;
