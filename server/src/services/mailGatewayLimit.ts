/**
 * Global outbound gate + 429 backoff for the PANJIT mail gateway.
 *
 * The mail gateway rate-limits (HTTP 429) under concurrent load — with ~30 users on
 * the email assistant, everyone's poller + on-demand loads can burst against it at
 * once and get throttled (the "spins forever" symptom). This does two things:
 *
 *  ① CONCURRENCY GATE — caps how many gateway requests run AT ONCE across ALL users
 *     (the rest queue). This limits REQUESTS, not USERS: everyone can still use the
 *     assistant; at peak, requests just wait a moment. Tunable via env once IT tells
 *     us the gateway's real limit — no redeploy needed.
 *
 *  ② 429 BACKOFF — on a 429, respect Retry-After (or exponential backoff), pause new
 *     gateway calls collectively for that window, and retry. Most 429s resolve
 *     silently so the user never notices.
 */
// Concurrent IN-FLIGHT gateway requests (NOT users). Steady state rarely reaches
// this — it only bounds bursts (e.g. everyone opening at once). Default 10 gives
// ~30+ users a snappy peak; raise/lower once IT tells us the gateway's real limit.
// (② 429 backoff self-corrects if this is set higher than the gateway tolerates.)
const MAX_CONCURRENT = Math.max(1, parseInt(process.env.MAIL_GATEWAY_CONCURRENCY || '10', 10));

let active = 0;
const waiters: Array<() => void> = [];
let cooldownUntil = 0; // epoch ms — new requests wait until here after a 429

// Counters for the 安全與審計 dashboard — proof the gate is absorbing rate limits.
let totalRequests = 0; // requests sent through the gate
let rateLimited = 0;   // 429 responses received
let recovered = 0;     // requests that hit ≥1 429 but succeeded on retry (user never saw it)
let surfaced = 0;      // requests whose 429 outlived all retries (returned to caller)
let peakQueued = 0;    // largest queue depth seen (burst indicator)

function acquire(): Promise<void> {
  return new Promise((resolve) => {
    if (active < MAX_CONCURRENT) { active++; resolve(); }
    else { waiters.push(() => { active++; resolve(); }); peakQueued = Math.max(peakQueued, waiters.length); }
  });
}
function release(): void {
  active = Math.max(0, active - 1);
  const next = waiters.shift();
  if (next) next();
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch() the mail gateway through the gate, retrying 429s with Retry-After backoff.
 * Pass `timeoutMs` (a fresh AbortSignal is made per attempt so retries aren't aborted
 * by a spent signal). Returns the final Response — including a 429 if retries are
 * exhausted, so the caller can surface a friendly "busy, try later" message.
 */
export async function gatewayFetch(
  url: string,
  init: RequestInit,
  opts: { timeoutMs: number; retries?: number },
): Promise<Response> {
  const retries = opts.retries ?? 3;
  totalRequests++;
  await acquire();
  let hit429 = false;
  try {
    for (let attempt = 0; ; attempt++) {
      const wait = cooldownUntil - Date.now();
      if (wait > 0) await sleep(wait);
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(opts.timeoutMs) });
      // Per the gateway spec: 429 = API-KEY rate limit (單位時間請求數超上限), 503 =
      // mail server busy — BOTH carry Retry-After and the guidance is "依 Retry-After
      // 延後重試,勿立即重打". Everything else (200/4xx/502) is returned to the caller.
      if (res.status !== 429 && res.status !== 503) { if (hit429) recovered++; return res; }
      hit429 = true;
      if (res.status === 429) rateLimited++;
      const ra = parseInt(res.headers.get('retry-after') || '', 10);
      const backoff = (Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(1000 * 2 ** attempt, 8000)) + Math.floor(Math.random() * 300);
      cooldownUntil = Math.max(cooldownUntil, Date.now() + backoff);
      console.warn(`[MailGateway] ${res.status} (attempt ${attempt + 1}/${retries + 1}), Retry-After backoff ${backoff}ms`);
      if (attempt >= retries) { if (res.status === 429) surfaced++; return res; } // give up → caller handles it
      await sleep(backoff);
    }
  } finally {
    release();
  }
}

/** For the 安全與審計 dashboard: live gate pressure + cumulative counters. */
export function mailGatewayStats() {
  return {
    max: MAX_CONCURRENT,
    active,
    queued: waiters.length,
    peakQueued,
    cooldownMs: Math.max(0, cooldownUntil - Date.now()),
    totalRequests,
    rateLimited,
    recovered,
    surfaced,
  };
}
