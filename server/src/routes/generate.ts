import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { spawnClaude } from '../services/claudeCli.js';
import { getSandboxPath } from '../services/sandbox.js';
import { analyzeInput, logSecurityEvent, WARN_THRESHOLD } from '../services/inputGuard.js';
import { recordTokenUsage } from '../services/tokenTracker.js';
import { registerNewFiles, getExistingFilePaths } from '../services/fileManager.js';
import { getUserStorageUsed } from './files.js';
import { getSkill, buildSystemPrompt, loadSkills, getRouterSkill } from '../skills/loader.js';
import { getUserUploadsForPrompt, getConversationFilesForPrompt } from '../services/uploadContext.js';
import { Orchestrator } from '../services/orchestrator.js';
import { config } from '../config.js';
import { checkUserUsageLimit, getStorageQuotaGb } from '../services/usageLimit.js';
import type { Conversation, Message, SSEEvent } from '../types.js';

const router = Router();

// All routes require authentication + rate limiting
router.use(authMiddleware);
router.use(rateLimit);

// Store active abort functions for cancellation
const activeGenerations = new Map<string, () => void>();

// GET /api/generate/skills — List available skills (exclude router from UI list)
router.get('/skills', (_req: Request, res: Response) => {
  const skills = loadSkills();
  const routerExists = skills.some(s => s.role === 'router');

  res.json(skills
    .filter(s => s.role !== 'router')  // Don't show router in skill picker
    .map(s => ({
      id: s.id,
      name: s.name,
      description: s.description,
      fileType: s.fileType,
    }))
    .concat(routerExists ? [{
      id: '',
      name: 'Smart (AI Decides)',
      description: 'AI automatically analyzes your request and chooses the best approach',
      fileType: '',
    }] : [])
  );
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
  const conversationId = req.params.conversationId as string;
  const { message, skillId, uploadIds } = req.body;

  if (!message) {
    res.status(400).json({ error: 'Message is required' });
    return;
  }

  // Verify conversation ownership
  const conversation = db.prepare(
    'SELECT * FROM conversations WHERE id = ? AND user_id = ?'
  ).get(conversationId, userId) as (Conversation & { mode?: string }) | undefined;

  if (!conversation) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }

  // Usage cap check — block generation if user exceeds spending limit
  const usageCheck = checkUserUsageLimit(userId);
  if (usageCheck.exceeded) {
    res.status(403).json({
      error: `您的帳號已超過用量上限（$${usageCheck.cost.toFixed(2)} / $${usageCheck.limit.toFixed(2)}），請聯繫管理者。`,
      code: 'USAGE_EXCEEDED',
    });
    return;
  }

  // Input Guard — multi-layer prompt injection detection (security layer 4)
  const guard = analyzeInput(message);

  if (guard.blocked) {
    logSecurityEvent(userId, 'prompt_injection', 'high',
      `Blocked: flags=[${guard.flags.join(',')}] score=${guard.score}`,
      message);
    res.status(400).json({
      error: '您的訊息包含可疑內容，已被安全系統攔截。請修改後重試。',
      code: 'INPUT_BLOCKED',
      flags: guard.flags,
    });
    return;
  }

  if (!guard.safe) {
    // Warn-level: log but allow through with sanitized content
    logSecurityEvent(userId, 'prompt_injection', 'medium',
      `Warning: flags=[${guard.flags.join(',')}] score=${guard.score}`,
      message);
  }

  const sanitizedMessage = guard.sanitized;

  // Storage quota check — block generation if user is over quota
  const storageUsed = getUserStorageUsed(userId);
  const storageQuotaBytes = getStorageQuotaGb() * 1024 * 1024 * 1024;
  if (storageUsed >= storageQuotaBytes) {
    const usedGB = (storageUsed / (1024 * 1024 * 1024)).toFixed(2);
    const quotaGB = (storageQuotaBytes / (1024 * 1024 * 1024)).toFixed(1);
    res.status(413).json({
      error: `儲存空間已滿（已使用 ${usedGB} GB / ${quotaGB} GB）。請先整理檔案，刪除不需要的文件後再生成新檔案。`,
      code: 'STORAGE_QUOTA_EXCEEDED',
    });
    return;
  }

  // Save user message to DB
  const userMsgId = uuidv4();
  db.prepare(
    'INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)'
  ).run(userMsgId, conversationId, 'user', sanitizedMessage);

  // Determine execution mode:
  // - If user explicitly picked a specific skill (non-empty skillId) → Direct mode
  // - If skillId is empty/null and router skill exists → Orchestrated mode
  // - Backwards compat: existing conversations with a skill_id stay in Direct mode
  const routerSkill = getRouterSkill();
  const useOrchestrator = routerSkill
    && !skillId  // User didn't explicitly pick a skill
    && !conversation.skill_id  // Conversation doesn't have a pinned skill
    && conversation.mode !== 'direct';  // Not forced to direct mode

  // Validate uploadIds (array of strings)
  const validUploadIds: string[] = Array.isArray(uploadIds)
    ? uploadIds.filter((id: unknown) => typeof id === 'string')
    : [];

  // Read user locale for AI language instruction
  const userRow = db.prepare('SELECT locale FROM users WHERE id = ?').get(userId) as { locale: string } | undefined;
  const userLocale = userRow?.locale || 'zh-TW';

  if (useOrchestrator) {
    // === Orchestrated Mode ===
    await handleOrchestrated(req, res, userId, conversationId, sanitizedMessage, validUploadIds, userLocale);
  } else {
    // === Direct Mode (backwards compatible) ===
    handleDirect(req, res, userId, conversationId, conversation, sanitizedMessage, skillId, validUploadIds, userLocale);
  }
});

