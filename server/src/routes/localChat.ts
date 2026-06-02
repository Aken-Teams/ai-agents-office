/**
 * /api/local-chat — 走地端 OpenAI 相容 LLM (Ollama gateway 等) 的「輕量對話」端點。
 *
 * 設計目的：與主 Claude CLI 編排器 (services/orchestrator.ts) 並存。
 * 凡是「不需要工具呼叫、不需要文件生成、純粹一問一答」的場景應該走這支，
 * 把貴的 Claude token 留給真正需要 multi-agent / tool-use 的任務。
 *
 * 三個端點：
 *   GET  /api/local-chat/status          — 看地端 LLM 是否啟用 + 預設模型
 *   POST /api/local-chat                 — 同步呼叫，回 { text, model, usage }
 *   POST /api/local-chat/stream          — SSE 串流，逐字回吐 delta
 *
 * 三個端點都需要登入（authMiddleware），避免被當公開 LLM 跳板。
 */

import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { config } from '../config.js';
import {
  isLocalLlmEnabled,
  listProviders,
  localLlmChat,
  localLlmStream,
  LocalLlmError,
  type ChatMessage,
} from '../services/localLlm.js';

const router = Router();

/* ============================================================
   Validation
   ============================================================ */

const MAX_MESSAGES = 50;
const MAX_CONTENT_LENGTH = 16_000;

function sanitizeMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) {
    throw new Error('messages must be an array');
  }
  if (raw.length === 0) {
    throw new Error('messages must not be empty');
  }
  if (raw.length > MAX_MESSAGES) {
    throw new Error(`messages too long (max ${MAX_MESSAGES})`);
  }
  const out: ChatMessage[] = [];
  for (const m of raw) {
    if (!m || typeof m !== 'object') throw new Error('invalid message entry');
    const role = (m as { role?: string }).role;
    const content = (m as { content?: string }).content;
    if (role !== 'system' && role !== 'user' && role !== 'assistant') {
      throw new Error(`invalid role: ${String(role)}`);
    }
    if (typeof content !== 'string') {
      throw new Error('content must be a string');
    }
    if (content.length > MAX_CONTENT_LENGTH) {
      throw new Error(`content too long (max ${MAX_CONTENT_LENGTH} chars)`);
    }
    out.push({ role, content });
  }
  return out;
}

/* ============================================================
   GET /api/local-chat/status
   ============================================================ */
router.get('/status', authMiddleware, (_req: Request, res: Response) => {
  res.json({
    enabled: isLocalLlmEnabled(),
    baseUrl: config.localLlm.baseUrl ? maskHost(config.localLlm.baseUrl) : null,
    defaultModel: config.localLlm.defaultModel || null,
    defaultProvider: config.localLlm.defaultProviderName,
    timeoutMs: config.localLlm.timeoutMs,
  });
});

/* ============================================================
   GET /api/local-chat/providers — list configured providers
   ============================================================ */
router.get('/providers', authMiddleware, (_req: Request, res: Response) => {
  res.json({ providers: listProviders() });
});

function maskHost(url: string): string {
  // Hide path tail; keep host visible for diagnosis.
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

/* ============================================================
   POST /api/local-chat — non-streaming
   Body: { messages, model?, temperature?, maxTokens?, jsonMode? }
   ============================================================ */
router.post('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const messages = sanitizeMessages(req.body?.messages);
    const result = await localLlmChat({
      messages,
      provider: typeof req.body?.provider === 'string' ? req.body.provider : undefined,
      model: typeof req.body?.model === 'string' ? req.body.model : undefined,
      temperature: typeof req.body?.temperature === 'number' ? req.body.temperature : undefined,
      maxTokens: typeof req.body?.maxTokens === 'number' ? req.body.maxTokens : undefined,
      jsonMode: req.body?.jsonMode === true,
    });
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

/* ============================================================
   POST /api/local-chat/stream — SSE
   Same body as above; client should EventSource or fetch + readableStream.
   ============================================================ */
router.post('/stream', authMiddleware, async (req: Request, res: Response) => {
  let messages: ChatMessage[];
  try {
    messages = sanitizeMessages(req.body?.messages);
  } catch (err) {
    handleError(err, res);
    return;
  }

  // Configure SSE response. X-Accel-Buffering: no avoids any reverse-proxy buffering.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  // Abort upstream only when the *response* is closed prematurely (client
  // disconnected mid-stream). Listening on req.on('close') in Express is
  // unreliable because body-parser can trigger it right after parsing the body.
  const abort = new AbortController();
  let finished = false;
  res.on('close', () => {
    if (!finished) abort.abort();
  });

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    for await (const delta of localLlmStream({
      messages,
      provider: typeof req.body?.provider === 'string' ? req.body.provider : undefined,
      model: typeof req.body?.model === 'string' ? req.body.model : undefined,
      temperature: typeof req.body?.temperature === 'number' ? req.body.temperature : undefined,
      maxTokens: typeof req.body?.maxTokens === 'number' ? req.body.maxTokens : undefined,
      jsonMode: req.body?.jsonMode === true,
      signal: abort.signal,
    })) {
      send('delta', { content: delta });
    }
    send('done', {});
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    const status = err instanceof LocalLlmError ? err.status : 502;
    if (!res.closed) send('error', { error: message, status });
  } finally {
    finished = true;
    if (!res.closed) res.end();
  }
});

/* ============================================================
   Error helper
   ============================================================ */
function handleError(err: unknown, res: Response): void {
  if (err instanceof LocalLlmError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof Error) {
    // Validation errors
    if (
      err.message.startsWith('messages') ||
      err.message.startsWith('content') ||
      err.message.startsWith('invalid')
    ) {
      res.status(400).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: err.message });
    return;
  }
  res.status(500).json({ error: 'unknown error' });
}

export default router;
