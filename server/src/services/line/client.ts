/**
 * Thin LINE Messaging API client.
 *
 * No `@line/bot-sdk` dependency — the wire format is small, well-documented,
 * and stable. fetch keeps it transparent and removes a 4 MB dep.
 *
 * Reference: https://developers.line.biz/en/reference/messaging-api/
 */

import { config } from '../../config.js';

const BASE_URL = 'https://api.line.me/v2/bot';

export interface LineTextMessage {
  type: 'text';
  text: string;
}

export interface LineEmojiMessage {
  type: 'text';
  text: string;
  emojis?: Array<{ index: number; productId: string; emojiId: string }>;
}

/**
 * Flex Message — LINE's rich card format. The contents object describes a
 * bubble or carousel; altText is shown in push notifications and on clients
 * that pre-date Flex support.
 */
export interface LineFlexMessage {
  type: 'flex';
  altText: string;
  contents: Record<string, unknown>;
}

/**
 * Image Message — LINE renders a thumbnail inline in the chat; tapping it
 * shows the full-size image. Both URLs must be HTTPS and reachable by LINE's
 * servers. We host these via the existing /api/files/share/:token endpoint.
 */
export interface LineImageMessage {
  type: 'image';
  originalContentUrl: string;
  previewImageUrl: string;
}

export type LineMessage = LineTextMessage | LineEmojiMessage | LineFlexMessage | LineImageMessage;

export interface LineUserProfile {
  userId: string;
  displayName: string;
  pictureUrl?: string;
  language?: string;
  statusMessage?: string;
}

export class LineApiError extends Error {
  status: number;
  bodyText: string;

  constructor(message: string, status: number, bodyText: string) {
    super(message);
    this.name = 'LineApiError';
    this.status = status;
    this.bodyText = bodyText;
  }
}

function authHeaders(): Record<string, string> {
  const token = config.line.channelAccessToken;
  if (!token) {
    throw new LineApiError('LINE_CHANNEL_ACCESS_TOKEN is not configured', 503, '');
  }
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

async function post(path: string, body: unknown): Promise<void> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new LineApiError(`LINE API ${path} → ${res.status}`, res.status, text.slice(0, 500));
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, { headers: authHeaders() });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new LineApiError(`LINE API ${path} → ${res.status}`, res.status, text.slice(0, 500));
  }
  return (await res.json()) as T;
}

/**
 * Reply to an event using its replyToken (valid ~5 minutes, one-shot).
 * Prefer this over push when responding to a webhook because it does not count
 * against the monthly push quota.
 */
export async function replyMessage(replyToken: string, messages: LineMessage[]): Promise<void> {
  if (messages.length === 0) return;
  if (messages.length > 5) {
    throw new LineApiError('LINE reply allows max 5 messages per call', 400, '');
  }
  await post('/message/reply', { replyToken, messages });
}

/**
 * Push to a user — used after async work where the replyToken has expired.
 * Counts against the monthly quota.
 */
export async function pushMessage(toUserId: string, messages: LineMessage[]): Promise<void> {
  if (messages.length === 0) return;
  if (messages.length > 5) {
    throw new LineApiError('LINE push allows max 5 messages per call', 400, '');
  }
  await post('/message/push', { to: toUserId, messages });
}

export async function getUserProfile(userId: string): Promise<LineUserProfile> {
  return get<LineUserProfile>(`/profile/${encodeURIComponent(userId)}`);
}

/**
 * The LINE Official Account's monthly push-message quota and how much of it
 * has been consumed this month.
 *
 * - /message/quota → { type: 'none' (unlimited) | 'limited', value?: number }
 * - /message/quota/consumption → { totalUsage: number }
 *
 * Returns limit=null when the plan is unlimited ('none'). Reply messages do
 * NOT count against this quota — only pushes/broadcasts/multicasts do.
 */
export async function getMessageQuotaStatus(): Promise<{
  type: 'none' | 'limited';
  limit: number | null;
  used: number;
  remaining: number | null;
}> {
  const [quota, consumption] = await Promise.all([
    get<{ type: 'none' | 'limited'; value?: number }>('/message/quota'),
    get<{ totalUsage: number }>('/message/quota/consumption'),
  ]);
  const limit = quota.type === 'limited' ? (quota.value ?? 0) : null;
  const used = consumption.totalUsage ?? 0;
  return {
    type: quota.type,
    limit,
    used,
    remaining: limit != null ? Math.max(0, limit - used) : null,
  };
}

/**
 * Show "loading" indicator in the user's chat for up to 60 seconds. Useful
 * while the orchestrator is running so users see the bot is working.
 */
/**
 * Download the raw content of a LINE message — used to fetch the binary of
 * `image` / `file` / `audio` / `video` events. Content lives on a separate
 * domain (api-data.line.me) per LINE docs.
 */
export async function fetchMessageContent(messageId: string): Promise<{ buffer: Buffer; contentType: string | null }> {
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${encodeURIComponent(messageId)}/content`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new LineApiError(`LINE content fetch → ${res.status}`, res.status, text.slice(0, 500));
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { buffer: buf, contentType: res.headers.get('content-type') };
}

export async function startLoadingIndicator(userId: string, durationSeconds: number = 30): Promise<void> {
  const seconds = Math.min(60, Math.max(5, Math.round(durationSeconds / 5) * 5));
  try {
    await post('/chat/loading/start', { chatId: userId, loadingSeconds: seconds });
  } catch {
    // Loading indicator is best-effort — never let it block the real work.
  }
}