/**
 * Orchestrated mode: Router Agent analyzes request and delegates to skill agents.
 */
async function handleOrchestrated(
  _req: Request,
  res: Response,
  userId: string,
  conversationId: string,
  message: string,
  uploadIds: string[] = [],
  userLocale: string = 'zh-TW',
) {
  // Setup SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Get existing files (to detect new ones after generation)
  const existingFiles = getExistingFilePaths(conversationId);

  // Update conversation mode
  db.prepare("UPDATE conversations SET mode = 'orchestrated' WHERE id = ?").run(conversationId);

  // Keepalive timer
  const keepaliveTimer = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch { /* connection closed */ }
  }, 10000);

  // SSE writer that forwards events to client
  const sseWriter = (event: SSEEvent) => {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch { /* connection closed */ }
  };

  const orchestrator = new Orchestrator(userId, conversationId, sseWriter, uploadIds, userLocale);

  // Track abort function
  activeGenerations.set(conversationId, () => orchestrator.abort());

  try {
    const result = await orchestrator.run(message);

    // Save assistant message
    if (result.assistantText) {
      const assistantMsgId = uuidv4();
      db.prepare(
        'INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)'
      ).run(assistantMsgId, conversationId, 'assistant', result.assistantText);
    }

    // Record total token usage
    if (result.totalInputTokens > 0 || result.totalOutputTokens > 0) {
      recordTokenUsage({
        userId,
        conversationId,
        inputTokens: result.totalInputTokens,
        outputTokens: result.totalOutputTokens,
        model: result.model,
      });
    }

    // Send usage event
    sseWriter({
      type: 'usage',
      data: {
        inputTokens: result.totalInputTokens,
        outputTokens: result.totalOutputTokens,
        model: result.model,
      },
    });

    // Scan for new files across all agent subdirectories
    const sandboxPath = getSandboxPath(userId, conversationId);
    const newFiles = registerNewFiles(userId, conversationId, sandboxPath, existingFiles);

    if (newFiles.length > 0) {
      sseWriter({
        type: 'file_generated',
        data: newFiles.map(f => ({
          id: f.id,
          filename: f.filename,
          file_type: f.file_type,
          file_size: f.file_size,
        })),
      });
    }
  } catch (err) {
    console.error(`[Generate] Orchestrator error for ${conversationId}:`, err);

    // Fallback: try direct mode
    sseWriter({
      type: 'error',
      data: `Orchestrator failed: ${(err as Error).message}. Falling back to direct mode.`,
    });
  } finally {
    clearInterval(keepaliveTimer);
    activeGenerations.delete(conversationId);
    sseWriter({ type: 'done', data: { exitCode: 0 } });
    res.end();
  }
}

