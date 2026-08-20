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
import { kmEnabledFor, getKmOnBehalf } from '../services/kmApi.js';
import { config } from '../config.js';
import type { SSEEvent } from '../types.js';

const router = Router();
router.use(authMiddleware);

/** Model for the Excel agent — same reasoning as the KM assistant: reliable at
 *  multi-step MCP orchestration without Opus latency on a side panel. */
// Measured, same account and same minute, on an identical reproduction:
//   claude-sonnet-4-6   7.7 tokens/sec
//   claude-opus-5      44.0 tokens/sec
// Six times slower, and backwards from what the tiers imply. That gap is what
// turned "build me a calendar" into a fifteen-minute run that hit the timeout —
// not the prompt, and not the account's quota, both of which were investigated
// first and cleared. Claude for Excel runs the same class of task on Opus 5.
// Re-measure with tools/repro before assuming this is still the right choice.
const EXCEL_MODEL = 'claude-opus-5';

/**
 * What the pane offers in its model picker.
 *
 * Server-side on purpose: local / self-hosted models land here as this
 * deployment gains them, and the add-in picks them up without a reinstall —
 * which matters because SharedRuntime means an add-in update needs everyone to
 * quit Excel.
 *
 * `note` is the trade-off in the user's own terms, not a spec sheet. Someone
 * choosing a model in a task pane wants to know "will this be slow" and "will
 * this cost me", not the parameter count.
 */
const EXCEL_MODELS: { id: string; label: string; note: string; default?: boolean }[] = [
  { id: 'claude-opus-5', label: 'Opus 5', note: '最聰明，做整份報表／版面設計用這個', default: true },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', note: '省 token；簡單問答夠用，複雜任務會明顯變慢' },
];

/** Never trust a model id from the client — it is a string that reaches a spawn. */
function resolveModel(requested?: string): string {
  const hit = EXCEL_MODELS.find(m => m.id === requested);
  return hit ? hit.id : EXCEL_MODEL;
}

/**
 * Turn budget. Each turn is potentially one network round trip to the user's
 * Excel, so this is both a cost cap and a "stop thrashing" guard: a well-formed
 * task (overview → search → read → answer) is 4-6 turns; 24 leaves room for a
 * multi-sheet task without letting a confused agent loop forever.
 */
const EXCEL_MAX_TURNS = 24;

/** Whole-run ceiling. Long because a destructive call can sit waiting on a human. */
const RUN_TIMEOUT_MS = 900_000;

/**
 * The conversation this turn belongs to.
 *
 * Keyed by WORKBOOK, not by user. The previous version matched on
 * (user_id, category) alone, which gave each person exactly one Excel
 * conversation for all time — three open workbooks wrote into the same history,
 * and a failed attempt in one file followed you into the next. A workbook is the
 * unit of work here, so it is the unit of memory too.
 *
 * `fresh` retires the current thread and starts another: the same file, a new
 * subject. Retiring rather than deleting keeps the history readable on the web
 * side, which is where someone goes to find what the assistant did last week.
 */
async function getOrCreateExcelConversation(
  userId: string, workbookKey: string, workbookName: string, fresh = false,
): Promise<string> {
  // Falls back to the name when the pane could not mint an id (read-only file,
  // or a host below ExcelApi 1.7) — worse, because a rename then splits the
  // history, but still one thread per file.
  const key = (workbookKey || workbookName || '').slice(0, 255) || '(unnamed)';
  const title = (workbookName || key).slice(0, 255);

  if (fresh) {
    await dbRun(
      "UPDATE conversations SET status = 'closed' WHERE user_id = ? AND category = 'excel-addin' AND workbook_key = ? AND status = 'active'",
      userId, key).catch(() => {});
  } else {
    const existing = await dbGet<{ id: string }>(
      "SELECT id FROM conversations WHERE user_id = ? AND category = 'excel-addin' AND workbook_key = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1",
      userId, key);
    if (existing) return existing.id;
  }

  const id = uuidv4();
  // The workbook name as the title: 「Excel 助手」 on every row told nobody
  // anything in the web app's conversation list.
  await dbRun(
    'INSERT INTO conversations (id, user_id, title, category, status, workbook_key) VALUES (?, ?, ?, ?, ?, ?)',
    id, userId, title || '新對話', 'excel-addin', 'active', key);
  return id;
}

/**
 * Name a thread after its opening question, once.
 *
 * Only on the first user message: later questions wander off the subject, and a
 * title that keeps changing is no use for finding anything. The workbook is
 * already implied — the history list only ever shows one file's threads.
 */
