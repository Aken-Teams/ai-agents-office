/**
 * Pre-router — 在 Claude Orchestrator 前面攔一層判斷，把「純聊天 / 簡單問答」
 * 留給地端 LLM，省下 Claude token；複雜任務再 fallthrough 給 Claude。
 *
 * 三段式設計：
 *   classifyIntent()       — JSON-mode 分類，回 simple_chat | complex_task
 *   streamSimpleReply()    — 簡單分支直接用地端 LLM 串流回覆
 *   shouldUsePreRouter()   — 決定本次請求是否值得走 pre-router（短輸入、有 router、無上傳檔等）
 *
 * 整合點：routes/generate.ts 的 useOrchestrator 分支前。
 */

import { config } from '../config.js';
import {
  isLocalLlmEnabled,
  localLlmChat,
  localLlmStream,
  pickProviderAuto,
  type ChatMessage,
} from './localLlm.js';

export type Intent = 'simple_chat' | 'complex_task';

export interface ClassifyContext {
  /** Conversation category — 'document' | 'assistant' 等。文件類更傾向 escalate。 */
  category: string;
  /** 用戶訊息（已過 sanitize）。 */
  message: string;
  /** 是否有附加上傳檔；有附檔幾乎必走 complex。 */
  hasUploads: boolean;
  /** 是否有跨對話引用；有引用通常是要綜合處理。 */
  hasReferences: boolean;
  /** 最近 N 則訊息，幫 LLM 判斷上下文。 */
  recentMessages?: Array<{ role: string; content: string }>;
}

export interface ClassifyResult {
  intent: Intent;
  reason: string;
  /** 分類本身花的 token，方便 caller 累計。 */
  inputTokens: number;
  outputTokens: number;
}

/* ============================================================
   Heuristic gate — short-circuit BEFORE calling local LLM
   ============================================================ */

/**
 * 是否值得走 pre-router？只有滿足下列才回 true：
 * - 整體開關 `LOCAL_LLM_PRE_ROUTER_ENABLED=true`
 * - 地端 LLM 有設定好
 * - 沒有上傳檔、沒有跨對話引用（這兩種 99% 都是 complex）
 * - 訊息長度 ≤ maxInputChars
 */
export function shouldUsePreRouter(ctx: ClassifyContext): boolean {
  if (!config.localLlm.preRouter.enabled) return false;
  if (!isLocalLlmEnabled()) return false;
  if (ctx.hasUploads) return false;
  if (ctx.hasReferences) return false;
  if (ctx.message.length > config.localLlm.preRouter.maxInputChars) return false;
  return true;
}

/* ============================================================
   Intent classification
   ============================================================ */

const CLASSIFIER_SYSTEM = `你是一個路由分類器。判斷使用者的訊息屬於以下哪一類：

- "simple_chat": 純對話 — 打招呼、感謝、寒暄、詢問 AI 能做什麼、簡單事實問答（一兩句話可答完）、簡單翻譯、簡單運算、釐清前一輪輸出。
- "complex_task": 需要文件生成、資料分析、研究查證、多步驟工作、需要呼叫工具、需要搜尋網路、需要產生圖表、需要寫程式或產生檔案的需求。

判斷原則（任一觸發即視為 complex_task）：
- 訊息提到「做」「製作」「生成」「分析」「研究」「報告」「簡報」「Excel」「PPT」「Word」「PDF」「圖表」「整理」「比較」「規劃」等動作詞
- 訊息要求查詢即時資訊、最新資料、外部來源
- 訊息看起來是延續前一個複雜任務（例如「再加一頁」「改一下標題」「重新生成」）

只回傳 JSON，格式為 {"intent": "simple_chat" | "complex_task", "reason": "<≤30 字理由>"}。
不要加任何其他文字、註解或 markdown。`;

function buildClassifierMessages(ctx: ClassifyContext): ChatMessage[] {
  const lines: string[] = [];
  lines.push(`對話類型: ${ctx.category}`);
  if (ctx.recentMessages && ctx.recentMessages.length > 0) {
    lines.push('');
    lines.push('最近對話（最舊→最新）:');
    for (const m of ctx.recentMessages.slice(-4)) {
      const role = m.role === 'user' ? '使用者' : '助手';
      const content = m.content.length > 200 ? m.content.substring(0, 200) + '…' : m.content;
      lines.push(`[${role}] ${content}`);
    }
  }
  lines.push('');
  lines.push('使用者最新訊息:');
  lines.push(ctx.message);

  return [
    { role: 'system', content: CLASSIFIER_SYSTEM },
    { role: 'user', content: lines.join('\n') },
  ];
}

