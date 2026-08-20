/**
 * Aux LLM — the cheap lane for TOOL-FREE text work.
 *
 * Three jobs use it: the email agent's one-line summaries (Layer 1), the team
 * run's round-2 discussion + synthesis, and the admin topic analysis. All three
 * only read text and write text, so none of them needs a `claude` CLI spawn —
 * which is a whole agent runtime at ~100s of MB per process, and was the main
 * source of host-memory pressure when many users arrived at once. This is a
 * plain HTTP call inside the existing process.
 *
 * ── Provider order: on-prem first, DeepSeek second ──
 * The private gateway is OpenAI-compatible and costs nothing per token, so it
 * leads. DeepSeek is the backup. Every caller ALSO keeps its own Claude CLI
 * fallback for when both are unreachable, so the chain degrades three deep and
 * never leaves a feature dead.
 *
 * ── Failing over must be fast, not polite ──
 * A provider that is DOWN is cheap (one refused connection). A provider that
 * HANGS is expensive: without care every call pays the full timeout before
 * moving on, and a 50-mail briefing turns into minutes of nothing. So:
 *   - each attempt gets its own bounded budget, not the caller's whole one;
 *   - streaming has a separate, much shorter first-token watchdog — silence is
 *     the symptom of a stuck box, and nothing has reached the user yet, so
 *     aborting there costs nothing;
 *   - repeated failures trip a breaker that skips the provider outright for a
 *     few minutes, so ONE wedged box does not tax every later call. That is the
 *     shape the dead DeepSeek key had: ten batches, ten identical failed round
 *     trips, every one of them predictable after the first.
 */
import { config } from '../config.js';
import { logAiCall } from './aiCallLog.js';

/**
 * Where a call came from, so the admin report can say "the email briefing is
 * what keeps timing out" rather than just "something failed 12 times".
 * Recorded in ai_call_log.skill_id, alongside the existing per-skill counts.
 */
export type AuxFeature =
  | 'email-summary' | 'team-discussion' | 'team-synthesis' | 'greeting'
  | 'content-safety' | 'team-builder' | 'role-prompt' | 'doc-narration' | 'topic-analysis';

/**
 * Record one attempt against one provider — including the failures, which is the
 * entire point: a success rate you can only compute from the calls that worked
 * is not a success rate. Fire-and-forget; never blocks or throws.
 */
function logAttempt(
  p: Provider, feature: AuxFeature | undefined, ok: boolean,
  inTok: number, outTok: number, reason: string,
): void {
  logAiCall({
    skillId: feature,
    model: p.model,
    authMode: p.name,
    reason,
    inputTokens: inTok,
    outputTokens: outTok,
    exitCode: null,
    success: ok,
  });
}

export interface AuxLlmResult {
  text: string;
  inTok: number;
  outTok: number;
  /** The model that actually answered — record this, never a guess. */
  model: string;
  provider: ProviderName;
}

type ProviderName = 'local' | 'deepseek';

interface Provider {
  name: ProviderName;
  url: string;
  apiKey: string;
  model: string;
  /** Per-attempt ceiling. Past this we stop waiting and try the next provider. */
  attemptTimeoutMs: number;
}

/**
 * Which local model to ask for.
 *
 * 'fast' is the default because most aux work is many small calls with someone
 * waiting. 'quality' is for the rare long call whose text a human will read.
 */
export type AuxTier = 'fast' | 'quality';

/** Providers this deployment can use, best first. Empty = nothing configured. */
function providers(tier: AuxTier = 'fast'): Provider[] {
  const list: Provider[] = [];
  if (config.localLlmBaseUrl && config.localLlmApiKey) {
    list.push({
      name: 'local',
      url: `${config.localLlmBaseUrl}/chat/completions`,
      apiKey: config.localLlmApiKey,
      model: tier === 'quality' ? config.localLlmModelQuality : config.localLlmModel,
      // The fast model answered a real batch in 1.8-8s even with the box under
      // load; 45s is generous for it and still short enough that a wedged box
      // does not hold the caller. The quality model is slower by design — it
      // gets the same ceiling, and when it misses, falling through to the CLI is
      // the intended outcome rather than a failure.
      attemptTimeoutMs: 45_000,
    });
  }
  if (config.deepseekApiKey) {
    list.push({
      name: 'deepseek',
      url: 'https://api.deepseek.com/chat/completions',
      apiKey: config.deepseekApiKey,
      model: 'deepseek-chat',
      attemptTimeoutMs: 60_000,
    });
  }
  return list;
}

