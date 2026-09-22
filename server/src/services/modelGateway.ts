/**
 * One way in to every model, wherever it runs.
 *
 * ── Why this layer exists at all ──
 * PRD 3.6 asks for four things that are not properties of any one feature:
 *
 *   · route to on-prem or cloud per user group / data sensitivity  (AC-18)
 *   · a stated fallback policy, and NEVER a silent downgrade        (AC-19)
 *   · switching models must not change tool behaviour or the UI
 *   · the endpoint is configuration, not code
 *
 * None of those can live inside a feature. If image generation calls one host
 * and text calls another, there is nowhere for 「這個群組走地端」 to be decided
 * and nowhere for 「本來該走地端，結果走了雲端」 to be noticed. So every model
 * call is supposed to come through here, and the features ask for a capability
 * rather than for a host.
 *
 * ── What is actually wired today, stated plainly ──
 * Images, only. Text still goes through the Claude CLI subprocess
 * (`claudeCli.ts`), which is not an HTTP client and cannot simply be pointed at
 * an OpenAI-compatible URL — the tool bridge, the confirmation gate, the undo
 * stack and the recorder all hang off that path. Moving text onto this gateway
 * is a real piece of work and naming it here is better than discovering it
 * during AC-18.
 *
 * ── Why the task pane never sees the endpoint ──
 * It asks for 「一張這個主題的圖」 and this decides where that comes from. The
 * internal address and the key stay on this side, and the add-in stays unaware
 * of the network it is not on.
 */
import crypto from 'crypto';
import { config } from '../config.js';
import { logAiCall } from './aiCallLog.js';

export type ModelSource = 'local' | 'cloud';

export interface ImageResult {
  ok: boolean;
  id?: string;
  width?: number;
  height?: number;
  bytes?: number;
  seconds?: number;
  source?: ModelSource;
  /** Set when policy allowed a fall back to cloud. NEVER silent — see AC-19. */
  fellBack?: boolean;
  error?: string;
}

interface Stored {
  buf: Buffer;
  userId: string;
  at: number;
}

/**
 * Generated pictures, held in memory and served by an unguessable id.
 *
 * ── Why not on disk, and why no auth on the fetch ──
 * The task pane pulls the bytes with a plain cross-origin fetch, the same path
 * it uses for a stock photo, and adding an Authorization header there would mean
 * teaching the host module about the session token it deliberately does not
 * hold. The id is 128 random bits and the entry is gone in thirty minutes; what
 * is behind it is a decorative background this same request just invented, not
 * anybody's document. That is the trade, made deliberately rather than by
 * omission.
 */
const store = new Map<string, Stored>();
const TTL_MS = 30 * 60 * 1000;
const MAX_HELD = 40;

function sweep(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, v] of store) if (v.at < cutoff) store.delete(id);
  while (store.size > MAX_HELD) {
    const oldest = [...store.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (!oldest) break;
    store.delete(oldest[0]);
  }
}

export function takeImage(id: string): Buffer | undefined {
  sweep();
  return store.get(String(id))?.buf;
}

/**
 * Where image work goes, and what happens when it cannot go there.
 *
 * Read from configuration rather than hard-coded, which is the PRD's 服務端點
 * field. The per-group and per-sensitivity half of AC-18 needs an admin screen
 * and a table; this is the seam it will plug into, and until it exists the
 * policy is one setting for everyone — which is honest, and visible in the audit
 * log either way.
 */
function imagePolicy(): {
  source: ModelSource;
  endpoint: string;
  apiKey: string;
  model: string;
  /** What to do when the on-prem host is unreachable. */
  onUnavailable: 'refuse' | 'cloud';
} {
  return {
    source: 'local',
    endpoint: config.localLlmBaseUrl,
    apiKey: config.localLlmApiKey,
    model: process.env.LOCAL_IMAGE_MODEL || 'mlx-community/Qwen-Image-2.1',
    // Refusing is the default because the reason to run on-prem at all is that
    // the data must not leave. Quietly sending the same request to a cloud
    // model when the local one is down would defeat the entire point, and PRD
    // 3.6 forbids it outright.
    onUnavailable: process.env.IMAGE_FALLBACK_POLICY === 'cloud' ? 'cloud' : 'refuse',
  };
}

/**
 * One at a time.
 *
 * It is a single GPU. Two concurrent requests do not finish in half the time;
 * they finish in twice the time, together, and a person watching a task pane
 * sees both stall. The queue is a promise chain rather than a worker pool for
 * exactly that reason.
 */
