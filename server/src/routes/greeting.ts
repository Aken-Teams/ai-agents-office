import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { dbAll, dbGet } from '../db.js';
import { config } from '../config.js';
import { runClaudeText } from '../services/claudeCli.js';

const router = Router();
router.use(authMiddleware);

// GET /api/greeting — SSE stream a personalized AI greeting
router.get('/', async (req: Request, res: Response) => {

  console.log('[Greeting] Request received');
  const userId = req.user!.userId;

  // Fetch user info
  const user = await dbGet<{ display_name: string; email: string; locale: string }>(
    'SELECT display_name, email, locale FROM users WHERE id = ?', userId
  );
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }

  // Fetch recent conversations (last 5 with summary or latest message)
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
     WHERE c.user_id = ?
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

  // No conversations — return a static welcome (no AI call needed)
  if (recentConversations.length === 0) {
    console.log('[Greeting] New/idle user, sending static welcome');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
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
    // Prefer summary (safe, pre-filtered) over raw message
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

  // Set up SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const keepalive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch { /* closed */ }
  }, 10000);

  const controller = new AbortController();
  let clientClosed = false;
  req.on('close', () => {
    clientClosed = true;
    controller.abort();
  });

  try {
    await runClaudeText({
      model: config.claudeText.greetingModel,
      maxTokens: 600,
      temperature: 0.7,
      system: 'You are a warm, concise professional assistant writing brief, human-feeling greetings. Plain text only — never use markdown.',
      prompt,
      signal: controller.signal,
      onDelta: (delta) => {
        if (clientClosed) return;
        try { res.write(`data: ${JSON.stringify({ type: 'text_delta', data: delta })}\n\n`); }
        catch { /* SSE closed mid-stream */ }
      },
    });
  } catch (err) {
    if (!controller.signal.aborted) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Greeting] runClaudeText failed: ${msg}`);
      try { res.write(`data: ${JSON.stringify({ type: 'error', data: 'Failed to generate greeting' })}\n\n`); }
      catch { /* closed */ }
    }
  } finally {
    clearInterval(keepalive);
    try { res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`); res.end(); }
    catch { /* already closed */ }
  }
});

export default router;