/** True when at least one aux provider is configured. */
export function auxLlmAvailable(): boolean {
  return providers().length > 0;
}

// ── Breaker ────────────────────────────────────────────────────────────────
// Three consecutive failures is not bad luck, it is a broken box or a revoked
// key. Stop asking for a while.

const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 5 * 60_000;
const breakers = new Map<ProviderName, { failures: number; openedAt: number }>();

function breakerOpen(name: ProviderName): boolean {
  const b = breakers.get(name);
  if (!b || b.failures < BREAKER_THRESHOLD) return false;
  if (Date.now() - b.openedAt < BREAKER_COOLDOWN_MS) return true;
  // Cooldown elapsed — let exactly one call through to see if it recovered.
  breakers.set(name, { failures: BREAKER_THRESHOLD - 1, openedAt: 0 });
  return false;
}

function noteFailure(name: ProviderName, why: string): void {
  const b = breakers.get(name) || { failures: 0, openedAt: 0 };
  b.failures++;
  if (b.failures === BREAKER_THRESHOLD) {
    b.openedAt = Date.now();
    console.warn(`[auxLlm] ${name} failed ${b.failures}x in a row (${why}) — skipping it for ${BREAKER_COOLDOWN_MS / 60_000} min`);
  }
  breakers.set(name, b);
}

function noteSuccess(name: ProviderName): void {
  if (breakers.has(name)) breakers.delete(name);
}

/** What the breaker currently thinks — for admin/debug views. */
export function auxLlmBreakerState(): Array<{ provider: ProviderName; model: string; failures: number; skipping: boolean }> {
  return providers().map(p => ({
    provider: p.name,
    model: p.model,
    failures: breakers.get(p.name)?.failures || 0,
    skipping: breakerOpen(p.name),
  }));
}

// ── Response shaping ───────────────────────────────────────────────────────

/**
 * Pull the answer out of a message.
 *
 * Two quirks the on-prem gateway has and OpenAI does not:
 *  - "thinking" models may leave `content` empty and put everything in
 *    `reasoning`, so empty content is not the same as no answer;
 *  - some models emit raw harmony tokens, where only what follows the final
 *    `<|channel|>final<|message|>` marker is the answer and the rest is scratch
 *    work the user must never see.
 */
function extractText(message: { content?: string; reasoning?: string } | undefined): string {
  let text = (message?.content || '').trim() || (message?.reasoning || '').trim();
  const marker = '<|channel|>final<|message|>';
  const at = text.lastIndexOf(marker);
  if (at !== -1) text = text.slice(at + marker.length);
  return text.replace(/<\|[a-z_]+\|>/g, '').trim();
}

/**
 * Close a JSON value that was cut off mid-write.
 *
 * Hitting max_tokens is the normal way a local model fails at structured output:
 * the JSON is perfectly well-formed right up to the point where it stops. Rather
 * than throw the whole answer away, cut back to the last complete element and
 * close whatever is still open — six categories minus the last one beats an
 * error banner. Returns null when the text is not salvageable that way.
 */
function repairTruncatedJson(s: string): string | null {
  const stack: string[] = [];
  let inStr = false, esc = false;
  // Where we could cut, plus what was still open AT that point (not at the end).
  let cutAt = -1;
  let cutStack: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    else if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') {
      stack.pop();
      cutAt = i + 1; cutStack = [...stack];       // just after a complete value
    } else if (c === ',') {
      cutAt = i; cutStack = [...stack];           // just before the next one starts
    }
  }
  if (!stack.length || cutAt <= 0) return null;   // complete already, or nothing usable
  return s.slice(0, cutAt) + cutStack.reverse().join('');
}

/**
 * Parse JSON out of a model's answer.
 *
 * Local models wrap JSON in ```json fences even when told not to, and even when
 * asked with response_format json_object — verified against this gateway. A bare
 * JSON.parse fails on output that is otherwise perfectly good, so take the
 * outermost brackets, ignore the decoration, and repair a truncated tail.
 * Handles objects and arrays alike.
 */
