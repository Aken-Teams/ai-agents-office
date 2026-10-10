/**
 * excel-bridge — lets an agent run tools against the LIVE workbook open in the
 * user's Excel, instead of against a file on this server.
 *
 * ── Why this exists ──
 * claudeCli spawns each MCP server as its OWN subprocess (see emailMcp.ts), so
 * excelMcp cannot reach the SSE connection held here in the Express process. The
 * round trip therefore has to come back through HTTP:
 *
 *   Claude CLI ──stdio──> excelMcp (subprocess)
 *                              │ POST /internal/excel/tool  (X-Excel-Run-Token)
 *                              ▼
 *                        THIS module ── SSE ──> add-in ── Office.js ──> Excel
 *                              ▲                                          │
 *                              └────── POST /api/excel/tool-result ───────┘
 *
 * Each hop is cheap; the round trip is not. Tools are coarse by design (see
 * excelToolSpec.ts) so a task costs a handful of trips, not hundreds.
 *
 * ── Identity ──
 * Same rule as email-mcp: the run token IS the identity. It is minted here, handed
 * to the subprocess via env, and maps to exactly one run owned by one user. The
 * model never names a user, a workbook, or a session — it cannot reach anyone
 * else's Excel even if it asks to.
 */
import crypto from 'crypto';
import { readAttachmentPart } from './excelAttachments.js';
import { createHandoff } from '../routes/handoffs.js';
import { describeArtSearch } from './artLibrary.js';
import { composeImagePrompt, stepsFor } from './imagePrompt.js';
import { generateImage } from './modelGateway.js';
import type { SSEEvent } from '../types.js';
import * as excelSpec from './excelToolSpec.js';
import * as wordSpec from './wordToolSpec.js';
import * as pptSpec from './pptToolSpec.js';
import { imageStyleRefusal } from './pptToolSpec.js';
import { logAddinAction, targetOf, hostOf, type ActionDecision } from './addinActionLog.js';

/**
 * Which host's rules apply to this call.
 *
 * The tool names carry it: every Excel tool is `excel_*`, every Word tool is
 * `word_*` and every PowerPoint tool is `ppt_*`, so nothing has to be threaded
 * through the MCP subprocess, the loopback endpoint, or the run token. That matters because those three were
 * built when there was one host, and a `host` parameter on each of them would be
 * three more places to keep in step for no gain.
 *
 * The pieces that differ are exactly the four that decide what the CONFIRMATION
 * CARD says and whether there is one — which is the whole reason the bridge
 * needs to know at all.
 */
function specFor(tool: string) {
  if (tool.startsWith('word_')) return wordSpec;
  if (tool.startsWith('ppt_')) return pptSpec;
  return excelSpec;
}

/** 活頁簿 / 文件 / 簡報, for the messages that reach the user. */
function nounFor(tool: string): { app: string; file: string } {
  if (tool.startsWith('word_')) return { app: 'Word', file: '文件' };
  if (tool.startsWith('ppt_')) return { app: 'PowerPoint', file: '簡報' };
  return { app: 'Excel', file: '活頁簿' };
}

/**
 * How long a single tool call may wait for the add-in.
 *
 * Generous on purpose: a destructive call sits here while a HUMAN reads the
 * confirmation dialog and decides. Too short and we reject a call the user was
 * about to approve; too long and a closed laptop lid stalls the agent. Two
 * minutes covers "read the dialog, check the cells, click".
 */
const CALL_TIMEOUT_MS = 120_000;

/** Reads have no human in the loop, so they fail fast. */
const READ_TIMEOUT_MS = 45_000;
/**
 * Calls that are waiting on a PERSON to read something and decide. Neither of the
 * other two limits fits: 45s is not long enough to weigh two options, and even the
 * 120s write limit assumes someone is already looking at the screen. Kept well
 * under RUN_TIMEOUT_MS so a slow answer still leaves the agent time to act on it.
 */
const HUMAN_TIMEOUT_MS = 240_000;

export interface ToolRequestEvent {
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  /** true → the add-in must get a human click before executing. */
  needsConfirm: boolean;
  /** One line describing the call, shown in the confirmation dialog. */
  summary: string;
  /** Small print under the action: how it will be done. May be ''. */
  meta: string;
  /** 'high' = destroys data the undo button cannot restore. Drives the red card. */
  risk: 'high' | 'normal';
}

