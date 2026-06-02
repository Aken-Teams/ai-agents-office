import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { dbGet, dbAll, dbRun } from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { spawnClaude } from '../services/claudeCli.js';
import { spawnCodex } from '../services/codexCli.js';
import { getSandboxPath } from '../services/sandbox.js';
import { analyzeInput, logSecurityEvent, WARN_THRESHOLD } from '../services/inputGuard.js';
import { recordTokenUsage } from '../services/tokenTracker.js';
import { registerNewFiles, getExistingFilePaths, snapshotExistingFiles } from '../services/fileManager.js';
import { getUserStorageUsed } from './files.js';
import { getSkill, buildSystemPrompt, buildMemoryContext, buildCrossAssistantContext, loadSkills, getRouterSkill } from '../skills/loader.js';
import { getUserUploadsForPrompt, getConversationFilesForPrompt } from '../services/uploadContext.js';
import { Orchestrator } from '../services/orchestrator.js';
import { extractMemoryAndSummary } from '../services/memoryExtractor.js';
import { searchTopK, formatHitsForPrompt, countIndexedChunks } from '../services/personalRag.js';
import { config, normalizeEngine, type AgentEngine } from '../config.js';
import { shouldUsePreRouter, classifyIntent, streamSimpleReply } from '../services/preRouter.js';
import { checkUserUsageLimit, getStorageQuotaGb } from '../services/usageLimit.js';
import type { Conversation, Message, SSEEvent } from '../types.js';

const router = Router();

router.use(authMiddleware);
router.use(rateLimit);

const activeGenerations = new Map<string, () => void>();

/**
 * Build context block from referenced assistant conversations.
 * Injects title, summary, and recent messages from each referenced conversation.
 */
async function buildCrossReferenceContext(userId: string, referencedConvIds: string[]): Promise<string> {
  if (!referencedConvIds.length) return '';

  const sections: string[] = [];

  for (const refId of referencedConvIds.slice(0, 3)) {
    const refConv = await dbGet<{ title: string; summary: string | null }>(
      'SELECT title, summary FROM conversations WHERE id = ? AND user_id = ?',
      refId, userId
    );
    if (!refConv) continue;

    const refMessages = await dbAll<{ role: string; content: string }>(
      'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 10',
      refId
    );

    const lines: string[] = [`### 引用：${refConv.title}`];
    if (refConv.summary) lines.push(`摘要：${refConv.summary}`);
    if (refMessages.length > 0) {
      lines.push('');
      for (const msg of refMessages.reverse()) {
        const role = msg.role === 'user' ? 'User' : 'Assistant';
        const content = msg.content.length > 1500 ? msg.content.substring(0, 1500) + '...' : msg.content;
        lines.push(`[${role}]: ${content}`);
      }
    }
    sections.push(lines.join('\n'));
  }

  if (!sections.length) return '';

  return [
    '\n\n## 引用的 AI 助手工作成果',
    '以下是用戶引用的其他 AI 助手對話內容，請善用這些成果來完成當前需求：',
    '',
    ...sections,
    '',
  ].join('\n');
}

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
  const { message, skillId, uploadIds, referencedConvIds: rawRefIds, engine: rawEngine } = req.body;
  const referencedConvIds: string[] = Array.isArray(rawRefIds)
    ? rawRefIds.filter((id: unknown) => typeof id === 'string').slice(0, 3)
    : [];

  if (!message) { res.status(400).json({ error: 'Message is required' }); return; }

  const conversation = await dbGet<Conversation & { mode?: string; agent_engine?: string | null }>(
    'SELECT * FROM conversations WHERE id = ? AND user_id = ?',
    conversationId, userId
  );
  if (!conversation) { res.status(404).json({ error: 'Conversation not found' }); return; }

  // Resolve the AI engine for this request: explicit body choice wins, then
  // the conversation's sticky choice, then the global default. A new explicit
  // choice is persisted so it sticks for subsequent turns and the UI can
  // restore it.
  const requestedEngine = normalizeEngine(rawEngine);
  const effectiveEngine: AgentEngine =
    requestedEngine ?? normalizeEngine(conversation.agent_engine) ?? config.agentEngine;
  if (requestedEngine && requestedEngine !== normalizeEngine(conversation.agent_engine)) {
    await dbRun('UPDATE conversations SET agent_engine = ? WHERE id = ?', requestedEngine, conversationId);
  }

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
  // Append refs metadata tag for display purposes (strip before AI usage)
  let storedUserMessage = sanitizedMessage;
  if (referencedConvIds.length > 0) {
    const refTitles: Array<{id: string; title: string}> = [];
    for (const refId of referencedConvIds) {
      const refConv = await dbGet<{title: string}>(
        'SELECT title FROM conversations WHERE id = ? AND user_id = ?',
        refId, userId
      );
      if (refConv) refTitles.push({ id: refId, title: refConv.title });
    }
    if (refTitles.length > 0) {
      storedUserMessage = sanitizedMessage + '\n\n[refs:' + JSON.stringify(refTitles) + ']';
    }
  }
  await dbRun(
    'INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)',
    userMsgId, conversationId, 'user', storedUserMessage
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

  const refContext = referencedConvIds.length > 0
    ? await buildCrossReferenceContext(userId, referencedConvIds)
    : '';

  if (useOrchestrator) {
    // Pre-router fast-path: try classifying simple chat → handle locally to save Claude tokens.
    const preCtx = {
      category: conversation.category || 'document',
      message: sanitizedMessage,
      hasUploads: validUploadIds.length > 0,
      hasReferences: referencedConvIds.length > 0,
    };
    if (shouldUsePreRouter(preCtx)) {
      const recentMsgs = await dbAll<{ role: string; content: string }>(
        'SELECT role, content FROM messages WHERE conversation_id = ? AND id != ? ORDER BY created_at DESC LIMIT 6',
        conversationId, userMsgId
      );
      const intent = await classifyIntent({ ...preCtx, recentMessages: recentMsgs.reverse() });
      console.log(`[PreRouter] ${conversationId} → ${intent.intent} (${intent.reason})`);
      if (intent.intent === 'simple_chat') {
        await handleSimpleChat(req, res, userId, conversationId, sanitizedMessage, recentMsgs, preCtx.category, intent.inputTokens, intent.outputTokens);
        return;
      }
      // complex_task → fall through to orchestrator below
    }
    await handleOrchestrated(req, res, userId, conversationId, sanitizedMessage, validUploadIds, userLocale, conversation.category || 'document', refContext, effectiveEngine);
  } else {
    await handleDirect(req, res, userId, conversationId, conversation, sanitizedMessage, skillId, validUploadIds, userLocale, refContext, effectiveEngine);
  }
});

