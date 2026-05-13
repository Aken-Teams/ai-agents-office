/**
 * Outlook API Service — wraps the Panjit Outlook API for email access.
 * Only used in DEPLOY_MODE=pro-panjit.
 */
import { config } from '../config.js';
import { dbGet, dbRun } from '../db.js';

const OUTLOOK_BASE = `${config.adApiUrl}/outlook`;

interface OutlookFolder {
  id: string;
  name: string;
  displayName: string;
  totalCount: number;
  unreadCount: number;
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
}

/**
 * Authenticate with Outlook API and cache the mail_token in DB.
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
  console.log('[Outlook] Auth response:', { success: data.success, hasToken: !!data.mail_token });
  const mailToken = data.mail_token;
  if (!mailToken) return null;

  // Cache token with 55-minute TTL (API grants 1 hour)
  // Use local time (not UTC) so that JS Date parsing is consistent on read-back
  const d = new Date(Date.now() + 55 * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const expiresAt = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  console.log('[Outlook] Storing token, expires_at:', expiresAt);
  await dbRun(
    `INSERT INTO outlook_tokens (user_id, mail_token, expires_at) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE mail_token = VALUES(mail_token), expires_at = VALUES(expires_at)`,
    userId, mailToken, expiresAt
  );
  console.log('[Outlook] Token stored successfully');

  return mailToken;
}

/**
 * Get a valid (non-expired) mail_token for a user.
 */
export async function getMailToken(userId: string): Promise<string | null> {
  const row = await dbGet<{ mail_token: string; expires_at: string }>(
    'SELECT mail_token, expires_at FROM outlook_tokens WHERE user_id = ?', userId
  );
  if (!row) return null;

  // Check expiry
  if (new Date(row.expires_at) < new Date()) {
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

interface OutlookMessageDetail extends OutlookMessage {
  body?: string;
  body_type?: string;
}

/**
 * Fetch a single message by ID (with full body).
 */
export async function fetchMessageDetail(mailToken: string, messageId: string): Promise<OutlookMessageDetail | null> {
  const res = await fetch(`${OUTLOOK_BASE}/messages/${encodeURIComponent(messageId)}`, {
    headers: { 'X-API-Key': config.adApiKey, 'Authorization': `Bearer ${mailToken}` },
  });
  if (!res.ok) {
    console.warn('[Outlook] fetchMessageDetail failed:', res.status, await res.text().catch(() => ''));
    return null;
  }
  const data = await res.json() as OutlookMessageDetail & { message?: OutlookMessageDetail };
  // API may return message at root or nested under .message
  return data.message || (data.id ? data : null);
}

/**
 * Logout and remove cached token.
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