export interface ToolCallResult {
  ok: boolean;
  /** Tool output as text (CSV for reads) — goes straight back to the model. */
  content?: string;
  error?: string;
  /**
   * Pixels, for the two tools that answer with a picture (a shape on a sheet, or
   * an image the user pasted into the chat). Carried through this bridge
   * untouched; excel-mcp is what turns it into an MCP image block, which is the
   * only thing that actually puts it in front of the model.
   *
   * The add-in shrinks before sending, so what arrives here is already sized for
   * a model rather than for a screen.
   */
  image?: { mimeType: string; data: string };
  /**
   * How this call got past the confirmation gate, when it came back from the
   * pane. Stripped in callWorkbookTool before the result reaches the model —
   * it is audit bookkeeping, not part of the tool's answer.
   */
  decision?: import('./addinActionLog.js').ActionDecision;
}

interface PendingCall {
  resolve: (r: ToolCallResult) => void;
  timer: NodeJS.Timeout;
  tool: string;
}

interface ExcelRun {
  runId: string;
  userId: string;
  /** Pushes an event down this run's SSE connection to the add-in. */
  write: (event: SSEEvent) => void;
  pending: Map<string, PendingCall>;
  closed: boolean;
  /**
   * Ids of files uploaded with this turn, in the order the user attached them.
   * {excel,word}_read_file is answered from these WITHOUT going to the add-in — the
   * text was extracted here, so the pane has nothing to contribute and a round
   * trip to it would only add latency and a way to fail.
   */
  files: string[];
  /** The open document's name, so a handoff can say where it came from. */
  documentName: string;
  /**
   * The origin the add-in reached us on.
   *
   * Needed because a generated picture goes back to the pane as a URL it has to
   * fetch, and this process cannot know from configuration whether it is being
   * reached as localhost, an internal name or a reverse proxy. The request that
   * opened the run does know, so it says so once and the whole run reuses it —
   * which beats an env var that is silently wrong until somebody notices the
   * pictures never arrive.
   */
  origin: string;
  /**
   * Whether this run may generate photo-realistic pictures.
   *
   * ── Why this is checked here as well as in the tool schema ──
   * The schema is what stops the model ASKING; this is what stops the request
   * being SERVED. They are not the same guard. The MCP subprocess builds its
   * schema from env at spawn time, so a run whose settings changed, a pane
   * pinned to an older build, or anything reaching the bridge by another path
   * would all sail past a schema-only check. A capability governed by a switch
   * has to be refused where it is actually performed.
   */
  allowPhoto: boolean;
  /** Which conversation this run belongs to, so an audited action can be found. */
  conversationId: string;
}

const runs = new Map<string, ExcelRun>();
const tokenToRun = new Map<string, string>();

/**
 * Open a run and mint its bridge token.
 *
 * The token goes to the MCP subprocess via env; the runId stays server-side. They
 * are separate values so a token leaking into a log never identifies a session
 * anyone can address directly.
 */
export function registerRun(
  runId: string,
  userId: string,
  write: (event: SSEEvent) => void,
  files: string[] = [],
  documentName = '',
  origin = '',
  allowPhoto = false,
  conversationId = '',
): string {
  const token = crypto.randomBytes(32).toString('hex');
  runs.set(runId, {
    runId, userId, write, pending: new Map(), closed: false, files, documentName, origin,
    // Default false, so a caller that has not been taught about this setting
    // gets the conservative answer rather than the permissive one.
    allowPhoto,
    conversationId,
  });
  tokenToRun.set(token, runId);
  return token;
}

/**
 * Close a run and fail everything still in flight.
 *
 * Called when the SSE connection drops (task pane closed, Excel quit, network
 * blip). Pending calls MUST be rejected rather than left hanging — otherwise the
 * CLI sits waiting on an MCP response that can never arrive, and the whole run
 * burns its timeout doing nothing.
 */
export function closeRun(runId: string): void {
  const run = runs.get(runId);
  if (!run) return;
  run.closed = true;
  for (const [callId, pending] of run.pending) {
    clearTimeout(pending.timer);
    const n = nounFor(pending.tool);
    pending.resolve({ ok: false, error: `使用者已關閉 ${n.app} 增益集，無法再存取${n.file}。` });
    run.pending.delete(callId);
  }
  runs.delete(runId);
  for (const [token, id] of tokenToRun) {
    if (id === runId) tokenToRun.delete(token);
  }
}

/**
 * Called from the internal HTTP endpoint that excelMcp posts to. Pushes the call
 * down to the add-in and waits for Office.js to report back.
 *
 * Returns a RESULT rather than throwing on user-facing failures (rejection,
 * timeout, closed pane): the model should see "使用者拒絕了這次寫入" as a normal
 * tool result it can react to, not as a crash.
 */
