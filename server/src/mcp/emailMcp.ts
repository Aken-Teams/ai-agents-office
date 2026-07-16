/**
 * email-mcp — a stdio MCP server that exposes the signed-in user's Outlook
 * mailbox (via the PANJIT gateway) as tools any generation agent can call.
 *
 * ── Identity & security (the whole point) ──
 * This process is spawned per agent-run by claudeCli, which injects the user's
 * OWN mail JWT via env (MCP_MAIL_TOKEN). The server NEVER accepts a "who am I"
 * argument from the model — identity comes only from that env token, so an agent
 * can only ever reach the mailbox of the user who started the run. No cross-user
 * access is possible.
 *
 * Deliberately self-contained: it talks to the gateway directly (base + api key
 * + token from env) instead of importing outlookApi/config/db, so the subprocess
 * stays tiny and free of DB/config side effects.
 *
 * Run:  node --import tsx server/src/mcp/emailMcp.ts   (env supplies the creds)
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const MAIL_TOKEN = process.env.MCP_MAIL_TOKEN || '';
const API_BASE = (process.env.MCP_MAIL_API_BASE || '').replace(/\/+$/, '');
const API_KEY = process.env.MCP_MAIL_API_KEY || '';
const OUTLOOK_BASE = `${API_BASE}/outlook`;

const DETAIL_MAX_CHARS = 6000; // cap a single message body fed back to the model

function headers(): Record<string, string> {
  return { 'X-API-Key': API_KEY, 'Authorization': `Bearer ${MAIL_TOKEN}` };
}

/** GET a gateway endpoint with a bounded timeout; return parsed JSON or throw. */
async function gwGet(pathAndQuery: string, timeoutMs = 30_000): Promise<any> {
  const res = await fetch(`${OUTLOOK_BASE}${pathAndQuery}`, {
    headers: headers(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`gateway ${res.status}: ${body.slice(0, 160)}`);
  }
  return res.json();
}

const TOOLS = [
  {
    name: 'email_list_folders',
    description: '列出目前使用者 Outlook 信箱的常用資料夾（Inbox / SentItems / Drafts …）及未讀數。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'email_search',
    description:
      '搜尋 / 列出目前使用者信箱的信件（只回每封約 200 字預覽）。可用主旨關鍵字、日期範圍、資料夾過濾。'
      + ' 要看完整內文與附件清單，再用 email_get_message 帶回傳的 id。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '主旨關鍵字（僅比對 subject，不掃內文）' },
        folder: { type: 'string', description: '資料夾，預設 Inbox（Inbox/SentItems/Drafts/DeletedItems/JunkEmail/Outbox）' },
        start_date: { type: 'string', description: '起始日期 YYYY-MM-DD（含）' },
        end_date: { type: 'string', description: '結束日期 YYYY-MM-DD（含）' },
        limit: { type: 'integer', description: '每頁筆數，預設 20、最大 50' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'email_get_message',
    description: '依 id 取單封信的完整內容（純文字內文、寄件/收件人、附件 metadata）。id 來自 email_search 的回傳。',
    inputSchema: {
      type: 'object',
      properties: { message_id: { type: 'string', description: '信件 id（email_search 回傳的 id）' } },
      required: ['message_id'],
      additionalProperties: false,
    },
  },
];

function jsonText(obj: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

async function callTool(name: string, args: Record<string, any>): Promise<any> {
  if (!MAIL_TOKEN || !API_BASE || !API_KEY) {
    return jsonText({ error: 'email-mcp 未取得使用者信箱憑證（缺 token / base / key）' });
  }

  if (name === 'email_list_folders') {
    const data = await gwGet('/folders');
    return jsonText({ folders: data.folders ?? data ?? [] });
  }

  if (name === 'email_search') {
    const p = new URLSearchParams({
      folder: String(args.folder || 'Inbox'),
      limit: String(Math.min(Number(args.limit) || 20, 50)),
      order: 'desc',
    });
    if (args.query) p.set('q', String(args.query));
    if (args.start_date) p.set('start_date', String(args.start_date));
    if (args.end_date) p.set('end_date', String(args.end_date));
    const data = await gwGet(`/messages?${p.toString()}`);
    const messages = (data.messages ?? []).map((m: any) => ({
      id: m.id, subject: m.subject, from: m.from, received_at: m.received_at,
      is_read: m.is_read, has_attachments: m.has_attachments, preview: m.preview,
    }));
    return jsonText({ total: data.total ?? messages.length, count: messages.length, messages });
  }

  if (name === 'email_get_message') {
    const id = String(args.message_id || '');
    if (!id) return jsonText({ error: 'message_id 為必填' });
    const data = await gwGet(`/messages/${encodeURIComponent(id)}`, 45_000);
    const d = data.message_detail ?? data;
    let body: string = d.body || '';
    // Strip HTML to plain text and cap length so a long mail can't blow context.
    if (d.body_type === 'html') body = body.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const truncated = body.length > DETAIL_MAX_CHARS;
    return jsonText({
      id: d.id, subject: d.subject, from: d.from, to: d.to, cc: d.cc,
      received_at: d.received_at, sent_at: d.sent_at, is_read: d.is_read,
      body: truncated ? body.slice(0, DETAIL_MAX_CHARS) : body,
      body_truncated: truncated,
      attachments: (d.attachments || []).map((a: any) => ({ filename: a.filename, content_type: a.content_type, size: a.size, is_inline: a.is_inline })),
    });
  }

  return jsonText({ error: `未知的工具：${name}` });
}

async function main(): Promise<void> {
  const server = new Server(
    { name: 'email', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      return await callTool(req.params.name, (req.params.arguments || {}) as Record<string, any>);
    } catch (e) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: (e as Error).message }) }], isError: true };
    }
  });

  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  console.error('[email-mcp] fatal:', e);
  process.exit(1);
});