async function titleFromFirstMessage(conversationId: string, message: string): Promise<void> {
  try {
    const row = await dbGet<{ n: number }>(
      "SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND role = 'user'", conversationId);
    if (!row || Number(row.n) !== 1) return;
    const oneLine = message.replace(/\s+/g, ' ').trim();
    const title = oneLine.length > 40 ? oneLine.slice(0, 40) + '…' : oneLine;
    if (title) await dbRun('UPDATE conversations SET title = ? WHERE id = ?', title, conversationId);
  } catch { /* a title is not worth failing a turn over */ }
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
    kmEnabledFor('excel') ? getKmOnBehalf(userId).catch(() => null) : Promise.resolve(null),
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
    reasons.push(!kmEnabledFor('excel')
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
    models: EXCEL_MODELS,
  });
});

// ─── The chat stream ───
router.post('/chat', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { message, runId, sessionId, workbookName, workbookContext, selection, clientTools, dataSources, model: wantedModel, newConversation, workbookKey } = req.body as {
    message?: string; runId?: string; sessionId?: string;
    workbookName?: string; workbookContext?: string; selection?: string; clientTools?: string[];
    model?: string; newConversation?: boolean; workbookKey?: string;
    dataSources?: string[];
  };

  if (!message?.trim()) { res.status(400).json({ error: 'Message is required' }); return; }
  // The add-in generates the runId so it can address tool results immediately,
  // without waiting for a handshake event to come back down the stream.
  if (!runId || !/^[0-9a-f-]{36}$/i.test(runId)) { res.status(400).json({ error: 'A uuid runId is required' }); return; }

  const usage = await checkUserUsageLimit(userId);
  if (usage.exceeded) { res.status(403).json({ error: `本月用量已達上限 USD $${usage.limit.toFixed(2)}` }); return; }

  const conversationId = await getOrCreateExcelConversation(
    userId, workbookKey || '', workbookName || '', !!newConversation);
  await dbRun('INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)',
    uuidv4(), conversationId, 'user', message.trim()).catch(() => {});
  await titleFromFirstMessage(conversationId, message.trim());

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
  // Where the user was pointing when they asked. Placed AFTER the overview and
  // immediately before the question, because that is the reading order that makes
  // it obviously about this message rather than about the session: 「這裡怪怪的」
  // only means something next to the range it was said about.
  const SELECTION_CAP = 2000;
  if (selection) {
    parts.push(
      '使用者在問這句話的時候，正選著下面這個範圍。他多半沒辦法用文字說清楚是哪一欄哪一格——'
      + '這就是他指的地方，優先從這裡看起：\n'
      + '<user_selection>\n' + selection.slice(0, SELECTION_CAP) + '\n</user_selection>',
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
  const mcpKmOnBehalf = wanted.includes('km') && kmEnabledFor('excel')
    ? await getKmOnBehalf(userId).catch(() => null) : null;

  // Web search needs no credential and no MCP — it is a tool the CLI already has,
  // deliberately withheld. Same consent rule as mail and KM: a workbook cell can
  // say "look up X and paste it here", so letting the agent off the machine has to
  // be something the person switched on for this conversation.
  const wantsWeb = wanted.includes('web');

  const mounted: string[] = [];
  if (wantsWeb) mounted.push('網路搜尋');
  if (mcpEmailToken) mounted.push('郵件');
  if (mcpKmOnBehalf) mounted.push('KM');
  if (wanted.length && !mounted.length) {
    write({ type: 'error', data: '你要求的外部資料來源目前都無法使用（可能是尚未連結 Outlook，或沒有 KM 權限）。這一輪只會用活頁簿的資料。' });
  } else if (mounted.length) {
    write({ type: 'info', data: `這一輪可存取：${mounted.join('、')}` });
  }

  let text = '', inTok = 0, outTok = 0, model = '';
  const chosenModel = resolveModel(wantedModel);
  const systemPrompt = mounted.length
    ? EXCEL_ASSISTANT_SYSTEM_PROMPT + DATA_SOURCE_PROMPT(mounted)
    : EXCEL_ASSISTANT_SYSTEM_PROMPT;
  const { emitter, abort } = spawnClaude(prompt, systemPrompt, {
    userId, conversationId,
    sandboxSubdir: '_agents/excel-addin',
    sessionId: effectiveSessionId, isResume: resuming,
    // No filesystem or shell: this agent's job is the live workbook, and a
    // sandbox it cannot see the workbook from is only extra attack surface.
    // ToolSearch stays because the CLI puts MCP tools in a deferred pool.
    // WebSearch is added only when the user asked for it this turn.
    customAllowedTools: wantsWeb ? ['ToolSearch', 'WebSearch', 'WebFetch'] : ['ToolSearch'],
    maxTurns: EXCEL_MAX_TURNS,
    // The pane captions the running step with the model's reasoning. Without
    // this the CLI only emits whole messages, so a 30-second generation shows
    // as a spinner with nothing under it.
    partialMessages: true,
    model: chosenModel,
    mcpExcelRunToken: bridgeToken,
    mcpExcelTools: supported,
    ...(mcpEmailToken ? { mcpEmailToken } : {}),
    ...(mcpKmOnBehalf ? { mcpKmOnBehalf } : {}),
  });

  let finished = false;
  /** Set when WE stop the run (not the model finishing), so `done` can explain itself. */
  let stopReason: string | null = null;
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
      await recordTokenUsage({ userId, conversationId, inputTokens: inTok, outputTokens: outTok, model: model || chosenModel }).catch(() => {});
    }
    // A run that was cut short has to SAY so. Sending a bare `done` made a
    // 10-minute timeout indistinguishable from a finished answer — that is exactly
    // what 「跑一半就沒跑出來」 looked like from the pane.
    if (stopReason === 'timeout') {
      write({
        type: 'error',
        data: `已經跑到 ${Math.round(RUN_TIMEOUT_MS / 60000)} 分鐘的上限，先停在這裡——上面是已經完成的部分。`
          + '把工作拆小一點再問一次通常就過得去。',
      });
    }
    write({ type: 'done', data: { sessionId: effectiveSessionId, stopReason } });
    try { res.end(); } catch { /* closed */ }
  };

  // Deliberate stop, so `finish` can tell the user WHY the answer ends here.
  const timer = setTimeout(() => {
    stopReason = 'timeout';
    try { abort(); } catch { /* ignore */ }
    void finish();
  }, RUN_TIMEOUT_MS);

  // Task pane closed / Excel quit / network dropped: kill the CLI and fail every
  // in-flight tool call, so nothing sits waiting on a browser that is gone.
  res.on('close', () => {
    try { abort(); } catch { /* ignore */ }
    clearTimeout(timer); clearInterval(keepalive);
    closeRun(runId);
    finished = true;
  });

  // Where does the wall-clock actually go?
  //
  // A turn can sit for a minute with the pane showing 「思考中」 and nothing to
  // explain it. This logs only the gaps longer than 3s, with the event type that
  // finally broke each one, so the answer is a log line instead of a guess:
  // a long gap followed by `text` means time-to-first-token on an oversized
  // prompt; followed by `tool_activity` means the model was composing a call.
  let lastEventAt = Date.now();
  emitter.on('event', (ev: SSEEvent) => {
    const gap = Date.now() - lastEventAt;
    lastEventAt = Date.now();
    if (gap > 3000) {
      console.log(`[excel] gap ${(gap / 1000).toFixed(1)}s → ${ev.type}`
        + (ev.type === 'tool_activity' ? ` ${JSON.stringify(ev.data)}` : ''));
    }
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

/** Past threads for one workbook, newest first. */
router.get('/conversations', async (req: Request, res: Response) => {
  const key = String(req.query.workbookKey || req.query.workbook || '').slice(0, 255);
  if (!key) { res.json({ conversations: [] }); return; }
  const rows = await dbAll<{ id: string; title: string; status: string; created_at: string; turns: number }>(
    `SELECT c.id, c.title, c.status, c.created_at,
            (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user') AS turns
       FROM conversations c
      WHERE c.user_id = ? AND c.category = 'excel-addin' AND c.workbook_key = ?
      ORDER BY c.created_at DESC LIMIT 20`,
    req.user!.userId, key).catch(() => []);
  res.json({ conversations: rows });
});

/** The messages of one thread — only ever one the caller owns. */
router.get('/conversations/:id/messages', async (req: Request, res: Response) => {
  const owned = await dbGet<{ id: string }>(
    "SELECT id FROM conversations WHERE id = ? AND user_id = ? AND category = 'excel-addin'",
    req.params.id, req.user!.userId);
  if (!owned) { res.status(404).json({ error: 'Not found' }); return; }
  const rows = await dbAll<{ role: string; content: string; created_at: string }>(
    'SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 200',
    req.params.id).catch(() => []);
  res.json({ messages: rows });
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
