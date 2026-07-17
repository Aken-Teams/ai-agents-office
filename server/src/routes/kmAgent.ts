/**
 * KM Agent routes — the bottom-right "KM 助手" dock.
 *
 * Unlike the email assistant (which POLLS the mailbox and pushes new mail), KM is
 * ON-DEMAND: the 文件 tab searches / opens / downloads documents directly (no AI,
 * no tokens), and the 對話 tab is AI Q&A grounded in KM via the km-mcp tools.
 *
 * Permission model: KM enforces per-user access via X-On-Behalf-Of = the user's AD
 * 員編 (resolved server-side). Search takes only the system API key, so it may list
 * a document the user can't open — opening/downloading then returns 403, which we
 * surface honestly. Only available in pro-panjit with KM_API_KEY set.
 */
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { authMiddleware } from '../middleware/auth.js';
import { config } from '../config.js';
import { dbGet, dbRun, dbAll } from '../db.js';
import { spawnClaude } from '../services/claudeCli.js';
import { recordTokenUsage } from '../services/tokenTracker.js';
import { checkUserUsageLimit } from '../services/usageLimit.js';
import { KM_ASSISTANT_SYSTEM_PROMPT } from '../services/emailContext.js';
import { kmEnabled, getKmOnBehalf, kmSearch, kmGetDocument, kmFetchAttachment } from '../services/kmApi.js';
import type { SSEEvent } from '../types.js';

const router = Router();
router.use(authMiddleware);

// Gate: only in pro-panjit AND when a KM system key is configured.
router.use((_req: Request, res: Response, next) => {
  if (!kmEnabled()) {
    res.status(403).json({ error: 'KM not available in this deployment' });
    return;
  }
  next();
});

// ─── Opt-in preference (mirrors email-agent): NULL = never asked, 0 = off, 1 = on ───
router.get('/preference', async (req: Request, res: Response) => {
  const row = await dbGet<{ km_agent_enabled: number | null }>('SELECT km_agent_enabled FROM users WHERE id = ?', req.user!.userId);
  res.json({ enabled: row?.km_agent_enabled ?? null });
});
router.post('/preference', async (req: Request, res: Response) => {
  const on = req.body?.enabled === true || req.body?.enabled === 1;
  await dbRun('UPDATE users SET km_agent_enabled = ? WHERE id = ?', on ? 1 : 0, req.user!.userId);
  res.json({ enabled: on ? 1 : 0 });
});

/** True only when the user has explicitly ENABLED the KM assistant (=1). */
async function kmAgentEnabled(userId: string): Promise<boolean> {
  const row = await dbGet<{ km_agent_enabled: number | null }>('SELECT km_agent_enabled FROM users WHERE id = ?', userId);
  return row?.km_agent_enabled === 1;
}

// ─── 文件 tab: search — streamed so slow KM queries still complete ───
// KM's /api/search is slow for broad terms (~40s). A plain request sends nothing
// while waiting, so the dev proxy treats it as idle and resets (ECONNRESET → 500).
// We stream keepalive bytes while KM works (like the email SSE), then emit the
// result — so even broad searches return everything instead of erroring out.
router.post('/search', async (req: Request, res: Response) => {
  const { query, folder_id, page, page_size } = req.body as { query?: string; folder_id?: number; page?: number; page_size?: number };
  if (!query?.trim()) { res.status(400).json({ error: 'query is required' }); return; }

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
  try { res.write(': searching\n\n'); } catch { /* closed */ }
  const keepalive = setInterval(() => { try { res.write(': ka\n\n'); } catch { /* closed */ } }, 5000);

  const r = await kmSearch(query.trim(), {
    folderId: typeof folder_id === 'number' ? folder_id : undefined,
    page: typeof page === 'number' ? page : undefined,
    pageSize: typeof page_size === 'number' ? page_size : undefined,
  });
  clearInterval(keepalive);
  const payload = r.ok ? { ok: true, data: r.data } : { ok: false, status: r.status ?? 502, error: r.error };
  try { res.write(`data: ${JSON.stringify(payload)}\n\n`); res.end(); } catch { /* closed */ }
});

// ─── 文件 tab: document detail (per-user permission) ───
router.get('/document/:id', async (req: Request, res: Response) => {
  const onBehalf = await getKmOnBehalf(req.user!.userId);
  if (!onBehalf) { res.status(400).json({ error: '無法取得你的員編（KM 需要 AD 帳號）。' }); return; }
  const r = await kmGetDocument(onBehalf, String(req.params.id));
  if (!r.ok) { res.status(r.status && r.status < 500 ? r.status : 502).json({ error: r.error }); return; }
  res.json(r.data);
});

