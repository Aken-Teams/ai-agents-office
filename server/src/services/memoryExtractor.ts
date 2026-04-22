import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { dbGet, dbAll, dbRun } from '../db.js';
import { config } from '../config.js';

// Thresholds
const MIN_MSGS_FOR_SUMMARY = 1;   // Summary: extract from any conversation
const MIN_MSGS_FOR_MEMORIES = 1;  // Extract from any conversation (safety prompt filters non-work content)
const MAX_MEMORIES_PER_USER = 50;  // Total memory cap per user
const MAX_PER_EXTRACTION = 3;      // Max new memories per extraction (fewer but higher quality)
const EXTRACTION_TIMEOUT_MS = 30_000;

/**
 * Resolve the Claude CLI to a direct node invocation.
 * (Same pattern as greeting.ts / claudeCli.ts)
 */
function resolveClaudeCliPath(cliPath: string): { bin: string; prefix: string[] } {
  if (cliPath.endsWith('.js')) {
    return { bin: process.execPath, prefix: [cliPath] };
  }
  try {
    const npmPrefix = execSync('npm prefix -g', { encoding: 'utf-8' }).trim();
    const cliScript = path.join(npmPrefix, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    if (fs.existsSync(cliScript)) {
      return { bin: process.execPath, prefix: [cliScript] };
    }
  } catch { /* fall through */ }
  return { bin: cliPath, prefix: [] };
}

interface ExtractionResult {
  summary: string;
  memories: Array<{ content: string; category: string }>;
}

/**
 * Fire-and-forget: extract a conversation summary + user memories.
 * Called after a conversation's 'done' event. Never blocks the response.
 */
export async function extractMemoryAndSummary(
  userId: string,
  conversationId: string,
  locale: string = 'zh-TW',
): Promise<void> {
  try {
    // Gate: need at least 1 user message for summary
    const msgCount = await dbGet<{ cnt: number }>(
      'SELECT COUNT(*) as cnt FROM messages WHERE conversation_id = ? AND role = ?',
      conversationId, 'user'
    );
    if (!msgCount || msgCount.cnt < MIN_MSGS_FOR_SUMMARY) return;

    // Skip if summary already exists (avoid duplicate extraction)
    const conv = await dbGet<{ summary: string | null }>(
      'SELECT summary FROM conversations WHERE id = ?', conversationId
    );
    if (conv?.summary) return;

    // Only extract memories if enough user messages
    const skipMemories = msgCount.cnt < MIN_MSGS_FOR_MEMORIES;

    // Check memory quota
    const memCount = await dbGet<{ cnt: number }>(
      'SELECT COUNT(*) as cnt FROM user_memories WHERE user_id = ?', userId
    );
    const atMemoryLimit = skipMemories || (memCount?.cnt ?? 0) >= MAX_MEMORIES_PER_USER;

    // Fetch conversation messages for context
    const messages = await dbAll<{ role: string; content: string }>(
      'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 20',
      conversationId
    );

    // Fetch existing memories for deduplication
    const existingMemories = await dbAll<{ content: string }>(
      'SELECT content FROM user_memories WHERE user_id = ? ORDER BY created_at DESC LIMIT 20',
      userId
    );

    const conversationText = messages.map(m => {
      const role = m.role === 'user' ? 'User' : 'Assistant';
      const content = m.content.length > 500 ? m.content.substring(0, 500) + '...' : m.content;
      return `[${role}]: ${content}`;
    }).join('\n');

    const existingText = existingMemories.length > 0
      ? `\nExisting memories (do NOT duplicate these):\n${existingMemories.map(m => `- ${m.content}`).join('\n')}`
      : '';

    const prompt = buildExtractionPrompt(conversationText, existingText, atMemoryLimit, locale);

    // Spawn Claude CLI to extract
    const output = await spawnExtractionClaude(prompt);
    if (!output) return;

    const parsed = parseExtractionResult(output);
    if (!parsed) return;

    // Save summary
    if (parsed.summary) {
      await dbRun(
        'UPDATE conversations SET summary = ? WHERE id = ?',
        parsed.summary.substring(0, 500), conversationId
      );
      console.log(`[MemoryExtractor] Summary saved for conversation ${conversationId}`);
    }

    // Save memories
    if (!atMemoryLimit && parsed.memories.length > 0) {
      const validCategories = ['preference', 'company', 'project', 'style', 'general'];
      let saved = 0;
      for (const mem of parsed.memories.slice(0, MAX_PER_EXTRACTION)) {
        if (!mem.content || mem.content.length < 3) continue;
        const category = validCategories.includes(mem.category) ? mem.category : 'general';
        await dbRun(
          'INSERT INTO user_memories (id, user_id, content, category, source_conversation_id) VALUES (?, ?, ?, ?, ?)',
          uuidv4(), userId, mem.content.substring(0, 200), category, conversationId
        );
        saved++;
      }
      if (saved > 0) {
        console.log(`[MemoryExtractor] ${saved} memories saved for user ${userId}`);
      }
    }
  } catch (err) {
    console.error(`[MemoryExtractor] Error for conversation ${conversationId}:`, err);
  }
}

const LOCALE_LABELS: Record<string, string> = {
  'zh-TW': '繁體中文',
  'zh-CN': '简体中文',
  'en': 'English',
};

function buildExtractionPrompt(
  conversationText: string,
  existingMemoriesText: string,
  skipMemories: boolean,
  locale: string,
): string {
  const lang = LOCALE_LABELS[locale] || LOCALE_LABELS['zh-TW'];
  return `You are a memory extraction system. Analyze this conversation and produce:

1. A 1-line summary (max 100 chars) describing what work was done. Focus on the document type and topic.
2. ${skipMemories ? 'SKIP memories — user is at storage limit. Return empty memories array.' : 'Up to 3 facts worth remembering about this user that would be useful across MANY future conversations.'}

WHAT TO EXTRACT (high value, reusable across future conversations):
- Company name, team name, industry, domain
- Recurring project names or product names
- Style and quality preferences inferred from the user's requests (e.g. user asked for "professional clean report" → remember "documents should feel professional with clean formatting")
- Visual preferences like color schemes, layout styles, tone of writing

WHAT NOT TO EXTRACT:
- File format choices (e.g. "prefers Word" or "prefers PPT") — users pick formats from templates per task, this is NOT a preference
- Task-specific document structure (e.g. "PRD has 8 sections") — this is about the task, not the user
- Language or locale preferences — controlled by system settings
- Personal opinions, emotions, relationships, health, political views, complaints, or anything sensitive

KEY PRINCIPLE: Focus on HOW the user wants things done (style, quality, tone), not WHAT format they used. A user choosing Word template doesn't mean they prefer Word — but asking for "clean professional formatting" tells you about their style preference. When in doubt, do NOT extract — return an empty memories array.

LANGUAGE RULE:
- Both summary and memory content MUST be written in ${lang}
${existingMemoriesText}

Output EXACTLY in this JSON format (no markdown fences, no explanation, just raw JSON):
{"summary":"...","memories":[{"content":"...","category":"preference|company|project|style|general"}]}

Conversation:
${conversationText}`;
}

function parseExtractionResult(text: string): ExtractionResult | null {
  try {
    // Extract JSON from response (Claude may wrap it in text)
    const jsonMatch = text.match(/\{[\s\S]*"summary"[\s\S]*"memories"[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      memories: Array.isArray(parsed.memories)
        ? parsed.memories.filter((m: any) =>
            typeof m.content === 'string' && m.content.length >= 3 &&
            typeof m.category === 'string'
          )
        : [],
    };
  } catch {
    return null;
  }
}

function spawnExtractionClaude(prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    const resolvedCmd = resolveClaudeCliPath(config.claudeCliPath);
    const args = [
      '-p',
      '--verbose',
      '--output-format', 'stream-json',
      '--max-turns', '1',
      '--disallowedTools', 'Bash,Write,Read,Edit,WebSearch,WebFetch,Glob,Grep,Task,TodoWrite,NotebookEdit',
    ];

    const tmpDir = path.join(config.workspaceRoot, '_memory');
    fs.mkdirSync(tmpDir, { recursive: true });

    const cleanEnv = { ...process.env };
    for (const key of Object.keys(cleanEnv)) {
      if (key.toUpperCase().startsWith('CLAUDE')) delete cleanEnv[key];
    }

    let proc;
    try {
      proc = spawn(resolvedCmd.bin, [...resolvedCmd.prefix, ...args], {
        cwd: tmpDir,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: cleanEnv,
      });
    } catch {
      resolve(null);
      return;
    }

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

    proc.stderr!.on('data', (data: Buffer) => {
      console.error(`[MemoryExtractor stderr] ${data.toString().trim()}`);
    });

    const timeout = setTimeout(() => {
      try { proc.kill(); } catch { /* already dead */ }
      console.warn('[MemoryExtractor] Timed out');
      resolve(null);
    }, EXTRACTION_TIMEOUT_MS);

    proc.on('exit', () => {
      clearTimeout(timeout);
      resolve(output || null);
    });
  });
}
