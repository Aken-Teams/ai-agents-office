/**
 * Auth-phase concurrency gate for Claude CLI spawns.
 *
 * The account OAuth token lives in a single shared credentials file. When many
 * CLIs spawn at once and the token needs refreshing, they RACE to refresh and
 * rewrite that file — some lose the race and die with exit!=0 and no output
 * ("OAuth token blip"), which used to silently fall back to the paid API (the
 * bill) or fail outright. This gate serialises ONLY the brief startup/auth
 * window: a spawn holds a slot until it produces its first output (auth done,
 * token freshly persisted) or a short timeout, then releases so the next spawn
 * reuses the now-fresh token WITHOUT its own refresh.
 *
 * The multi-minute generation phase still runs fully in parallel — the gate is
 * released the moment the CLI emits anything — so users feel at most a ~1-3s
 * stagger, and only during the rare moments a token refresh is actually in
 * flight (when the token is warm the first event arrives almost instantly and
 * the gate clears with no perceptible wait).
 *
 * Tune with AUTH_SPAWN_CONCURRENCY (default 1 = fully serial auth).
 */
const MAX_AUTH_CONCURRENT = Math.max(1, parseInt(process.env.AUTH_SPAWN_CONCURRENCY || '1', 10) || 1);

let active = 0;
const waiters: Array<() => void> = [];

/**
 * Acquire an auth slot. Resolves with a release() that must be called exactly
 * once when the spawn's startup/auth window is over (first output or timeout).
 */
export function acquireAuthSlot(): Promise<() => void> {
  return new Promise<() => void>(resolve => {
    const grant = () => {
      active++;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        active--;
        const next = waiters.shift();
        if (next) next();
      });
    };
    if (active < MAX_AUTH_CONCURRENT) grant();
    else waiters.push(grant);
  });
}

/** Debug/observability: current auth-gate saturation. */
export function authGateStats(): { active: number; queued: number; max: number } {
  return { active, queued: waiters.length, max: MAX_AUTH_CONCURRENT };
}
