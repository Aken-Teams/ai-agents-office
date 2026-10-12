/**
 * localAgent — run a turn on a self-hosted model instead of the Claude CLI.
 *
 * ── Why this exists ──
 * 「如果客戶想省錢，他會用地端模型」. Until now the model picker could only offer
 * Claude models, because the chosen id went straight to `--model` on the Claude
 * CLI: picking `gpt-oss:120b` would have produced a CLI error about an unknown
 * model, three layers away from anything the user could act on. Offering an
 * option the backend cannot execute is worse than not offering it.
 *
 * So this is the second execution path. It speaks the OpenAI chat-completions
 * shape — which is what Ollama, llama.cpp and MLX all serve — and runs the tool
 * loop itself.
 *
 * ── What it deliberately reuses ──
 * Everything downstream of the model. Tools still execute through
 * `callWorkbookTool`, which means the confirmation gate, the undo snapshot and
 * the audit row all behave exactly as they do on the Claude path. A local run
 * that skipped the gate would be a different product wearing the same UI.
 *
 * ── What it cannot do ──
 * No resume. The Claude CLI keeps a session on disk and can pick a conversation
 * back up; here the history lives for one turn and is gone. A local run always
 * starts from the system prompt plus this message.
 */
import { EventEmitter } from 'events';
import { callWorkbookTool } from './excelBridge.js';

export interface LocalModel {
  id: string;
  /** The id the endpoint knows it by, if it differs from the one in the picker. */
  remote: string;
  label: string;
}

/**
 * The models this build can run locally.
 *
 * Measured rather than guessed: both of these drove the real tool specs through
 * a four-task and a three-scenario harness without inventing an argument or
 * writing before reading. The ones that failed those are deliberately not here
 * — a picker entry is a promise that the thing works.
 */
export const LOCAL_MODELS: LocalModel[] = [
  { id: 'local-gpt-oss-120b', remote: 'gpt-oss:120b', label: 'gpt-oss 120B（地端）' },
  { id: 'local-qwen3-27b', remote: 'mlx-community/Qwen3.8-27B-4bit', label: 'Qwen3.8 27B（地端）' },
];

export const isLocalModel = (id: string): boolean => LOCAL_MODELS.some((m) => m.id === id);
const remoteOf = (id: string): string =>
  (LOCAL_MODELS.find((m) => m.id === id)?.remote) || id;

interface SSEEvent { type: string; data?: unknown }
interface AnthropicTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** The add-in's tool specs are Anthropic-shaped; these endpoints want OpenAI's. */
const toOpenAI = (t: AnthropicTool) => ({
  type: 'function' as const,
  function: { name: t.name, description: t.description, parameters: t.inputSchema },
});

/**
 * 把模型多跳脫一層的 `\n` 還原成真正的換行。
 *
 * ── 看到的畫面 ──
 * gpt-oss 插進文件的段落長這樣：
 *
 *   `\n1. 目標與背景\n 本文件說明一份個人問卷系統的產品需求…`
 *
 * 整份 PRD 擠成一段，中間散落著字面上的反斜線 n。原因是模型產生的 JSON 裡寫的
 * 是 `"\\n"`——跳脫了兩層，所以 `JSON.parse` 解出來是「反斜線加上 n」這兩個字元，
 * 而不是換行。增益集的 `asParagraphs` 是用 /\r?\n/ 切的，當然切不到。
 *
 * ── 為什麼在這裡修，而且只在這裡 ──
 * 這是這個端點上的模型才有的毛病，Claude 那條路沒有。修在共用的地方會動到所有
 * 模型，而「文字裡真的要有一個反斜線 n」雖然罕見，卻是合法的。
 *
 * 保守的條件：整個字串裡**一個真的換行都沒有**的時候才換。模型在同一段字裡混用
 * 兩種寫法的話，代表那個 `\n` 是它刻意要的。
 */
function unescapeNewlines(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.includes('\n') || !/\\n/.test(value)) return value;
    return value.replace(/\\r\\n|\\n/g, '\n').replace(/\\t/g, '\t');
  }
  if (Array.isArray(value)) return value.map(unescapeNewlines);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = unescapeNewlines(v);
    }
    return out;
  }
  return value;
}

