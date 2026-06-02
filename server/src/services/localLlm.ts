/**
 * 地端 / 私有 OpenAI 相容 LLM 客戶端。
 *
 * 用途：與主 Claude CLI 協作 — 輕量級任務（簡單對話、分類、摘要、JSON
 * 格式化）走這個 API 以節省 token；重活（多智能體編排、文件生成）仍走
 * Claude CLI。
 *
 * 為什麼用 fetch 而不是 openai npm SDK：
 * - 避免新增依賴；server 原本就用 fetch 打 DeepSeek
 * - OpenAI 相容 API 在 wire format 上很穩定，自己處理足夠且更可控
 *
 * 使用方式：
 *   import { localLlmChat, localLlmStream, isLocalLlmEnabled } from '../services/localLlm.js';
 *
 *   if (!isLocalLlmEnabled()) { ... fallback ... }
 *
 *   const text = await localLlmChat({
 *     messages: [{ role: 'user', content: '一句話講解什麼是 RAG' }],
 *     temperature: 0.3,
 *   });
 *
 *   for await (const delta of localLlmStream({ messages: [...] })) {
 *     process.stdout.write(delta);
 *   }
 */

import { config, type LocalLlmProvider } from '../config.js';
import { isLocalLlmEnabledSetting } from './llmSettings.js';

export type Role = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface LocalLlmRequest {
  messages: ChatMessage[];
  /** Provider slug; omit to use the configured default provider. */
  provider?: string;
  /** Override the provider's configured model. Rarely needed. */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** 強制 JSON 輸出 (response_format = { type: 'json_object' }) */
  jsonMode?: boolean;
  /** 額外 OpenAI compatible 參數 (top_p, frequency_penalty 等) */
  extra?: Record<string, unknown>;
  /** AbortController.signal — 串接 caller 的取消能力 */
  signal?: AbortSignal;
}