/**
 * Pre-router 簡單聊天分支：完全用地端 LLM 處理，跳過 Claude orchestrator。
 * SSE 事件格式必須與 handleOrchestrated 相容（text / usage / done），
 * 前端 chat/[id]/page.tsx 才能無縫接收。
 */
async function handleSimpleChat(
  req: Request, res: Response,
  userId: string, conversationId: string, message: string,
  recentMessages: Array<{ role: string; content: string }>,
  conversationCategory: string,
  classifierInputTokens: number,
  classifierOutputTokens: number,
) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive', 'X-Accel-Buffering': 'no',
  });

  const keepaliveTimer = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch { /* closed */ }
  }, 10000);

  const sseWriter = (event: SSEEvent) => {
    try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* closed */ }
  };

  // Mark conversation mode so future loads know this turn went through the local path.
  await dbRun("UPDATE conversations SET mode = 'simple-chat-local' WHERE id = ?", conversationId);

  const abortCtl = new AbortController();
  let finished = false;
  res.on('close', () => { if (!finished) abortCtl.abort(); });
  activeGenerations.set(conversationId, () => abortCtl.abort());

  // Personal RAG — same retrieval as the orchestrator path. The hits get
  // prepended to the user's message as a "private knowledge base" prelude;
  // streamSimpleReply doesn't take a separate referenceContext, so the
  // simplest way to give the local model the context is in the message body.
  let messageWithRag = message;
  try {
    const hasDocs = (await countIndexedChunks(userId)) > 0;
    if (hasDocs) {
      const hits = await searchTopK({ userId, query: message, k: 4 });
      if (hits.length > 0) {
        const ragBlock = formatHitsForPrompt(hits);
        messageWithRag = `${ragBlock}\n\n# 使用者問題\n${message}`;
      }
    }
  } catch (err) {
    console.warn('[Generate/simple] RAG retrieval failed (non-fatal):', err);
  }

  let collected = '';
  let model = '';
  try {
    const result = await streamSimpleReply({
      message: messageWithRag,
      category: conversationCategory,
      recentMessages,
      signal: abortCtl.signal,
      onDelta: (delta) => {
        collected += delta;
        sseWriter({ type: 'text', data: delta });
      },
    });
    model = result.model;

    // Persist assistant reply.
    if (collected.trim()) {
      await dbRun(
        'INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)',
        uuidv4(), conversationId, 'assistant', collected
      );
    }

    // Token accounting: classifier (real) + reply (estimated by char count, since
    // streaming endpoint doesn't return usage). Char-to-token ratio for CJK ~ 1:1.
    const estimatedReplyOutput = Math.max(1, Math.ceil(collected.length));
    const totalInputTokens = classifierInputTokens + Math.ceil(message.length);
    const totalOutputTokens = classifierOutputTokens + estimatedReplyOutput;
    if (totalInputTokens > 0 || totalOutputTokens > 0) {
      await recordTokenUsage({
        userId, conversationId,
        inputTokens: totalInputTokens, outputTokens: totalOutputTokens,
        model: model || 'local-llm',
        provider: 'local-llm',
      });
    }
    sseWriter({ type: 'usage', data: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, model: model || 'local-llm', provider: 'local-llm' } });
  } catch (err) {
    console.error(`[Generate] Simple-chat error for ${conversationId}:`, err);
    sseWriter({ type: 'error', data: `Local LLM failed: ${(err as Error).message}` });
  } finally {
    finished = true;
    clearInterval(keepaliveTimer);
    activeGenerations.delete(conversationId);
    sseWriter({ type: 'done', data: { exitCode: 0 } });
    try { res.end(); } catch { /* already closed */ }
  }
}

