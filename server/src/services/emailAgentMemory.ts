/**
 * Email Agent Memory — independent memory extraction for the email agent.
 * Stores memories with memory_type='email_agent', separate from general preferences.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { dbGet, dbAll, dbRun } from '../db.js';
import { config } from '../config.js';
import { resolveClaudeCliPath } from './resolveClaudeCli.js';

const MAX_EMAIL_AGENT_MEMORIES = 30;
const MAX_PER_EXTRACTION = 2;
const EXTRACTION_TIMEOUT_MS = 20_000;

function spawnExtractionClaude(prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    const resolvedCmd = resolveClaudeCliPath(config.claudeCliPath);
    const args = [
      '-p', '--verbose', '--output-format', 'stream-json', '--max-turns', '1',
      '--disallowedTools', 'Bash,Write,Read,Edit,WebSearch,WebFetch,Glob,Grep,Task,TodoWrite,NotebookEdit',
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
            if (delta?.type === 'text_delta' && delta.text) output += delta.text;
          } else if (parsed.type === 'assistant') {
            const content = parsed.message?.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'text' && block.text) output += block.text;
              }
            }
          }
        } catch { /* skip */ }
      }
    });

    proc.stderr!.on('data', () => {});

    const timeout = setTimeout(() => {
      try { proc.kill(); } catch {}
      resolve(output || null);
    }, EXTRACTION_TIMEOUT_MS);

    proc.on('exit', () => {
      clearTimeout(timeout);
      resolve(output || null);
    });
  });
}

/**
 * Build memory context string for injection into email agent prompts.
 */
export function buildEmailAgentMemoryContext(memories: { content: string }[]): string {
  if (!memories.length) return '';
  return '\n\n## 你的信件偏好（從過往互動學習）\n' +
    memories.map(m => `- ${m.content}`).join('\n') + '\n';
}

/**
 * Extract email agent memories from a chat interaction. Fire-and-forget.
 */
export async function extractEmailAgentMemory(
  userId: string,
  conversationId: string,
  locale: string = 'zh-TW',
): Promise<void> {
  try {
    // Check memory quota
    const memCount = await dbGet<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM user_memories WHERE user_id = ? AND memory_type = 'email_agent'",
      userId
    );
    if ((memCount?.cnt ?? 0) >= MAX_EMAIL_AGENT_MEMORIES) return;

    // Fetch recent chat messages
    const messages = await dbAll<{ role: string; content: string }>(
      'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 10',
      conversationId
    );
    if (!messages.length) return;

    // Fetch existing email agent memories for dedup
    const existing = await dbAll<{ content: string }>(
      "SELECT content FROM user_memories WHERE user_id = ? AND memory_type = 'email_agent' ORDER BY created_at DESC LIMIT 20",
      userId
    );

    const chatText = messages.reverse().map(m => {
      const role = m.role === 'user' ? 'User' : 'Assistant';
      const content = m.content.length > 400 ? m.content.substring(0, 400) + '...' : m.content;
      return `[${role}]: ${content}`;
    }).join('\n');

    const existingText = existing.length > 0
      ? `\n既有記憶（不要重複）:\n${existing.map(m => `- ${m.content}`).join('\n')}`
      : '';

    const langLabel = locale === 'en' ? 'English' : locale === 'zh-CN' ? '简体中文' : '繁體中文';

    const prompt = `你是信件偏好萃取系統。分析以下信件助手對話，萃取最多 ${MAX_PER_EXTRACTION} 條值得記住的事實。

要萃取（跨對話有用的高價值資訊）：
- 用戶特別關注的寄件者或網域
- 用戶在意的信件類型（合約、資安、特定專案）
- 用戶看信的時間模式或優先順序
- 用戶對信件處理的偏好（如：某類信件不用通知）

不要萃取：
- 具體信件內容（隱私）
- 一次性的動作
- 已存在的記憶
${existingText}

語言規則：所有記憶必須用${langLabel}撰寫

回傳 JSON（不要 markdown 包裝）：
{"memories":[{"content":"...","category":"sender_priority|email_pattern|general"}]}

對話：
${chatText}`;

    const output = await spawnExtractionClaude(prompt);
    if (!output) return;

    // Parse
    let parsed: { memories: Array<{ content: string; category: string }> } | null = null;
    try {
      const jsonMatch = output.match(/\{[\s\S]*"memories"[\s\S]*\}/);
      if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
    } catch { return; }

    if (!parsed?.memories?.length) return;

    const validCategories = ['sender_priority', 'email_pattern', 'general'];
    let saved = 0;
    for (const mem of parsed.memories.slice(0, MAX_PER_EXTRACTION)) {
      if (!mem.content || mem.content.length < 3) continue;
      const category = validCategories.includes(mem.category) ? mem.category : 'general';
      await dbRun(
        'INSERT INTO user_memories (id, user_id, content, category, memory_type, source_conversation_id) VALUES (?, ?, ?, ?, ?, ?)',
        uuidv4(), userId, mem.content.substring(0, 200), category, 'email_agent', conversationId
      );
      saved++;
    }
    if (saved > 0) {
      console.log(`[EmailAgentMemory] ${saved} memories saved for user ${userId}`);
    }
  } catch (err) {
    console.error(`[EmailAgentMemory] Error:`, err);
  }
}
