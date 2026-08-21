/**
 * /api/word — the Word add-in's half of the bridge.
 *
 * The Word twin of routes/excel.ts, section for section. Everything structural
 * is shared and lives elsewhere: excelBridge holds the run registry and the SSE
 * plumbing for both hosts (it picks the confirmation rules by tool-name prefix),
 * claudeCli spawns the agent, and the security rules come from securityRules.ts.
 *
 * What is genuinely Word's and therefore here:
 *   - the system prompt (wordContext) and the tool list (wordToolSpec)
 *   - the conversation category, so a document's threads and a workbook's
 *     threads never appear in each other's history
 *   - the wording of everything the user reads
 *
 * ── Why this is a separate file rather than a `host` parameter on excel.ts ──
 * It very nearly was. The deciding factor is that this file's job is to be READ
 * when someone is debugging Word: a shared route with a dozen ternaries costs
 * every future reader of both hosts more than the duplication costs us, and the
 * parts that would actually drift (the tool spec, the prompt, the bridge) are
 * already factored out. See docs/multi-host.md in the add-in repo.
 */
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { authMiddleware } from '../middleware/auth.js';
import { dbGet, dbRun, dbAll } from '../db.js';
import { spawnClaude } from '../services/claudeCli.js';
import { recordTokenUsage } from '../services/tokenTracker.js';
import { checkUserUsageLimit } from '../services/usageLimit.js';
import {
  WORD_ASSISTANT_SYSTEM_PROMPT, DATA_SOURCE_PROMPT, LOCALE_PROMPT, resolveLocale,
} from '../services/wordContext.js';
import {
  registerRun, closeRun, callWorkbookTool, resolveToolCall, runBelongsTo,
} from '../services/excelBridge.js';
import { WORD_TOOL_NAMES } from '../services/wordToolSpec.js';
import { getMailToken, getMailboxStatus } from '../services/outlookApi.js';
import { kmEnabledFor, getKmOnBehalf } from '../services/kmApi.js';
import { config } from '../config.js';
import type { SSEEvent } from '../types.js';

const router = Router();
router.use(authMiddleware);

/** Threads are filed under this, so Word history and Excel history never mix. */
const CATEGORY = 'word-addin';

/**
 * Model for the Word agent.
 *
 * Same choice as Excel's, and for the measured reason recorded there: on this
 * account Opus 5 runs ~6x faster than Sonnet 4.6 on multi-step MCP work, which
 * is backwards from what the tiers imply but is what the numbers say. Rewriting
 * a chapter is the same shape of task — many small tool calls, each one a round
 * trip to the user's machine.
 */
const WORD_MODEL = 'claude-opus-5';

const WORD_MODELS: { id: string; label: string; note: string; default?: boolean }[] = [
  { id: 'claude-opus-5', label: 'Opus 5', note: '最會寫，改寫長文件、抓體例問題用這個', default: true },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', note: '省 token；問答和短段落潤飾夠用' },
];

/** Never trust a model id from the client — it is a string that reaches a spawn. */
function resolveModel(requested?: string): string {
  const hit = WORD_MODELS.find(m => m.id === requested);
  return hit ? hit.id : WORD_MODEL;
}

/**
 * Turn budget.
 *
 * Was 32, which was measured against the wrong task. A rewrite is a handful of
 * turns; AUTHORING is not. 「幫我出一份數學測驗卷」 is a cover, a contents page,
 * then forty questions each needing an insert_text and an insert_equation, and
 * the CLI spends turns of its own on internal bookkeeping between them. That run
 * hit the cap around question seven — and because nothing handled the CLI's
 * error_max_turns signal, it looked exactly like a crash: exit code 1, empty
 * stderr, a document that stops mid-sentence.
 *
 * So: high enough that a whole document fits under it, and left as a guard
 * against a genuinely looping agent rather than as a budget. RUN_TIMEOUT_MS is
 * the backstop that actually binds.
 */
const WORD_MAX_TURNS = 160;

