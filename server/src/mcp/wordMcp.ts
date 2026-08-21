/**
 * word-mcp — a stdio MCP server that exposes the document CURRENTLY OPEN in the
 * user's Word as tools any agent can call.
 *
 * The Word twin of excelMcp.ts, and deliberately identical in shape: it owns no
 * data at all. Every tool call is forwarded to the Express process, which pushes
 * it down the user's SSE connection, where the add-in runs it through Office.js
 * against the live document and posts the result back. A thin, stateless relay —
 * which is exactly why it can stay this small.
 *
 * ── Identity & security ──
 * claudeCli spawns this per agent-run and injects a single-use run token via env
 * (MCP_WORD_RUN_TOKEN). The server NEVER accepts a "which document / which user"
 * argument from the model — the token IS the identity, and it maps to exactly one
 * live add-in session owned by one user. An agent can only ever touch the
 * document of the run that started it.
 *
 * ── Startup MUST stay fast ──
 * The CLI has an MCP handshake window; a slow-to-connect server means the tools
 * never register and the agent concludes it "has no Word tools". So: no heavy
 * imports, no DB, no config — only the MCP SDK and a dependency-free tool spec.
 *
 * Run:  node --import tsx server/src/mcp/wordMcp.ts   (env supplies the creds)
 */
import fs from 'fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { WORD_TOOLS, WORD_TOOL_NAMES } from '../services/wordToolSpec.js';

const RUN_TOKEN = process.env.MCP_WORD_RUN_TOKEN || '';
const BRIDGE_URL = (process.env.MCP_WORD_BRIDGE_URL || '').replace(/\/+$/, '');

// Which tools the connected task pane can actually run. The pane's JavaScript is
// pinned for the life of a SharedRuntime — i.e. until Word is quit — so a user
// who updates the add-in mid-session has an old executor behind a new server.
// Advertising only what it can run turns that into "fewer abilities" instead of
// an agent looping on 未知的工具. Empty/unset = advertise everything.
//
// For Word this also carries the WordApi 1.4 gate: on an older build the pane
// leaves word_tracked_changes and word_comment out of the list, and the model
// simply never sees them.
const CLIENT_TOOLS = (process.env.MCP_WORD_CLIENT_TOOLS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const OFFERED = CLIENT_TOOLS.length
  ? WORD_TOOLS.filter(t => CLIENT_TOOLS.includes(t.name))
  : WORD_TOOLS;

// Debug log (append-only). The CLI swallows MCP stderr, so without this we are
// blind to what the relay actually did. Silent no-op when the env isn't set.
const DEBUG_LOG = process.env.MCP_DEBUG_LOG || '';
function dlog(msg: string): void {
  if (!DEBUG_LOG) return;
  try { fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`); } catch { /* ignore */ }
}

/**
 * Longer than the bridge's own per-call timeouts on purpose: we want the
 * bridge's specific, human-readable timeout message to reach the model, not a
 * generic socket abort from this side.
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
 * declined rewrite or a closed task pane is something the model should read and
 * react to ("使用者拒絕了這次改寫"), not an exception that aborts the run.
 */
async function relay(tool: string, args: Record<string, unknown>): Promise<string> {
  if (!RUN_TOKEN || !BRIDGE_URL) {
    dlog(`  MISSING config: token=${!!RUN_TOKEN} bridge=${!!BRIDGE_URL}`);
    return '錯誤：word-mcp 未取得連線設定，無法存取文件。';
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
    return `錯誤：無法連上 Word 端（${(e as Error).message}）。`;
  }
  if (!res.ok) {
    dlog(`  relay ${tool} HTTP ${res.status}`);
    return `錯誤：Word 橋接回應 HTTP ${res.status}。`;
  }
  const body = await res.json() as { ok?: boolean; content?: string; error?: string };
  if (!body.ok) return `錯誤：${body.error || '未知的失敗'}`;
  return body.content ?? '（沒有內容）';
}

async function callTool(name: string, args: Record<string, unknown>): Promise<ReturnType<typeof textResult>> {
  dlog(`CALL ${name} ${JSON.stringify(args).slice(0, 500)}`);
  if (!WORD_TOOL_NAMES.includes(name)) return textResult(`未知的工具：${name}`, true);
  if (!OFFERED.some(t => t.name === name)) {
    return textResult(`「${name}」這個版本的 Word 增益集不支援，請使用者完全關閉 Word 再重開以更新。`, true);
  }

  // Shape-check the calls that can destroy work, before they cost a round trip
  // AND a human's attention on a confirmation dialog.
  if (name === 'word_write_range') {
    if (args.text === undefined && !Array.isArray(args.paragraphs)) {
      return textResult('錯誤：word_write_range 需要 text 或 paragraphs 其中一個——沒有新內容的改寫等於刪除，'
        + '真的要刪請用 word_delete_range。', true);
    }
    if (args.from === undefined) {
      return textResult('錯誤：需要 from（起始段落編號）。先用 word_get_overview 或 word_search 取得編號，不要猜。', true);
    }
  }
  if (name === 'word_delete_range' && args.from === undefined) {
    return textResult('錯誤：需要 from（起始段落編號）。', true);
  }
  if (name === 'word_insert_table' && !Array.isArray(args.values)) {
    return textResult('錯誤：values 必須是二維陣列（外層是列、內層是欄）。', true);
  }

  return textResult(await relay(name, args));
}

async function main(): Promise<void> {
  dlog(`--- word-mcp start: token_len=${RUN_TOKEN.length} bridge=${BRIDGE_URL || 'MISSING'} tools=${OFFERED.length}/${WORD_TOOLS.length} ---`);
  const server = new Server({ name: 'word', version: '0.1.0' }, { capabilities: { tools: {} } });
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
  console.error('[word-mcp] fatal:', e);
  process.exit(1);
});