interface Msg {
  role: string;
  content?: string | null;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export interface LocalRunOptions {
  model: string;
  prompt: string;
  systemPrompt: string;
  tools: AnthropicTool[];
  /** The bridge token — tools execute in the pane, exactly as on the Claude path. */
  bridgeToken: string;
  maxTurns?: number;
  timeoutMs?: number;
}

/**
 * Run one turn and stream it, with the same event shapes the route already
 * handles: `text`, `tool_activity`, `usage`, `done`, `error`.
 */
export function runLocalAgent(opts: LocalRunOptions): { emitter: EventEmitter; abort: () => void } {
  const emitter = new EventEmitter();
  const controller = new AbortController();
  const base = String(process.env.LLM_BASE_URL || '').replace(/\/+$/, '');
  const key = String(process.env.LLM_API_KEY || '');
  const maxTurns = opts.maxTurns ?? 24;
  const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60 * 1000);

  void (async () => {
    let inTok = 0;
    let outTok = 0;
    try {
      if (!base) throw new Error('伺服器沒有設定 LLM_BASE_URL，無法使用地端模型。');

      const tools = opts.tools.map(toOpenAI);
      const messages: Msg[] = [
        { role: 'system', content: opts.systemPrompt },
        { role: 'user', content: opts.prompt },
      ];

      for (let turn = 0; turn < maxTurns; turn += 1) {
        if (Date.now() > deadline) throw new Error('這一輪超過時間上限了。');

        const res = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model: remoteOf(opts.model),
            messages,
            tools,
            tool_choice: 'auto',
            temperature: 0,
            max_tokens: 4000,
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`地端模型回了 HTTP ${res.status}。${body.slice(0, 200)}`);
        }
        const json = await res.json() as {
          choices?: Array<{ message?: Msg }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        inTok += json.usage?.prompt_tokens || 0;
        outTok += json.usage?.completion_tokens || 0;

        const msg = json.choices?.[0]?.message;
        if (!msg) throw new Error('地端模型沒有回覆內容。');
        messages.push(msg);

        if (msg.content) emitter.emit('event', { type: 'text', data: msg.content } satisfies SSEEvent);

        const calls = msg.tool_calls || [];
        if (!calls.length) break;

        for (const call of calls) {
          const name = call.function?.name || '';
          emitter.emit('event', {
            type: 'tool_activity',
            data: { tool: name, id: call.id, status: 'running' },
          } satisfies SSEEvent);

          let args: Record<string, unknown> = {};
          let parseFailed = '';
          try {
            args = unescapeNewlines(
              JSON.parse(call.function?.arguments || '{}'),
            ) as Record<string, unknown>;
          } catch {
            /**
             * Malformed JSON is told to the model, not thrown.
             *
             * A smaller model emits a truncated argument object often enough
             * that killing the run over it would make this path unusable — and
             * the model can usually fix it when it is shown what arrived.
             */
            parseFailed = '參數不是合法的 JSON，請重新產生這個工具呼叫。';
          }

          const result = parseFailed
            ? { ok: false, error: parseFailed }
            : await callWorkbookTool(opts.bridgeToken, name, args);

          emitter.emit('event', {
            type: 'tool_activity',
            data: { tool: '_mark_completed', status: 'completed' },
          } satisfies SSEEvent);

          const text = result.ok === false
            ? `錯誤：${String((result as { error?: string }).error || '工具執行失敗')}`
            : String((result as { content?: string }).content ?? '完成。');
          messages.push({ role: 'tool', tool_call_id: call.id, content: text.slice(0, 20_000) });
        }
      }

      emitter.emit('event', {
        type: 'usage',
        data: { inputTokens: inTok, outputTokens: outTok, model: remoteOf(opts.model) },
      } satisfies SSEEvent);
      emitter.emit('event', { type: 'done' } satisfies SSEEvent);
    } catch (e) {
      const why = (e as Error).name === 'AbortError' ? '已中止。' : (e as Error).message;
      emitter.emit('event', { type: 'error', data: why } satisfies SSEEvent);
      emitter.emit('event', { type: 'done' } satisfies SSEEvent);
    }
  })();

  return { emitter, abort: () => controller.abort() };
}