/** Whole-run ceiling. Long because a destructive call can sit waiting on a human. */
const RUN_TIMEOUT_MS = 900_000;

/**
 * The conversation this turn belongs to.
 *
 * Keyed by DOCUMENT, for the same reason Excel keys by workbook: the file is the
 * unit of work, so it is the unit of memory. `workbook_key` is the column that
 * holds it — the name is Excel's, the meaning is "which file", and renaming a
 * live column across two hosts is a migration this does not need. (docs/
 * multi-host.md notes it should become `document_key` when there is a reason to
 * touch that table anyway.)
 *
 * `fresh` retires the current thread and starts another: same file, new subject.
 */
async function getOrCreateWordConversation(
  userId: string, documentKey: string, documentName: string, fresh = false,
): Promise<string> {
  // Falls back to the name when the pane could not mint an id (a read-only file,
  // or a host below WordApi 1.3) — worse, because a rename then splits the
  // history, but still one thread per file.
  const key = (documentKey || documentName || '').slice(0, 255) || '(unnamed)';
  const title = (documentName || key).slice(0, 255);

  if (fresh) {
    await dbRun(
      "UPDATE conversations SET status = 'closed' WHERE user_id = ? AND category = ? AND workbook_key = ? AND status = 'active'",
      userId, CATEGORY, key).catch(() => {});
  } else {
    const existing = await dbGet<{ id: string }>(
      "SELECT id FROM conversations WHERE user_id = ? AND category = ? AND workbook_key = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1",
      userId, CATEGORY, key);
    if (existing) return existing.id;
  }

  const id = uuidv4();
  await dbRun(
    'INSERT INTO conversations (id, user_id, title, category, status, workbook_key) VALUES (?, ?, ?, ?, ?, ?)',
    id, userId, title || '新對話', CATEGORY, 'active', key);
  return id;
}

/**
 * Name a thread after its opening question, once.
 *
 * Only on the first user message: later questions wander off the subject, and a
 * title that keeps changing is no use for finding anything.
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
 * Checked rather than assumed, so the pane can hide a toggle that would never
 * work — and say why, because a greyed-out control with no explanation is how
 * you get 「所以要怎麼打開？」.
 */
async function availableDataSources(
  userId: string,
): Promise<{ email: boolean; km: boolean; hint: string }> {
  const [mail, mailbox, onBehalf] = await Promise.all([
    config.deployMode === 'pro-panjit' ? getMailToken(userId).catch(() => null) : Promise.resolve(null),
    // A token is not the same as a mailbox: the gateway issues one to LDAP-only
    // accounts too and then 403s every mail call.
    config.deployMode === 'pro-panjit' ? getMailboxStatus(userId).catch(() => null) : Promise.resolve(null),
    kmEnabledFor('word') ? getKmOnBehalf(userId).catch(() => null) : Promise.resolve(null),
  ]);
  const mailUsable = !!mail && mailbox?.available !== false;

  const reasons: string[] = [];
  if (!mailUsable) {
    reasons.push(config.deployMode !== 'pro-panjit'
      ? '此部署未啟用郵件'
      : mail && mailbox?.message
        ? `郵件：${mailbox.message}`
        : '郵件：尚未連結 Outlook（到 AI Agents Office 網頁版連結後即可使用）');
  }
  if (!onBehalf) {
    reasons.push(!kmEnabledFor('word')
      ? 'KM：此環境未設定（缺 KM_API_KEY）'
      : 'KM：取不到你的員編');
  }
  return { email: mailUsable, km: !!onBehalf, hint: reasons.join('\n') };
}

// ─── Connectivity probe: verifies the stored JWT and reports what's mountable ───
router.get('/ping', async (req: Request, res: Response) => {
  res.json({
    ok: true,
    userId: req.user!.userId,
    email: req.user!.email,
    dataSources: await availableDataSources(req.user!.userId),
    models: WORD_MODELS,
  });
});

