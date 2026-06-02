/**
 * Per-LINE-user message rate limit.
 *
 * In-memory token bucket keyed by LINE user ID. Fine for a single Express
 * process; Phase B will swap this for a Redis-backed implementation when we
 * scale workers. The configured ceiling defaults to 10 msg/min and is read
 * from LINE_MAX_MSG_PER_MIN.
 */

import { getLineMaxMsgPerMin } from '../lineSettings.js';

interface Bucket {
  count: number;
  windowStartMs: number;
}

const buckets = new Map<string, Bucket>();
const WINDOW_MS = 60_000;

/**
 * Returns true when the message is allowed and bumps the counter; false when
 * the user has exceeded the limit in the current 60-second window.
 */
export function checkLineRateLimit(lineUserId: string): boolean {
  const now = Date.now();
  const max = getLineMaxMsgPerMin();
  const existing = buckets.get(lineUserId);

  if (!existing || now - existing.windowStartMs >= WINDOW_MS) {
    buckets.set(lineUserId, { count: 1, windowStartMs: now });
    return true;
  }

  if (existing.count >= max) return false;
  existing.count += 1;
  return true;
}

/**
 * Periodic cleanup so the Map doesn't grow unbounded on a public bot.
 * Called by index.ts in setInterval.
 */
export function pruneExpiredBuckets(): void {
  const cutoff = Date.now() - WINDOW_MS * 2;
  for (const [key, bucket] of buckets) {
    if (bucket.windowStartMs < cutoff) buckets.delete(key);
  }
}