export interface LocalLlmResult {
  text: string;
  /**
   * gpt-oss / harmony 模型的「思考內容」(analysis channel)。
   * 上游有給才會有；多數普通模型為空字串。caller 可用來做 fallback parse。
   */
  reasoning: string;
  model: string;
  /** 原始 usage 物件，欄位依 server 而定（Ollama / vLLM / OpenAI 不完全一致） */
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/* ============================================================
   Capability check + provider resolution
   ============================================================ */

export function isLocalLlmEnabled(provider?: string): boolean {
  // Admin kill-switch overrides everything — when off, behave as if not configured.
  if (!isLocalLlmEnabledSetting()) return false;
  return Boolean(resolveProvider(provider));
}

/* ============================================================
   Embeddings — OpenAI-compatible /embeddings endpoint
   ============================================================ */

export interface EmbedRequest {
  /** Inputs to embed — either a single string or a batch. */
  input: string | string[];
  /** Provider name (must have kind='embedding'). Defaults to 'embed'. */
  provider?: string;
  /** Override model id. Rare. */
  model?: string;
  /** AbortController.signal — propagates cancellation. */
  signal?: AbortSignal;
}

export interface EmbedResult {
  vectors: number[][];
  model: string;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

/**
 * Call the gateway's /embeddings endpoint and return one float[] per input.
 * The caller decides batching; we just pass the array through. For very
 * large batches (>200 inputs) caller should chunk to keep the request body
 * small and to bound latency.
 */
export async function embed(req: EmbedRequest): Promise<EmbedResult> {
  const provider = ensureProvider(req.provider ?? 'embed');
  if (provider.kind && provider.kind !== 'embedding') {
    throw new LocalLlmError(`Provider ${provider.name} is not an embedding provider`, 400);
  }

  const url = `${provider.baseUrl}/embeddings`;
  const body = {
    model: req.model || provider.model,
    input: req.input,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(provider),
    body: JSON.stringify(body),
    signal: buildAbortSignal({ messages: [], signal: req.signal } as LocalLlmRequest),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new LocalLlmError(`Embed ${res.status}: ${errText.slice(0, 500)}`, res.status);
  }

  const data = (await res.json()) as {
    data: Array<{ embedding: number[]; index: number }>;
    model: string;
    usage?: EmbedResult['usage'];
  };

  // Reorder by `index` because OpenAI-compatible servers don't guarantee
  // the response array follows input order in all implementations.
  const ordered = [...(data.data ?? [])].sort((a, b) => a.index - b.index);
  return {
    vectors: ordered.map(r => r.embedding),
    model: data.model,
    usage: data.usage,
  };
}

export function listProviders(): Array<{
  name: string;
  model: string;
  thinking: boolean;
  isDefault: boolean;
}> {
  const def = config.localLlm.defaultProviderName;
  return Object.values(config.localLlm.providers).map(p => ({
    name: p.name,
    model: p.model,
    thinking: Boolean(p.thinking),
    isDefault: p.name === def,
  }));
}

function resolveProvider(name?: string): LocalLlmProvider | null {
  const target = name || config.localLlm.defaultProviderName;
  return config.localLlm.providers[target] ?? null;
}

/**
 * Rule-based auto provider selection. Picks a "thinking" provider when the
 * request looks like it benefits from reasoning (long input, code, math,
 * multi-turn context, explicit reasoning keywords), otherwise the fast
 * non-thinking provider. Falls back to whatever is configured if only one
 * provider exists.
 */
export function pickProviderAuto(req: Pick<LocalLlmRequest, 'messages' | 'jsonMode'>): string {
  // Embedding providers can't serve chat completions; exclude them or the
  // first long-input prompt will get sent to /embeddings and fail.
  const all = Object.values(config.localLlm.providers).filter(p => p.kind !== 'embedding');
  const thinking = all.find(p => p.thinking);
  const fast = all.find(p => !p.thinking);

  if (!thinking) return fast?.name ?? config.localLlm.defaultProviderName;
  if (!fast) return thinking.name;

  // JSON mode → stick with the non-thinking model: thinking models can stall
  // on the reasoning channel and leave the structured content empty.
  if (req.jsonMode) return fast.name;

  const lastUserMsg = [...req.messages].reverse().find(m => m.role === 'user');
  const text = lastUserMsg?.content ?? '';

  // Long input → likely complex
  if (text.length > 600) return thinking.name;

  // Code block (fenced or 3+ indented lines)
  if (/```[\s\S]*?```/.test(text) || /(?:^|\n)( {4,}|\t).+\n( {4,}|\t).+\n( {4,}|\t)/.test(text)) {
    return thinking.name;
  }

  // Math / equation markers
  if (/[∫∑√≈∂∇π≠≤≥]|\\frac|\\sum|\\int|\\sqrt|\\lim/.test(text)) {
    return thinking.name;
  }

  // Reasoning intent (zh + en)
  if (/(推理|證明|步驟|分析|為什麼|為何|怎麼算|計算|解釋|推導|思考|debug|reasoning|why|explain|prove|analyz|solve|step.by.step|derive)/i.test(text)) {
    return thinking.name;
  }

  // Multi-turn dialogue (>4 prior messages) → context-heavy, prefer reasoning
  if (req.messages.length > 4) return thinking.name;

  return fast.name;
}

function ensureProvider(name?: string): LocalLlmProvider {
  if (!isLocalLlmEnabledSetting()) {
    throw new LocalLlmError('Local LLM is disabled by administrator', 503);
  }
  const p = resolveProvider(name);
  if (!p) {
    const want = name || config.localLlm.defaultProviderName;
    const have = Object.keys(config.localLlm.providers);
    throw new LocalLlmError(
      `LocalLlm provider not configured: "${want}". Available: [${have.join(', ') || 'none'}]`,
      503,
    );
  }
  if (!p.baseUrl) throw new LocalLlmError(`Provider ${p.name}: baseUrl is missing`, 503);
  if (!p.apiKey) throw new LocalLlmError(`Provider ${p.name}: apiKey is missing`, 503);
  if (!p.model) throw new LocalLlmError(`Provider ${p.name}: model is missing`, 503);
  return p;
}

export class LocalLlmError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = 'LocalLlmError';
    this.status = status;
  }
}

/* ============================================================
   Internal helpers
   ============================================================ */