/**
 * 用地端 LLM 把使用者訊息分類成 simple_chat / complex_task。
 * 任何錯誤、解析失敗、超時都會 fallback 成 complex_task（safer default — 寧可走 Claude）。
 */
export async function classifyIntent(ctx: ClassifyContext): Promise<ClassifyResult> {
  try {
    // NOTE: jsonMode disabled on purpose — gpt-oss-harmony models count internal
    // reasoning tokens against max_tokens, and JSON mode then frequently returns
    // an empty content string. The classifier system prompt already enforces JSON
    // output, and parseClassifierJson() is tolerant of harmony / markdown wrappers.
    const result = await localLlmChat({
      messages: buildClassifierMessages(ctx),
      temperature: 0.1,
      maxTokens: 600,
      extra: { reasoning_effort: 'low' },
    });

    // gpt-oss often reasons but stops before emitting content. Treat reasoning
    // as a fallback signal: pattern-match the intent keywords from the analysis
    // channel rather than requiring well-formed JSON.
    const parsed = parseClassifierResponse(result.text, result.reasoning);
    return {
      intent: parsed.intent,
      reason: parsed.reason,
      inputTokens: result.usage?.prompt_tokens ?? 0,
      outputTokens: result.usage?.completion_tokens ?? 0,
    };
  } catch (err) {
    // Any failure → safer to escalate to Claude.
    console.warn('[PreRouter] classifyIntent failed, falling back to complex_task:', err);
    return { intent: 'complex_task', reason: 'classifier_error', inputTokens: 0, outputTokens: 0 };
  }
}

/**
 * 解析分類器輸出。優先用 `content` 中的 JSON；若 content 為空（reasoning model
 * 把所有 tokens 用在思考），改從 `reasoning` 內容偵測關鍵字。
 *
 * Reasoning 模型常見的思考文字（範例）：
 *   "The user says 'hello'. The intent is simple_chat. So output ..."
 * 只要文字裡明確出現 simple_chat / complex_task 字串就足以判定。
 */
function parseClassifierResponse(content: string, reasoning: string): { intent: Intent; reason: string } {
  // 1. Try JSON parse on content first.
  if (content.trim()) {
    try {
      return parseClassifierJson(content);
    } catch {
      /* fall through to reasoning */
    }
  }

  // 2. Fallback: keyword search in reasoning.
  if (reasoning) {
    // Try JSON-like pattern in reasoning too.
    const jsonMatch = reasoning.match(/\{[^{}]*"intent"[^{}]*\}/);
    if (jsonMatch) {
      try {
        return parseClassifierJson(jsonMatch[0]);
      } catch {
        /* keep scanning */
      }
    }
    // Simple keyword check — case insensitive.
    const lower = reasoning.toLowerCase();
    const complexHit = lower.includes('complex_task') || lower.includes('"complex_task"');
    const simpleHit = lower.includes('simple_chat') || lower.includes('"simple_chat"');
    if (complexHit && !simpleHit) return { intent: 'complex_task', reason: 'from_reasoning' };
    if (simpleHit && !complexHit) return { intent: 'simple_chat', reason: 'from_reasoning' };
    // Both or neither mentioned → ambiguous, treat as complex (safer).
  }

  // 3. Nothing usable. Safer default.
  throw new Error('No parseable intent in classifier output');
}

function parseClassifierJson(text: string): { intent: Intent; reason: string } {
  // Try direct JSON parse first; if model wrapped it in ```json ... ```, peel it.
  const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();

  // gpt-oss harmony format may include <|channel|>...<|message|>...
  const harmonyMatch = cleaned.match(/<\|message\|>([\s\S]*?)(?:<\||$)/);
  const candidate = harmonyMatch ? harmonyMatch[1].trim() : cleaned;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    // Last resort: extract the first {...} substring.
    const m = candidate.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('No JSON object in classifier response');
    parsed = JSON.parse(m[0]);
  }

  const obj = parsed as { intent?: string; reason?: string };
  const intent: Intent = obj.intent === 'simple_chat' ? 'simple_chat' : 'complex_task';
  return { intent, reason: typeof obj.reason === 'string' ? obj.reason : '' };
}

/* ============================================================
   Simple-chat reply via local LLM (streaming)
   ============================================================ */

const SIMPLE_REPLY_SYSTEM = `你是 AI Agents Office 的對話助手。使用者問了一個簡單的問題或閒聊。
請直接、清楚、簡短地回答。

行為準則：
- 回答精簡，不要客套廢話
- 預設使用繁體中文回答（除非使用者用其他語言）
- 不要假裝可以打開檔案、執行程式或產生 PPT/Word/Excel/PDF — 這些功能由其他 agent 負責，本次互動只負責對話
- 若使用者要求的事情你判斷其實需要文件生成或工具，回覆「這個我請工具幫你做」並建議他重新表述（不要自己編造檔案）`;

