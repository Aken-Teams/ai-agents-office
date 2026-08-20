import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { dbAll, dbGet } from '../db.js';
import { auxChatStream } from '../services/auxLlm.js';

const router = Router();
router.use(authMiddleware);

// GET /api/greeting — SSE stream a personalized AI greeting via the aux LLM
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

  // ONE writer for this response, and it stops for good once the stream is
  // finished or the client has gone.
  //
  // Node reports a write-after-end ASYNCHRONOUSLY — as an error event, not a
  // throw — so wrapping res.write() in try/catch cannot save you; the only fix is
  // not to write. The old code ended the response on an API error and then let
  // `finally` write `done` on the way out, which crashed the process with
  // ERR_STREAM_WRITE_AFTER_END every time a provider answered 401.
  let closed = false;
  const send = (payload: unknown) => {
    if (closed) return;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  const keepalive = setInterval(() => {
    if (!closed) res.write(': keepalive\n\n');
  }, 10000);
  const finish = () => {
    if (closed) return;
    closed = true;
    clearInterval(keepalive);
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
  };

  const clientGone = new AbortController();
  req.on('close', () => {
    // The reader left. Stop generating for them, and never write again.
    closed = true;
    clearInterval(keepalive);
    clientGone.abort();
  });

  // A greeting runs on the aux LLM chain (on-prem first, DeepSeek second). It
  // deliberately has no Claude CLI fallback: this is a hello, not a deliverable,
  // and it is not worth an agent spawn.
  const aux = await auxChatStream({
    user: prompt,
    onText: (delta) => send({ type: 'text_delta', data: delta }),
    maxTokens: 300,
    temperature: 0.7,
    timeoutMs: 60_000,
    feature: 'greeting',
    billTo: { userId },
    signal: clientGone.signal,
  });

  if (!aux) {
    // Every provider is down. Greet them anyway — a warm generic line reads far
    // better than telling someone their greeting service is broken.
    console.warn('[Greeting] No aux LLM answered — falling back to a static greeting');
    send({
      type: 'text_delta',
      data: locale === 'en'
        ? `Welcome back, ${userName}!\n\nWhat would you like to work on today?`
        : locale === 'zh-CN'
          ? `${userName}，欢迎回来！\n\n今天想处理什么呢？`
          : `${userName}，歡迎回來！\n\n今天想處理什麼呢？`,
    });
  }
  finish();
});

export default router;
