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
import type { Conversation, SSEEvent } from '../types.js';

const router = Router();

// All routes require authentication + rate limiting
router.use(authMiddleware);
router.use(rateLimit);

// Store active generations for abort
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

  const systemPrompt = buildSystemPrompt(skill, config.generatorsDir);

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

  // Spawn Claude CLI
  // First message: create new session (--session-id)
  // Subsequent messages: resume existing session (--resume)
  const isExistingSession = !!conversation.session_id;
  const sessionId = conversation.session_id || uuidv4();
  if (!isExistingSession) {
    db.prepare('UPDATE conversations SET session_id = ? WHERE id = ?').run(sessionId, conversationId);
  }

  const { emitter, abort } = spawnClaude(sanitizedMessage, systemPrompt, {
    userId,
    conversationId,
    sessionId,
    isResume: isExistingSession,
    skillId: effectiveSkillId,
  });

  // Store abort function for potential cancellation
  activeGenerations.set(conversationId, abort);

  // Accumulate assistant response
  let assistantText = '';
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let model = '';

  // Forward events as SSE
  emitter.on('event', (event: SSEEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);

    // Accumulate text for saving
    if (event.type === 'text') {
      assistantText += event.data as string;
    }

    // Track token usage
    if (event.type === 'usage') {
      const usage = event.data as { inputTokens: number; outputTokens: number; model: string };
      totalInputTokens = usage.inputTokens;
      totalOutputTokens = usage.outputTokens;
      model = usage.model;
    }

    // Capture session_id from Claude CLI (may differ from what we passed)
    if (event.type === 'session_id') {
      const cliSessionId = event.data as string;
      if (cliSessionId && cliSessionId !== sessionId) {
        db.prepare('UPDATE conversations SET session_id = ? WHERE id = ?').run(cliSessionId, conversationId);
      }
    }

    // On completion
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

  // Handle client disconnect — use res.on('close') not req.on('close')
  // req.on('close') fires when request body is consumed (immediately for POST),
  // while res.on('close') fires when the SSE connection is actually terminated.
  res.on('close', () => {
    if (activeGenerations.has(conversationId)) {
      activeGenerations.delete(conversationId);
      abort();
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
