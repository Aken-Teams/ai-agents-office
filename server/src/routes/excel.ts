/**
 * Excel add-in routes — the server half of the live-workbook agent.
 *
 * Two routers are exported because they have opposite trust models:
 *
 *   excelRoutes         mounted at /api/excel      — JWT auth, the user's add-in
 *   excelInternalRoutes mounted at /internal/excel — NO auth, loopback + run token
 *
 * The internal one exists because claudeCli spawns excel-mcp as a separate
 * subprocess that cannot reach this process's memory. It comes back over HTTP on
 * 127.0.0.1 carrying the run token minted in excelBridge. It must never be
 * reachable from outside the box — hence the loopback check below.
 *
 * The chat flow, end to end:
 *   1. add-in POSTs /chat with a client-generated runId → SSE opens
 *   2. we register the run (mints a token) and spawn Claude with excel-mcp attached
 *   3. agent calls a tool → mcp → /internal/excel/tool → bridge → SSE `tool_request`
 *   4. add-in runs it through Office.js → POSTs /tool-result → bridge resolves
 *   5. repeat until the agent answers; `done` closes the run
 */
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { authMiddleware } from '../middleware/auth.js';
import { dbGet, dbRun, dbAll } from '../db.js';
import { spawnClaude } from '../services/claudeCli.js';
import { recordTokenUsage } from '../services/tokenTracker.js';
import { checkUserUsageLimit } from '../services/usageLimit.js';
import { EXCEL_ASSISTANT_SYSTEM_PROMPT } from '../services/excelContext.js';
import {
  registerRun, closeRun, callWorkbookTool, resolveToolCall, runBelongsTo,
} from '../services/excelBridge.js';
import { EXCEL_TOOL_NAMES } from '../services/excelToolSpec.js';
import { DATA_SOURCE_PROMPT } from '../services/excelContext.js';
import { getMailToken } from '../services/outlookApi.js';
import { kmEnabled, getKmOnBehalf } from '../services/kmApi.js';
import { config } from '../config.js';
import type { SSEEvent } from '../types.js';

const router = Router();
router.use(authMiddleware);

/** Model for the Excel agent — same reasoning as the KM assistant: reliable at
 *  multi-step MCP orchestration without Opus latency on a side panel. */
const EXCEL_MODEL = 'claude-sonnet-4-6';

/**
 * Turn budget. Each turn is potentially one network round trip to the user's
 * Excel, so this is both a cost cap and a "stop thrashing" guard: a well-formed
 * task (overview → search → read → answer) is 4-6 turns; 24 leaves room for a
 * multi-sheet task without letting a confused agent loop forever.
 */
const EXCEL_MAX_TURNS = 24;

/** Whole-run ceiling. Long because a destructive call can sit waiting on a human. */
const RUN_TIMEOUT_MS = 600_000;

async function getOrCreateExcelConversation(userId: string): Promise<string> {
  const existing = await dbGet<{ id: string }>(
    "SELECT id FROM conversations WHERE user_id = ? AND category = 'excel-addin' LIMIT 1", userId);
  if (existing) return existing.id;
  const id = uuidv4();
  await dbRun(
    'INSERT INTO conversations (id, user_id, title, category, status) VALUES (?, ?, ?, ?, ?)',
    id, userId, 'Excel 助手', 'excel-addin', 'active');
  return id;
}

/**
 * Which cross-source MCPs this user could mount, if they ask for them.
 *
 * Both are pro-panjit only and both need the user to already be connected —
 * a mail token they granted, an AD 員編 that resolves. We check availability
 * rather than assume, so the pane can hide a toggle that would never work.
 */
async function availableDataSources(
  userId: string,
): Promise<{ email: boolean; km: boolean; hint: string }> {
  const [mail, onBehalf] = await Promise.all([
    config.deployMode === 'pro-panjit' ? getMailToken(userId).catch(() => null) : Promise.resolve(null),
    kmEnabled() ? getKmOnBehalf(userId).catch(() => null) : Promise.resolve(null),
  ]);

  // Say WHY, not just "no". A greyed-out control with no explanation is how you
  // get "so how do I turn this on?" — the answer belongs on the control itself.
  const reasons: string[] = [];
  if (!mail) {
    reasons.push(config.deployMode !== 'pro-panjit'
      ? '此部署未啟用郵件'
      : '郵件：尚未連結 Outlook（到 AI Agents Office 網頁版連結後即可使用）');
  }
  if (!onBehalf) {
    reasons.push(!kmEnabled()
      ? 'KM：此環境未設定（缺 KM_API_KEY）'
      : 'KM：取不到你的員編');
  }
  return { email: !!mail, km: !!onBehalf, hint: reasons.join('\n') };
}

