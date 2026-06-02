/**
 * BullMQ wiring for the LINE worker pool.
 *
 * One Redis instance backs everything (queue + Phase B's rate limit later).
 * The Worker shares the host process with Express — appropriate for the
 * 50–1000 concurrent-user range. When traffic justifies it, the Worker is
 * factored out into its own systemd unit with no code changes; only the
 * caller of `startLineWorker` moves to a separate entrypoint.
 */

import { Queue, Worker, JobsOptions, QueueEvents, type ConnectionOptions } from 'bullmq';
import { config } from '../config.js';

/**
 * Job payload mirrors the LINE webhook event shape — keeping it small so
 * Redis stays light. The handler re-fetches profile/state on demand instead
 * of stuffing extra fields in.
 */
export interface LineMessageJob {
  type: 'message' | 'postback' | 'follow';
  messageType?: 'text' | 'image' | 'file' | 'audio' | 'video';
  text?: string;
  /** LINE message id — needed to download content via the Content API. */
  messageId?: string;
  /** Original filename (file events only). */
  filename?: string;
  lineUserId: string;
  replyToken?: string;
  postbackData?: string;
  receivedAt: number;
}

let lineQueue: Queue<LineMessageJob> | null = null;
let lineQueueEvents: QueueEvents | null = null;
let lineWorker: Worker<LineMessageJob> | null = null;

let embedQueue: Queue<EmbedJob> | null = null;
let embedWorker: Worker<EmbedJob> | null = null;

// BullMQ refuses queue names containing ':' (it uses that as a key separator).
const QUEUE_NAME = 'line-message';
const EMBED_QUEUE_NAME = 'line-embed';

/**
 * Personal-RAG indexing job. The file is on disk at `storagePath`
 * (relative to workspaceRoot), so the worker reads from there — no binary
 * blobs travel through Redis.
 */
export interface EmbedJob {
  userId: string;
  /** Present for LINE uploads (status pushed back to chat); absent for web uploads. */
  lineUserId?: string;
  filename: string;
  fileType: string;
  storagePath: string;
  sourceUploadId?: string;
}

// BullMQ owns its own ioredis instance per Queue/Worker — that side-steps the
// dual-version trap pnpm gets into when a top-level ioredis dep mismatches
// the one bullmq vendors. We just pass the URL.
function connectionOptions(): ConnectionOptions {
  const url = new URL(config.redisUrl);
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    password: url.password || undefined,
    db: url.pathname && url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0,
    maxRetriesPerRequest: null,
  };
}

export function getLineQueue(): Queue<LineMessageJob> {
  if (!lineQueue) {
    lineQueue = new Queue<LineMessageJob>(QUEUE_NAME, { connection: connectionOptions() });
  }
  return lineQueue;
}

/**
 * Default job options — fail fast (one retry) so a permanently broken event
 * doesn't park forever. LINE itself retries delivery, so we don't need to.
 */
export function defaultJobOptions(): JobsOptions {
  return {
    attempts: 2,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { age: 3600, count: 1000 }, // 1h or 1k completed jobs
    removeOnFail: { age: 24 * 3600, count: 500 }, // 24h or 500 failed jobs
  };
}

/**
 * Boot the LINE worker. Called from `index.ts` after the DB is ready.
 *
 * processor is injected so the worker file stays decoupled from the
 * orchestrator chain — easier to test and to relocate later.
 */
export function startLineWorker(processor: (job: LineMessageJob) => Promise<void>): Worker<LineMessageJob> {
  if (lineWorker) return lineWorker;

  // Worker concurrency = max parallel Claude CLI orchestrator runs.
  // Each orchestrator spawns one Claude process; six processes peak around
  // 600 MB which fits in our 1.5 GB envelope.
  lineWorker = new Worker<LineMessageJob>(
    QUEUE_NAME,
    async job => {
      await processor(job.data);
    },
    {
      connection: connectionOptions(),
      concurrency: 6,
      // BullMQ recommends explicit `lockDuration` for long-running jobs so
      // the lock isn't lost while Claude works for several minutes.
      lockDuration: 5 * 60 * 1000,    // 5 min lock, renewed by stalledInterval
      stalledInterval: 30 * 1000,
      maxStalledCount: 1,
    },
  );

  lineWorker.on('failed', (job, err) => {
    console.error(`[Queue] line:message job ${job?.id} failed:`, err.message);
  });
  lineWorker.on('error', err => {
    console.error('[Queue] Worker error:', err.message);
  });

  // QueueEvents provides reliable completion/failure notifications across
  // processes — primed here so future code can wait on a specific job.
  lineQueueEvents = new QueueEvents(QUEUE_NAME, { connection: connectionOptions() });
  lineQueueEvents.on('error', err => {
    console.error('[Queue] QueueEvents error:', err.message);
  });

  return lineWorker;
}

/* ============================================================
   Embedding queue (personal RAG indexing)
   ============================================================ */

export function getEmbedQueue(): Queue<EmbedJob> {
  if (!embedQueue) {
    embedQueue = new Queue<EmbedJob>(EMBED_QUEUE_NAME, { connection: connectionOptions() });
  }
  return embedQueue;
}

/**
 * Indexing concurrency is decoupled from the chat worker — embedding calls
 * are I/O-bound (single HTTP roundtrip per batch), so we can run more of
 * them in parallel without competing for Claude CLI memory. Cap at 3 so we
 * stay friendly to the upstream ollama gateway.
 */
export function startEmbedWorker(processor: (job: EmbedJob) => Promise<void>): Worker<EmbedJob> {
  if (embedWorker) return embedWorker;
  embedWorker = new Worker<EmbedJob>(
    EMBED_QUEUE_NAME,
    async job => { await processor(job.data); },
    {
      connection: connectionOptions(),
      concurrency: 3,
      lockDuration: 10 * 60 * 1000, // large files can take a while
      stalledInterval: 60 * 1000,
      maxStalledCount: 1,
    },
  );
  embedWorker.on('failed', (job, err) => {
    console.error(`[Queue] line-embed job ${job?.id} failed:`, err.message);
  });
  embedWorker.on('error', err => {
    console.error('[Queue] Embed worker error:', err.message);
  });
  return embedWorker;
}

/**
 * Graceful shutdown — drains in-flight jobs (up to a few minutes) then
 * closes Redis connections. Called from index.ts on SIGTERM/SIGINT.
 */
export async function stopQueueSystem(): Promise<void> {
  const work: Promise<unknown>[] = [];
  if (lineWorker) work.push(lineWorker.close());
  if (lineQueueEvents) work.push(lineQueueEvents.close());
  if (lineQueue) work.push(lineQueue.close());
  if (embedWorker) work.push(embedWorker.close());
  if (embedQueue) work.push(embedQueue.close());
  await Promise.allSettled(work);
  lineWorker = null;
  lineQueueEvents = null;
  lineQueue = null;
  embedWorker = null;
  embedQueue = null;
}
