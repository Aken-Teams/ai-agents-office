/**
 * Concurrency cap for AUXILIARY Claude CLI spawns — the background helpers that
 * run alongside a generation rather than as one: memory/summary extraction,
 * data-fidelity correction, email-agent memory, and the admin security report.
 *
 * These call `spawn()` directly instead of going through `spawnClaude()`, so the
 * global heavy-AI gate in aiConcurrency.ts never saw them. That mattered most for
 * memory extraction, which routes/generate.ts fires and forgets AFTER res.end():
 * every completed generation released an ungated ~300MB CLI, so a burst of N
 * generations could pile up N of them outside the cap of 4. Measured cost is
 * ~300MB per live CLI, scaling linearly with no sharing between processes.
 *
 * This is a SEPARATE semaphore from acquireAiSlot() on purpose:
 *   - Auxiliary work must not consume the slots reserved for user-facing
 *     generations, which is what sharing the main gate would do.
 *   - None of these paths call spawnClaude(), so they never acquire the main
 *     gate. Waiting only ever goes main → aux, never aux → main, so the two
 *     semaphores cannot deadlock against each other.
 *
 * Tune with env AUX_AI_MAX_CONCURRENT (default 3).
 */

const MAX_CONCURRENT = Math.max(1, parseInt(process.env.AUX_AI_MAX_CONCURRENT || '3', 10) || 3);

let active = 0;
const waiters: Array<() => void> = [];

/**
 * Acquire an auxiliary-AI slot. Resolves with a release() that must be called
 * exactly once when the spawned process is gone — including the timeout and
 * spawn-failure paths, or the slot leaks and the cap silently shrinks to zero.
 * The returned release() is idempotent, so callers can wire it to several
 * handlers (exit / error / timeout) without tracking which fired first.
 */
export async function acquireAuxAiSlot(): Promise<() => void> {
  await new Promise<void>(resolve => {
    if (active < MAX_CONCURRENT) {
      active++;
      resolve();
    } else {
      waiters.push(() => { active++; resolve(); });
    }
  });

  let released = false;
  return () => {
    if (released) return;
    released = true;
    active--;
    const next = waiters.shift();
    if (next) next();
  };
}

/** Live occupancy, for the admin system-pressure indicator. */
export function getAuxAiSlotStats(): { active: number; max: number; queued: number } {
  return { active, max: MAX_CONCURRENT, queued: waiters.length };
}
