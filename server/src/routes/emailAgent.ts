/**
 * Email Agent routes — proactive email monitoring via persistent SSE.
 * Only available in DEPLOY_MODE=pro-panjit.
 */
import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { authMiddleware } from '../middleware/auth.js';
import { config } from '../config.js';
import { dbGet, dbAll, dbRun } from '../db.js';
import { registerConnection, unregisterConnection, pushEvent, isConnected } from '../services/emailAgentRegistry.js';
import { generateLayer2Analysis } from '../services/emailAgentPoller.js';
import { extractEmailAgentMemory, buildEmailAgentMemoryContext } from '../services/emailAgentMemory.js';
import { resolveClaudeCliPath } from '../services/resolveClaudeCli.js';

const router = Router();
router.use(authMiddleware);

// Gate: only available in pro-panjit mode
router.use((_req: Request, res: Response, next) => {
  if (config.deployMode !== 'pro-panjit') {
    res.status(403).json({ error: 'Not available in this deployment mode' });
    return;
  }
  next();
});

// ─── GET /api/email-agent/events — Persistent SSE connection ───

router.get('/events', async (req: Request, res: Response) => {
  const userId = req.user!.userId;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Register this connection (starts polling + keepalive)
  await registerConnection(userId, res);

  // Clean up on disconnect
  req.on('close', () => {
    unregisterConnection(userId);
  });
});

// ─── POST /api/email-agent/chat — User sends a message ───

