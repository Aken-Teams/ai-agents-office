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
import type { SSEEvent } from '../types.js';
import { describeToolCall, describeToolMeta, isDestructiveTool, toolRisk } from './excelToolSpec.js';

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
): string {
  const token = crypto.randomBytes(32).toString('hex');
  runs.set(runId, { runId, userId, write, pending: new Map(), closed: false });
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
    pending.resolve({ ok: false, error: '使用者已關閉 Excel 增益集，無法再存取活頁簿。' });
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
    return Promise.resolve({ ok: false, error: 'Excel 連線已結束，無法存取活頁簿。' });
  }

  const callId = crypto.randomUUID();
  const needsConfirm = isDestructiveTool(tool, args);
  const summary = describeToolCall(tool, args);
  const meta = describeToolMeta(tool, args);
  const risk = toolRisk(tool, args);

  return new Promise<ToolCallResult>(resolve => {
    const timer = setTimeout(() => {
      run.pending.delete(callId);
      resolve({
        ok: false,
        error: needsConfirm
          ? '等待使用者確認逾時，這次寫入沒有執行。'
          : 'Excel 端未在時限內回應，可能是範圍太大或活頁簿正在忙。試著縮小範圍再讀一次。',
      });
    }, tool === 'excel_ask_user' ? HUMAN_TIMEOUT_MS
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
