import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { dbGet, dbAll, dbRun } from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { spawnClaude } from '../services/claudeCli.js';
import { getSandboxPath } from '../services/sandbox.js';
import { analyzeInput, logSecurityEvent, WARN_THRESHOLD } from '../services/inputGuard.js';
import { recordTokenUsage } from '../services/tokenTracker.js';
import { registerNewFiles, getExistingFilePaths, snapshotExistingFiles } from '../services/fileManager.js';
import { getUserStorageUsed } from './files.js';
import { getSkill, buildSystemPrompt, loadSkills, getRouterSkill } from '../skills/loader.js';
import { getUserUploadsForPrompt, getConversationFilesForPrompt } from '../services/uploadContext.js';
import { Orchestrator } from '../services/orchestrator.js';
import { config } from '../config.js';
import { checkUserUsageLimit, getStorageQuotaGb } from '../services/usageLimit.js';
import type { Conversation, Message, SSEEvent } from '../types.js';

const router = Router();

router.use(authMiddleware);
router.use(rateLimit);

const activeGenerations = new Map<string, () => void>();

// GET /api/generate/skills
router.get('/skills', (_req: Request, res: Response) => {
  const skills = loadSkills();
  const routerExists = skills.some(s => s.role === 'router');

  res.json(skills
    .filter(s => s.role !== 'router')
    .map(s => ({ id: s.id, name: s.name, description: s.description, fileType: s.fileType }))
    .concat(routerExists ? [{ id: '', name: 'Smart (AI Decides)', description: 'AI automatically analyzes your request and chooses the best approach', fileType: '' }] : [])
  );
});

/**
 * Build conversation history string for context injection.
 */
async function buildChatHistory(conversationId: string): Promise<string> {
  const messages = await dbAll<Pick<Message, 'role' | 'content'>>(
    'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC',
    conversationId
  );

  if (messages.length === 0) return '';

  const MAX_HISTORY_MESSAGES = 20;
  const recent = messages.slice(-MAX_HISTORY_MESSAGES);

  const lines = recent.map(m => {
    const role = m.role === 'user' ? 'User' : 'Assistant';
    const content = m.content.length > 2000
      ? m.content.substring(0, 2000) + '... (truncated)'
      : m.content;
    return `[${role}]: ${content}`;
  });

  return [
    '', '## Previous Conversation History',
    'Below is the conversation so far. Continue from where you left off.',
    'If the user previously requested a document and it was not yet created, create it now.',
    '', ...lines, '', '---', '',
  ].join('\n');
}

// POST /api/generate/:conversationId
router.post('/:conversationId', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const conversationId = req.params.conversationId as string;
  const { message, skillId, uploadIds } = req.body;

  if (!message) { res.status(400).json({ error: 'Message is required' }); return; }

  const conversation = await dbGet<Conversation & { mode?: string }>(
    'SELECT * FROM conversations WHERE id = ? AND user_id = ?',
    conversationId, userId
  );
  if (!conversation) { res.status(404).json({ error: 'Conversation not found' }); return; }

  const usageCheck = await checkUserUsageLimit(userId);
  if (usageCheck.exceeded) {
    res.status(403).json({
      error: `您的帳號已超過用量上限（$${usageCheck.cost.toFixed(2)} / $${usageCheck.limit.toFixed(2)}），請聯繫管理者。`,
      code: 'USAGE_EXCEEDED',
    }); return;
  }

  const guard = analyzeInput(message);
  if (guard.blocked) {
    logSecurityEvent(userId, 'prompt_injection', 'high',
      `Blocked: flags=[${guard.flags.join(',')}] score=${guard.score}`, message);
    res.status(400).json({ error: '您的訊息包含可疑內容，已被安全系統攔截。請修改後重試。', code: 'INPUT_BLOCKED', flags: guard.flags }); return;
  }
  if (!guard.safe) {
    logSecurityEvent(userId, 'prompt_injection', 'medium',
      `Warning: flags=[${guard.flags.join(',')}] score=${guard.score}`, message);
  }

  const sanitizedMessage = guard.sanitized;

  const storageUsed = await getUserStorageUsed(userId);
  const storageQuotaBytes = (await getStorageQuotaGb()) * 1024 * 1024 * 1024;
  if (storageUsed >= storageQuotaBytes) {
    const usedGB = (storageUsed / (1024 * 1024 * 1024)).toFixed(2);
    const quotaGB = (storageQuotaBytes / (1024 * 1024 * 1024)).toFixed(1);
    res.status(413).json({
      error: `儲存空間已滿（已使用 ${usedGB} GB / ${quotaGB} GB）。請先整理檔案，刪除不需要的文件後再生成新檔案。`,
      code: 'STORAGE_QUOTA_EXCEEDED',
    }); return;
  }

  const userMsgId = uuidv4();
  await dbRun(
    'INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)',
    userMsgId, conversationId, 'user', sanitizedMessage
  );

  const routerSkill = getRouterSkill();
  const useOrchestrator = routerSkill
    && !skillId
    && !conversation.skill_id
    && conversation.mode !== 'direct';

  const validUploadIds: string[] = Array.isArray(uploadIds)
    ? uploadIds.filter((id: unknown) => typeof id === 'string')
    : [];

  if (validUploadIds.length > 0) {
    const placeholders = validUploadIds.map(() => '?').join(',');
    await dbRun(
      `UPDATE user_uploads SET conversation_id = ? WHERE id IN (${placeholders}) AND user_id = ? AND conversation_id IS NULL`,
      conversationId, ...validUploadIds, userId
    );
  }

  const userRow = await dbGet<{ locale: string }>('SELECT locale FROM users WHERE id = ?', userId);
  const userLocale = userRow?.locale || 'zh-TW';

  if (useOrchestrator) {
    await handleOrchestrated(req, res, userId, conversationId, sanitizedMessage, validUploadIds, userLocale);
  } else {
    await handleDirect(req, res, userId, conversationId, conversation, sanitizedMessage, skillId, validUploadIds, userLocale);
  }
});

