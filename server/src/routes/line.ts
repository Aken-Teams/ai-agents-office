/**
 * LINE webhook endpoint and helper routes.
 *
 * Mounted at `/webhook` so the public URL is
 * `https://agents.theaken.com/webhook/line` (Next.js proxies /webhook/* to
 * Express). The webhook handler must respond to LINE within ~3 seconds, so
 * processing is dispatched via `setImmediate` after sending the 200.
 */

import { Router, Request, Response } from 'express';
import { dbRun } from '../db.js';
import { config } from '../config.js';
import { verifyLineSignature } from '../services/line/signature.js';
import { getLineQueue, defaultJobOptions, type LineMessageJob } from '../services/queue.js';

const router = Router();

interface LineWebhookEvent {
  type: string;
  webhookEventId?: string;
  source?: { type?: string; userId?: string };
  message?: { type?: string; id?: string; text?: string; fileName?: string };
  replyToken?: string;
  postback?: { data?: string };
}

interface LineWebhookBody {
  destination?: string;
  events?: LineWebhookEvent[];
}

router.post('/line', async (req: Request, res: Response) => {
  // Master switch — LINE Bot disabled in env returns 404 so the URL looks
  // dead to scanners but doesn't expose any error detail.
  if (!config.line.enabled) {
    res.status(404).end();
    return;
  }
  // LINE is enabled but Redis (the job queue) is off — can't enqueue work.
  if (!config.redisEnabled) {
    res.status(503).end();
    return;
  }

  // Signature verification on the raw bytes we captured upstream.
  const signature = req.header('X-Line-Signature');
  if (!verifyLineSignature(req.rawBody, signature)) {
    res.status(401).end();
    return;
  }

  let body: LineWebhookBody;
  try {
    body = JSON.parse((req.rawBody ?? Buffer.alloc(0)).toString('utf-8'));
  } catch {
    res.status(400).end();
    return;
  }

  // Ack to LINE before any work — they enforce a ~3s SLA.
  res.status(200).end();

  const events = Array.isArray(body.events) ? body.events : [];
  for (const ev of events) {
    enqueue(ev).catch(err => {
      console.error('[LINE webhook] enqueue failed:', err instanceof Error ? err.stack : err);
    });
  }
});

/**
 * Normalize a LINE webhook event into a small queue payload and hand it off
 * to BullMQ. Dedupes by `webhookEventId` so LINE retries don't double-process.
 */
async function enqueue(ev: LineWebhookEvent): Promise<void> {
  // Only 1-on-1 chats are supported in v1. Group/room events are silently
  // ignored — explicit refusal would spam the chat.
  if (ev.source?.type !== 'user' || !ev.source.userId) return;

  // Dedupe by webhookEventId (LINE retries failed events). Cheap DB primary
  // key conflict — if INSERT IGNORE matches an existing row, skip the job.
  if (ev.webhookEventId) {
    try {
      const result = await dbRun(
        'INSERT IGNORE INTO line_webhook_events (event_id) VALUES (?)',
        ev.webhookEventId,
      ) as { affectedRows?: number };
      if (typeof result?.affectedRows === 'number' && result.affectedRows === 0) {
        return; // already seen
      }
    } catch (err) {
      // Don't let a transient DB error break webhook handling — log and continue.
      console.warn('[LINE webhook] dedupe failed:', err);
    }
  }

  const job = buildJob(ev);
  if (!job) return;

  await getLineQueue().add('process', job, {
    ...defaultJobOptions(),
    // Use the webhook event id as the BullMQ job id so retries of the same
    // event also dedupe at the queue layer.
    jobId: ev.webhookEventId,
  });
}

function buildJob(ev: LineWebhookEvent): LineMessageJob | null {
  const lineUserId = ev.source?.userId;
  if (!lineUserId) return null;

  const replyToken = ev.replyToken;
  const now = Date.now();

  if (ev.type === 'message' && ev.message) {
    const msgType = ev.message.type;
    if (msgType === 'text') {
      const text = (ev.message.text ?? '').trim();
      if (!text) return null;
      return { type: 'message', messageType: 'text', text, lineUserId, replyToken, receivedAt: now };
    }
    if (msgType === 'image' || msgType === 'file' || msgType === 'audio' || msgType === 'video') {
      return {
        type: 'message',
        messageType: msgType,
        messageId: ev.message.id,
        filename: ev.message.fileName,
        lineUserId,
        replyToken,
        receivedAt: now,
      };
    }
    return null;
  }

  if (ev.type === 'postback' && ev.postback) {
    return {
      type: 'postback',
      lineUserId,
      replyToken,
      postbackData: ev.postback.data ?? '',
      receivedAt: now,
    };
  }

  // follow / unfollow / other events — silently ignore for v1.
  return null;
}

export default router;
