/**
 * excel-mcp — a stdio MCP server that exposes the workbook CURRENTLY OPEN in the
 * user's Excel as tools any agent can call.
 *
 * ── How it differs from email-mcp / km-mcp ──
 * Those two reach an API and answer by themselves. This one owns no data at all:
 * every tool call is forwarded to the Express process, which pushes it down the
 * user's SSE connection, where the add-in runs it through Office.js against the
 * live workbook and posts the result back. This process is a thin, stateless
 * relay — which is exactly why it can stay this small.
 *
 * ── Identity & security ──
 * Same rule as email-mcp: claudeCli spawns this per agent-run and injects a
 * single-use run token via env (MCP_EXCEL_RUN_TOKEN). The server NEVER accepts a
 * "which workbook / which user" argument from the model — the token IS the
 * identity, and it maps to exactly one live add-in session owned by one user. An
 * agent can only ever touch the workbook of the run that started it.
 *
 * ── Startup MUST stay fast ──
 * The CLI has an MCP handshake window; a slow-to-connect server means the tools
 * never register and the agent concludes it "has no Excel tools". So: no heavy
 * imports, no DB, no config — only the MCP SDK and a dependency-free tool spec.
 *
 * Run:  node --import tsx server/src/mcp/excelMcp.ts   (env supplies the creds)
 */
import fs from 'fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { EXCEL_TOOLS, EXCEL_TOOL_NAMES } from '../services/excelToolSpec.js';

const RUN_TOKEN = process.env.MCP_EXCEL_RUN_TOKEN || '';
const BRIDGE_URL = (process.env.MCP_EXCEL_BRIDGE_URL || '').replace(/\/+$/, '');

// Which tools the connected task pane can actually run. The pane's JavaScript is
// pinned for the life of a SharedRuntime — i.e. until Excel is quit — so a user
// who updates the add-in mid-session has an old executor behind a new server.
// Advertising only what it can run turns that into "fewer abilities" instead of
// an agent looping on 未知的工具. Empty/unset = advertise everything.
const CLIENT_TOOLS = (process.env.MCP_EXCEL_CLIENT_TOOLS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const OFFERED = CLIENT_TOOLS.length
  ? EXCEL_TOOLS.filter(t => CLIENT_TOOLS.includes(t.name))
  : EXCEL_TOOLS;

// Debug log (append-only). The CLI swallows MCP stderr, so without this we are
// blind to what the relay actually did. Silent no-op when the env isn't set.
const DEBUG_LOG = process.env.MCP_DEBUG_LOG || '';
function dlog(msg: string): void {
  if (!DEBUG_LOG) return;
  try { fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`); } catch { /* ignore */ }
}

/**
 * Longer than the bridge's own per-call timeouts (45s reads / 120s confirmed
 * writes) on purpose: we want the bridge's specific, human-readable timeout
 * message to reach the model, not a generic socket abort from this side.
 */
const FETCH_TIMEOUT_MS = 150_000;

function textResult(text: string, isError = false): { content: { type: string; text: string }[]; isError?: boolean } {
  return isError
    ? { content: [{ type: 'text', text }], isError: true }
    : { content: [{ type: 'text', text }] };
}

/**
 * Forward one tool call to the Express bridge and wait for the add-in.
 *
 * Failures come back as ordinary tool RESULTS rather than thrown errors: a
 * declined write or a closed task pane is something the model should read and
 * react to ("使用者拒絕了這次寫入"), not an exception that aborts the run.
 */
async function relay(tool: string, args: Record<string, unknown>): Promise<string> {
  if (!RUN_TOKEN || !BRIDGE_URL) {
    dlog(`  MISSING config: token=${!!RUN_TOKEN} bridge=${!!BRIDGE_URL}`);
    return '錯誤：excel-mcp 未取得連線設定，無法存取活頁簿。';
  }
  let res: Response;
  try {
    res = await fetch(`${BRIDGE_URL}/tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Excel-Run-Token': RUN_TOKEN },
      body: JSON.stringify({ tool, args }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    dlog(`  relay ${tool} network error: ${(e as Error).message}`);
    return `錯誤：無法連上 Excel 端（${(e as Error).message}）。`;
  }
  if (!res.ok) {
    dlog(`  relay ${tool} HTTP ${res.status}`);
    return `錯誤：Excel 橋接回應 HTTP ${res.status}。`;
  }
  const body = await res.json() as { ok?: boolean; content?: string; error?: string };
  if (!body.ok) return `錯誤：${body.error || '未知的失敗'}`;
  return body.content ?? '（沒有內容）';
}

async function callTool(name: string, args: Record<string, unknown>): Promise<ReturnType<typeof textResult>> {
  dlog(`CALL ${name} ${JSON.stringify(args).slice(0, 500)}`);
  if (!EXCEL_TOOL_NAMES.includes(name)) return textResult(`未知的工具：${name}`, true);
  if (!OFFERED.some(t => t.name === name)) {
    return textResult(`「${name}」這個版本的 Excel 增益集不支援，請使用者完全關閉 Excel 再重開以更新。`, true);
  }

  // Shape-check the one tool that can destroy work, before it costs a round trip
  // AND a human's attention on a confirmation dialog.
  if (name === 'excel_write_range') {
    const grid = (args.formulas ?? args.values) as unknown;
    if (!Array.isArray(grid) || !grid.length || !Array.isArray(grid[0])) {
      return textResult('錯誤：values 或 formulas 必須是二維陣列（外層是列、內層是欄），且至少要有一列。', true);
    }
    const width = (grid[0] as unknown[]).length;
    if (grid.some(row => !Array.isArray(row) || row.length !== width)) {
      return textResult('錯誤：每一列的欄數必須相同（要寫成矩形範圍）。', true);
    }
  }

  return textResult(await relay(name, args));
}

async function main(): Promise<void> {
  dlog(`--- excel-mcp start: token_len=${RUN_TOKEN.length} bridge=${BRIDGE_URL || 'MISSING'} tools=${OFFERED.length}/${EXCEL_TOOLS.length} ---`);
  const server = new Server({ name: 'excel', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    dlog('tools/list requested');
    return { tools: OFFERED.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) };
  });
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const r = await callTool(req.params.name, (req.params.arguments || {}) as Record<string, unknown>);
      dlog(`  -> ${req.params.name} returned ${r.content[0]?.text?.length || 0} chars`);
      return r;
    } catch (e) {
      dlog(`  -> ${req.params.name} THREW: ${(e as Error).message}`);
      return textResult(`錯誤：${(e as Error).message}`, true);
    }
  });
  await server.connect(new StdioServerTransport());
  dlog('connected to stdio transport');
}

main().catch((e) => {
  console.error('[excel-mcp] fatal:', e);
  process.exit(1);
});
