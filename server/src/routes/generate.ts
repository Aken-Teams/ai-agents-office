import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { spawnClaude } from '../services/claudeCli.js';
import { sanitizeUserInput, getSandboxPath } from '../services/sandbox.js';
import { recordTokenUsage } from '../services/tokenTracker.js';
import { registerNewFiles, getExistingFilePaths } from '../services/fileManager.js';
import { getSkill, buildSystemPrompt, loadSkills } from '../skills/loader.js';
import { config } from '../config.js';
import type { Conversation, Message, SSEEvent } from '../types.js';

const router = Router();

// All routes require authentication + rate limiting
router.use(authMiddleware);
router.use(rateLimit);

// Store active abort functions for cancellation
const activeGenerations = new Map<string, () => void>();

// GET /api/generate/skills — List available skills
router.get('/skills', (_req: Request, res: Response) => {
  const skills = loadSkills();
  res.json(skills.map(s => ({
    id: s.id,
    name: s.name,
    description: s.description,
    fileType: s.fileType,
  })));
});

/**
 * Build conversation history string for context injection.
 * Used when creating a new session (not resuming) so Claude
 * has memory of previous messages in this conversation.
 */
function buildChatHistory(conversationId: string): string {
  const messages = db.prepare(
    'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC'
  ).all(conversationId) as Pick<Message, 'role' | 'content'>[];

  if (messages.length === 0) return '';

  // Take last N messages to avoid exceeding context limits
  const MAX_HISTORY_MESSAGES = 20;
  const recent = messages.slice(-MAX_HISTORY_MESSAGES);

  const lines = recent.map(m => {
    const role = m.role === 'user' ? 'User' : 'Assistant';
    // Truncate very long messages to save context
    const content = m.content.length > 2000
      ? m.content.substring(0, 2000) + '... (truncated)'
      : m.content;
    return `[${role}]: ${content}`;
  });

  return [
    '',
    '## Previous Conversation History',
    'Below is the conversation so far. Continue from where you left off.',
    'If the user previously requested a document and it was not yet created, create it now.',
    '',
    ...lines,
    '',
    '---',
    '',
  ].join('\n');
}