async function handleOrchestrated(
  _req: Request, res: Response,
  userId: string, conversationId: string, message: string,
  uploadIds: string[] = [], userLocale: string = 'zh-TW',
) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
    'Connection': 'keep-alive', 'X-Accel-Buffering': 'no',
  });

  const existingFiles = await getExistingFilePaths(conversationId);
  await snapshotExistingFiles(userId, conversationId);
  await dbRun("UPDATE conversations SET mode = 'orchestrated' WHERE id = ?", conversationId);

  const keepaliveTimer = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch { /* closed */ }
  }, 10000);

  const sseWriter = (event: SSEEvent) => {
    try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* closed */ }
  };

  const orchestrator = new Orchestrator(userId, conversationId, sseWriter, uploadIds, userLocale);
  activeGenerations.set(conversationId, () => orchestrator.abort());

  try {
    const result = await orchestrator.run(message);

    if (result.assistantText) {
      const assistantMsgId = uuidv4();
      await dbRun(
        'INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)',
        assistantMsgId, conversationId, 'assistant', result.assistantText
      );
    }

    if (result.totalInputTokens > 0 || result.totalOutputTokens > 0) {
      await recordTokenUsage({
        userId, conversationId,
        inputTokens: result.totalInputTokens, outputTokens: result.totalOutputTokens,
        model: result.model,
      });
    }

    sseWriter({
      type: 'usage',
      data: { inputTokens: result.totalInputTokens, outputTokens: result.totalOutputTokens, model: result.model },
    });

    const sandboxPath = getSandboxPath(userId, conversationId);
    const newFiles = await registerNewFiles(userId, conversationId, sandboxPath, existingFiles);
    if (newFiles.length > 0) {
      sseWriter({
        type: 'file_generated',
        data: newFiles.map(f => ({ id: f.id, filename: f.filename, file_path: f.file_path, file_type: f.file_type, file_size: f.file_size, version: f.version })),
      });
    }
  } catch (err) {
    console.error(`[Generate] Orchestrator error for ${conversationId}:`, err);
    sseWriter({ type: 'error', data: `Orchestrator failed: ${(err as Error).message}. Falling back to direct mode.` });
  } finally {
    clearInterval(keepaliveTimer);
    activeGenerations.delete(conversationId);
    sseWriter({ type: 'done', data: { exitCode: 0 } });
    res.end();
  }
}