/**
 * Direct mode: single skill agent handles the request (backwards compatible).
 */
function handleDirect(
  _req: Request,
  res: Response,
  userId: string,
  conversationId: string,
  conversation: Conversation,
  sanitizedMessage: string,
  skillId?: string,
  uploadIds: string[] = [],
  userLocale: string = 'zh-TW',
) {
  // Load skill and build system prompt
  const effectiveSkillId = skillId || conversation.skill_id || 'pptx-gen';
  const skill = getSkill(effectiveSkillId);

  if (!skill) {
    res.status(400).json({ error: `Unknown skill: ${effectiveSkillId}` });
    return;
  }

  // Build system prompt with user upload context
  const sandboxPath = getSandboxPath(userId, conversationId);
  const uploadContext = effectiveSkillId === 'rag-analyst'
    ? getConversationFilesForPrompt(userId, sandboxPath, conversationId)
    : getUserUploadsForPrompt(userId, sandboxPath, {
        uploadIds: uploadIds.length > 0 ? uploadIds : undefined,
        conversationId,
      });
  const baseSystemPrompt = buildSystemPrompt(skill, config.generatorsDir, userLocale) + uploadContext;

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
  const sessionId = conversation.session_id || uuidv4();
  if (!isExistingSession) {
    db.prepare('UPDATE conversations SET session_id = ? WHERE id = ?').run(sessionId, conversationId);
  }

  // Keepalive to prevent proxy/connection timeout during long AI processing
  const keepaliveTimer = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch { /* connection closed */ }
  }, 10000);

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
      // If retry was already triggered, suppress all remaining events from failed process
      if (hasRetried) {
        return;
      }

      // Auto-retry: if resume fails, start fresh session immediately
      if (event.type === 'error' && isResume) {
        const errStr = String(event.data || '');
        if (errStr.includes('Session') || errStr.includes('exit') || errStr.includes('code 1')) {
          hasRetried = true;
          console.log(`[Generate] Resume failed for ${conversationId}, retrying with fresh session + history`);
          const freshId = uuidv4();
          db.prepare('UPDATE conversations SET session_id = ? WHERE id = ?').run(freshId, conversationId);
          startClaude(freshId, false);
          return;
        }
      }

      // Forward event to client
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch (err) {
        console.error(`[Generate] SSE write failed for ${conversationId}:`, err);
        clearInterval(keepaliveTimer);
        return;
      }

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
        clearInterval(keepaliveTimer);
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
          try {
            res.write(`data: ${JSON.stringify({
              type: 'file_generated',
              data: newFiles.map(f => ({
                id: f.id,
                filename: f.filename,
                file_type: f.file_type,
                file_size: f.file_size,
              })),
            })}\n\n`);
          } catch { /* connection closed */ }
        }

        res.end();
      }
    });
  }

  startClaude(sessionId, isExistingSession);

  // Handle client disconnect
  res.on('close', () => {
    clearInterval(keepaliveTimer);
    const abortFn = activeGenerations.get(conversationId);
    if (abortFn) {
      activeGenerations.delete(conversationId);
      abortFn();
    }
  });
}

// POST /api/generate/:conversationId/abort — Abort active generation
router.post('/:conversationId/abort', (req: Request, res: Response) => {
  const conversationId = req.params.conversationId as string;
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
