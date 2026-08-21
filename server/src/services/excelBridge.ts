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
import type { SSEEvent } from '../types.js';
import * as excelSpec from './excelToolSpec.js';
import * as wordSpec from './wordToolSpec.js';
import * as pptSpec from './pptToolSpec.js';

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
): string {
  const token = crypto.randomBytes(32).toString('hex');
  runs.set(runId, { runId, userId, write, pending: new Map(), closed: false, files });
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
export function callWorkbookTool(
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
  result: ToolCallResult,
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
