/**
 * Global concurrency cap for the HEAVY AI spawns — team member analyses, the
 * coordinator synthesis, formal-report writing, and document generation.
 *
 * Unlike the email agent (light Haiku batches, its own cap of 6), these each
 * launch a full Claude CLI (often a large model) and — for docs — a python
 * subprocess too. Without a global limit, the scheduler could fan out up to
 * 10 schedules × 5 members = 50 processes at once and exhaust the host's RAM.
 *
 * Every heavy team/doc spawn must `acquireAiSlot()` first and call the returned
 * release() when the process finishes (in a finally / on done|error|timeout).
 * Excess requests queue FIFO. Tune with env AI_MAX_CONCURRENT (default 4).
 */

const MAX_CONCURRENT = Math.max(1, parseInt(process.env.AI_MAX_CONCURRENT || '4', 10) || 4);

let active = 0;
const waiters: Array<() => void> = [];

export async function acquireAiSlot(): Promise<() => void> {
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
export function getAiSlotStats(): { active: number; max: number; queued: number } {
  return { active, max: MAX_CONCURRENT, queued: waiters.length };
}