async function handleOrchestrated(
  _req: Request, res: Response,
  userId: string, conversationId: string, message: string,
  uploadIds: string[] = [], userLocale: string = 'zh-TW', conversationCategory: string = 'document',
  refContext: string = '', engine?: AgentEngine,
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

  // Personal RAG — append retrieved passages from the user's own indexed
  // documents to the existing cross-conversation reference block. Failures
  // here must not block the main flow.
  let combinedRefContext = refContext;
  try {
    const hasDocs = (await countIndexedChunks(userId)) > 0;
    if (hasDocs) {
      const hits = await searchTopK({ userId, query: message, k: 4 });
      if (hits.length > 0) {
        const ragBlock = formatHitsForPrompt(hits);
        combinedRefContext = combinedRefContext
          ? `${combinedRefContext}\n\n${ragBlock}`
          : ragBlock;
      }
    }
  } catch (err) {
    console.warn('[Generate] RAG retrieval failed (non-fatal):', err);
  }

  const orchestrator = new Orchestrator(userId, conversationId, sseWriter, uploadIds, userLocale, conversationCategory, combinedRefContext, engine);
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
        provider: 'claude',
      });
    }

    sseWriter({
      type: 'usage',
      data: { inputTokens: result.totalInputTokens, outputTokens: result.totalOutputTokens, model: result.model, provider: 'claude' },
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
    try { res.end(); } catch { /* SSE already closed */ }

    // Fire-and-forget: extract conversation summary + user memories
    extractMemoryAndSummary(userId, conversationId, userLocale, conversationCategory).catch(e =>
      console.error('[Generate] Memory extraction failed (non-blocking):', e)
    );
  }
}

