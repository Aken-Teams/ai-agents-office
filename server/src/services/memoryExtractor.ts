import { v4 as uuidv4 } from 'uuid';
import { dbGet, dbAll, dbRun } from '../db.js';
import { config } from '../config.js';
import { runClaudeText } from './claudeCli.js';

// Thresholds
const MIN_MSGS_FOR_SUMMARY = 1;   // Summary: extract from any conversation
const MIN_MSGS_FOR_MEMORIES = 1;  // Extract from any conversation (safety prompt filters non-work content)
const MAX_MEMORIES_PER_USER = 50;  // Total memory cap per user
const MAX_PER_EXTRACTION = 3;      // Max new memories per extraction (fewer but higher quality)
const EXTRACTION_TIMEOUT_MS = 30_000;

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
  conversationCategory: string = 'document',
): Promise<void> {
  try {
    // Gate: need at least 1 user message for summary
    const msgCount = await dbGet<{ cnt: number }>(
      'SELECT COUNT(*) as cnt FROM messages WHERE conversation_id = ? AND role = ?',
      conversationId, 'user'
    );
    if (!msgCount || msgCount.cnt < MIN_MSGS_FOR_SUMMARY) return;

    // Skip if summary already exists (avoid duplicate extraction)
    // Exception: assistant conversations always re-extract to keep work_log current
    const conv = await dbGet<{ summary: string | null }>(
      'SELECT summary FROM conversations WHERE id = ?', conversationId
    );
    if (conv?.summary && conversationCategory !== 'assistant') return;

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

      // For assistant conversations: upsert a work_log memory (update if exists, insert if new)
      // so cross-assistant context always reflects the latest state
      if (conversationCategory === 'assistant') {
        const existingWorkLog = await dbGet<{ id: string }>(
          "SELECT id FROM user_memories WHERE source_conversation_id = ? AND memory_type = 'work_log'",
          conversationId
        );
        if (existingWorkLog) {
          await dbRun('UPDATE user_memories SET content = ? WHERE id = ?',
            parsed.summary.substring(0, 200), existingWorkLog.id);
          console.log(`[MemoryExtractor] work_log updated for assistant conversation ${conversationId}`);
        } else if (!atMemoryLimit) {
          await dbRun(
            'INSERT INTO user_memories (id, user_id, content, category, memory_type, source_conversation_id) VALUES (?, ?, ?, ?, ?, ?)',
            uuidv4(), userId, parsed.summary.substring(0, 200), 'general', 'work_log', conversationId
          );
          console.log(`[MemoryExtractor] work_log created for assistant conversation ${conversationId}`);
        }
      }
    }

    // Save preference memories
    if (!atMemoryLimit && parsed.memories.length > 0) {
      const validCategories = ['preference', 'company', 'project', 'style', 'general'];
      let saved = 0;
      for (const mem of parsed.memories.slice(0, MAX_PER_EXTRACTION)) {
        if (!mem.content || mem.content.length < 3) continue;
        const category = validCategories.includes(mem.category) ? mem.category : 'general';
        await dbRun(
          'INSERT INTO user_memories (id, user_id, content, category, memory_type, source_conversation_id) VALUES (?, ?, ?, ?, ?, ?)',
          uuidv4(), userId, mem.content.substring(0, 200), category, 'preference', conversationId
        );
        saved++;
      }
      if (saved > 0) {
        console.log(`[MemoryExtractor] ${saved} preference memories saved for user ${userId}`);
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

async function spawnExtractionClaude(prompt: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EXTRACTION_TIMEOUT_MS);
  try {
    const result = await runClaudeText({
      model: config.claudeText.extractionModel,
      maxTokens: 1500,
      temperature: 0.2,
      system: 'You extract structured memory and a short summary from a chat transcript. Output only the requested format. No commentary, no markdown fences unless explicitly requested.',
      prompt,
      signal: controller.signal,
    });
    return result?.text || null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (controller.signal.aborted) {
      console.warn('[MemoryExtractor] Timed out');
    } else {
      console.error(`[MemoryExtractor] extraction failed: ${msg}`);
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