function buildHeaders(p: LocalLlmProvider): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${p.apiKey}`,
  };
}

/**
 * Apply provider-declared quirks before sending:
 *  - thinking models: inject identityOverride if caller didn't supply a system
 *    prompt, and raise max_tokens floor to minMaxTokens (default 1500).
 */
function applyProviderQuirks(p: LocalLlmProvider, req: LocalLlmRequest): LocalLlmRequest {
  let messages = req.messages;
  let maxTokens = req.maxTokens;

  if (p.identityOverride && !messages.some(m => m.role === 'system')) {
    messages = [{ role: 'system', content: p.identityOverride }, ...messages];
  }
  if (p.thinking) {
    const floor = p.minMaxTokens ?? 1500;
    maxTokens = Math.max(maxTokens ?? 0, floor);
  }

  return { ...req, messages, maxTokens };
}

function buildBody(p: LocalLlmProvider, req: LocalLlmRequest, stream: boolean): Record<string, unknown> {
  return {
    model: req.model || p.model,
    messages: req.messages,
    stream,
    ...(req.temperature !== undefined && { temperature: req.temperature }),
    ...(req.maxTokens !== undefined && { max_tokens: req.maxTokens }),
    ...(req.jsonMode && { response_format: { type: 'json_object' } }),
    ...(req.extra || {}),
  };
}

function buildAbortSignal(req: LocalLlmRequest): AbortSignal {
  // Combine the caller's signal (if any) with our timeout.
  const timeoutCtl = new AbortController();
  const timer = setTimeout(() => timeoutCtl.abort(new Error('LocalLlm timeout')), config.localLlm.timeoutMs);

  if (req.signal) {
    if (req.signal.aborted) timeoutCtl.abort(req.signal.reason);
    else req.signal.addEventListener('abort', () => timeoutCtl.abort(req.signal!.reason), { once: true });
  }

  // Clear the timeout when the signal aborts (avoid leaking timers in tests).
  timeoutCtl.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  return timeoutCtl.signal;
}

/* ============================================================
   Non-streaming chat completion
   ============================================================ */

export async function localLlmChat(req: LocalLlmRequest): Promise<LocalLlmResult> {
  const resolvedName = req.provider === 'auto' ? pickProviderAuto(req) : req.provider;
  const provider = ensureProvider(resolvedName);
  const finalReq = applyProviderQuirks(provider, req);
  const url = `${provider.baseUrl}/chat/completions`;

  const res = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(provider),
    body: JSON.stringify(buildBody(provider, finalReq, false)),
    signal: buildAbortSignal(finalReq),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new LocalLlmError(`LocalLlm ${res.status}: ${errText.slice(0, 500)}`, res.status);
  }

  const data = (await res.json()) as {
    model: string;
    choices: Array<{ message?: { content?: string; reasoning_content?: string } }>;
    usage?: LocalLlmResult['usage'];
  };

  const msg = data.choices?.[0]?.message ?? {};
  return {
    text: msg.content ?? '',
    reasoning: msg.reasoning_content ?? '',
    model: data.model,
    usage: data.usage,
  };
}

/* ============================================================
   Streaming chat completion (async generator of text deltas)
   ============================================================ */

export async function* localLlmStream(req: LocalLlmRequest): AsyncGenerator<string, void, void> {
  const resolvedName = req.provider === 'auto' ? pickProviderAuto(req) : req.provider;
  const provider = ensureProvider(resolvedName);
  const finalReq = applyProviderQuirks(provider, req);

  // Thinking models often emit raw harmony tokens through delta.content
  // (<|channel|>analysis<|message|>... etc). The gateway only normalises that
  // on the non-stream path, so for forceNonStream providers we fall back to a
  // single chat call and yield the cooked content as one chunk.
  if (provider.forceNonStream) {
    const result = await localLlmChat(finalReq);
    if (result.text) yield result.text;
    return;
  }

  const url = `${provider.baseUrl}/chat/completions`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { ...buildHeaders(provider), Accept: 'text/event-stream' },
    body: JSON.stringify(buildBody(provider, finalReq, true)),
    signal: buildAbortSignal(finalReq),
  });

  if (!res.ok || !res.body) {
    const errText = res.body ? await res.text().catch(() => '') : '';
    throw new LocalLlmError(`LocalLlm stream ${res.status}: ${errText.slice(0, 500)}`, res.status);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // OpenAI SSE: each event is "data: <json>\n\n", terminator is "data: [DONE]"
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const rawLine = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!rawLine.startsWith('data:')) continue;
        const payload = rawLine.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const evt = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const delta = evt.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch {
          // Tolerate malformed lines (some gateways insert keepalive comments).
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
