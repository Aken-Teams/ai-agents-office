/**
 * Outlook API Service — wraps the Panjit Outlook API for email access.
 * Only used in DEPLOY_MODE=pro-panjit.
 */
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';
import { config } from '../config.js';
import { dbGet, dbRun } from '../db.js';
import { gatewayFetch } from './mailGatewayLimit.js';

const OUTLOOK_BASE = `${config.adApiUrl}/outlook`;

// Derive a stable 32-byte AES key from jwtSecret
const AES_KEY = createHash('sha256').update(config.jwtSecret).digest();

function encrypt(text: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', AES_KEY, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), enc.toString('base64'), tag.toString('base64')].join(':');
}

function decrypt(data: string): string {
  const [ivB64, encB64, tagB64] = data.split(':');
  const decipher = createDecipheriv('aes-256-gcm', AES_KEY, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return decipher.update(Buffer.from(encB64, 'base64')) + decipher.final('utf8');
}

interface OutlookFolder {
  id: string;
  name: string;
  displayName: string;
  totalCount: number;
  unreadCount: number;
}

interface OutlookAttachment {
  id: string;
  filename: string;
  content_type: string;
  size: number;
  is_inline: boolean;
  // The gateway's 2026-07 rewrite returns the inline-image id in `content_id`
  // (the value that a body's `cid:xxx` reference points at). Older/other shapes
  // used `cid`. Read either — see `cidOf()` in resolveCidImages.
  content_id?: string;
  cid?: string;
}

export interface OutlookMessage {
  id: string;
  subject: string;
  from: { name: string; address: string };
  to: Array<{ name: string; address: string }>;
  cc: Array<{ name: string; address: string }>;
  received_at: string;
  is_read: boolean;
  has_attachments: boolean;
  size: number;
  preview: string;
  body?: string;
  body_type?: string;
  attachments?: OutlookAttachment[];
}

/**
 * Authenticate with Outlook API and cache the mail_token + encrypted credentials in DB.
 */
export async function authenticateOutlook(userId: string, username: string, password: string): Promise<string | null> {
  console.log('[Outlook] Authenticating for user:', userId, 'username:', username);
  if (!config.adApiKey) {
    console.warn('[Outlook] No AD API key configured, skipping');
    return null;
  }

  const res = await gatewayFetch(`${OUTLOOK_BASE}/auth`, {
    method: 'POST',
    headers: { 'X-API-Key': config.adApiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  }, { timeoutMs: GATEWAY_TIMEOUT_MS });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.warn('[Outlook] Auth failed:', res.status, body);
    return null;
  }

  const data = await res.json() as { success: boolean; mail_token?: string };
  const mailToken = data.mail_token;
  if (!mailToken) return null;

  // Cache token with 55-minute TTL (API grants 1 hour)
  const d = new Date(Date.now() + 55 * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const expiresAt = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

  const credEnc = encrypt(JSON.stringify({ username, password }));

  await dbRun(
    `INSERT INTO outlook_tokens (user_id, mail_token, expires_at, credentials_enc) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE mail_token = VALUES(mail_token), expires_at = VALUES(expires_at), credentials_enc = VALUES(credentials_enc)`,
    userId, mailToken, expiresAt, credEnc
  );
  console.log('[Outlook] Token stored, expires_at:', expiresAt);

  return mailToken;
}

// Prevent concurrent refresh for the same user
const refreshLocks = new Map<string, Promise<string | null>>();

/**
 * Get a valid mail_token for a user. Auto-refreshes if expired using stored credentials.
 */
export async function getMailToken(userId: string): Promise<string | null> {
  const row = await dbGet<{ mail_token: string; expires_at: string; credentials_enc?: string }>(
    'SELECT mail_token, expires_at, credentials_enc FROM outlook_tokens WHERE user_id = ?', userId
  );
  if (!row) return null;

  // Token still valid (>5 min remaining) — return as-is
  const remaining = new Date(row.expires_at).getTime() - Date.now();
  if (remaining > 5 * 60_000) {
    return row.mail_token;
  }

  // Token expired or expiring soon — try auto-refresh
  if (row.credentials_enc) {
    // Deduplicate concurrent refresh attempts
    if (refreshLocks.has(userId)) {
      return refreshLocks.get(userId)!;
    }
    const promise = (async () => {
      try {
        const { username, password } = JSON.parse(decrypt(row.credentials_enc!));
        console.log('[Outlook] Auto-refreshing token for user:', userId);
        const newToken = await authenticateOutlook(userId, username, password);
        if (newToken) return newToken;
      } catch (err) {
        console.warn('[Outlook] Auto-refresh failed:', err);
      }
      // Refresh failed — if token not yet expired, still usable
      if (remaining > 0) return row.mail_token;
      await dbRun('DELETE FROM outlook_tokens WHERE user_id = ?', userId);
      return null;
    })();
    refreshLocks.set(userId, promise);
    try { return await promise; } finally { refreshLocks.delete(userId); }
  }

  // No stored credentials — if expired, delete
  if (remaining <= 0) {
    await dbRun('DELETE FROM outlook_tokens WHERE user_id = ?', userId);
    return null;
  }
  return row.mail_token;
}

/**
 * Fetch email folders.
 */
export async function fetchFolders(mailToken: string): Promise<OutlookFolder[]> {
  const res = await gatewayFetch(`${OUTLOOK_BASE}/folders`, {
    headers: { 'X-API-Key': config.adApiKey, 'Authorization': `Bearer ${mailToken}` },
  }, { timeoutMs: GATEWAY_TIMEOUT_MS });
  if (!res.ok) {
    console.warn('[Outlook] fetchFolders failed:', res.status, await res.text().catch(() => ''));
    return [];
  }
  const data = await res.json() as { folders?: OutlookFolder[] };
  return data.folders || [];
}

/**
 * Fetch messages from a folder.
 */
export async function fetchMessages(
  mailToken: string,
  folder: string = 'Inbox',
  limit: number = 20,
  offset: number = 0,
  opts?: { q?: string; startDate?: string; endDate?: string },
): Promise<{ messages: OutlookMessage[]; total: number }> {
  const params = new URLSearchParams({ folder, limit: String(limit), order: 'desc' });
  if (offset > 0) params.set('offset', String(offset));
  // Server-side filters (EWS-side, fast). q matches subject only.
  if (opts?.q) params.set('q', opts.q);
  if (opts?.startDate) params.set('start_date', opts.startDate);
  if (opts?.endDate) params.set('end_date', opts.endDate);
  const res = await gatewayFetch(`${OUTLOOK_BASE}/messages?${params}`, {
    headers: { 'X-API-Key': config.adApiKey, 'Authorization': `Bearer ${mailToken}` },
  }, { timeoutMs: GATEWAY_TIMEOUT_MS });
  if (!res.ok) {
    console.warn('[Outlook] fetchMessages failed:', res.status, await res.text().catch(() => ''));
    return { messages: [], total: 0 };
  }
  const data = await res.json() as { messages?: OutlookMessage[]; total?: number };
  return { messages: data.messages || [], total: data.total ?? (data.messages?.length || 0) };
}

/**
 * Fetch a single message by ID (with full body).
 */
export async function fetchMessageDetail(mailToken: string, messageId: string): Promise<OutlookMessage | null> {
  const url = `${OUTLOOK_BASE}/messages/${encodeURIComponent(messageId)}`;
  const headers = { 'X-API-Key': config.adApiKey, 'Authorization': `Bearer ${mailToken}` };
  // The mail gateway is intermittently flaky — retry transient failures
  // (5xx / network error / non-JSON body). Bounded at 2 attempts so a slow
  // gateway can't stack up to ~90s (30s × 3) and outlast the frontend request.
  for (let attempt = 0; attempt < 2; attempt++) {
    const backoff = () => new Promise(r => setTimeout(r, 400 * (attempt + 1)));
    try {
      // The gateway can take >15s to assemble a message with inline images. The
      // API's own guidance is ~30s for non-attachment endpoints; a too-tight
      // timeout aborted attempt-after-attempt and the frontend proxy gave up
      // (ECONNRESET) before any retry could land. 30s lets attempt 1 succeed.
      const res = await gatewayFetch(url, { headers }, { timeoutMs: GATEWAY_TIMEOUT_MS });
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        console.warn(`[Outlook] fetchMessageDetail ${res.status} (attempt ${attempt + 1}):`, bodyText.slice(0, 200));
        if (res.status >= 500 && attempt < 1) { await backoff(); continue; }
        return null;
      }
      const raw = await res.text();
      let data: any;
      try { data = JSON.parse(raw); } catch {
        console.warn(`[Outlook] fetchMessageDetail non-JSON body (attempt ${attempt + 1}):`, raw.slice(0, 200));
        if (attempt < 1) { await backoff(); continue; }
        return null;
      }
      // Panjit API returns: { success, message: "查詢成功", message_detail: {...} }
      const detail = data.message_detail;
      if (!detail || typeof detail !== 'object') {
        console.warn('[Outlook] fetchMessageDetail: no message_detail in response, keys:', Object.keys(data || {}));
        return null;
      }
      return detail as OutlookMessage;
    } catch (err) {
      console.warn(`[Outlook] fetchMessageDetail error (attempt ${attempt + 1}):`, err instanceof Error ? err.message : err);
      if (attempt < 1) { await backoff(); continue; }
      return null;
    }
  }
  return null;
}

// The gateway's attachment download endpoint is slow (~20KB/s measured) — 12s was
// too tight even for a 250KB image. Raised so mid-size inline images can finish.
// The attachment download endpoint is the slow one (streams file bytes); the
// API's own guidance is a 60s client timeout for it. A too-tight value was
// leaving mid-size inline images as broken boxes.
const ATTACHMENT_TIMEOUT_MS = 60_000;

// auth / folders / messages / detail. Raised 30s→45s: the mail gateway slows
// noticeably under concurrent load (30 users opening at once), so give slow
// responses more headroom before we abort — fewer spurious timeouts at peak.
const GATEWAY_TIMEOUT_MS = 45_000;

/**
 * Download a single attachment as a Buffer.
 */
export async function fetchAttachment(mailToken: string, messageId: string, attachmentId: string, timeoutMs: number = ATTACHMENT_TIMEOUT_MS): Promise<Buffer | null> {
  const url = `${OUTLOOK_BASE}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`;
  // Timeout + never throw: a single slow/404/erroring attachment must not reject
  // the parallel CID resolution (which would 500 the whole email view).
  try {
    const res = await gatewayFetch(url, {
      headers: { 'X-API-Key': config.adApiKey, 'Authorization': `Bearer ${mailToken}` },
    }, { timeoutMs });
    if (!res.ok) {
      console.warn(`[Outlook][cid] attachment download ${res.status} for att=${attachmentId.slice(0, 24)}…`);
      return null;
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    console.warn(`[Outlook][cid] attachment download error for att=${attachmentId.slice(0, 24)}…:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Resolve CID images in an HTML body by downloading inline attachments
 * and replacing cid: references with base64 data URIs.
 */
export async function resolveCidImages(mailToken: string, messageId: string, body: string, attachments: OutlookAttachment[]): Promise<string> {
  if (!attachments?.length || !body) return body;

  // Find all cid: references in body. Stop the capture at quotes, '>', whitespace
  // or ')' so we don't swallow trailing markup (the old /[^"']+/ over-captured on
  // unquoted src=cid:... attributes).
  const cidRefs = [...body.matchAll(/cid:([^"'>\s)]+)/gi)];
  if (cidRefs.length === 0) return body;

  // Normalize a Content-ID for tolerant matching: strip angle brackets, trim,
  // lowercase. Real Content-IDs are often stored as "<image001@host>" while the
  // body references "cid:image001@host" — exact compare missed those.
  const norm = (s: string | undefined) => (s || '').replace(/[<>]/g, '').trim().toLowerCase();

  // Inline images larger than this are skipped: at the gateway's ~20KB/s this would
  // time out anyway, and inlining it as base64 would bloat the whole email body.
  // Skipping keeps the OTHER images rendering fast (they resolve in parallel).
  const MAX_INLINE_BYTES = 8 * 1024 * 1024; // 8MB — cover oversized inline banners
  // (senders sometimes embed a 6MB+ banner). Base64-inlining that bloats the
  // email HTML by ~33%, but it's a one-off view; the 60s attachment timeout still
  // caps how long we'll wait, so a genuinely huge/slow file degrades gracefully.

  // Resolve each DISTINCT cid once (an image referenced N times is fetched once).
  const uniqueCids = [...new Set(cidRefs.map(m => m[1]))];

  // The inline id lives in `content_id` (new gateway) or `cid` (older). Read either.
  const cidOf = (a: OutlookAttachment) => a.content_id ?? a.cid;

  const replacements = await Promise.all(uniqueCids.map(async (cidValue) => {
    const nCid = norm(cidValue);
    const nFile = norm(cidValue.split('@')[0]); // "image008.jpg@..." → "image008.jpg"

    // Match against ALL attachments (not just is_inline): some mail servers don't
    // flag inline images correctly, which is exactly why they went missing before.
    // Try content_id/cid, then filename, then id-vs-filename cross match.
    const att =
      attachments.find(a => nCid && norm(cidOf(a)) === nCid) ||
      attachments.find(a => nFile && norm(a.filename) === nFile) ||
      attachments.find(a => nFile && norm(cidOf(a)) === nFile);
    if (!att) { console.warn(`[Outlook][cid] NO MATCH for "cid:${cidValue}"`); return null; }
    if (att.size && att.size > MAX_INLINE_BYTES) {
      console.warn(`[Outlook][cid] "cid:${cidValue}" → ${att.filename} SKIPPED (too big: ${att.size} bytes > ${MAX_INLINE_BYTES})`);
      return null;
    }

    // Big images get a SHORTER budget so a slow gateway can't hold the whole
    // email hostage for the full 60s: small inline images (≤2MB) finish even at
    // ~20KB/s, but a 6MB banner only lands if the endpoint is genuinely fast —
    // otherwise we bail after 20s and show a placeholder (email stays snappy).
    const dlTimeout = (att.size && att.size > 2 * 1024 * 1024) ? 20_000 : ATTACHMENT_TIMEOUT_MS;
    const buf = await fetchAttachment(mailToken, messageId, att.id, dlTimeout);
    if (!buf) { console.warn(`[Outlook][cid] "cid:${cidValue}" → ${att.filename} (${att.size}B) download returned null`); return null; }

    return { cidValue, dataUri: `data:${att.content_type || 'image/png'};base64,${buf.toString('base64')}` };
  }));

  // One-line diagnostic: how many resolved, and the raw cid ↔ attachment picture,
  // so an unresolved image can be pinned to no-match / too-big / download-fail.
  const okCount = replacements.filter(Boolean).length;
  if (okCount < uniqueCids.length) {
    console.warn(
      `[Outlook][cid] resolved ${okCount}/${uniqueCids.length}. body cids=${JSON.stringify(uniqueCids)} ` +
      `attachments=${JSON.stringify((attachments || []).map(a => ({ file: a.filename, content_id: a.content_id ?? a.cid ?? null, inline: a.is_inline, size: a.size })))}`,
    );
  }

  for (const r of replacements) {
    if (!r) continue;
    // Global literal replace (all occurrences) — String.replace only did the first.
    body = body.split('cid:' + r.cidValue).join(r.dataUri);
  }
  return body;
}

/**
 * Logout and remove cached token + credentials.
 */
export async function logoutOutlook(userId: string): Promise<void> {
  const token = await getMailToken(userId);
  if (token) {
    await fetch(`${OUTLOOK_BASE}/logout`, {
      method: 'POST',
      headers: { 'X-API-Key': config.adApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mail_token: token }),
    }).catch(() => {});
  }
  await dbRun('DELETE FROM outlook_tokens WHERE user_id = ?', userId);
}