/**
 * Every tool call, logged once, wherever it was answered.
 *
 * The audit row is written HERE rather than in each branch below because this is
 * the single point every call passes through — pane-executed ones, the ones this
 * server answers itself, and the ones that fail before either. A per-branch log
 * would miss whichever branch somebody adds next.
 */
export function callWorkbookTool(
  token: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const runId = tokenToRun.get(token);
  const run = runs.get(runId || '');
  return dispatchTool(token, tool, args).then((result) => {
    if (run) {
      logAddinAction({
        userId: run.userId,
        conversationId: run.conversationId,
        host: hostOf(tool),
        tool,
        target: targetOf(tool, args),
        destructive: isDestructiveFor(tool, args),
        // Set by the pane when it sends the result back. Absent means nothing
        // asked — a read, or a write that needed no gate.
        decision: (result.decision as ActionDecision) || 'none',
        ok: result.ok !== false,
        summary: describeFor(tool, args),
      });
    }
    // The decision is bookkeeping between the pane and this log. It must not
    // travel on to the model, which has no use for it and would read it as part
    // of the tool's answer.
    const { decision, ...rest } = result as ToolCallResult & { decision?: string };
    void decision;
    return rest as ToolCallResult;
  });
}

// specFor is already defined above — the bridge has always needed to know which
// spec a tool belongs to, for the confirmation card.
const describeFor = (tool: string, args: Record<string, unknown>): string => {
  try { return specFor(tool).describeToolCall(tool, args); } catch { return ''; }
};

const isDestructiveFor = (tool: string, args: Record<string, unknown>): boolean => {
  try { return specFor(tool).isDestructiveTool(tool, args); } catch { return false; }
};