router.post('/chat', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { message, emailContext } = req.body as {
    message?: string;
    emailContext?: Array<{
      subject: string; from: string; summary: string;
      priority: string; category: string; receivedAt: string; hasAttachments: boolean;
    }>;
  };

  if (!message?.trim()) {
    res.status(400).json({ error: 'Message is required' });
    return;
  }

  try {
    // Get or create the email-agent conversation
    const conversationId = await getOrCreateConversation(userId);

    // Save user message
    await dbRun(
      'INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)',
      uuidv4(), conversationId, 'user', message.trim()
    );

    // Build context
    const memories = await dbAll<{ content: string }>(
      "SELECT content FROM user_memories WHERE user_id = ? AND memory_type = 'email_agent' ORDER BY created_at DESC LIMIT 10",
      userId
    );
    const memoryBlock = buildEmailAgentMemoryContext(memories);

    // Build email context block from client-provided summaries
    let emailBlock = '';
    if (emailContext?.length) {
      emailBlock = '\n\n## 目前信箱狀態（最新信件摘要）\n' +
        emailContext.map((e, i) =>
          `${i + 1}. [${e.priority}] ${e.summary}\n   寄件者: ${e.from} | 分類: ${e.category} | 時間: ${e.receivedAt}${e.hasAttachments ? ' | 📎 有附件' : ''}`
        ).join('\n') + '\n';
    }

    const recentMessages = await dbAll<{ role: string; content: string }>(
      'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 10',
      conversationId
    );
    const chatHistory = recentMessages.reverse().map(m => {
      const r = m.role === 'user' ? 'User' : 'Assistant';
      const c = m.content.length > 500 ? m.content.substring(0, 500) + '...' : m.content;
      return `[${r}]: ${c}`;
    }).join('\n');

    const prompt = `你是一位專業且貼心的 AI 信件秘書。你的個性是：主動、有洞察力、簡潔有效率。
你能幫助用戶：查看和分析 Outlook 信件、整理待辦、識別重要信件、提供回覆建議、標記資安風險。

回覆規則：
- 用繁體中文，語氣親切專業
- 善用 markdown 格式（**粗體**標重點、列點整理、適當分段）
- 回覆要有洞察力，不只是複述資訊，要給出建議和判斷
- 直接根據下方的信件資料回答用戶問題，不要說你無法存取信箱
- 如果用戶問的問題不在信件資料範圍內，誠實說明
${emailBlock}${memoryBlock}

近期對話紀錄：
${chatHistory}

用戶最新訊息：${message.trim()}`;

    // Spawn Claude CLI and stream response via SSE
    const responseText = await spawnChatClaude(userId, prompt);

    // Save assistant response
    if (responseText) {
      await dbRun(
        'INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)',
        uuidv4(), conversationId, 'assistant', responseText
      );

      // Push complete response
      pushEvent(userId, { type: 'ai_response_done', data: { text: responseText } });

      // Fire-and-forget: extract email agent memories
      const user = await dbGet<{ locale: string }>(
        'SELECT locale FROM users WHERE id = ?', userId
      );
      extractEmailAgentMemory(userId, conversationId, user?.locale || 'zh-TW').catch(() => {});
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[EmailAgent] Chat error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ─── POST /api/email-agent/analyze/:emailId — Layer 2 deep analysis ───

router.post('/analyze/:emailId', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const emailId = req.params.emailId as string;

  if (!isConnected(userId)) {
    res.status(400).json({ error: 'No active SSE connection' });
    return;
  }

  // Fire-and-forget: analysis is pushed via SSE
  generateLayer2Analysis(userId, emailId).catch(err =>
    console.error('[EmailAgent] Layer 2 error:', err)
  );

  res.json({ ok: true, message: 'Analysis started' });
});

// ─── GET /api/email-agent/history — Fetch chat history ───

router.get('/history', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const conversationId = await getOrCreateConversation(userId);

  const messages = await dbAll<{ id: string; role: string; content: string; created_at: string }>(
    'SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 30',
    conversationId
  );

  res.json({ messages: messages.reverse() });
});

// ─── Helpers ───

async function getOrCreateConversation(userId: string): Promise<string> {
  const existing = await dbGet<{ id: string }>(
    "SELECT id FROM conversations WHERE user_id = ? AND category = 'email-agent' LIMIT 1",
    userId
  );
  if (existing) return existing.id;

  const id = uuidv4();
  await dbRun(
    "INSERT INTO conversations (id, user_id, title, category, status) VALUES (?, ?, ?, ?, ?)",
    id, userId, '信件助手', 'email-agent', 'active'
  );
  return id;
}

/**
 * Spawn Claude CLI for chat — collects full response, streams deltas via SSE.
 */
function spawnChatClaude(userId: string, prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    const resolvedCmd = resolveClaudeCliPath(config.claudeCliPath);
    const args = [
      '-p', '--verbose', '--output-format', 'stream-json', '--max-turns', '1',
      '--disallowedTools', 'Bash,Write,Read,Edit,Glob,Grep,Task,TodoWrite,NotebookEdit',
      '--allowedTools', 'WebSearch,WebFetch',
    ];

    const tmpDir = path.join(config.workspaceRoot, '_email_agent');
    fs.mkdirSync(tmpDir, { recursive: true });

    const cleanEnv = { ...process.env };
    for (const key of Object.keys(cleanEnv)) {
      if (key.toUpperCase().startsWith('CLAUDE')) delete cleanEnv[key];
    }

    let proc;
    try {
      proc = spawn(resolvedCmd.bin, [...resolvedCmd.prefix, ...args], {
        cwd: tmpDir, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: cleanEnv,
      });
    } catch { resolve(null); return; }

    proc.stdin!.write(prompt);
    proc.stdin!.end();

    let output = '';
    let stdoutBuffer = '';

    proc.stdout!.on('data', (data: Buffer) => {
      stdoutBuffer += data.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === 'content_block_delta') {
            const delta = parsed.delta;
            if (delta?.type === 'text_delta' && delta.text) {
              output += delta.text;
              // Stream delta to client via SSE
              pushEvent(userId, { type: 'ai_response_delta', data: { text: delta.text } });
            }
          } else if (parsed.type === 'assistant') {
            const content = parsed.message?.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'text' && block.text) output += block.text;
              }
            }
          }
        } catch { /* skip malformed */ }
      }
    });

    proc.stderr!.on('data', () => {});

    const timeout = setTimeout(() => {
      try { proc.kill(); } catch {}
      resolve(output || null);
    }, 60_000);

    proc.on('exit', () => {
      clearTimeout(timeout);
      resolve(output || null);
    });
  });
}

export default router;