// POST /api/generate/:conversationId — Stream Claude response via SSE
router.post('/:conversationId', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { conversationId } = req.params;
  const { message, skillId } = req.body;

  if (!message) {
    res.status(400).json({ error: 'Message is required' });
    return;
  }

  // Verify conversation ownership
  const conversation = db.prepare(
    'SELECT * FROM conversations WHERE id = ? AND user_id = ?'
  ).get(conversationId, userId) as Conversation | undefined;

  if (!conversation) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }

  // Sanitize input (security layer 4)
  let sanitizedMessage: string;
  try {
    sanitizedMessage = sanitizeUserInput(message);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
    return;
  }

  // Save user message to DB
  const userMsgId = uuidv4();
  db.prepare(
    'INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)'
  ).run(userMsgId, conversationId, 'user', sanitizedMessage);

  // Load skill and build system prompt
  const effectiveSkillId = skillId || conversation.skill_id || 'pptx-gen';
  const skill = getSkill(effectiveSkillId);

  if (!skill) {
    res.status(400).json({ error: `Unknown skill: ${effectiveSkillId}` });
    return;
  }

  const baseSystemPrompt = buildSystemPrompt(skill, config.generatorsDir);

  // Update conversation skill if changed
  if (skillId && skillId !== conversation.skill_id) {
    db.prepare('UPDATE conversations SET skill_id = ? WHERE id = ?').run(skillId, conversationId);
  }

  // Setup SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Get existing files (to detect new ones after generation)
  const existingFiles = getExistingFilePaths(conversationId);

  // Session management
  const isExistingSession = !!conversation.session_id;
  let sessionId = conversation.session_id || uuidv4();
  if (!isExistingSession) {
    db.prepare('UPDATE conversations SET session_id = ? WHERE id = ?').run(sessionId, conversationId);
  }

  /**
   * Start Claude CLI with the given session parameters.
   * If isResume=true and it fails, auto-retries with a fresh session + chat history.
   */
  function startClaude(sid: string, isResume: boolean) {
    // When NOT resuming, inject conversation history for memory
    let systemPrompt = baseSystemPrompt;
    if (!isResume) {
      const history = buildChatHistory(conversationId);
      if (history) {
        systemPrompt = baseSystemPrompt + history;
      }
    }

    const { emitter, abort } = spawnClaude(sanitizedMessage, systemPrompt, {
      userId,
      conversationId,
      sessionId: sid,
      isResume,
      skillId: effectiveSkillId,
    });

    // Track current abort function
    activeGenerations.set(conversationId, abort);

    let assistantText = '';
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let model = '';
    let hasRetried = false;

    emitter.on('event', (event: SSEEvent) => {
      // Auto-retry: if resume fails, create fresh session with history
      if (event.type === 'error' && isResume && !hasRetried) {
        const errStr = String(event.data || '');
        if (errStr.includes('Session') || errStr.includes('exit') || errStr.includes('code 1')) {
          hasRetried = true;
          console.log(`[Generate] Resume failed for ${conversationId}, retrying with fresh session + history`);
          const freshId = uuidv4();
          db.prepare('UPDATE conversations SET session_id = ? WHERE id = ?').run(freshId, conversationId);
          return; // Don't forward this error
        }
      }

      // When the failed process exits, start fresh
      if (event.type === 'done' && isResume && hasRetried) {
        const row = db.prepare('SELECT session_id FROM conversations WHERE id = ?').get(conversationId) as { session_id: string } | undefined;
        startClaude(row?.session_id || uuidv4(), false);
        return;
      }

      // Forward event to client
      res.write(`data: ${JSON.stringify(event)}\n\n`);

      if (event.type === 'text') {
        assistantText += event.data as string;
      }

      if (event.type === 'usage') {
        const usage = event.data as { inputTokens: number; outputTokens: number; model: string };
        totalInputTokens = usage.inputTokens;
        totalOutputTokens = usage.outputTokens;
        model = usage.model;
      }

      if (event.type === 'session_id') {
        const cliSessionId = event.data as string;
        if (cliSessionId) {
          db.prepare('UPDATE conversations SET session_id = ? WHERE id = ?').run(cliSessionId, conversationId);
        }
      }

      if (event.type === 'done') {
        activeGenerations.delete(conversationId);

        // Save assistant message
        if (assistantText) {
          const assistantMsgId = uuidv4();
          db.prepare(
            'INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)'
          ).run(assistantMsgId, conversationId, 'assistant', assistantText);
        }

        // Record token usage
        if (totalInputTokens > 0 || totalOutputTokens > 0) {
          recordTokenUsage({
            userId,
            conversationId,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            model,
          });
        }

        // Scan for new files (security layer 5)
        const sandboxPath = getSandboxPath(userId, conversationId);
        const newFiles = registerNewFiles(userId, conversationId, sandboxPath, existingFiles);

        if (newFiles.length > 0) {
          res.write(`data: ${JSON.stringify({
            type: 'file_generated',
            data: newFiles.map(f => ({
              id: f.id,
              filename: f.filename,
              file_type: f.file_type,
              file_size: f.file_size,
            })),
          })}\n\n`);
        }

        res.end();
      }
    });
  }

  startClaude(sessionId, isExistingSession);

  // Handle client disconnect
  res.on('close', () => {
    const abortFn = activeGenerations.get(conversationId);
    if (abortFn) {
      activeGenerations.delete(conversationId);
      abortFn();
    }
  });
});

// POST /api/generate/:conversationId/abort — Abort active generation
router.post('/:conversationId/abort', (req: Request, res: Response) => {
  const { conversationId } = req.params;
  const abortFn = activeGenerations.get(conversationId);

  if (abortFn) {
    abortFn();
    activeGenerations.delete(conversationId);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'No active generation for this conversation' });
  }
});

export default router;
