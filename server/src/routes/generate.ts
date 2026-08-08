import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { dbGet, dbAll, dbRun } from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { spawnClaude } from '../services/claudeCli.js';
import { getSandboxPath } from '../services/sandbox.js';
import { analyzeInput, logSecurityEvent, WARN_THRESHOLD } from '../services/inputGuard.js';
import { moderateAiRequest } from '../services/contentSafety.js';
import { recordTokenUsage } from '../services/tokenTracker.js';
import { registerNewFiles, getExistingFilePaths, snapshotExistingFiles, captureBlocksForFile } from '../services/fileManager.js';
import { getUserStorageUsed } from './files.js';
import { getSkill, buildSystemPrompt, buildMemoryContext, buildCrossAssistantContext, loadSkills, getRouterSkill } from '../skills/loader.js';
import { getUserUploadsForPrompt, getConversationFilesForPrompt } from '../services/uploadContext.js';
import { Orchestrator } from '../services/orchestrator.js';
import { enforceDataFidelity } from '../services/dataFidelityGuard.js';
import { normalizePptx } from '../services/pptxNormalize.js';
import { getMailToken } from '../services/outlookApi.js';
import { getKmOnBehalf } from '../services/kmApi.js';
import { buildRetrieverSystemPrompt } from '../services/emailContext.js';
import path from 'path';
import fs from 'fs';
import { parseInfographicDirective, renderInfographic, compositeRegionMask, regionEditToFile } from '../services/infographicService.js';
import type { DocumentBlock } from '../types.js';
import { extractMemoryAndSummary } from '../services/memoryExtractor.js';
import { config } from '../config.js';
import { checkUserUsageLimit, getStorageQuotaGb } from '../services/usageLimit.js';
import type { Conversation, Message, SSEEvent } from '../types.js';

const router = Router();

router.use(authMiddleware);
router.use(rateLimit);

// Friendly zh-TW label of what each single-skill agent can produce — for the
// direct-mode scope guard below.
const SKILL_PRODUCES: Record<string, string> = {
  pptx: 'PowerPoint 簡報（.pptx）',
  docx: 'Word 文件（.docx）',
  xlsx: 'Excel 試算表（.xlsx）',
  pdf: 'PDF 文件（.pdf）',
  html: '互動網頁 / HTML 簡報',
};

/**
 * Direct (quick-wizard / single-agent) mode locks the conversation to ONE skill.
 * This guard tells that agent its boundary so it NEVER fakes an out-of-scope task
 * (e.g. "好的，我幫你做成 Word 了" when it can't produce a Word file) — instead it
 * honestly states what it is and redirects the user to AUTO mode / the matching
 * button. NOT injected in orchestrated/AUTO mode (the router already dispatched
 * to the correct agent there).
 */
function buildDirectScopeGuard(skill: { fileType: string }): string {
  const produces = skill.fileType
    ? (SKILL_PRODUCES[skill.fileType] || `.${skill.fileType} 檔`)
    : '文字分析 / 研究內容（不會產生任何可下載的檔案）';
  const outOfScope = skill.fileType
    ? `要你產生「不是 ${SKILL_PRODUCES[skill.fileType] || skill.fileType}」的其他檔案（例如另一種 Word / 簡報 / Excel / PDF）`
    : '要你產生任何可下載的檔案（Word / 簡報 / Excel / PDF 等）';
  return `

## ⛔ 職責邊界（單一 agent 模式 — 最高優先，務必遵守）
這條對話**被鎖定為單一 agent**，你**只負責產出：${produces}**。

當使用者的要求**超出你的職責**（尤其是${outOfScope}）時：
- **絕對不可以**假裝「好的，我幫你做成 XX 了」或宣稱產出了根本不存在的檔案——那會讓使用者**空等一個永遠不會出現的檔**，是最糟的體驗。
- **一開始就誠實講清楚**：你只能做「${produces}」，這個需求不在你的範圍內。
- **引導**使用者去對的地方：回首頁用**最下面的大輸入框（AUTO 模式）**直接說需求，系統會自動派專門的 agent；或點對應按鈕（做 Word →「撰寫產品需求規格文件」、做簡報 →「製作 AI 趨勢簡報」、做 Excel →「建立銷售數據分析表」、做 PDF →「產生 PDF 商業報告」）。
- 屬於你職責內的部分，仍照常盡力完成。`;
}

/**
 * Normalize generated .pptx chart decks into schema-valid OOXML (LibreOffice
 * round-trip) BEFORE the user sees them, so PowerPoint never shows a "repair"
 * prompt for pptxgenjs's non-compliant chart XML. Only chart decks are touched;
 * updates file_size in the DB + on the passed objects. Non-fatal.
 */