export function parseJsonLoose<T = unknown>(text: string): T | null {
  if (!text) return null;
  const stripped = text.replace(/```(?:json)?/gi, '');
  // Start at whichever opener comes first, so an array answer parses too.
  const objAt = stripped.indexOf('{');
  const arrAt = stripped.indexOf('[');
  const start = objAt === -1 ? arrAt : arrAt === -1 ? objAt : Math.min(objAt, arrAt);
  if (start === -1) return null;
  const end = Math.max(stripped.lastIndexOf('}'), stripped.lastIndexOf(']'));
  const candidate = stripped.slice(start, end > start ? end + 1 : undefined);

  try { return JSON.parse(candidate) as T; } catch { /* fall through to repair */ }
  const repaired = repairTruncatedJson(candidate);
  if (!repaired) return null;
  try {
    const value = JSON.parse(repaired) as T;
    console.warn('[auxLlm] answer was truncated mid-JSON — recovered the complete part');
    return value;
  } catch { return null; }
}

// ── The calls ──────────────────────────────────────────────────────────────

/**
 * One-shot completion. Returns null only when EVERY provider failed, so callers
 * can fall back to their own CLI path.
 */
export async function auxChat(
  prompt: string,
  opts?: {
    system?: string; maxTokens?: number; temperature?: number; timeoutMs?: number;
    jsonMode?: boolean; tier?: AuxTier; feature?: AuxFeature;
  },
): Promise<AuxLlmResult | null> {
  const messages: Array<{ role: string; content: string }> = [];
  if (opts?.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: prompt });

  // timeoutMs is the TOTAL the caller is willing to wait, not a per-attempt
  // allowance — otherwise a caller that can spare 8s (a content-safety check
  // sitting in a chat turn) would silently wait 16 when the first provider
  // stalls. Each attempt gets whatever is left, capped by its own ceiling.
  const deadline = opts?.timeoutMs ? Date.now() + opts.timeoutMs : null;

  for (const p of providers(opts?.tier)) {
    if (breakerOpen(p.name)) continue;
    const remaining = deadline ? deadline - Date.now() : p.attemptTimeoutMs;
    if (remaining <= 250) break; // not enough left to be worth a round trip
    // Thinking models spend output tokens on reasoning before they answer; too
    // small a cap returns finish_reason=length with EMPTY content.
    const maxTokens = Math.max(opts?.maxTokens ?? 1024, p.name === 'local' ? 1500 : 0);
    const budget = Math.min(remaining, p.attemptTimeoutMs);
    try {
      const res = await fetch(p.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.apiKey}` },
        body: JSON.stringify({
          model: p.model,
          messages,
          temperature: opts?.temperature ?? 0.3,
          max_tokens: maxTokens,
          ...(opts?.jsonMode ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: AbortSignal.timeout(budget),
      });
      if (!res.ok) {
        console.error(`[auxLlm] ${p.name} (${p.model}) HTTP ${res.status}:`, (await res.text().catch(() => '')).slice(0, 300));
        noteFailure(p.name, `HTTP ${res.status}`);
        logAttempt(p, opts?.feature, false, 0, 0, `HTTP ${res.status}`);
        continue;
      }
      const data = await res.json() as {
        choices?: Array<{ message?: { content?: string; reasoning?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const text = extractText(data.choices?.[0]?.message);
      const inTok = data.usage?.prompt_tokens ?? 0;
      const outTok = data.usage?.completion_tokens ?? 0;
      if (!text) {
        noteFailure(p.name, 'empty answer');
        logAttempt(p, opts?.feature, false, inTok, outTok, 'empty answer');
        continue;
      }
      noteSuccess(p.name);
      logAttempt(p, opts?.feature, true, inTok, outTok, 'ok');
      return { text, inTok, outTok, model: p.model, provider: p.name };
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      console.error(`[auxLlm] ${p.name} (${p.model}) failed:`, why);
      noteFailure(p.name, why);
      // "aborted due to timeout" is the interesting one — it means the box was
      // alive but too slow, which is a different decision from "it was down".
      logAttempt(p, opts?.feature, false, 0, 0, /timeout|abort/i.test(why) ? 'timeout' : why.slice(0, 120));
    }
  }
  return null;
}

/**
 * Streaming completion — same chain, deltas pushed through `onText` so live UIs
 * keep updating.
 *
 * Falls through to the next provider ONLY while nothing has been emitted. Once
 * the user has seen text, retrying elsewhere would duplicate it on screen, so a
 * mid-stream failure returns the partial answer instead.
 */
export async function auxChatStream(opts: {
  system?: string;
  user: string;
  onText: (chunk: string) => void;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  /** Silence budget before giving up on a provider. Free to abort: nothing shown yet. */
  firstTokenTimeoutMs?: number;
  tier?: AuxTier;
  feature?: AuxFeature;
  /** Caller's own stop signal — e.g. the reader closed the page. Ends the chain. */
  signal?: AbortSignal;
}): Promise<AuxLlmResult | null> {
  const messages: Array<{ role: string; content: string }> = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: opts.user });
  // The quality tier is a bigger model on a box that swaps models in and out, so
  // it gets longer to say its first word before we give up on it.
  const firstTokenBudget = opts.firstTokenTimeoutMs ?? (opts.tier === 'quality' ? 40_000 : 25_000);

  for (const p of providers(opts.tier)) {
    // The caller gave up (reader closed the page) — do not start another attempt.
    if (opts.signal?.aborted) return null;
    if (breakerOpen(p.name)) continue;
    let text = '';
    let inTok = 0, outTok = 0;
    const controller = new AbortController();
    const onCallerAbort = () => controller.abort();
    opts.signal?.addEventListener('abort', onCallerAbort, { once: true });
    // Two clocks: total, and "has it said ANYTHING yet".
    const totalTimer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 120_000);
    let silenceTimer: NodeJS.Timeout | null = setTimeout(() => {
      console.warn(`[auxLlm] ${p.name} sent nothing in ${firstTokenBudget}ms — moving on`);
      controller.abort();
    }, firstTokenBudget);
    const clearTimers = () => {
      clearTimeout(totalTimer);
      if (silenceTimer) clearTimeout(silenceTimer);
      opts.signal?.removeEventListener('abort', onCallerAbort);
    };

    try {
      const res = await fetch(p.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.apiKey}` },
        body: JSON.stringify({
          model: p.model,
          messages,
          temperature: opts.temperature ?? 0.4,
          max_tokens: Math.max(opts.maxTokens ?? 4096, p.name === 'local' ? 1500 : 0),
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        clearTimers();
        console.error(`[auxLlm] ${p.name} stream HTTP ${res.status}:`, (await res.text().catch(() => '')).slice(0, 300));
        noteFailure(p.name, `stream HTTP ${res.status}`);
        logAttempt(p, opts.feature, false, 0, 0, `HTTP ${res.status}`);
        continue;
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
            if (delta) {
              if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
              text += delta;
              opts.onText(delta);
            }
            if (j.usage) {
              inTok = j.usage.prompt_tokens ?? inTok;
              outTok = j.usage.completion_tokens ?? outTok;
            }
          } catch { /* skip malformed SSE line */ }
        }
      }
      clearTimers();
      if (!text.trim()) {
        noteFailure(p.name, 'empty stream');
        logAttempt(p, opts.feature, false, inTok, outTok, 'empty stream');
        continue;
      }
      noteSuccess(p.name);
      logAttempt(p, opts.feature, true, inTok, outTok, 'ok');
      return { text: text.trim(), inTok, outTok, model: p.model, provider: p.name };
    } catch (e) {
      clearTimers();
      // The caller walked away. Not the provider's fault, so it must not count
      // toward the breaker or the success rate — the reader left, the box didn't fail.
      if (opts.signal?.aborted) return text.trim() ? { text: text.trim(), inTok, outTok, model: p.model, provider: p.name } : null;
      const why = e instanceof Error ? e.message : String(e);
      console.error(`[auxLlm] ${p.name} stream failed:`, why);
      noteFailure(p.name, why);
      const partial = text.trim();
      // A stream that died after saying something is a partial success: the user
      // got an answer. Log it as such, with the reason, so the rate is honest.
      logAttempt(p, opts.feature, !!partial, inTok, outTok,
        partial ? 'partial (stream cut)' : (/timeout|abort/i.test(why) ? 'timeout' : why.slice(0, 120)));
      if (partial) return { text: partial, inTok, outTok, model: p.model, provider: p.name };
    }
  }
  return null;
}
