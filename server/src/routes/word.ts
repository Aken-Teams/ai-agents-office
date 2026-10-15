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
import { templateForAudit } from './promptTemplates.js';
import { skillsForHost } from '../skills/loader.js';
import { dbGet, dbRun, dbAll } from '../db.js';
import { spawnClaude } from '../services/claudeCli.js';
import { recordTokenUsage } from '../services/tokenTracker.js';
import { checkUserUsageLimit } from '../services/usageLimit.js';
import {
  WORD_ASSISTANT_SYSTEM_PROMPT, DATA_SOURCE_PROMPT, LOCALE_PROMPT, resolveLocale,
} from '../services/wordContext.js';
import { runLocalAgent, isLocalModel, LOCAL_MODEL_CHOICES } from '../services/localAgent.js';
import {
  registerRun, closeRun, callWorkbookTool, resolveToolCall, runBelongsTo,
} from '../services/excelBridge.js';
import { WORD_TOOL_NAMES, WORD_SERVER_TOOLS, WORD_TOOLS } from '../services/wordToolSpec.js';
import { getMailToken, getMailboxStatus } from '../services/outlookApi.js';
import { kmEnabledFor, getKmOnBehalf } from '../services/kmApi.js';
import { config } from '../config.js';
import multer from 'multer';
import {
  addAttachment, getAttachment, describeAttachments, type StoredAttachment,
} from '../services/excelAttachments.js';
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
const WORD_MODEL = 'claude-opus-5-5';

/**
 * What the model picker offers.
 *
 * ── Names only, on purpose ──
 * An earlier version carried a one-line note and a price per row. It read as a
 * comparison table in a 250px menu: four rows of prose to scan past before
 * reaching the one you were going to pick anyway. Somebody opening this menu has
 * already decided to change model; what they need is the list, not a briefing.
 *
 * The `note` field stays in the shape because the pane still renders one when it
 * is there — it is the right place for a caveat that only applies to one entry,
 * not a slot every entry has to fill.
 */
/**
 * 選單上的模型。
 *
 * 地端那兩個是量過才放上來的：它們把真的工具規格跑完四題單輪和三個多輪情境，
 * 沒有發明參數、也沒有不讀就寫。沒過的那幾個刻意不列——**選單上的每一個選項都是
 * 一個承諾**，列一個後端跑不動的東西比不列更糟。
 */
const WORD_MODELS: { id: string; label: string; note: string; default?: boolean }[] = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', note: '', default: true },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', note: '' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', note: '' },
  { id: 'claude-opus-5', label: 'Opus 5', note: '' },
  /**
   * 地端模型預設不列。整條執行路徑還在，開關在 LOCAL_MODELS_ENABLED——
   * 選單上沒有的 id 會被 resolveModel 擋下來退回預設，所以關掉就是真的關掉。
   */
  ...LOCAL_MODEL_CHOICES().map((m) => ({ id: m.id, label: m.label, note: '' })),
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
    /**
     * 帳號設定的語言，窗格要拿它來顯示「跟著帳號設定」實際上是哪一個。
     *
     * ── 為什麼非給不可 ──
     * 窗格的語言選單停在「跟著帳號設定」時，它送出的 locale 是空的，伺服器就改用帳號的
     * 設定。但窗格介面在沒有指定語言時會退回預設字典（中文）——於是使用者看到的是
     * 中文介面配英文回覆，而且**沒有任何一個設定看起來是錯的**。
     *
     * 他不可能自己查出來，因為那個值只存在伺服器。所以把它送回去，讓選單寫清楚
     * 「跟著帳號設定（目前：English）」。
     */
    locale: (await dbGet<{ locale: string }>(
      'SELECT locale FROM users WHERE id = ?', req.user!.userId).catch(() => null))?.locale || '',
  });
});

// ─── Files the person attached to the next question ───
//
// Same store, same parser, same limits as Excel's — services/excelAttachments.ts
// is not Excel-specific despite the name, and a person attaching last year's
// report should not find the button behaves differently depending on which
// Office app they happen to be in.
const uploadToMemory = multer({ storage: multer.memoryStorage() });