async function normalizeDeckFiles<T extends { id: string; file_path: string; file_type: string; file_size: number }>(
  files: T[],
): Promise<T[]> {
  await Promise.all(files.map(async (f) => {
    if (f.file_type !== 'pptx') return;
    const abs = path.isAbsolute(f.file_path) ? f.file_path : path.join(config.workspaceRoot, f.file_path);
    const r = await normalizePptx(abs);
    if (r.normalized && r.newSize) {
      f.file_size = r.newSize;
      await dbRun('UPDATE generated_files SET file_size = ? WHERE id = ?', r.newSize, f.id);
    }
  }));
  return files;
}

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
      `SELECT m.role, m.content FROM messages m
       INNER JOIN conversations c ON c.id = m.conversation_id AND c.user_id = ?
       WHERE m.conversation_id = ? ORDER BY m.created_at DESC LIMIT 10`,
      userId, refId
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
  const { message, docContext, skillId, uploadIds, referencedConvIds: rawRefIds, regionMask, regionFileId, dataSources } = req.body;
  const referencedConvIds: string[] = Array.isArray(rawRefIds)
    ? rawRefIds.filter((id: unknown) => typeof id === 'string').slice(0, 3)
    : [];

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

  // Content safety — refuse crime / hacking / secret-theft / harassment / harm,
  // and probing THIS system's own internals (底層技術/原始碼/架構/提示詞). The
  // injection guard above only catches jailbreak syntax; this catches malicious
  // INTENT phrased as a normal question. Runs before any streaming starts.
  // When the user explicitly attached the "我的信件" data source, the run is
  // authorized to read THEIR OWN mailbox (identity via their own token, no
  // cross-user access). Tell the moderator so "列出我的信件" isn't mistaken for
  // data exfiltration — own-mailbox access is legitimate personal productivity.
  const emailDataSource = Array.isArray(dataSources) && dataSources.includes('email');
  const safetyVerdict = await moderateAiRequest(message, '無法回答這個問題',
    emailDataSource
      ? { contextNote: '使用者已在對話中選取「我的信件」資料源。系統只會用其本人的授權 Token 讀取「他自己」的 Outlook 信箱（不可能存取他人信箱）。因此「查詢／列出／整理／摘要自己的信件」是被授權的正當操作，不屬於竊取機密或危害他人。' }
      : undefined);
  if (!safetyVerdict.allowed) {
    logSecurityEvent(userId, 'blocked_request', 'high', `chat blocked (category=${safetyVerdict.category})`, message);
    res.status(403).json({ error: safetyVerdict.reason, code: 'CONTENT_BLOCKED' }); return;
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

  // Prepend doc context for AI processing (not stored in DB — already saved above without it)
  const aiMessage = docContext
    ? `[DOC_CONTEXT: ${docContext}]\n\n${sanitizedMessage}`
    : sanitizedMessage;

  // Data-source MCP: when the user picked "email" in the data-source selector,
  // resolve THEIR OWN mail token so worker/doc agents can pull their mailbox via
  // email-mcp. Explicit selection (not intent-guessing) → deterministic + opt-in.
  let mcpEmailToken: string | undefined;
  if (Array.isArray(dataSources) && dataSources.includes('email')) {
    mcpEmailToken = (await getMailToken(userId)) || undefined;
  }
  // KM data source: resolve the user's 員編 (X-On-Behalf-Of) for km-mcp. May be
  // combined with email. Both flow through the same rag-analyst retriever path.
  let mcpKmOnBehalf: string | undefined;
  if (Array.isArray(dataSources) && dataSources.includes('km')) {
    mcpKmOnBehalf = (await getKmOnBehalf(userId)) || undefined;
  }

  if (useOrchestrator) {
    await handleOrchestrated(req, res, userId, conversationId, aiMessage, validUploadIds, userLocale, conversation.category || 'document', refContext, conversation.system_prompt || '', mcpEmailToken, mcpKmOnBehalf);
  } else {
    await handleDirect(req, res, userId, conversationId, conversation, aiMessage, skillId, validUploadIds, userLocale, refContext,
      typeof regionMask === 'string' ? regionMask : undefined,
      typeof regionFileId === 'string' ? regionFileId : undefined, mcpEmailToken, mcpKmOnBehalf);
  }
});

