/**
 * Rolling HTTP request metrics feeding the admin pressure indicator.
 *
 * These exist because event-loop delay turned out to be the WRONG pressure signal
 * for this workload. Under a real 80-concurrency read load — enough to push p50
 * response times to ~150ms and flatten throughput at its ceiling — loop delay sat
 * at 0.7ms and the indicator still read "系統順暢". The work here is I/O bound, so
 * the loop is never blocked; requests queue on the database, not in libuv. Loop
 * delay still earns its place for genuine CPU stalls, but it cannot be the only
 * server-side signal.
 *
 * What users actually feel is how long a request takes and how many are in flight,
 * so that is what we measure.
 */
import { Request, Response, NextFunction } from 'express';

// Ring buffer of recent request durations, each with the wall time it finished.
//
// The timestamps are not optional bookkeeping: a size-only ring goes stale. After
// a load spike ends, the buffer still holds 256 slow samples, so the indicator
// kept reporting elevated pressure with zero requests in flight and only decayed
// once 256 fresh requests overwrote it — which on a quiet server never happens.
const WINDOW = 256;
const MAX_AGE_MS = 60_000;
const durations = new Float64Array(WINDOW);
const finishedAt = new Float64Array(WINDOW);
let cursor = 0;
let filled = 0;

let inFlight = 0;
let peakInFlight = 0;

/** Mount BEFORE the routes so every request is counted, including 404s. */
export function requestMetricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  // The pressure endpoint itself is polled on a timer by every open admin tab;
  // counting it would let the monitoring inflate the number it reports.
  if (req.path === '/api/admin/system/pressure') { next(); return; }

  const start = performance.now();
  inFlight++;
  if (inFlight > peakInFlight) peakInFlight = inFlight;

  // 'finish' misses aborted connections, which are exactly the ones that pile up
  // under load — 'close' always fires, so the counter can never drift upward.
  res.on('close', () => {
    inFlight--;
    const now = performance.now();
    durations[cursor] = now - start;
    finishedAt[cursor] = now;
    cursor = (cursor + 1) % WINDOW;
    if (filled < WINDOW) filled++;
  });

  next();
}

/** Durations from the last MAX_AGE_MS only — anything older no longer describes "now". */
function recentDurations(): number[] {
  const cutoff = performance.now() - MAX_AGE_MS;
  const out: number[] = [];
  for (let i = 0; i < filled; i++) {
    if (finishedAt[i] >= cutoff) out.push(durations[i]);
  }
  return out.sort((a, b) => a - b);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[idx] * 10) / 10;
}

export interface RequestMetrics {
  inFlight: number;
  peakInFlight: number;
  p50Ms: number;
  p95Ms: number;
  sampled: number;
}

export function getRequestMetrics(): RequestMetrics {
  const recent = recentDurations();
  const m = {
    inFlight,
    peakInFlight,
    p50Ms: percentile(recent, 50),
    p95Ms: percentile(recent, 95),
    sampled: recent.length,
  };
  peakInFlight = inFlight;   // peak is "since last read", so it reflects the poll interval
  return m;
}