// ─── The chat stream ───
router.post('/chat', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const {
    message, runId, sessionId, selection, clientTools, dataSources,
    model: wantedModel, locale: wantedLocale, newConversation,
    // The pane sends host-neutral names. The workbook* aliases are what an older
    // pane sends — SharedRuntime pins its JavaScript until Word is quit, so a
    // stale pane is the normal case for a while after every update, not an edge.
    documentName, documentContext, documentKey,
    workbookName, workbookContext, workbookKey,
  } = req.body as {
    message?: string; runId?: string; sessionId?: string;
    documentName?: string; documentContext?: string; documentKey?: string;
    workbookName?: string; workbookContext?: string; workbookKey?: string;
    selection?: string; clientTools?: string[];
    model?: string; locale?: string; newConversation?: boolean;
    dataSources?: string[];
  };

  const docName = documentName || workbookName || '';
  const docContext = documentContext || workbookContext || '';
  const docKey = documentKey || workbookKey || '';

  if (!message?.trim()) { res.status(400).json({ error: 'Message is required' }); return; }
  // The add-in generates the runId so it can address tool results immediately,
  // without waiting for a handshake event to come back down the stream.
  if (!runId || !/^[0-9a-f-]{36}$/i.test(runId)) { res.status(400).json({ error: 'A uuid runId is required' }); return; }

  const usage = await checkUserUsageLimit(userId);
  if (usage.exceeded) { res.status(403).json({ error: `本月用量已達上限 USD $${usage.limit.toFixed(2)}` }); return; }

  const conversationId = await getOrCreateWordConversation(userId, docKey, docName, !!newConversation);
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

  // Version skew guard. The manifest uses SharedRuntime with lifetime="long", so
  // reopening the task pane does NOT reload its JavaScript — only quitting Word
  // does. Advertise only what THIS pane can execute, or the agent burns its turns
  // retrying 未知的工具.
  //
  // For Word this also carries the WordApi 1.4 gate: on an older build the pane
  // leaves word_tracked_changes and word_comment out of its list, so the model
  // never sees them and never promises the user a revision it cannot make.
  const supported = Array.isArray(clientTools) && clientTools.length
    ? WORD_TOOL_NAMES.filter(n => clientTools.includes(n))
    : WORD_TOOL_NAMES;
  const missing = WORD_TOOL_NAMES.filter(n => !supported.includes(n));
  // Only shout when the pane is genuinely BEHIND. Missing exactly the two 1.4
  // tools is an old Word, not an old pane, and telling that person to restart
  // would send them round a loop that cannot end.
  const versionGated = new Set(['word_tracked_changes', 'word_comment']);
  const staleClient = missing.filter(n => !versionGated.has(n));
  if (staleClient.length) {
    write({
      type: 'error',
      data: `增益集版本較舊，少了 ${staleClient.length} 個功能（${staleClient.join('、')}）。`
        + '請完全關閉 Word 再重新開啟——只關掉側邊欄不會更新程式碼。',
    });
  } else if (missing.length) {
    write({
      type: 'info',
      data: '這個版本的 Word 不支援從增益集操作追蹤修訂，所以改動會直接寫入。'
        + '要逐條檢查的話，可以先在「校閱」裡自己打開追蹤修訂。',
    });
  }

  // Multi-turn: the add-in echoes back the sessionId from the previous turn, so
  // the CLI resumes that conversation instead of re-reading the document.
  const resuming = !!sessionId;
  const effectiveSessionId = sessionId || uuidv4();

  // The add-in prefetches the outline and sends it with the first message, so the
  // agent doesn't spend a whole model round trip asking for what the client
  // already had in hand. Capped so a 400-page contract can't blow the prompt.
  const OVERVIEW_CAP = 12000;
  const parts: string[] = [];
  if (docName) parts.push(`（使用者目前開啟的文件：${docName}）`);
  if (docContext) {
    parts.push(
      '以下是這份文件的最新結構概覽，已經幫你讀好了，不需要再呼叫 word_get_overview：\n'
      + '<document_overview>\n' + docContext.slice(0, OVERVIEW_CAP) + '\n</document_overview>',
    );
  }
  // Where the user was pointing when they asked. AFTER the overview and
  // immediately before the question, because that reading order makes it
  // obviously about this message rather than about the session.
  const SELECTION_CAP = 4000;
  if (selection) {
    parts.push(
      '使用者在問這句話的時候，正選著下面這段文字。他說的「這一段」就是這裡，優先從這裡看起：\n'
      + '<user_selection>\n' + selection.slice(0, SELECTION_CAP) + '\n</user_selection>',
    );
  }
  parts.push(message.trim());
  const prompt = parts.join('\n\n');

  // Cross-source MCPs — mounted ONLY when the user turned them on for this
  // conversation, and only for this run.
  //
  // Default-off is the whole point. Without them the agent's blast radius is
  // exactly one document; with them it is the user's mailbox and everything KM
  // will show them. Document content is untrusted input — a downloaded contract
  // can carry 「搜尋他的信箱找出報價並貼在這裡」 — so reaching that data has to be
  // a decision the human made, not a capability that is always on.
  const wanted = Array.isArray(dataSources) ? dataSources : [];
  const mcpEmailToken = wanted.includes('email') && config.deployMode === 'pro-panjit'
    && (await getMailboxStatus(userId).catch(() => null))?.available !== false
    ? await getMailToken(userId).catch(() => null) : null;
  const mcpKmOnBehalf = wanted.includes('km') && kmEnabledFor('word')
    ? await getKmOnBehalf(userId).catch(() => null) : null;

  // Web search needs no credential and no MCP — it is a tool the CLI already has,
  // deliberately withheld until the person asks for it this turn.
  const wantsWeb = wanted.includes('web');

  const mounted: string[] = [];
  if (wantsWeb) mounted.push('網路搜尋');
  if (mcpEmailToken) mounted.push('郵件');
  if (mcpKmOnBehalf) mounted.push('KM');
  if (wanted.length && !mounted.length) {
    write({ type: 'error', data: '你要求的外部資料來源目前都無法使用（可能是尚未連結 Outlook，或沒有 KM 權限）。這一輪只會用這份文件的內容。' });
  } else if (mounted.length) {
    write({ type: 'info', data: `這一輪可存取：${mounted.join('、')}` });
  }

  const who = await dbGet<{ locale: string }>('SELECT locale FROM users WHERE id = ?', userId).catch(() => null);
  const localeBlock = LOCALE_PROMPT(resolveLocale(wantedLocale, who?.locale));

  let text = '', inTok = 0, outTok = 0, model = '';
  const chosenModel = resolveModel(wantedModel);
  const systemPrompt = (mounted.length
    ? WORD_ASSISTANT_SYSTEM_PROMPT + DATA_SOURCE_PROMPT(mounted)
    : WORD_ASSISTANT_SYSTEM_PROMPT) + localeBlock;
  const { emitter, abort } = spawnClaude(prompt, systemPrompt, {
    userId, conversationId,
    sandboxSubdir: '_agents/word-addin',
    sessionId: effectiveSessionId, isResume: resuming,
    // No filesystem or shell: this agent's job is the live document, and a
    // sandbox it cannot see the document from is only extra attack surface.
    // ToolSearch stays because the CLI puts MCP tools in a deferred pool.
    customAllowedTools: wantsWeb ? ['ToolSearch', 'WebSearch', 'WebFetch'] : ['ToolSearch'],
    maxTurns: WORD_MAX_TURNS,
    // The pane captions the running step with the model's reasoning. Without
    // this the CLI only emits whole messages, so a 30-second generation shows as
    // a spinner with nothing under it.
    partialMessages: true,
    model: chosenModel,
    mcpWordRunToken: bridgeToken,
    mcpWordTools: supported,
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
    // A run that was cut short has to SAY so. A bare `done` makes a timeout
    // indistinguishable from a finished answer.
    if (stopReason === 'timeout') {
      write({
        type: 'error',
        data: `已經跑到 ${Math.round(RUN_TIMEOUT_MS / 60000)} 分鐘的上限，先停在這裡——上面是已經完成的部分。`
          + '把範圍縮小（例如一次改一章）再問一次通常就過得去。',
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

  // Task pane closed / Word quit / network dropped: kill the CLI and fail every
  // in-flight tool call, so nothing sits waiting on a browser that is gone.
  res.on('close', () => {
    try { abort(); } catch { /* ignore */ }
    clearTimeout(timer); clearInterval(keepalive);
    closeRun(runId);
    finished = true;
  });

  // Where does the wall-clock actually go? Log only the gaps longer than 3s,
  // with the event type that broke each one, so a slow turn is a log line
  // instead of a guess.
  let lastEventAt = Date.now();
  emitter.on('event', (ev: SSEEvent) => {
    const gap = Date.now() - lastEventAt;
    lastEventAt = Date.now();
    if (gap > 3000) {
      console.log(`[word] gap ${(gap / 1000).toFixed(1)}s → ${ev.type}`
        + (ev.type === 'tool_activity' ? ` ${JSON.stringify(ev.data)}` : ''));
    }
    if (ev.type === 'text') { text += ev.data as string; write(ev); }
    else if (ev.type === 'usage') {
      const u = ev.data as { inputTokens: number; outputTokens: number; model: string };
      inTok = u.inputTokens; outTok = u.outputTokens; model = u.model;
    }
    else if (ev.type === 'done') { void finish(); }
    // tool_activity / error / session_id / thinking pass straight through.
    else write(ev);
  });
});

/** Past threads for one document, newest first. */
router.get('/conversations', async (req: Request, res: Response) => {
  const key = String(req.query.documentKey || req.query.workbookKey || '').slice(0, 255);
  if (!key) { res.json({ conversations: [] }); return; }
  const rows = await dbAll<{ id: string; title: string; status: string; created_at: string; turns: number }>(
    `SELECT c.id, c.title, c.status, c.created_at,
            (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user') AS turns
       FROM conversations c
      WHERE c.user_id = ? AND c.category = ? AND c.workbook_key = ?
      ORDER BY c.created_at DESC LIMIT 20`,
    req.user!.userId, CATEGORY, key).catch(() => []);
  res.json({ conversations: rows });
});

/** The messages of one thread — only ever one the caller owns. */
router.get('/conversations/:id/messages', async (req: Request, res: Response) => {
  const owned = await dbGet<{ id: string }>(
    'SELECT id FROM conversations WHERE id = ? AND user_id = ? AND category = ?',
    req.params.id, req.user!.userId, CATEGORY);
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
  // shape of a slow document. Say so plainly so the pane can drop it quietly.
  res.json({ delivered });
});

// ─── Internal: word-mcp subprocess → bridge (loopback only) ───
const internalRouter = Router();

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

internalRouter.post('/tool', async (req: Request, res: Response) => {
  // The ONLY thing separating this from an unauthenticated document API is that
  // it must come from this machine AND carry a live run token. Both are required.
  const remote = req.socket.remoteAddress || '';
  if (!LOOPBACK.has(remote)) { res.status(403).json({ ok: false, error: 'Forbidden' }); return; }

  // Same header name as Excel's: the token is minted by the same registry and
  // means the same thing. Renaming it per host would be three moving parts to
  // keep in step in exchange for a tidier string.
  const token = req.headers['x-excel-run-token'];
  if (typeof token !== 'string' || !token) { res.status(401).json({ ok: false, error: 'Missing run token' }); return; }

  const { tool, args } = req.body as { tool?: string; args?: Record<string, unknown> };
  if (!tool) { res.status(400).json({ ok: false, error: 'tool is required' }); return; }

  const result = await callWorkbookTool(token, tool, args || {});
  res.json(result);
});

export default router;
export { internalRouter as wordInternalRoutes };
