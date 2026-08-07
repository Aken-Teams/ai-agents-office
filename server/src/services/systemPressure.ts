/**
 * System pressure snapshot for the admin indicator in the top bar.
 *
 * What "pressure" means here comes straight out of the load testing: this server
 * is a SINGLE Node process (no cluster), so its two real ceilings are
 *
 *   1. the AI concurrency gates — every Claude CLI is a ~300MB process, and the
 *      gates are what stop them piling up. When a gate is full, users wait.
 *   2. the event loop — read throughput flattened at ~660 req/s regardless of
 *      added concurrency, because one loop serialises every request. Loop delay
 *      is therefore the earliest honest signal that the box is straining.
 *
 * Heap is deliberately a third-tier signal: sustained load moved RSS between
 * 163MB and 343MB and it always came back, so memory alone rarely predicts
 * trouble on this workload — a full AI gate does.
 */
import { monitorEventLoopDelay } from 'perf_hooks';
import v8 from 'v8';
import { getAiSlotStats } from './aiConcurrency.js';
import { getEmailSlotStats } from './emailAgentConcurrency.js';
import { getAuxAiSlotStats } from './auxAiConcurrency.js';
import { getRequestMetrics } from './requestMetrics.js';

// Histogram runs for the process lifetime; it is a libuv-level counter, so this
// costs far less than polling with a timer and cannot itself add loop delay.
//
// Resolution is deliberately coarse. Measured on this box, a FINER resolution
// reports LESS delay under load, not more: with resolution 1ms a 50ms block
// queues ~50 samples that all fire together — the first is 50ms late and the
// rest ~0ms — so the mean collapses (10.8ms, p50 1.1ms) even though the loop was
// blocked 90% of the time. At 20ms only a couple of samples land per block, so
// the mean tracks the real stall (55ms raw for the same load).
const LOOP_RESOLUTION_MS = 20;
const loopDelay = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
loopDelay.enable();

// Reset the histogram each time we read it so the figure reflects RIGHT NOW
// rather than a lifetime average that never recovers after one bad minute.
function readLoopDelayMs(): number {
  const meanMs = loopDelay.mean / 1e6;          // ns → ms
  loopDelay.reset();
  if (!Number.isFinite(meanMs)) return 0;
  // The histogram measures the sampling interval INCLUDING the interval itself,
  // so an idle loop reports ≈ resolution (measured 20.2ms at rest). Subtract that
  // floor, or a perfectly healthy server would sit at a permanent 20ms and score
  // 30/100 for nothing.
  const trueLag = Math.max(0, meanMs - LOOP_RESOLUTION_MS);
  return Math.round(trueLag * 10) / 10;
}

export type PressureLevel = 'low' | 'medium' | 'high';

export interface SlotStats { active: number; max: number; queued: number }

export interface SystemPressure {
  level: PressureLevel;
  score: number;                 // 0-100, the worst contributing signal
  reason: string;                // which signal set the level (zh-TW, for the UI)
  gates: {
    document: SlotStats;         // heavy generation — AI_MAX_CONCURRENT
    email: SlotStats;            // email agent
    background: SlotStats;       // auxiliary spawns (memory/fidelity/report)
  };
  memory: { rssMb: number; heapUsedMb: number; heapLimitMb: number; heapPct: number };
  eventLoopLagMs: number;
  requests: { inFlight: number; peakInFlight: number; p50Ms: number; p95Ms: number };
  uptimeSec: number;
}

/**
 * Response time is the server-side signal that actually tracks this workload —
 * see requestMetrics.ts for why loop delay alone missed real load. Thresholds
 * come from the load tests: idle reads land under 20ms, a healthy box at high
 * concurrency sits near 150ms, and the worst endpoint pre-optimisation peaked
 * around 500ms, which is where users start calling it broken.
 */
function latencyScore(p95: number): number {
  if (p95 <= 100) return (p95 / 100) * 30;
  if (p95 <= 500) return 30 + ((p95 - 100) / 400) * 50;
  return Math.min(100, 80 + ((p95 - 500) / 500) * 20);
}

/**
 * A gate's pressure counts WAITERS, not just occupancy: 4/4 with nobody queued is
 * fully utilised but nobody is suffering, while 4/4 with 8 queued is a backlog.
 * Occupancy alone therefore tops out at 80 and only a queue pushes it past that.
 */
function gateScore(s: SlotStats): number {
  const occupancy = s.max > 0 ? (s.active / s.max) * 80 : 0;
  const backlog = s.queued > 0 ? Math.min(20 + (s.queued - 1) * 5, 20) : 0;
  return Math.min(100, occupancy + backlog);
}

function lagScore(ms: number): number {
  if (ms <= 20) return (ms / 20) * 30;            // healthy
  if (ms <= 100) return 30 + ((ms - 20) / 80) * 40;
  return Math.min(100, 70 + ((ms - 100) / 200) * 30);
}

export function getSystemPressure(): SystemPressure {
  const document = getAiSlotStats();
  const email = getEmailSlotStats();
  const background = getAuxAiSlotStats();

  const mem = process.memoryUsage();
  const heapLimit = v8.getHeapStatistics().heap_size_limit;
  const heapPct = Math.round((mem.heapUsed / heapLimit) * 100);
  const lag = readLoopDelayMs();

  const req = getRequestMetrics();

  const signals: Array<{ score: number; reason: string }> = [
    { score: gateScore(document),   reason: document.queued > 0 ? `文件生成排隊 ${document.queued} 件` : '文件生成忙碌' },
    { score: gateScore(email),      reason: email.queued > 0 ? `信件助手排隊 ${email.queued} 件` : '信件助手忙碌' },
    { score: gateScore(background), reason: background.queued > 0 ? `背景作業排隊 ${background.queued} 件` : '背景作業忙碌' },
    { score: latencyScore(req.p95Ms), reason: `回應延遲 ${Math.round(req.p95Ms)}ms` },
    { score: lagScore(lag),         reason: `事件循環延遲 ${lag}ms` },
    { score: heapPct,               reason: `記憶體使用 ${heapPct}%` },
  ];

  // The worst signal defines the level — averaging would let a saturated AI gate
  // hide behind four idle metrics, which is exactly the case worth surfacing.
  const worst = signals.reduce((a, b) => (b.score > a.score ? b : a));
  const score = Math.round(worst.score);
  const level: PressureLevel = score >= 80 ? 'high' : score >= 40 ? 'medium' : 'low';

  return {
    level,
    score,
    reason: level === 'low' ? '系統順暢' : worst.reason,
    gates: { document, email, background },
    memory: {
      rssMb: Math.round(mem.rss / 1048576),
      heapUsedMb: Math.round(mem.heapUsed / 1048576),
      heapLimitMb: Math.round(heapLimit / 1048576),
      heapPct,
    },
    eventLoopLagMs: lag,
    requests: { inFlight: req.inFlight, peakInFlight: req.peakInFlight, p50Ms: req.p50Ms, p95Ms: req.p95Ms },
    uptimeSec: Math.round(process.uptime()),
  };
}