// ─── 文件 tab: attachment stream (view inline OR download) ───
router.get('/document/:id/attachment/:filename', async (req: Request, res: Response) => {
  const onBehalf = await getKmOnBehalf(req.user!.userId);
  if (!onBehalf) { res.status(400).json({ error: '無法取得你的員編。' }); return; }
  const filename = decodeURIComponent(String(req.params.filename));
  const r = await kmFetchAttachment(onBehalf, String(req.params.id), filename);
  if (!r.ok || !r.buf) { res.status(r.status && r.status < 500 ? r.status : 502).json({ error: r.error }); return; }
  const download = req.query.download === '1';
  // RFC 5987 filename* so Chinese names survive; inline for the in-app viewer.
  const encoded = encodeURIComponent(filename);
  res.setHeader('Content-Type', r.contentType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encoded}`);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.send(r.buf);
});

// ─── 對話 tab: AI Q&A grounded in KM (via km-mcp), streamed over SSE on THIS request ───
async function getOrCreateKmConversation(userId: string): Promise<string> {
  const existing = await dbGet<{ id: string }>("SELECT id FROM conversations WHERE user_id = ? AND category = 'km-agent' LIMIT 1", userId);
  if (existing) return existing.id;
  const id = uuidv4();
  await dbRun("INSERT INTO conversations (id, user_id, title, category, status) VALUES (?, ?, ?, ?, ?)", id, userId, 'KM 助手', 'km-agent', 'active');
  return id;
}

router.post('/chat', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { message } = req.body as { message?: string };
  if (!(await kmAgentEnabled(userId))) { res.status(403).json({ error: 'km_agent_disabled', message: '尚未開啟 KM 助手。' }); return; }
  if (!message?.trim()) { res.status(400).json({ error: 'Message is required' }); return; }

  const usage = await checkUserUsageLimit(userId);
  if (usage.exceeded) { res.status(403).json({ error: `本月用量已達上限 USD $${usage.limit.toFixed(2)}` }); return; }

  const onBehalf = await getKmOnBehalf(userId);
  if (!onBehalf) { res.status(400).json({ error: '無法取得你的員編（KM 需要 AD 帳號）。' }); return; }

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
  const write = (event: SSEEvent) => { try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* closed */ } };
  const keepalive = setInterval(() => { try { res.write(': keepalive\n\n'); } catch { /* closed */ } }, 10000);

  const conversationId = await getOrCreateKmConversation(userId);
  await dbRun('INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)', uuidv4(), conversationId, 'user', message.trim());

  // Recent turns for lightweight context (last 6 messages).
  const history = await dbAll<{ role: string; content: string }>(
    'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 6', conversationId);
  const historyBlock = history.reverse().map(m => `${m.role === 'user' ? '使用者' : '助手'}：${m.content.slice(0, 500)}`).join('\n');
  const prompt = historyBlock ? `${historyBlock}\n\n使用者最新問題：${message.trim()}` : message.trim();

  let text = '';
  let inTok = 0, outTok = 0, model = '';
  const { emitter, abort } = spawnClaude(prompt, KM_ASSISTANT_SYSTEM_PROMPT, {
    userId, conversationId,
    sandboxSubdir: '_agents/km-assistant',
    sessionId: uuidv4(), isResume: false,
    customAllowedTools: ['Read'], maxTurns: 8,
    mcpKmOnBehalf: onBehalf, // attaches km-mcp (claudeCli disables Task, keeps ToolSearch)
  });
  const timer = setTimeout(() => { try { abort(); } catch { /* ignore */ } }, 180_000);
  req.on('close', () => { try { abort(); } catch { /* ignore */ } });

  emitter.on('event', async (ev: SSEEvent) => {
    if (ev.type === 'text') { text += ev.data as string; write({ type: 'text', data: ev.data }); }
    else if (ev.type === 'tool_activity') { write(ev); }
    else if (ev.type === 'usage') { const u = ev.data as { inputTokens: number; outputTokens: number; model: string }; inTok = u.inputTokens; outTok = u.outputTokens; model = u.model; }
    else if (ev.type === 'done') {
      clearTimeout(timer);
      clearInterval(keepalive);
      if (text.trim()) {
        await dbRun('INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)', uuidv4(), conversationId, 'assistant', text).catch(() => {});
        if (inTok || outTok) await recordTokenUsage({ userId, conversationId, inputTokens: inTok, outputTokens: outTok, model: model || 'claude-haiku-4-5-20251001' }).catch(() => {});
      }
      write({ type: 'done', data: {} });
      try { res.end(); } catch { /* closed */ }
    }
  });
});

// ─── Chat history (for the 對話 tab on open) ───
router.get('/history', async (req: Request, res: Response) => {
  const conv = await dbGet<{ id: string }>("SELECT id FROM conversations WHERE user_id = ? AND category = 'km-agent' LIMIT 1", req.user!.userId);
  if (!conv) { res.json({ messages: [] }); return; }
  const rows = await dbAll<{ role: string; content: string; created_at: string }>(
    'SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 40', conv.id);
  res.json({ messages: rows });
});

export default router;