router.post('/attachments', (req: Request, res: Response) => {
  uploadToMemory.array('files', 5)(req, res, async (err: unknown) => {
    if (err) {
      const m = err as { code?: string; message?: string };
      res.status(400).json({
        error: m.code === 'LIMIT_FILE_SIZE' ? '檔案太大。' : (m.message || '檔案上傳失敗。'),
      });
      return;
    }
    const files = ((req as Request & { files?: Express.Multer.File[] }).files) || [];
    if (!files.length) { res.status(400).json({ error: '沒有收到檔案。' }); return; }

    // The same result shape Excel's endpoint answers with. The pane parses one
    // format, so these two must not drift apart.
    const accepted: { id: string; filename: string; chars: number; blocked: boolean }[] = [];
    const rejected: { filename: string; reason: string }[] = [];
    for (const f of files) {
      // Multer/busboy parses multipart filenames as latin1, which mangles
      // Chinese. Same fix routes/uploads.ts carries, for the same reason.
      const raw = f.originalname || 'file';
      const filename = /[^\u0000-\u00ff]/.test(raw) ? raw : Buffer.from(raw, 'latin1').toString('utf8');
      const r = await addAttachment(req.user!.userId, filename, f.buffer);
      if (r.ok) {
        accepted.push({ id: r.file.id, filename, chars: r.file.text?.length ?? 0, blocked: r.file.blocked });
      } else {
        rejected.push({ filename, reason: r.reason });
      }
    }
    res.json({ accepted, rejected });
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
    documentName, documentContext, documentKey, attachments, fileIds,
    workbookName, workbookContext, workbookKey,
  } = req.body as {
    message?: string; runId?: string; sessionId?: string;
    documentName?: string; documentContext?: string; documentKey?: string;
    workbookName?: string; workbookContext?: string; workbookKey?: string;
    selection?: string; clientTools?: string[];
    model?: string; locale?: string; newConversation?: boolean;
    dataSources?: string[]; attachments?: number; fileIds?: string[];
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
  // PRD 3.5 asks the audit log to name the 常用指令 a turn was started from.
  // Resolved server-side rather than trusted: a forged id records nothing rather
  // than attributing this turn to a stranger's template.
  const appliedTemplate = await templateForAudit(userId, (req.body as Record<string, unknown>).promptTemplateId);
  await dbRun(
    'INSERT INTO messages (id, conversation_id, role, content, prompt_template_id) VALUES (?, ?, ?, ?, ?)',
    uuidv4(), conversationId, 'user', message.trim(), appliedTemplate).catch(() => {});
  await titleFromFirstMessage(conversationId, message.trim());

  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
    'Connection': 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  const write = (event: SSEEvent) => { try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* closed */ } };
  const keepalive = setInterval(() => { try { res.write(': keepalive\n\n'); } catch { /* closed */ } }, 10000);

  // The ids go to the run so word_read_file can be answered here rather than
  // being sent down to Word and back for text this process already holds.
  // Resolved against THIS user before the run is registered: ids come from the
  // client, and one that belongs to somebody else — or expired an hour ago —
  // must drop out here rather than reach the store.
  const uploaded: StoredAttachment[] = (Array.isArray(fileIds) ? fileIds.slice(0, 8) : [])
    .map((id) => getAttachment(userId, String(id)))
    .filter((f): f is StoredAttachment => !!f);

  // origin and allowPhoto are PowerPoint's concerns; conversationId is not —
  // every audited action needs to say which conversation it belongs to.
  const bridgeToken = registerRun(runId, userId, write, uploaded.map((f) => f.id),
    // 模型在這裡就決定好，稽核紀錄才知道這一輪的每一個動作是誰做的。
    documentName, '', false, conversationId, resolveModel(wantedModel));

  // Version skew guard. The manifest uses SharedRuntime with lifetime="long", so
  // reopening the task pane does NOT reload its JavaScript — only quitting Word
  // does. Advertise only what THIS pane can execute, or the agent burns its turns
  // retrying 未知的工具.
  //
  // For Word this also carries the WordApi 1.4 gate: on an older build the pane
  // leaves word_tracked_changes and word_comment out of its list, so the model
  // never sees them and never promises the user a revision it cannot make.
  const supported = Array.isArray(clientTools) && clientTools.length
    // Server-answered tools are never in the pane's list — it does not run them —
    // so they have to be added back or the model would never see them.
    ? WORD_TOOL_NAMES.filter(n => clientTools.includes(n) || WORD_SERVER_TOOLS.includes(n))
    : WORD_TOOL_NAMES;
  const missing = WORD_TOOL_NAMES.filter(n => !supported.includes(n) && !WORD_SERVER_TOOLS.includes(n));
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
  // Attached files go in AFTER the document overview and BEFORE the question,
  // for the same reason the selection does: reading order is what makes it
  // obvious they belong to this message rather than to the session.
  // Resolved against THIS user before the run starts: ids come from the client,
  // and one that belongs to somebody else — or expired — must drop out here
  // rather than reach the store.
  // A manifest, not the contents. A 200 000 character PDF pushed into the prompt
  // would crowd out the document the person actually wants written, so the model
  // is told what it has and reads the parts it needs.
  if (uploaded.length) {
    parts.push(
      `使用者這則訊息上傳了 ${uploaded.length} 個檔案：\n${describeAttachments(uploaded)}\n`
      + `用 word_read_file 讀（index 從 1 到 ${uploaded.length}，長檔案用 part 一段一段拿）。`
      + '他多半是要你**依這些檔案產出一份 Word 文件**——讀完就直接動手寫進文件，'
      + '不要只把內容複述一遍。',
    );
  } else if (Array.isArray(fileIds) && fileIds.length) {
    write({ type: 'error', data: '附加的檔案已經過期了。請重新上傳一次。' });
  }

  // Images the person pasted. The pane holds the bytes; this is only the count,
  // and word_read_attachment is what actually fetches one — same design as
  // Excel's, so a screenshot behaves the same in both hosts.
  const imageCount = Number.isFinite(Number(attachments))
    ? Math.max(0, Math.min(8, Number(attachments))) : 0;
  if (imageCount) {
    parts.push(
      `使用者在這則訊息附了 ${imageCount} 張圖片。用 word_read_attachment 看（index 從 1 到 ${imageCount}）。`
      + '多半那張圖就是他要問的東西本身——先看過再回答，不要先問他圖裡是什麼。',
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
    /**
   * 使用技能 (PRD 3.1): the person picked a specialist for this turn.
   *
   * Appended to the host prompt rather than replacing it. The host prompt is
   * what makes the agent able to drive this document at all — the tool
   * contract, the confirmation rules, the citation format — and a skill that
   * replaced it would be an agent with expertise and no hands. A skill adds
   * judgement on top: which numbers matter, what order to do things in.
   *
   * Resolved through skillsForHost, so an id that is real but belongs to
   * another surface is ignored rather than honoured — otherwise the web
   * app's file generators would be reachable from a task pane by id.
   */
  const wantedSkill = String((req.body as Record<string, unknown>).skillId || '').trim();
  const skill = wantedSkill
    ? skillsForHost('word').find(sk => sk.id === wantedSkill)
    : undefined;
  if (wantedSkill && !skill) {
    write({ type: 'info', data: '找不到指定的技能，這一輪改由 AI 自動判斷。' });
  } else if (skill) {
    write({ type: 'info', data: `這一輪使用技能：${skill.name}` });
  }

  const systemPrompt = (mounted.length
    ? WORD_ASSISTANT_SYSTEM_PROMPT + DATA_SOURCE_PROMPT(mounted)
    : WORD_ASSISTANT_SYSTEM_PROMPT) + localeBlock
    + (skill ? `

## 這一輪指定的專業技能：${skill.name}
${skill.systemPrompt}
` : '');
  /**
   * 兩條執行路徑，同一組事件。
   *
   * 地端模型不走 Claude CLI——那支只認得 Anthropic 的模型名稱，把
   * `gpt-oss:120b` 丟給它只會換來一個離使用者三層遠的錯誤。改走 localAgent：
   * 它自己跑工具迴圈，但工具仍然經過同一個 bridge，所以確認閘門、復原快照和
   * 稽核紀錄的行為完全一樣。
   *
   * 地端這條沒有 resume：Claude CLI 把工作階段存在磁碟上，這裡的歷史只活一輪。
   */
  const { emitter, abort } = isLocalModel(chosenModel)
    ? runLocalAgent({
      model: chosenModel,
      prompt,
      systemPrompt,
      /**
       * 名稱換成真的規格。
       *
       * `supported` 是工具**名稱**的陣列——Claude CLI 那條路只需要名字，因為規格
       * 是 MCP 伺服器那邊給的。地端這條要自己把規格送進請求裡，所以得在這裡查回
       * 來。原本我用型別轉換把這個差異壓掉，那會讓模型收到一串
       * `{ name: undefined }`，而且 tsc 不會吭聲。
       */
      tools: WORD_TOOLS.filter((t) => supported.includes(t.name)),
      bridgeToken,
      maxTurns: WORD_MAX_TURNS,
    })
    : spawnClaude(prompt, systemPrompt, {
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
  const { runId, callId, ok, content, error, image, decision, note } = req.body as {
    runId?: string; callId?: string; ok?: boolean; content?: string; error?: string;
    image?: { mimeType?: string; data?: string };
    // How it got past the confirmation gate. Only the pane knows, because
    // only the pane showed the card — so only the pane can say whether a
    // human actually looked at it.
    decision?: 'none' | 'auto' | 'allowed' | 'rejected';
    /**
     * 使用者在這一輪執行中補的話。
     *
     * 窗格把它搭在工具結果的回程上送過來——那是一個每隔幾秒就出現、而且模型一定會讀的
     * 通道（它正在等這個結果）。這樣使用者不用按停止就能補充：手上這件事做完，接著就
     * 照補的做。打斷的語意是「不要做了」，跟「照這個繼續」是兩回事。
     */
    note?: string;
  };
  if (!runId || !callId) { res.status(400).json({ error: 'runId and callId are required' }); return; }
  if (!runBelongsTo(runId, req.user!.userId)) { res.status(403).json({ error: 'Not your run' }); return; }

  // Shape-checked rather than trusted: this is JSON from the pane, and it ends
  // up as a base64 payload handed to the model. A malformed one should be a
  // missing picture, not a broken tool result.
  const pic = image && typeof image.data === 'string' && typeof image.mimeType === 'string'
    && /^image\/(png|jpeg|gif|webp)$/.test(image.mimeType)
    ? { mimeType: image.mimeType, data: image.data }
    : undefined;
  const delivered = resolveToolCall(runId, callId, {
    ok: ok !== false,
    // 補充接在工具結果後面，標清楚是誰說的——模型要分得出哪些是工具回報、哪些是人說的。
    /**
     * 補充要寫得像使用者在說話，不像工具的輸出。
     *
     * 只寫「【使用者補充】…」的話，它夾在一段工具回報裡，模型很容易把它讀成結果的一部分
     * ——那是系統在描述狀態，不是人在下指令。於是它點頭稱是，然後繼續照原本的計畫做完。
     *
     * 所以講清楚三件事：這是人說的、它是對整份文件的要求、而且它可以推翻原本的計畫。
     * 窗格會在這一輪剩下的每一次工具結果都帶上同一段話，所以它不會往下做幾步就漂走。
     */
    content: note
      ? `${content || ''}

────────
`
        + `**使用者在你執行到一半時補充了需求**（不是工具的輸出，是他剛剛打字說的）：

`
        + `${String(note).slice(0, 2000)}

`
        + `這是對**整份產出**的要求，不只是這一步。如果它跟你原本的計畫衝突，`
        + `以他這句為準，並且在下一句話讓他知道你收到了。`
      : content,
    error, image: pic,
    // Validated rather than trusted: this becomes an audit fact, and an
    // unrecognised value must read as 「沒有人確認」 rather than be stored.
    decision: ['none', 'auto', 'allowed', 'rejected'].includes(String(decision))
      ? decision : 'none',
  });
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