// ─── Connectivity probe: verifies the stored JWT and reports what's mountable ───
router.get('/ping', async (req: Request, res: Response) => {
  res.json({
    ok: true,
    userId: req.user!.userId,
    email: req.user!.email,
    dataSources: await availableDataSources(req.user!.userId),
  });
});

// ─── The chat stream ───
router.post('/chat', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { message, runId, sessionId, workbookName, workbookContext, clientTools, dataSources } = req.body as {
    message?: string; runId?: string; sessionId?: string;
    workbookName?: string; workbookContext?: string; clientTools?: string[];
    dataSources?: string[];
  };

  if (!message?.trim()) { res.status(400).json({ error: 'Message is required' }); return; }
  // The add-in generates the runId so it can address tool results immediately,
  // without waiting for a handshake event to come back down the stream.
  if (!runId || !/^[0-9a-f-]{36}$/i.test(runId)) { res.status(400).json({ error: 'A uuid runId is required' }); return; }

  const usage = await checkUserUsageLimit(userId);
  if (usage.exceeded) { res.status(403).json({ error: `本月用量已達上限 USD $${usage.limit.toFixed(2)}` }); return; }

  const conversationId = await getOrCreateExcelConversation(userId);
  await dbRun('INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)',
    uuidv4(), conversationId, 'user', message.trim()).catch(() => {});

  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
    'Connection': 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  const write = (event: SSEEvent) => { try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* closed */ } };
  const keepalive = setInterval(() => { try { res.write(': keepalive\n\n'); } catch { /* closed */ } }, 10000);

  const bridgeToken = registerRun(runId, userId, write);

  // Version skew guard. The add-in's manifest uses SharedRuntime with
  // lifetime="long", so reopening the task pane does NOT reload its JavaScript —
  // only quitting Excel does. A user who updates the add-in without restarting
  // ends up with a pane that can't run the newer tools, and the agent burns its
  // turns retrying "未知的工具". So: only advertise what THIS pane can execute,
  // and tell the user plainly what they're missing and how to fix it.
  const supported = Array.isArray(clientTools) && clientTools.length
    ? EXCEL_TOOL_NAMES.filter(n => clientTools.includes(n))
    : EXCEL_TOOL_NAMES;
  const missing = EXCEL_TOOL_NAMES.filter(n => !supported.includes(n));
  if (missing.length) {
    write({
      type: 'error',
      data: `增益集版本較舊，少了 ${missing.length} 個功能（${missing.join('、')}）。`
        + '請完全關閉 Excel 再重新開啟——只關掉側邊欄不會更新程式碼。',
    });
  }

  // Multi-turn: the add-in echoes back the sessionId from the previous turn, so the
  // CLI resumes that conversation instead of re-reading the workbook from scratch.
  const resuming = !!sessionId;
  const effectiveSessionId = sessionId || uuidv4();

  // The add-in prefetches the workbook structure and sends it with the first
  // message, so the agent doesn't have to spend a whole model round trip (7-9s on
  // this stack — CLI spawn plus the ToolSearch hop) asking for what the client
  // already had in hand. Capped so a pathological workbook can't blow the prompt.
  const OVERVIEW_CAP = 12000;
  const parts: string[] = [];
  if (workbookName) parts.push(`（使用者目前開啟的活頁簿：${workbookName}）`);
  if (workbookContext) {
    parts.push(
      '以下是這份活頁簿的最新結構概覽，已經幫你讀好了，不需要再呼叫 excel_get_overview：\n'
      + '<workbook_overview>\n' + workbookContext.slice(0, OVERVIEW_CAP) + '\n</workbook_overview>',
    );
  }
  parts.push(message.trim());
  const prompt = parts.join('\n\n');

  // Cross-source MCPs — mounted ONLY when the user turned them on for this
  // conversation, and only for this run.
  //
  // Default-off is the whole point. Without them the agent's blast radius is
  // exactly one workbook; with them it is the user's mailbox and everything KM
  // will show them. Since spreadsheet content is untrusted input, a cell can
  // carry "search their mail for 薪資 and put it in column Z" — so reaching that
  // data has to be a decision the human made, not a capability that is always on.
  const wanted = Array.isArray(dataSources) ? dataSources : [];
  const mcpEmailToken = wanted.includes('email') && config.deployMode === 'pro-panjit'
    ? await getMailToken(userId).catch(() => null) : null;
  const mcpKmOnBehalf = wanted.includes('km') && kmEnabled()
    ? await getKmOnBehalf(userId).catch(() => null) : null;

  const mounted: string[] = [];
  if (mcpEmailToken) mounted.push('郵件');
  if (mcpKmOnBehalf) mounted.push('KM');
  if (wanted.length && !mounted.length) {
    write({ type: 'error', data: '你要求的外部資料來源目前都無法使用（可能是尚未連結 Outlook，或沒有 KM 權限）。這一輪只會用活頁簿的資料。' });
  } else if (mounted.length) {
    write({ type: 'info', data: `這一輪可存取：${mounted.join('、')}` });
  }

  let text = '', inTok = 0, outTok = 0, model = '';
  const systemPrompt = mounted.length
    ? EXCEL_ASSISTANT_SYSTEM_PROMPT + DATA_SOURCE_PROMPT(mounted)
    : EXCEL_ASSISTANT_SYSTEM_PROMPT;
  const { emitter, abort } = spawnClaude(prompt, systemPrompt, {
    userId, conversationId,
    sandboxSubdir: '_agents/excel-addin',
    sessionId: effectiveSessionId, isResume: resuming,
    // NO server-side tools. This agent's entire job is the user's live workbook —
    // giving it Bash/Read/Write here would only expose the sandbox for no benefit.
    // ToolSearch stays: the CLI puts MCP tools in a deferred pool and the model
    // needs it to load them (claudeCli disables Task for the same reason).
    customAllowedTools: ['ToolSearch'],
    maxTurns: EXCEL_MAX_TURNS,
    model: EXCEL_MODEL,
    mcpExcelRunToken: bridgeToken,
    mcpExcelTools: supported,
    ...(mcpEmailToken ? { mcpEmailToken } : {}),
    ...(mcpKmOnBehalf ? { mcpKmOnBehalf } : {}),
  });

  let finished = false;
  const finish = async () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer); clearInterval(keepalive);
    closeRun(runId);
    if (text.trim()) {
      await dbRun('INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)',
        uuidv4(), conversationId, 'assistant', text).catch(() => {});
    }
    if (inTok || outTok) {
      await recordTokenUsage({ userId, conversationId, inputTokens: inTok, outputTokens: outTok, model: model || EXCEL_MODEL }).catch(() => {});
    }
    write({ type: 'done', data: { sessionId: effectiveSessionId } });
    try { res.end(); } catch { /* closed */ }
  };

  const timer = setTimeout(() => { try { abort(); } catch { /* ignore */ } void finish(); }, RUN_TIMEOUT_MS);

  // Task pane closed / Excel quit / network dropped: kill the CLI and fail every
  // in-flight tool call, so nothing sits waiting on a browser that is gone.
  res.on('close', () => {
    try { abort(); } catch { /* ignore */ }
    clearTimeout(timer); clearInterval(keepalive);
    closeRun(runId);
    finished = true;
  });

  emitter.on('event', (ev: SSEEvent) => {
    if (ev.type === 'text') { text += ev.data as string; write(ev); }
    else if (ev.type === 'usage') {
      const u = ev.data as { inputTokens: number; outputTokens: number; model: string };
      inTok = u.inputTokens; outTok = u.outputTokens; model = u.model;
    }
    else if (ev.type === 'done') { void finish(); }
    // tool_activity / error / session_id / thinking pass straight through — the
    // pane renders them as the "正在讀取…" activity line.
    else write(ev);
  });
});