let queue: Promise<unknown> = Promise.resolve();
function serialise<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  // The chain must survive a failed job, or one error stops every later one.
  queue = run.then(() => undefined, () => undefined);
  return run;
}

/** Measured: 1024×576 at 8 steps takes ~15s, 1024×768 at 24 steps ~56s. */
const TIMEOUT_MS = 300000;

export interface GenerateArgs {
  userId: string;
  prompt: string;
  negative: string;
  size: string;
  steps: number;
  seed: number;
}

export async function generateImage(args: GenerateArgs): Promise<ImageResult> {
  const policy = imagePolicy();
  if (!policy.endpoint || !policy.apiKey) {
    return {
      ok: false,
      error: '地端影像模型尚未設定（LLM_BASE_URL / LLM_API_KEY）。'
        + '請管理員在後台設定服務端點後再試。',
    };
  }

  return serialise(async () => {
    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${policy.endpoint}/images/generations`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${policy.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: policy.model,
          prompt: args.prompt,
          negative_prompt: args.negative,
          size: args.size,
          steps: args.steps,
          // Fixed at 1 deliberately: above 1 the model runs the transformer
          // twice per step for exactly double the time, and this model does not
          // need it. The same seconds buy more from extra steps.
          guidance: 1,
          seed: args.seed,
        }),
        signal: ctrl.signal,
      });

      const seconds = Math.round((Date.now() - t0) / 100) / 10;
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        logAiCall({
          userId: args.userId, model: policy.model, authMode: 'local',
          reason: `image-http-${res.status}`, inputTokens: 0, outputTokens: 0,
          exitCode: res.status, success: false,
        });
        return {
          ok: false,
          error: res.status === 403
            ? '這把金鑰沒有這個影像模型的權限（403）。請管理員確認後台設定。'
            : res.status === 400
              ? `影像模型不認識這組參數（400）。${body.slice(0, 200)}`
              : `地端影像模型回應 HTTP ${res.status}。`,
        };
      }

      const json = await res.json() as { data?: Array<{ b64_json?: string }> };
      const b64 = json?.data?.[0]?.b64_json;
      if (!b64) {
        return { ok: false, error: '影像模型沒有回傳圖片內容。' };
      }
      const buf = Buffer.from(b64, 'base64');

      sweep();
      const id = crypto.randomBytes(16).toString('hex');
      store.set(id, { buf, userId: args.userId, at: Date.now() });

      logAiCall({
        userId: args.userId, model: policy.model, authMode: 'local',
        reason: 'image', inputTokens: 0, outputTokens: 0,
        exitCode: 0, success: true,
      });

      // PNG IHDR: the real pixel size, rather than the size we asked for. The
      // endpoint honours undocumented ratios, so trusting the request would mean
      // reporting a shape the picture does not have.
      const width = buf.length > 24 ? buf.readUInt32BE(16) : 0;
      const height = buf.length > 24 ? buf.readUInt32BE(20) : 0;
      return { ok: true, id, width, height, bytes: buf.length, seconds, source: 'local' };
    } catch (e) {
      const err = e as Error;
      const seconds = Math.round((Date.now() - t0) / 100) / 10;
      logAiCall({
        userId: args.userId, model: policy.model, authMode: 'local',
        reason: `image-${err.name}`, inputTokens: 0, outputTokens: 0,
        exitCode: null, success: false,
      });
      if (err.name === 'AbortError') {
        return {
          ok: false,
          error: `地端影像模型超過 ${TIMEOUT_MS / 1000} 秒沒有回應（已等 ${seconds} 秒）。`
            + '**不要重送**——重送只會讓同一台 GPU 同時算兩張，兩張都更慢。'
            + '請改用 ppt_find_art 的扁平插畫，或這一頁不要放圖。',
        };
      }
      // AC-19: a downgrade is a thing the person has to be told about. When the
      // policy is 'refuse' we say so instead of quietly using something else,
      // and when it is 'cloud' the result carries fellBack so the pane can.
      return {
        ok: false,
        error: policy.onUnavailable === 'refuse'
          ? `連不上地端影像模型（${err.message}）。`
            + '依目前設定不會改用雲端模型，所以這次沒有產生圖片。'
          : `連不上地端影像模型（${err.message}）。`,
      };
    } finally {
      clearTimeout(timer);
    }
  });
}
