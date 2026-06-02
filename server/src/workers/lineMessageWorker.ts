/**
 * LINE message worker — invoked by BullMQ for every queued LINE event.
 *
 * Bridges the queue's payload back to the existing `processIncomingEvent`
 * handler. Adds a loading-indicator heartbeat so long Claude runs keep the
 * LINE chat showing "typing…" instead of going silent at the 60-second
 * indicator cap.
 */

import { processIncomingEvent, type IncomingEvent } from '../services/line/handler.js';
import { startLoadingIndicator } from '../services/line/client.js';
import type { LineMessageJob } from '../services/queue.js';

const HEARTBEAT_INTERVAL_MS = 50 * 1000; // LINE indicator max is 60s; refresh well before that.

export async function runLineJob(job: LineMessageJob): Promise<void> {
  const event = jobToEvent(job);
  if (!event) return;

  // Loading indicator only makes sense for events that might run the
  // orchestrator. Postbacks resolve fast — skip the heartbeat there.
  const wantsHeartbeat = event.type === 'message' && event.messageType === 'text';
  const heartbeat = wantsHeartbeat ? setInterval(() => {
    startLoadingIndicator(job.lineUserId, 60).catch(() => {});
  }, HEARTBEAT_INTERVAL_MS) : null;
  heartbeat?.unref?.();
  if (wantsHeartbeat) startLoadingIndicator(job.lineUserId, 60).catch(() => {});

  try {
    await processIncomingEvent(event);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

function jobToEvent(job: LineMessageJob): IncomingEvent | null {
  if (job.type === 'message' && job.messageType) {
    if (job.messageType === 'text') {
      return {
        type: 'message',
        messageType: 'text',
        text: job.text ?? '',
        lineUserId: job.lineUserId,
        replyToken: job.replyToken,
      };
    }
    return {
      type: 'message',
      messageType: job.messageType,
      messageId: job.messageId,
      filename: job.filename,
      lineUserId: job.lineUserId,
      replyToken: job.replyToken,
    };
  }

  if (job.type === 'postback') {
    return {
      type: 'postback',
      data: job.postbackData ?? '',
      lineUserId: job.lineUserId,
      replyToken: job.replyToken,
    };
  }

  return null;
}
