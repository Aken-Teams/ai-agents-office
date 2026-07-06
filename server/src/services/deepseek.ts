/**
 * Minimal DeepSeek chat-completion helper.
 *
 * Used for LIGHTWEIGHT, tool-free AI tasks (email one-line summaries, etc.) that
 * do NOT need the full `claude` CLI. A CLI spawn is a whole agent runtime (~100s
 * of MB per process); this is just an HTTP call in the existing Node process, so
 * it costs almost no local memory — the key win for high-concurrency scenarios.
 */

import { config } from '../config.js';

export interface DeepseekResult {
  text: string;
  inTok: number;
  outTok: number;
}

/**
 * One-shot DeepSeek chat completion. Returns null when DeepSeek isn't configured
 * or the request fails, so callers can fall back to the CLI.
 */
export async function deepseekChat(
  prompt: string,
  opts?: { maxTokens?: number; temperature?: number; timeoutMs?: number },
): Promise<DeepseekResult | null> {
  if (!config.deepseekApiKey) return null;
  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.deepseekApiKey}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        temperature: opts?.temperature ?? 0.3,
        max_tokens: opts?.maxTokens ?? 1024,
      }),
      signal: AbortSignal.timeout(opts?.timeoutMs ?? 30000),
    });
    if (!res.ok) {
      console.error('[deepseek] error:', res.status, await res.text().catch(() => ''));
      return null;
    }
    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      text: (data.choices?.[0]?.message?.content || '').trim(),
      inTok: data.usage?.prompt_tokens ?? 0,
      outTok: data.usage?.completion_tokens ?? 0,
    };
  } catch (e) {
    console.error('[deepseek] failed:', e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Streaming DeepSeek chat — same as deepseekChat but calls `onText` per delta so
 * live UIs (team discussion / synthesis) keep streaming. Returns null ONLY when
 * nothing was emitted (so the caller can safely fall back to the CLI); if it
 * fails mid-stream after emitting text, it returns the partial result to avoid
 * a fallback re-run duplicating output.
 */
export async function deepseekChatStream(opts: {
  system?: string;
  user: string;
  onText: (chunk: string) => void;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}): Promise<DeepseekResult | null> {
  if (!config.deepseekApiKey) return null;
  const messages: Array<{ role: string; content: string }> = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: opts.user });

  let text = '';
  let inTok = 0, outTok = 0;
  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.deepseekApiKey}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages,
        temperature: opts.temperature ?? 0.4,
        max_tokens: opts.maxTokens ?? 4096,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 120000),
    });
    if (!res.ok || !res.body) {
      console.error('[deepseek] stream error:', res.status, await res.text().catch(() => ''));
      return null;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const payload = s.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          const delta = j.choices?.[0]?.delta?.content;
          if (delta) { text += delta; opts.onText(delta); }
          if (j.usage) { inTok = j.usage.prompt_tokens ?? inTok; outTok = j.usage.completion_tokens ?? outTok; }
        } catch { /* skip malformed SSE line */ }
      }
    }
    return { text: text.trim(), inTok, outTok };
  } catch (e) {
    console.error('[deepseek] stream failed:', e instanceof Error ? e.message : e);
    // Already streamed something → return partial (a fallback re-run would duplicate).
    return text ? { text: text.trim(), inTok, outTok } : null;
  }
}