async function handleDirect(
  _req: Request, res: Response,
  userId: string, conversationId: string, conversation: Conversation,
  sanitizedMessage: string, skillId?: string, uploadIds: string[] = [],
  userLocale: string = 'zh-TW',
) {
  const effectiveSkillId = skillId || conversation.skill_id || 'pptx-gen';
  const skill = getSkill(effectiveSkillId);
  if (!skill) { res.status(400).json({ error: `Unknown skill: ${effectiveSkillId}` }); return; }

  const sandboxPath = getSandboxPath(userId, conversationId);
  const uploadContext = effectiveSkillId === 'rag-analyst'
    ? await getConversationFilesForPrompt(userId, sandboxPath, conversationId)
    : await getUserUploadsForPrompt(userId, sandboxPath, {
        uploadIds: uploadIds.length > 0 ? uploadIds : undefined,
        conversationId,
      });
  const baseSystemPrompt = buildSystemPrompt(skill, config.generatorsDir, userLocale) + uploadContext;

  if (skillId && skillId !== conversation.skill_id) {
    await dbRun('UPDATE conversations SET skill_id = ? WHERE id = ?', skillId, conversationId);
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
    'Connection': 'keep-alive', 'X-Accel-Buffering': 'no',
  });

  const existingFiles = await getExistingFilePaths(conversationId);
  await snapshotExistingFiles(userId, conversationId);

  const isExistingSession = !!conversation.session_id;
  const sessionId = conversation.session_id || uuidv4();
  if (!isExistingSession) {
    await dbRun('UPDATE conversations SET session_id = ? WHERE id = ?', sessionId, conversationId);
  }

  const keepaliveTimer = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch { /* closed */ }
  }, 10000);

  async function startClaude(sid: string, isResume: boolean) {
    let systemPrompt = baseSystemPrompt;
    if (!isResume) {
      const history = await buildChatHistory(conversationId);
      if (history) systemPrompt = baseSystemPrompt + history;
    }

    const { emitter, abort } = spawnClaude(sanitizedMessage, systemPrompt, {
      userId, conversationId, sessionId: sid, isResume, skillId: effectiveSkillId,
      customAllowedTools: skill?.allowedTools,
      customDisallowedTools: skill?.disallowedTools,
    });

    activeGenerations.set(conversationId, abort);

    let assistantText = '';
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let model = '';
    let hasRetried = false;

    emitter.on('event', (event: SSEEvent) => {
      if (hasRetried) return;

      if (event.type === 'error' && isResume) {
        const errStr = String(event.data || '');
        if (errStr.includes('Session') || errStr.includes('exit') || errStr.includes('code 1')) {
          hasRetried = true;
          console.log(`[Generate] Resume failed for ${conversationId}, retrying with fresh session + history`);
          const freshId = uuidv4();
          dbRun('UPDATE conversations SET session_id = ? WHERE id = ?', freshId, conversationId)
            .then(() => startClaude(freshId, false))
            .catch(e => console.error('Failed to retry with fresh session:', e));
          return;
        }
      }

      try { res.write(`data: ${JSON.stringify(event)}\n\n`); }
      catch (err) { console.error(`[Generate] SSE write failed for ${conversationId}:`, err); clearInterval(keepaliveTimer); return; }

      if (event.type === 'text') assistantText += event.data as string;

      if (event.type === 'usage') {
        const usage = event.data as { inputTokens: number; outputTokens: number; model: string };
        totalInputTokens = usage.inputTokens; totalOutputTokens = usage.outputTokens; model = usage.model;
      }

      if (event.type === 'session_id') {
        const cliSessionId = event.data as string;
        if (cliSessionId) {
          dbRun('UPDATE conversations SET session_id = ? WHERE id = ?', cliSessionId, conversationId)
            .catch(e => console.error('Failed to update session_id:', e));
        }
      }

      if (event.type === 'done') {
        clearInterval(keepaliveTimer);
        activeGenerations.delete(conversationId);

        (async () => {
          if (assistantText) {
            const assistantMsgId = uuidv4();
            await dbRun(
              'INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)',
              assistantMsgId, conversationId, 'assistant', assistantText
            );
          }

          if (totalInputTokens > 0 || totalOutputTokens > 0) {
            await recordTokenUsage({ userId, conversationId, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, model });
          }

          const sandboxPath = getSandboxPath(userId, conversationId);
          const newFiles = await registerNewFiles(userId, conversationId, sandboxPath, existingFiles);
          if (newFiles.length > 0) {
            try {
              res.write(`data: ${JSON.stringify({
                type: 'file_generated',
                data: newFiles.map(f => ({ id: f.id, filename: f.filename, file_path: f.file_path, file_type: f.file_type, file_size: f.file_size, version: f.version })),
              })}\n\n`);
            } catch { /* closed */ }
          }

          res.end();
        })().catch(e => {
          console.error('Error in done handler:', e);
          res.end();
        });
      }
    });
  }

  await startClaude(sessionId, isExistingSession);

  res.on('close', () => {
    clearInterval(keepaliveTimer);
    const abortFn = activeGenerations.get(conversationId);
    if (abortFn) { activeGenerations.delete(conversationId); abortFn(); }
  });
}

// POST /api/generate/:conversationId/abort
router.post('/:conversationId/abort', (req: Request, res: Response) => {
  const conversationId = req.params.conversationId as string;
  const abortFn = activeGenerations.get(conversationId);
  if (abortFn) {
    abortFn(); activeGenerations.delete(conversationId);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'No active generation for this conversation' });
  }
});

export default router;
