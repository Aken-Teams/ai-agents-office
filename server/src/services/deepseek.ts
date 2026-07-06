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
