/**
 * Outlook API Service — wraps the Panjit Outlook API for email access.
 * Only used in DEPLOY_MODE=pro-panjit.
 */
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';
import { config } from '../config.js';
import { dbGet, dbRun } from '../db.js';

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
  cid?: string;
}

interface OutlookMessage {
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

  const res = await fetch(`${OUTLOOK_BASE}/auth`, {
    method: 'POST',
    headers: { 'X-API-Key': config.adApiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });

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
  const res = await fetch(`${OUTLOOK_BASE}/folders`, {
    headers: { 'X-API-Key': config.adApiKey, 'Authorization': `Bearer ${mailToken}` },
  });
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
export async function fetchMessages(mailToken: string, folder: string = 'Inbox', limit: number = 20): Promise<OutlookMessage[]> {
  const res = await fetch(`${OUTLOOK_BASE}/messages?folder=${encodeURIComponent(folder)}&limit=${limit}`, {
    headers: { 'X-API-Key': config.adApiKey, 'Authorization': `Bearer ${mailToken}` },
  });
  if (!res.ok) {
    console.warn('[Outlook] fetchMessages failed:', res.status, await res.text().catch(() => ''));
    return [];
  }
  const data = await res.json() as { messages?: OutlookMessage[] };
  return data.messages || [];
}

/**
 * Fetch a single message by ID (with full body).
 */
export async function fetchMessageDetail(mailToken: string, messageId: string): Promise<OutlookMessage | null> {
  const res = await fetch(`${OUTLOOK_BASE}/messages/${encodeURIComponent(messageId)}`, {
    headers: { 'X-API-Key': config.adApiKey, 'Authorization': `Bearer ${mailToken}` },
  });
  if (!res.ok) {
    console.warn('[Outlook] fetchMessageDetail failed:', res.status, await res.text().catch(() => ''));
    return null;
  }
  const data = await res.json() as any;

  // Panjit API returns: { success, message: "查詢成功", message_detail: {...} }
  const detail = data.message_detail;
  if (!detail || typeof detail !== 'object') {
    console.warn('[Outlook] fetchMessageDetail: no message_detail in response, keys:', Object.keys(data || {}));
    return null;
  }
  return detail as OutlookMessage;
}

/**
 * Download a single attachment as a Buffer.
 */
export async function fetchAttachment(mailToken: string, messageId: string, attachmentId: string): Promise<Buffer | null> {
  const url = `${OUTLOOK_BASE}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`;
  const res = await fetch(url, {
    headers: { 'X-API-Key': config.adApiKey, 'Authorization': `Bearer ${mailToken}` },
  });
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Resolve CID images in an HTML body by downloading inline attachments
 * and replacing cid: references with base64 data URIs.
 */
export async function resolveCidImages(mailToken: string, messageId: string, body: string, attachments: OutlookAttachment[]): Promise<string> {
  const inlineAtts = attachments.filter(a => a.is_inline);
  if (inlineAtts.length === 0) return body;

  // Find all cid: references in body
  const cidRefs = [...body.matchAll(/cid:([^"']+)/gi)];
  if (cidRefs.length === 0) return body;

  // Download and replace in parallel
  const replacements = await Promise.all(cidRefs.map(async (match) => {
    const cidValue = match[1]; // e.g. "image008.jpg@01DCD71A.FF39ECA0"
    const filename = cidValue.split('@')[0]; // e.g. "image008.jpg"

    // Match by cid field first, fallback to filename
    const att = inlineAtts.find(a => a.cid === cidValue) || inlineAtts.find(a => a.filename === filename);
    if (!att) return null;

    const buf = await fetchAttachment(mailToken, messageId, att.id);
    if (!buf) return null;

    return { from: 'cid:' + cidValue, to: `data:${att.content_type};base64,${buf.toString('base64')}` };
  }));

  for (const r of replacements) {
    if (r) body = body.replace(r.from, r.to);
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
