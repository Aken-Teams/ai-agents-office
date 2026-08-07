/**
 * Global concurrency cap for Email-Agent Claude CLI spawns.
 *
 * Each connected user can fan out several Claude spawns (briefing batches +
 * chat + deep analysis). Without a global limit, N simultaneous users ×
 * per-user parallelism would launch dozens of Claude processes at once —
 * exhausting the account's rate limit and the host's resources.
 *
 * Every email-agent spawn must `acquireEmailSlot()` first and call the returned
 * release() when done (in a finally). Excess requests queue FIFO.
 */

const MAX_CONCURRENT = 6;

let active = 0;
const waiters: Array<() => void> = [];

export async function acquireEmailSlot(): Promise<() => void> {
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
export function getEmailSlotStats(): { active: number; max: number; queued: number } {
  return { active, max: MAX_CONCURRENT, queued: waiters.length };
}