async function handleDirect(
  _req: Request, res: Response,
  userId: string, conversationId: string, conversation: Conversation,
  sanitizedMessage: string, skillId?: string, uploadIds: string[] = [],
  userLocale: string = 'zh-TW', refContext: string = '', engine?: AgentEngine,
) {
  const effectiveSkillId = skillId || conversation.skill_id || 'pptx-gen';
  // Engine dispatch — same signature & SSE protocol for both CLIs.
  const spawnAgentProcess = (engine ?? config.agentEngine) === 'codex' ? spawnCodex : spawnClaude;
  const skill = getSkill(effectiveSkillId);
  if (!skill) { res.status(400).json({ error: `Unknown skill: ${effectiveSkillId}` }); return; }

  const sandboxPath = getSandboxPath(userId, conversationId);
  const uploadContext = effectiveSkillId === 'rag-analyst'
    ? await getConversationFilesForPrompt(userId, sandboxPath, conversationId)
    : await getUserUploadsForPrompt(userId, sandboxPath, {
        uploadIds: uploadIds.length > 0 ? uploadIds : undefined,
        conversationId,
      });
  // Fetch user memories for context injection
  const userMemories = await dbAll<{ content: string }>(
    "SELECT content FROM user_memories WHERE user_id = ? AND memory_type = 'preference' ORDER BY created_at DESC LIMIT 10", userId
  );
  const memoryContext = buildMemoryContext(userMemories);

  // For assistant conversations: inject cross-assistant context from other assistant conversations
  let crossAssistantContext = '';
  if (conversation.category === 'assistant') {
    const otherSummaries = await dbAll<{ title: string; summary: string; created_at: string }>(
      "SELECT title, summary, created_at FROM conversations WHERE user_id = ? AND category = 'assistant' AND id != ? AND summary IS NOT NULL ORDER BY created_at DESC LIMIT 3",
      userId, conversationId
    );
    crossAssistantContext = buildCrossAssistantContext(otherSummaries, conversationId);
  }

  const baseSystemPrompt = buildSystemPrompt(skill, config.generatorsDir, userLocale) + uploadContext + memoryContext + crossAssistantContext + refContext;

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

  // Track SSE connection state — process continues even if SSE closes
  let sseOpen = true;
  function sseWrite(event: SSEEvent) {
    if (!sseOpen) return;
    try { res.write(`data: ${JSON.stringify(event)}\n\n`); }
    catch { sseOpen = false; }
  }

  async function startClaude(sid: string, isResume: boolean) {
    let systemPrompt = baseSystemPrompt;
    if (!isResume) {
      const history = await buildChatHistory(conversationId);
      if (history) systemPrompt = baseSystemPrompt + history;
    }

    const { emitter, abort } = spawnAgentProcess(sanitizedMessage, systemPrompt, {
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

      // Always accumulate state regardless of SSE connection
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

      // Forward to SSE (best-effort — SSE may be closed)
      sseWrite(event);

      if (event.type === 'done') {
        clearInterval(keepaliveTimer);
        activeGenerations.delete(conversationId);

        (async () => {
          // Anthropic auth blip leaked through Claude CLI as a fake assistant
          // message — replace it with a friendly notice instead of persisting
          // the raw "Failed to authenticate. API Error: 401 ..." string.
          if (/Failed to authenticate\.\s*API Error: 4\d\d/i.test(assistantText)
              || /Invalid authentication credentials/i.test(assistantText)) {
            console.warn(`[Generate] Upstream auth blip on ${conversationId}, substituting friendly message`);
            assistantText = '⚠️ 暫時無法連線到模型服務（上游驗證問題），請過一兩分鐘後再試一次。如果持續失敗請聯繫管理員。';
          }
          if (assistantText) {
            const assistantMsgId = uuidv4();
            await dbRun(
              'INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)',
              assistantMsgId, conversationId, 'assistant', assistantText
            );
          }

          if (totalInputTokens > 0 || totalOutputTokens > 0) {
            await recordTokenUsage({ userId, conversationId, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, model, provider: 'claude' });
          }

          const sandboxPath = getSandboxPath(userId, conversationId);
          const newFiles = await registerNewFiles(userId, conversationId, sandboxPath, existingFiles);
          if (newFiles.length > 0) {
            sseWrite({
              type: 'file_generated',
              data: newFiles.map(f => ({ id: f.id, filename: f.filename, file_path: f.file_path, file_type: f.file_type, file_size: f.file_size, version: f.version })),
            });
          }

          // Fire-and-forget: extract conversation summary + user memories
          extractMemoryAndSummary(userId, conversationId, userLocale, conversation.category || 'document').catch(e =>
            console.error('[Generate] Memory extraction failed (non-blocking):', e)
          );

          if (sseOpen) { try { res.end(); } catch { /* closed */ } }
        })().catch(e => {
          console.error('Error in done handler:', e);
          if (sseOpen) { try { res.end(); } catch { /* closed */ } }
        });
      }
    });
  }

  await startClaude(sessionId, isExistingSession);

  res.on('close', () => {
    clearInterval(keepaliveTimer);
    sseOpen = false;
    // Do NOT abort — Claude process continues in background and saves result to DB
    console.log(`[Generate] SSE closed for ${conversationId}, process continues in background`);
  });
}

// GET /api/generate/:conversationId/status — check if a generation is in progress
router.get('/:conversationId/status', (req: Request, res: Response) => {
  const conversationId = req.params.conversationId as string;
  res.json({ processing: activeGenerations.has(conversationId) });
});

// GET /api/generate/:conversationId/tasks — get recent agent task executions
router.get('/:conversationId/tasks', async (req: Request, res: Response) => {
  const conversationId = req.params.conversationId as string;
  const userId = req.user!.userId;

  const conversation = await dbGet<{ id: string }>(
    'SELECT id FROM conversations WHERE id = ? AND user_id = ?',
    conversationId, userId
  );
  if (!conversation) { res.status(404).json({ error: 'Not found' }); return; }

  const tasks = await dbAll<{
    id: string; skill_id: string; description: string; status: string; result_summary: string | null;
  }>(
    `SELECT id, skill_id, description, status, result_summary
     FROM task_executions
     WHERE conversation_id = ? AND created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)
     ORDER BY created_at ASC`,
    conversationId
  );
  res.json({ tasks });
});

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