async function handleOrchestrated(
  _req: Request, res: Response,
  userId: string, conversationId: string, message: string,
  uploadIds: string[] = [], userLocale: string = 'zh-TW', conversationCategory: string = 'document',
  refContext: string = '', systemPrompt: string = '', mcpEmailToken?: string, mcpKmOnBehalf?: string,
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

  const customRolePrompt = systemPrompt
    ? `\n\n## Custom Role Instructions\nThe user has configured this assistant with the following role:\n${systemPrompt}\nPlease behave according to this role description.\n`
    : '';
  const orchestrator = new Orchestrator(userId, conversationId, sseWriter, uploadIds, userLocale, conversationCategory, refContext, customRolePrompt, mcpEmailToken, mcpKmOnBehalf);
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

    // Fold any infographic Gemini cost into the conversation usage (equivalent
    // output tokens at the $15/M display rate), same as the direct path.
    if (result.geminiCostUsd > 0) {
      const geminiTokens = Math.round((result.geminiCostUsd * 1_000_000) / 15);
      if (geminiTokens > 0) {
        await recordTokenUsage({ userId, conversationId, inputTokens: 0, outputTokens: geminiTokens, model: 'gemini-3-pro-image' });
        result.totalOutputTokens += geminiTokens;
      }
    }

    sseWriter({
      type: 'usage',
      data: { inputTokens: result.totalInputTokens, outputTokens: result.totalOutputTokens, model: result.model },
    });

    const sandboxPath = getSandboxPath(userId, conversationId);
    // Only surface deliverables of the type(s) the dispatched generators produce —
    // intermediate scratch (analysis .md, .json, extracted images…) still exists on
    // disk for the agents, it just isn't shown to the user.
    const expectedTypes = new Set(
      (result.tasks || []).map(t => getSkill(t.skillId)?.fileType).filter((ft): ft is string => !!ft)
    );
    // Infographic agent renders png/html via Gemini — whitelist the actual type.
    for (const it of result.infographicTypes) expectedTypes.add(it);
    const newFiles = await registerNewFiles(userId, conversationId, sandboxPath, existingFiles, expectedTypes.size ? expectedTypes : undefined);
    if (newFiles.length > 0) {
      // Capture block structure first (no emit yet) so we can verify before showing.
      const captureResults = await Promise.allSettled(
        newFiles.map(f => captureBlocksForFile(f, userId, conversationId, sandboxPath))
      );
      const blocksByFile = new Map<string, DocumentBlock[]>();
      for (let i = 0; i < newFiles.length; i++) {
        const r = captureResults[i];
        if (r.status === 'fulfilled' && r.value) blocksByFile.set(newFiles[i].id, r.value);
      }
      // Data-fidelity gate: verify against the uploaded source + auto-correct any
      // fabricated data BEFORE the user sees the file. Returns instantly when the
      // conversation has no uploaded source to verify against.
      // Auto-correct fabricated data (pptx via dedicated rebuild; docx/xlsx/pdf/
      // html by resuming each file's own worker session in its _agents/{skillId}
      // dir, where the file + previous_step.md live).
      const rebuilt = await enforceDataFidelity(
        newFiles, blocksByFile, userId, conversationId, sseWriter,
        async (file) => {
          const m = file.file_path.replace(/\\/g, '/').match(/_agents\/([^/]+)\//);
          if (!m) return null;                       // not a worker-dir file → can't resume
          const skillId = m[1];
          const sess = await dbGet<{ session_uuid: string }>(
            'SELECT session_uuid FROM agent_sessions WHERE conversation_id = ? AND skill_id = ?',
            conversationId, skillId,
          );
          if (!sess?.session_uuid) return null;
          return { skillId, sessionId: sess.session_uuid, sandboxSubdir: `_agents/${skillId}` };
        },
      );
      const finalFiles = newFiles.map(f => rebuilt.get(f.id) || f);
      // Schema-normalize chart decks (LibreOffice round-trip) so PowerPoint never
      // shows a "repair" prompt for pptxgenjs's non-compliant chart XML.
      await normalizeDeckFiles(finalFiles);
      sseWriter({
        type: 'file_generated',
        data: finalFiles.map(f => ({ id: f.id, filename: f.filename, file_path: f.file_path, file_type: f.file_type, file_size: f.file_size, version: f.version })),
      });
      for (const f of finalFiles) {
        const blocks = blocksByFile.get(f.id);
        if (blocks) sseWriter({ type: 'blocks_ready', data: { fileId: f.id, blocks } });
      }
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

// Single-agent template-wizard cards that CONSUME uploaded data files and so
// need a parse pre-step when the user attaches files. Analysts parse themselves;
// text-only skills (research/reviewer/planner) don't read uploaded data; the
// infographic gemini/region flow is left untouched.
const PRE_PARSE_CONSUMER_SKILLS = new Set([
  'pptx-gen', 'docx-gen', 'xlsx-gen', 'pdf-gen', 'slides-gen', 'webapp-gen',
]);

/**
 * Template-wizard (single-agent) parse pre-step.
 *
 * When a user uploads files to a single skill card, that one agent often can't
 * parse a binary upload (e.g. webapp-gen has no Bash) or isn't a data
 * specialist (→ fabrication risk). This runs ONE lightweight data-analyst pass
 * that fully extracts the upload into text, writes it to the card agent's
 * working dir as `previous_step.md`, and returns a hand-off instruction to
 * prepend to the card agent's message (source-of-truth, no fabrication).
 *
 * It mirrors the orchestrated pipeline hand-off (attachPreviousStepData) but is
 * kept deliberately lean — no Router, no multi-round — so the wizard keeps its
 * "single generation agent + style = fast" core. Only triggers when files are
 * attached. Non-fatal: on failure returns ok:false and the card agent proceeds
 * exactly as before.
 */
async function runUploadParsePreStep(opts: {
  userId: string; conversationId: string; uploadIds: string[];
  userLocale: string; baseSandboxPath: string; userMessage: string;
  sseWrite: (e: SSEEvent) => void;
}): Promise<{ ok: boolean; handoff: string; inputTokens: number; outputTokens: number; model: string }> {
  const { userId, conversationId, uploadIds, userLocale, baseSandboxPath, userMessage, sseWrite } = opts;
  const fail = { ok: false, handoff: '', inputTokens: 0, outputTokens: 0, model: '' };
  const analyst = getSkill('data-analyst');
  if (!analyst) return fail;

  const taskId = uuidv4();
  sseWrite({ type: 'task_dispatched', data: { taskId, skillId: 'data-analyst', description: '解析上傳檔案中…' } });

  // Mirror the orchestrator: data-analyst runs in _agents/data-analyst and reads
  // uploads from ../_uploads (paths supplied via the upload context).
  const agentCwd = path.join(baseSandboxPath, '_agents', 'data-analyst');
  const uploadContext = await getUserUploadsForPrompt(userId, agentCwd, {
    uploadIds: uploadIds.length > 0 ? uploadIds : undefined,
    conversationId,
  });
  const systemPrompt = buildSystemPrompt(analyst, config.generatorsDir, userLocale) + uploadContext;
  const message = `請讀取使用者上傳的檔案，**完整**擷取其中所有資料（每一列、每一欄、所有數字與名稱），整理成結構化的 Markdown 表格／清單，直接輸出在你的回覆文字中。\n\n要求：\n- 資料必須完整，不要只給摘要、不要省略列數。\n- **不要產生任何輸出檔案**（不要寫 .docx/.pdf/.xlsx/.html）；只要把資料用文字回覆出來。\n- 若有多個工作表或多個檔案，逐一標明來源後完整列出。\n\n（使用者接下來會用這份資料製作文件，以下原始需求供你理解資料用途）：\n${userMessage}`;

  return await new Promise(resolve => {
    let text = '';
    let inputTokens = 0, outputTokens = 0, model = '';
    let settled = false;
    const finish = (v: typeof fail | { ok: true; handoff: string; inputTokens: number; outputTokens: number; model: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };

    const { emitter, abort } = spawnClaude(message, systemPrompt, {
      userId, conversationId, skillId: 'data-analyst',
      sandboxSubdir: '_agents/data-analyst',
      sessionId: uuidv4(), isResume: false,
      customAllowedTools: analyst.allowedTools,
      customDisallowedTools: analyst.disallowedTools,
    });
    // Allow the user to cancel during the parse step too.
    activeGenerations.set(conversationId, abort);

    const onParseTimeout = () => {
      try { abort(); } catch { /* ignore */ }
      sseWrite({ type: 'task_failed', data: { taskId, skillId: 'data-analyst', error: 'parse timed out' } });
      finish(fail);
    };
    // Queue wait must NOT count toward the limit: generous while queued for a slot, reset
    // to the real 3-min limit once the CLI actually spawns ('spawn_started').
    let timer = setTimeout(onParseTimeout, 10 * 60 * 1000);

    emitter.on('event', (event: SSEEvent) => {
      if (event.type === 'spawn_started') { clearTimeout(timer); timer = setTimeout(onParseTimeout, 180000); return; }
      if (event.type === 'text') {
        text += event.data as string;
      } else if (event.type === 'tool_activity') {
        sseWrite({ type: 'agent_stream', data: { taskId, skillId: 'data-analyst', type: 'tool_activity', content: event.data } });
      } else if (event.type === 'usage') {
        const u = event.data as { inputTokens: number; outputTokens: number; model: string };
        inputTokens = u.inputTokens; outputTokens = u.outputTokens; model = u.model;
      } else if (event.type === 'done') {
        if (!text.trim()) {
          sseWrite({ type: 'task_failed', data: { taskId, skillId: 'data-analyst', error: 'parse produced no data' } });
          finish(fail);
          return;
        }
        try {
          fs.mkdirSync(baseSandboxPath, { recursive: true });
          fs.writeFileSync(path.join(baseSandboxPath, 'previous_step.md'), text, 'utf-8');
        } catch (e) {
          console.warn('[PreParse] write previous_step.md failed:', e);
          finish(fail);
          return;
        }
        sseWrite({ type: 'task_completed', data: { taskId, skillId: 'data-analyst' } });
        const handoff = `## 上傳檔案的完整資料（重要，務必先讀）\n使用者上傳檔案的完整資料已解析並存於工作目錄的 \`previous_step.md\`。\n**你必須先用 Read 工具讀取 \`previous_step.md\`**，所有數字／名稱／客戶名／公司名一律以該檔為準，**不可超出該檔內容，也不可自行補充或編造**任何來源外的名稱或數值。若資料筆數少於版面所需，寧可少放（標「資料未提供」），也不可湊數。\n\n`;
        finish({ ok: true, handoff, inputTokens, outputTokens, model });
      }
    });
  });
}

/**
 * Template-wizard (single-agent) EMAIL retrieval pre-step.
 *
 * Direct mode runs ONE doc-gen agent (e.g. pptx-gen). When the user attaches the
 * "我的信件" data source, we do NOT hand the generator the raw mail tools (its job
 * is making documents, not searching mailboxes — bolting tools on is unreliable).
 * Instead — exactly like runUploadParsePreStep — we first run ONE rag-analyst pass
 * that HAS the email-mcp tools, retrieves the relevant emails/attachments/images,
 * writes them to `email_context.md`, and returns a hand-off to prepend. So direct
 * mode gets the same retrieve→generate split as the orchestrated flow.
 *
 * Non-fatal: on failure returns ok:false and the generator proceeds without email.
 */
async function runDataSourceRetrievalPreStep(opts: {
  userId: string; conversationId: string; mcpEmailToken?: string; mcpKmOnBehalf?: string;
  userLocale: string; baseSandboxPath: string; userMessage: string;
  sseWrite: (e: SSEEvent) => void;
}): Promise<{ ok: boolean; handoff: string; inputTokens: number; outputTokens: number; model: string }> {
  const { userId, conversationId, mcpEmailToken, mcpKmOnBehalf, userLocale, baseSandboxPath, userMessage, sseWrite } = opts;
  const fail = { ok: false, handoff: '', inputTokens: 0, outputTokens: 0, model: '' };
  const analyst = getSkill('rag-analyst');
  if (!analyst) return fail;

  // Which sources are attached → labels for prompts/UI.
  const srcLabels: string[] = [];
  if (mcpEmailToken) srcLabels.push('他自己的 Outlook 信箱');
  if (mcpKmOnBehalf) srcLabels.push('KM 知識庫（他有權限的文件）');
  const srcLabel = srcLabels.join('與');

  const taskId = uuidv4();
  sseWrite({ type: 'task_dispatched', data: { taskId, skillId: 'rag-analyst', description: `從${srcLabel}檢索相關資料中…` } });

  // LEAN focused retriever prompt (NOT the full rag-analyst SKILL.md, which distracts
  // the model into thrashing on ToolSearch). analyst is still used for its tool list.
  const systemPrompt = buildRetrieverSystemPrompt({ email: !!mcpEmailToken, km: !!mcpKmOnBehalf });
  const message = `使用者接下來要用「${srcLabel}」的內容製作文件。請依下面的需求，檢索相關的資料（含舊信/文件、附件、圖片）並完整整理輸出（附來源）。\n\n使用者的需求：\n${userMessage}`;

  return await new Promise(resolve => {
    let text = '';
    let inputTokens = 0, outputTokens = 0, model = '';
    let settled = false;
    const finish = (v: typeof fail | { ok: true; handoff: string; inputTokens: number; outputTokens: number; model: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };

    const { emitter, abort } = spawnClaude(message, systemPrompt, {
      userId, conversationId, skillId: 'rag-analyst',
      sandboxSubdir: '_agents/rag-analyst',
      sessionId: uuidv4(), isResume: false,
      customAllowedTools: analyst.allowedTools,
      customDisallowedTools: analyst.disallowedTools,
      // Attaches email-mcp and/or km-mcp + (in claudeCli) disables Task, keeps ToolSearch
      ...(mcpEmailToken ? { mcpEmailToken } : {}),
      ...(mcpKmOnBehalf ? { mcpKmOnBehalf } : {}),
    });
    activeGenerations.set(conversationId, abort);

    const onRetrieveTimeout = () => {
      try { abort(); } catch { /* ignore */ }
      sseWrite({ type: 'task_failed', data: { taskId, skillId: 'rag-analyst', error: 'data-source retrieval timed out' } });
      finish(fail);
    };
    // Queue wait must NOT count toward the limit: generous while queued for a slot, reset
    // to the real 4-min limit once the CLI actually spawns ('spawn_started').
    let timer = setTimeout(onRetrieveTimeout, 10 * 60 * 1000);

    emitter.on('event', (event: SSEEvent) => {
      if (event.type === 'spawn_started') { clearTimeout(timer); timer = setTimeout(onRetrieveTimeout, 240000); return; }
      if (event.type === 'text') {
        text += event.data as string;
      } else if (event.type === 'tool_activity') {
        sseWrite({ type: 'agent_stream', data: { taskId, skillId: 'rag-analyst', type: 'tool_activity', content: event.data } });
      } else if (event.type === 'usage') {
        const u = event.data as { inputTokens: number; outputTokens: number; model: string };
        inputTokens = u.inputTokens; outputTokens = u.outputTokens; model = u.model;
      } else if (event.type === 'done') {
        if (!text.trim()) {
          sseWrite({ type: 'task_failed', data: { taskId, skillId: 'rag-analyst', error: 'no data retrieved' } });
          finish(fail);
          return;
        }
        try {
          const agentCwd = path.join(baseSandboxPath, '_agents');
          fs.mkdirSync(agentCwd, { recursive: true });
          fs.writeFileSync(path.join(baseSandboxPath, 'datasource_context.md'), text, 'utf-8');
        } catch (e) {
          console.warn('[DataSourceRetrieve] write datasource_context.md failed:', e);
          finish(fail);
          return;
        }
        sseWrite({ type: 'task_completed', data: { taskId, skillId: 'rag-analyst' } });
        const handoff = `## 從你的資料源檢索到的資料（重要，務必先讀）\n與本需求相關的資料已檢索並存於工作目錄的 \`datasource_context.md\`。\n**你必須先用 Read 工具讀取 \`datasource_context.md\`**，所有標題／寄件者／日期／內文／附件內容一律以該檔為準，**不可超出該檔內容，也不可自行補充或編造**任何來源外的資訊。\n\n`;
        finish({ ok: true, handoff, inputTokens, outputTokens, model });
      }
    });
  });
}

async function handleDirect(
  _req: Request, res: Response,
  userId: string, conversationId: string, conversation: Conversation,
  sanitizedMessage: string, skillId?: string, uploadIds: string[] = [],
  userLocale: string = 'zh-TW', refContext: string = '',
  regionMask?: string, regionFileId?: string, mcpEmailToken?: string, mcpKmOnBehalf?: string,
) {
  const effectiveSkillId = skillId || conversation.skill_id || 'pptx-gen';
  const skill = getSkill(effectiveSkillId);
  if (!skill) { res.status(400).json({ error: `Unknown skill: ${effectiveSkillId}` }); return; }

  // Infographic region context: the user brushed an area on the image and is
  // asking about it or asking to change it. Composite the mark onto the image so
  // Claude can SEE the region (vision); keep the marked image + target path for a
  // possible region edit in the done handler.
  let regionMarked: Buffer | null = null;
  let regionTargetPath: string | null = null;
  if (effectiveSkillId === 'infographic-gen' && regionMask && regionFileId) {
    try {
      const rf = await dbGet<{ file_path: string }>(
        'SELECT file_path FROM generated_files WHERE id = ? AND user_id = ? ORDER BY version DESC LIMIT 1',
        regionFileId, userId,
      );
      if (rf) {
        const abs = path.join(config.workspaceRoot, rf.file_path);
        if (fs.existsSync(abs)) {
          regionMarked = await compositeRegionMask(abs, regionMask);
          regionTargetPath = abs;
        }
      }
    } catch (e) {
      console.error('[Generate] region mask composite failed:', e);
    }
  }

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

  // For assistant conversations: inject cross-assistant context (same user only)
  let crossAssistantContext = '';
  if (conversation.category === 'assistant') {
    const otherSummaries = await dbAll<{ title: string; summary: string; created_at: string }>(
      "SELECT title, summary, created_at FROM conversations WHERE user_id = ? AND category = 'assistant' AND id != ? AND summary IS NOT NULL ORDER BY created_at DESC LIMIT 3",
      userId, conversationId
    );
    crossAssistantContext = buildCrossAssistantContext(otherSummaries, conversationId);
  }

  // Email: when the "我的信件" data source is explicitly selected we run the
  // rag-analyst retrieval pre-step below (flexible — old mail + attachments + images).
  // Only fall back to the legacy keyword pre-fetch (recent-list preview) when NO data
  // source was selected, so the two mechanisms never compete.
  let emailContext = '';
  if (!mcpEmailToken) {
    const { messageNeedsEmail, getEmailContextForPrompt } = await import('../services/emailContext.js');
    if (messageNeedsEmail(sanitizedMessage)) emailContext = await getEmailContextForPrompt(userId, sanitizedMessage);
  }

  // Inject user-defined system_prompt (role description) for this assistant
  const customRolePrompt = conversation.system_prompt
    ? `\n\n## Custom Role Instructions\nThe user has configured this assistant with the following role:\n${conversation.system_prompt}\nPlease behave according to this role description.\n`
    : '';
  const baseSystemPrompt = buildSystemPrompt(skill, config.generatorsDir, userLocale) + buildDirectScopeGuard(skill) + customRolePrompt + uploadContext + memoryContext + crossAssistantContext + refContext;

  // Inject email data into user message (not system prompt) so it persists on resume
  let finalMessage = emailContext ? sanitizedMessage + emailContext : sanitizedMessage;

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

  // Notify frontend which skill is being used (for document mode detection)
  sseWrite({ type: 'skill_started', data: { skillId: effectiveSkillId } });

  // ── Upload parse pre-step (template-wizard single-agent gap fill) ──
  // The wizard runs ONE skill agent. If files are attached and that agent can't
  // parse them itself (webapp-gen has no Bash) or isn't a data specialist, first
  // run a lightweight data-analyst pass to extract the data into previous_step.md,
  // then hand it to the card agent (source-of-truth, no fabrication). Only fires
  // when files are attached this turn — the no-upload "style only" path is
  // untouched and stays fast. The post-gen data-fidelity gate below still runs.
  if (uploadIds.length > 0 && PRE_PARSE_CONSUMER_SKILLS.has(effectiveSkillId)) {
    const pre = await runUploadParsePreStep({
      userId, conversationId, uploadIds, userLocale,
      baseSandboxPath: sandboxPath, userMessage: sanitizedMessage, sseWrite,
    });
    if (pre.ok) {
      finalMessage = pre.handoff + finalMessage;
      if (pre.inputTokens > 0 || pre.outputTokens > 0) {
        await recordTokenUsage({ userId, conversationId, inputTokens: pre.inputTokens, outputTokens: pre.outputTokens, model: pre.model });
      }
    }
  }

  // ── Data-source retrieval pre-step (template-wizard + "我的信件" / "KM 知識庫") ──
  // Same split as the orchestrated flow: run rag-analyst (with the mail/KM tools) to
  // RETRIEVE the relevant emails/documents/attachments/images first, then hand the
  // DATA to the single doc-gen agent — which gets the data, not the raw tools. Skipped
  // when the user picked the rag-analyst card itself (it IS the retriever).
  if ((mcpEmailToken || mcpKmOnBehalf) && effectiveSkillId !== 'rag-analyst') {
    const pre = await runDataSourceRetrievalPreStep({
      userId, conversationId, mcpEmailToken, mcpKmOnBehalf, userLocale,
      baseSandboxPath: sandboxPath, userMessage: sanitizedMessage, sseWrite,
    });
    if (pre.ok) {
      finalMessage = pre.handoff + finalMessage;
      if (pre.inputTokens > 0 || pre.outputTokens > 0) {
        await recordTokenUsage({ userId, conversationId, inputTokens: pre.inputTokens, outputTokens: pre.outputTokens, model: pre.model });
      }
    }
    // The generator consumes the retrieved data (datasource_context.md), NOT the raw
    // tools — keeps it a reliable single-purpose generator.
    mcpEmailToken = undefined;
    mcpKmOnBehalf = undefined;
  }

  async function startClaude(sid: string, isResume: boolean) {
    let systemPrompt = baseSystemPrompt;
    if (!isResume) {
      const history = await buildChatHistory(conversationId);
      if (history) systemPrompt = baseSystemPrompt + history;
    }

    // Region context: attach the marked image so Claude can SEE the brushed area
    // (vision) and answer questions about it or decide on an edit.
    const regionImages = regionMarked
      ? [{ media_type: 'image/png', data: regionMarked.toString('base64') }]
      : undefined;
    const regionMsg = regionMarked
      ? `${finalMessage}\n\n【附圖說明】使用者在目前這張資訊圖表上用半透明筆刷塗抹標記了一個區域（已附在訊息圖片中）。請看著那個被標記的區域回答：\n- 如果使用者是「詢問」（例如這是什麼、這裡寫什麼），就直接用文字回答，不要輸出任何指令區塊。\n- 如果使用者是要「修改」那個區域，就照常輸出 gemini-infographic 指令區塊（mode 用 image、edit 設 true，filename 沿用原檔名），prompt 描述要改成什麼即可（系統會只改標記區、其他不動）。`
      : finalMessage;

    const { emitter, abort } = spawnClaude(regionMsg, systemPrompt, {
      userId, conversationId, sessionId: sid, isResume, skillId: effectiveSkillId,
      customAllowedTools: skill?.allowedTools,
      customDisallowedTools: skill?.disallowedTools,
      ...(regionImages ? { images: regionImages } : {}),
      ...(mcpEmailToken ? { mcpEmailToken } : {}),
      ...(mcpKmOnBehalf ? { mcpKmOnBehalf } : {}),
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

          // 資訊圖表技能：Claude 已輸出 gemini-infographic 指令區塊，這裡呼叫
          // Gemini 實際生成（html 或 png）並寫進 sandbox，交給下方既有的檔案
          // 註冊流程交付。Gemini 失敗不影響其他流程，只回報錯誤訊息。
          let extraExpectedType: string | undefined;
          if (effectiveSkillId === 'infographic-gen' && assistantText) {
            const directive = parseInfographicDirective(assistantText);
            // With a region attached: a directive means "edit the brushed area";
            // no directive means it was a question (Claude already answered in text).
            if (directive) {
              try {
                let usage;
                if (regionMarked && regionTargetPath) {
                  const r = await regionEditToFile(regionMarked, directive.prompt || sanitizedMessage, regionTargetPath);
                  usage = r.usage;
                  extraExpectedType = path.extname(regionTargetPath).slice(1).toLowerCase();
                  console.log(`[Infographic] 局部編輯（聊天圈選）約 $${usage.costUsd.toFixed(4)}`);
                } else {
                  const rendered = await renderInfographic(directive, sandboxPath);
                  usage = rendered.usage;
                  extraExpectedType = rendered.fileType;
                  console.log(`[Infographic] 以 Gemini 生成 ${rendered.fileType}（約 $${usage.costUsd.toFixed(4)}）`);
                }

                // Fold the Gemini cost into the conversation's usage by converting
                // it to equivalent output tokens at the display's output rate ($15/M),
                // so every cost view reproduces (gemini cost × markup) without a
                // schema change. Recorded as a separate row + pushed to the live UI.
                const GEMINI_OUTPUT_RATE = 15;
                const geminiTokens = Math.round((usage.costUsd * 1_000_000) / GEMINI_OUTPUT_RATE);
                if (geminiTokens > 0) {
                  await recordTokenUsage({ userId, conversationId, inputTokens: 0, outputTokens: geminiTokens, model: usage.model });
                  totalOutputTokens += geminiTokens;
                  sseWrite({ type: 'usage', data: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, model } });
                }
              } catch (e) {
                sseWrite({ type: 'error', data: `資訊圖表生成失敗：${(e as Error).message}` });
              }
            }
          }

          const ft = skill?.fileType;
          const typeSet = [ft, extraExpectedType].filter((t): t is string => !!t);
          const expectedTypes = typeSet.length ? new Set(typeSet) : undefined;
          const newFiles = await registerNewFiles(userId, conversationId, sandboxPath, existingFiles, expectedTypes);
          if (newFiles.length > 0) {
            // Capture blocks first (no emit yet), verify + auto-correct, then show.
            const captureResults = await Promise.allSettled(
              newFiles.map(f => captureBlocksForFile(f, userId, conversationId, sandboxPath))
            );
            const blocksByFile = new Map<string, DocumentBlock[]>();
            for (let i = 0; i < newFiles.length; i++) {
              const r = captureResults[i];
              if (r.status === 'fulfilled' && r.value) blocksByFile.set(newFiles[i].id, r.value);
            }
            // Resume the file's own generator session to auto-correct fabricated
            // data in place (covers docx/xlsx/pdf/html; pptx uses its dedicated
            // rebuild). Use the freshest session id (the CLI may have rotated it).
            const convNow = await dbGet<{ session_id: string }>('SELECT session_id FROM conversations WHERE id = ?', conversationId);
            const rebuilt = await enforceDataFidelity(
              newFiles, blocksByFile, userId, conversationId, sseWrite,
              // Direct mode: the card skill ran in the base sandbox on the
              // conversation session → correct in place there.
              async () => (convNow?.session_id ? { skillId: effectiveSkillId, sessionId: convNow.session_id } : null),
            );
            const finalFiles = newFiles.map(f => rebuilt.get(f.id) || f);
            // Schema-normalize chart decks (LibreOffice round-trip) so PowerPoint
            // never shows a "repair" prompt for pptxgenjs's non-compliant chart XML.
            await normalizeDeckFiles(finalFiles);
            sseWrite({
              type: 'file_generated',
              data: finalFiles.map(f => ({ id: f.id, filename: f.filename, file_path: f.file_path, file_type: f.file_type, file_size: f.file_size, version: f.version })),
            });
            for (const f of finalFiles) {
              const blocks = blocksByFile.get(f.id);
              if (blocks) sseWrite({ type: 'blocks_ready', data: { fileId: f.id, blocks } });
            }
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
router.get('/:conversationId/status', async (req: Request, res: Response) => {
  const conversationId = req.params.conversationId as string;
  const userId = req.user!.userId;

  const conversation = await dbGet<{ id: string }>(
    'SELECT id FROM conversations WHERE id = ? AND user_id = ?',
    conversationId, userId
  );
  if (!conversation) { res.status(404).json({ error: 'Not found' }); return; }

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
router.post('/:conversationId/abort', async (req: Request, res: Response) => {
  const conversationId = req.params.conversationId as string;
  const userId = req.user!.userId;

  const conversation = await dbGet<{ id: string }>(
    'SELECT id FROM conversations WHERE id = ? AND user_id = ?',
    conversationId, userId
  );
  if (!conversation) { res.status(404).json({ error: 'Not found' }); return; }

  const abortFn = activeGenerations.get(conversationId);
  if (abortFn) {
    abortFn(); activeGenerations.delete(conversationId);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'No active generation for this conversation' });
  }
});

export default router;