function dispatchTool(
  token: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const runId = tokenToRun.get(token);
  const run = runId ? runs.get(runId) : undefined;
  if (!run || run.closed) {
    const n = nounFor(tool);
    return Promise.resolve({ ok: false, error: `${n.app} 連線已結束，無法存取${n.file}。` });
  }

  // Answered here, never forwarded. An uploaded file was parsed on this side —
  // the add-in has never seen its bytes — so sending the call down the SSE
  // connection would be asking the pane about something it does not have. No
  // callId, no timer, no confirmation: reading a file the user just handed over
  // is not an act on their workbook.
  //
  // It still sits below the closed-run check above, and has to: closeRun deletes
  // the run outright, which takes `files` with it. So closing the task pane mid-
  // answer does cut off a half-read PDF. Worth revisiting if that shows up in
  // practice — it would mean keeping the file list alive past the SSE drop.
  if (tool === 'excel_read_file' || tool === 'word_read_file' || tool === 'ppt_read_file') {
    const r = readAttachmentPart(
      run.userId, run.files, Number(args.index ?? 1), Number(args.part ?? 1));
    return Promise.resolve(r);
  }

  /**
   * Searching the illustration library is answered here too.
   *
   * It is a read of a JSON file sitting on this machine. Relaying it to the task
   * pane so the pane could ask us for it would be a round trip to put a question
   * to ourselves, and it touches no deck, so there is nothing to confirm and
   * nothing that could be lost.
   */
  if (tool === 'ppt_find_art') {
    return Promise.resolve(describeArtSearch(
      String(args.query ?? ''),
      Math.max(1, Math.min(24, Number(args.limit ?? 12) || 12))));
  }

  /**
   * Generating a picture is answered here too — it has to be.
   *
   * The on-prem endpoint and its key live on this side and are not something the
   * task pane should ever learn; a generation also takes fifteen to sixty
   * seconds and has to be queued against a single GPU, neither of which a pane
   * running on somebody's laptop can arrange. What goes back is a URL on this
   * server, which the pane then feeds to ppt_add_photo exactly like a stock
   * photo — so the layout half needed no changes at all.
   */
  if (tool === 'ppt_generate_image') {
    // 寫實照片 is the user's switch, and this is where it bites. Refused with the
    // reason and the alternative: an error that only says 「不行」 gets retried,
    // one that names the other two styles gets a background instead.
    const refused = imageStyleRefusal(args.style, run.allowPhoto);
    if (refused) return Promise.resolve({ ok: false, error: refused });
    const spec = composeImagePrompt({
      subject: String(args.subject ?? ''),
      mode: String(args.mode ?? 'hero'),
      style: String(args.style ?? ''),
      look: String(args.look ?? ''),
      theme: String(args.theme ?? ''),
      mood: String(args.mood ?? ''),
    });
    if (!spec.prompt.trim() || !String(args.subject ?? '').trim()) {
      return Promise.resolve({ ok: false, error: 'subject 是必要的（這張圖要畫什麼，英文）。' });
    }
    // Depends on what is being drawn — see stepsFor. A background is finished
    // at 10; an illustration at 10 is still a smudge.
    const steps = stepsFor(String(args.style ?? ''), args.quality === true, String(args.mode ?? 'hero'));
    return generateImage({
      userId: run.userId,
      prompt: spec.prompt,
      negative: spec.negative,
      size: spec.size,
      steps,
      seed: spec.seed,
    }).then((r) => (r.ok
      ? {
        ok: true,
        content: `已產生一張 ${r.width}×${r.height} 的圖（${r.seconds} 秒，地端模型）。
`
          + `網址：${run.origin}/api/ppt/image/${r.id}.png
`
          + '接著用 ppt_add_photo 把這個網址放上去，mode 用同一個。'
          + '這張圖 30 分鐘後就會失效，要用就現在用。',
      }
      : { ok: false, error: r.error || '產生圖片失敗。' }));
  }

  /**
   * Packing a handoff is also answered here.
   *
   * It writes a row to this server and touches no document at all — the parcel
   * is content the agent has already worked out, not an act on the workbook. So
   * there is nothing for the pane to do, no confirmation to show (nothing can be
   * lost), and a round trip to it would only add a way to fail.
   */
  if (tool.endsWith('_create_handoff')) {
    return createHandoff({
      userId: run.userId,
      sourceHost: tool.split('_')[0],
      sourceName: run.documentName,
      target: String(args.target ?? ''),
      title: String(args.title ?? ''),
      payload: String(args.content ?? ''),
    }).then((r) => (r.ok
      ? {
        ok: true,
        content: `已備妥交接包（${r.id.slice(0, 8)}）。`
          + `請使用者開啟 ${args.target === 'word' ? 'Word 文件' : 'PowerPoint 簡報'}`
          + '並打開 JVision 助手，側邊欄頂端就會出現這筆分析，按「接受」即可在那份檔案裡生成。'
          + ' 24 小時內有效。',
      }
      : { ok: false, error: r.error }));
  }

  const callId = crypto.randomUUID();
  const spec = specFor(tool);
  const noun = nounFor(tool);
  const needsConfirm = spec.isDestructiveTool(tool, args);
  const summary = spec.describeToolCall(tool, args);
  const meta = spec.describeToolMeta(tool, args);
  const risk = spec.toolRisk(tool, args);

  return new Promise<ToolCallResult>(resolve => {
    const timer = setTimeout(() => {
      run.pending.delete(callId);
      resolve({
        ok: false,
        error: needsConfirm
          ? '等待使用者確認逾時，這次修改沒有執行。'
          : `${noun.app} 端未在時限內回應，可能是範圍太大或${noun.file}正在忙。試著縮小範圍再試一次。`,
      });
    }, tool.endsWith('_ask_user') ? HUMAN_TIMEOUT_MS
      : needsConfirm ? CALL_TIMEOUT_MS
        : READ_TIMEOUT_MS);

    run.pending.set(callId, { resolve, timer, tool });

    const payload: ToolRequestEvent = { callId, tool, args, needsConfirm, summary, meta, risk };
    run.write({ type: 'tool_request', data: payload });
  });
}

/**
 * Called from POST /api/excel/tool-result when the add-in finishes (or the user
 * declines). Unknown callIds are ignored — that is the normal shape of a result
 * arriving after its own timeout already fired.
 */
export function resolveToolCall(
  runId: string,
  callId: string,
  result: ToolCallResult & { decision?: ActionDecision },
): boolean {
  const run = runs.get(runId);
  const pending = run?.pending.get(callId);
  if (!run || !pending) return false;
  clearTimeout(pending.timer);
  run.pending.delete(callId);
  pending.resolve(result);
  return true;
}

/** Ownership check for the result endpoint — a run only accepts its own user. */
export function runBelongsTo(runId: string, userId: string): boolean {
  const run = runs.get(runId);
  return !!run && run.userId === userId;
}

/** Live counts for the admin system-pressure panel. */
export function getExcelBridgeStats(): { runs: number; pendingCalls: number } {
  let pendingCalls = 0;
  for (const run of runs.values()) pendingCalls += run.pending.size;
  return { runs: runs.size, pendingCalls };
}