export interface SimpleReplyOptions {
  message: string;
  category: string;
  recentMessages?: Array<{ role: string; content: string }>;
  /** 串流 callback：每段 delta 內容傳出。 */
  onDelta: (delta: string) => void;
  /** Caller's abort signal — caller 端結束時要中斷上游。 */
  signal?: AbortSignal;
}

export interface SimpleReplyResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

/**
 * 用地端 LLM 串流回覆簡單對話。
 * 策略：harmony 格式內部頻道（channel: analysis 等）會被過濾掉，只串 final 內容。
 */
export async function streamSimpleReply(opts: SimpleReplyOptions): Promise<SimpleReplyResult> {
  const messages: ChatMessage[] = [{ role: 'system', content: SIMPLE_REPLY_SYSTEM }];

  // Inject up to last 6 messages of context so multi-turn chat works.
  if (opts.recentMessages && opts.recentMessages.length > 0) {
    for (const m of opts.recentMessages.slice(-6)) {
      if (m.role === 'user' || m.role === 'assistant') {
        messages.push({ role: m.role, content: m.content });
      }
    }
  }
  messages.push({ role: 'user', content: opts.message });

  // Pick the best provider for this reply (rules in pickProviderAuto):
  // short greetings → default (gpt-oss, fast streaming);
  // reasoning-ish input → thinking provider (deepseek, single non-stream chunk).
  const chosenProviderName = pickProviderAuto({ messages });
  const chosenModel = config.localLlm.providers[chosenProviderName]?.model
    ?? config.localLlm.defaultModel;

  let collected = '';
  const harmonyFilter = createHarmonyFilter();

  for await (const rawDelta of localLlmStream({
    provider: chosenProviderName,
    messages,
    temperature: 0.4,
    maxTokens: 1500,
    signal: opts.signal,
  })) {
    const visible = harmonyFilter(rawDelta);
    if (visible) {
      collected += visible;
      opts.onDelta(visible);
    }
  }

  // Streaming endpoint doesn't return usage; we can't easily count without a follow-up
  // call, so we report 0/0. Caller may estimate from text length if needed.
  return {
    text: collected,
    inputTokens: 0,
    outputTokens: 0,
    model: chosenModel,
  };
}

/**
 * gpt-oss harmony format 流式過濾器：
 *   <|channel|>analysis<|message|>...thinking...
 *   <|channel|>final<|message|>...response...
 * 只把 channel=final 的內容透出去；其它 channel 全部丟掉。
 *
 * 因為 delta 邊界可能切斷 marker，filter 持有 buffer 直到 marker 完整。
 */
function createHarmonyFilter(): (delta: string) => string {
  let buffer = '';
  let mode: 'unknown' | 'final' | 'analysis' = 'unknown';

  return (delta: string): string => {
    buffer += delta;
    let out = '';

    while (true) {
      if (mode === 'unknown' || mode === 'analysis') {
        // Look for next channel header.
        const channelMatch = buffer.match(/<\|channel\|>(\w+)<\|message\|>/);
        if (!channelMatch) {
          // No marker yet. If the model never emits harmony, treat everything as final.
          // Heuristic: if the buffer looks like raw text (no `<|`) and we're in unknown mode,
          // flush it through as final.
          if (mode === 'unknown' && !buffer.includes('<|')) {
            out += buffer;
            buffer = '';
            mode = 'final';
          }
          break;
        }
        // Discard whatever was before the marker (it was either nothing or analysis output).
        const channel = channelMatch[1];
        buffer = buffer.slice(channelMatch.index! + channelMatch[0].length);
        mode = channel === 'final' ? 'final' : 'analysis';
      } else {
        // mode === 'final'
        const nextChannelIdx = buffer.indexOf('<|channel|>');
        const nextEndIdx = buffer.indexOf('<|end|>');
        // Stop emitting at the first boundary marker we encounter.
        const stopIdx = [nextChannelIdx, nextEndIdx].filter(i => i >= 0).sort((a, b) => a - b)[0];
        if (stopIdx === undefined) {
          // No boundary in buffer — emit everything except potential partial marker tail.
          // Conservative: hold back last 12 chars in case '<|channel|' is partial.
          if (buffer.length > 12) {
            out += buffer.slice(0, -12);
            buffer = buffer.slice(-12);
          }
          break;
        }
        out += buffer.slice(0, stopIdx);
        buffer = buffer.slice(stopIdx);
        mode = 'unknown';
      }
    }

    return out;
  };
}