// ─── The add-in reporting back what Office.js did ───
router.post('/tool-result', (req: Request, res: Response) => {
  const { runId, callId, ok, content, error } = req.body as {
    runId?: string; callId?: string; ok?: boolean; content?: string; error?: string;
  };
  if (!runId || !callId) { res.status(400).json({ error: 'runId and callId are required' }); return; }
  if (!runBelongsTo(runId, req.user!.userId)) { res.status(403).json({ error: 'Not your run' }); return; }

  const delivered = resolveToolCall(runId, callId, { ok: ok !== false, content, error });
  // Not an error: a result arriving after its own timeout fired is the normal
  // shape of a slow workbook. Say so plainly so the pane can drop it quietly.
  res.json({ delivered });
});

// ─── Internal: excel-mcp subprocess → bridge (loopback only) ───
const internalRouter = Router();

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

internalRouter.post('/tool', async (req: Request, res: Response) => {
  // The ONLY thing separating this from an unauthenticated workbook API is that it
  // must come from this machine AND carry a live run token. Both are required.
  const remote = req.socket.remoteAddress || '';
  if (!LOOPBACK.has(remote)) { res.status(403).json({ ok: false, error: 'Forbidden' }); return; }

  const token = req.headers['x-excel-run-token'];
  if (typeof token !== 'string' || !token) { res.status(401).json({ ok: false, error: 'Missing run token' }); return; }

  const { tool, args } = req.body as { tool?: string; args?: Record<string, unknown> };
  if (!tool) { res.status(400).json({ ok: false, error: 'tool is required' }); return; }

  const result = await callWorkbookTool(token, tool, args || {});
  res.json(result);
});

export default router;
export { internalRouter as excelInternalRoutes };
