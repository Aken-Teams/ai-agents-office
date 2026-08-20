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
 * The AD domains this gateway serves. Codes + labels are the gateway's own; the
 * login page offers the identical list (client/src/app/login/page.tsx).
 */
export const AD_DOMAIN_LABELS: Record<string, string> = {
  PANJIT: 'PANJIT（台灣）',
  PYNMAX: 'PYNMAX（璟茂）',
  WXPJ: 'WXPJ（無錫強茂）',
  PJWS: 'PJWS（強茂深圳）',
  GDPJ: 'GDPJ（蘇州群鑫）',
  PJXZ: 'PJXZ（強茂徐州）',
  PJSD: 'PJSD（山東強茂）',
};

/**
 * Domains the gateway has not wired to Exchange yet. Their users' mail_available
 * is ALWAYS false — a documented state, not a fault. Sending them to IT (which
 * is what a generic "請洽 IT 開通" does) wastes both their time and IT's.
 */
export const MAIL_UNSUPPORTED_DOMAINS = new Set(['GDPJ', 'PJSD']);

/**
 * Why the account cannot read mail. The gateway returns mail_available=false for
 * three genuinely different reasons and each needs a DIFFERENT person — one
 * blanket "請洽 IT" message sends two thirds of these users to someone who has
 * no way to help them.
 */
export type MailStatusCode =
  | 'ok'
  | 'not_connected'         // no token at all — sign in again
  | 'domain_unsupported'    // this plant has no mail support yet (known)
  | 'no_mailbox'            // AD account has no mail address → that plant's IT
  | 'no_exchange'           // domain has no Exchange server → this platform's admin
  | 'exchange_unreachable'  // transient → sign in again later
  | 'unknown';

export interface MailStatus {
  available: boolean;
  code: MailStatusCode;
  /** Ready to show a user, in zh-TW. Null when available. */
  message: string | null;
}

/**
 * Map the gateway's `message` onto who can actually fix it.
 *
 * A known-unsupported domain wins over whatever the gateway said, because for
 * those accounts the answer is "not yet built", not "something went wrong".
 */
export function classifyMailUnavailable(
  gatewayMessage: string | undefined,
  domain?: string,
): { code: MailStatusCode; message: string } {
  const dom = (domain || '').toUpperCase();
  if (MAIL_UNSUPPORTED_DOMAINS.has(dom)) {
    return {
      code: 'domain_unsupported',
      message: `${AD_DOMAIN_LABELS[dom] || dom} 目前尚未支援信件功能，這是已知狀況，暫時無法使用「我的信件」與信件助手。`,
    };
  }

  const msg = gatewayMessage || '';
  if (/信箱位址|信箱位置|mail\s*address|mailbox\s*(not|no)/i.test(msg)) {
    return {
      code: 'no_mailbox',
      message: '您的 AD 帳號沒有設定信箱位址，無法使用信件功能，請洽貴廠 IT 協助開通。',
    };
  }
  if (/尚未設定|未設定.*Exchange|no\s*Exchange\s*server|not\s*configured/i.test(msg)) {
    const where = AD_DOMAIN_LABELS[dom] ? `（${AD_DOMAIN_LABELS[dom]}）` : '';
    return {
      code: 'no_exchange',
      message: `貴公司網域${where}尚未設定 Exchange 伺服器，請洽本平台管理者協助設定。`,
    };
  }
  if (/暫時無法連線|無法連線|連線失敗|unreachable|timeout|timed\s*out|unavailable/i.test(msg)) {
    return {
      code: 'exchange_unreachable',
      message: 'Exchange 伺服器暫時無法連線，請稍後重新登入再試。',
    };
  }
  return {
    code: 'unknown',
    message: msg
      ? `信件功能目前無法使用：${msg}`
      : '信件功能目前無法使用，請稍後重新登入；若持續發生請洽本平台管理者。',
  };
}

/**
 * Authenticate with Outlook API and cache the mail_token + encrypted credentials in DB.
 *
 * `domain` is NOT optional in practice for anyone outside PANJIT: the gateway
 * resolves against PANJIT alone when it is omitted and answers 401
 * "使用者名稱或密碼錯誤" — indistinguishable from a genuinely wrong password.
 * This endpoint is also independent of the LDAP /auth call, so a domain passed
 * there does not carry over; callers must pass it here too.
 */
export async function authenticateOutlook(userId: string, username: string, password: string, domain?: string): Promise<string | null> {
  const result = await requestOutlookToken(username, password, domain, userId);
  if (!result) return null;
  await persistOutlookToken(userId, result);
  return result.mailToken;
}

/**
 * A mail token that has been fetched but not yet filed against a user.
 *
 * The two halves are separate because of first-time AD sign-in: we hold the
 * password at /ad/login, but the user row that outlook_tokens keys on does not
 * exist until they finish registering (or inheriting) a few screens later. Ask
 * the gateway while we can, store it once there is somewhere to put it.
 */
export interface OutlookAuthResult {
  mailToken: string;
  mailAvailable: boolean;
  status: { code: MailStatusCode; message: string } | null;
  expiresAt: string;
  credEnc: string;
}

/** Ask the gateway for a mail token. Stores nothing. */
export async function requestOutlookToken(
  username: string, password: string, domain?: string, forUser = '(new user)',
): Promise<OutlookAuthResult | null> {
  console.log('[Outlook] Authenticating for user:', forUser, 'username:', username, 'domain:', domain || '(default)');
  if (!config.adApiKey) {
    console.warn('[Outlook] No AD API key configured, skipping');
    return null;
  }

  const res = await gatewayFetch(`${OUTLOOK_BASE}/auth`, {
    method: 'POST',
    headers: { 'X-API-Key': config.adApiKey, 'Content-Type': 'application/json' },
    // The gateway resolves the account against a single default domain unless one
    // is given — PYNMAX/WXPJ/… accounts fail with "使用者名稱或密碼錯誤" without it.
    body: JSON.stringify(domain ? { username, password, domain } : { username, password }),
  }, { timeoutMs: GATEWAY_TIMEOUT_MS });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.warn('[Outlook] Auth failed:', res.status, body);
    // A 401 here reads as "wrong password" but is just as often a missing/wrong
    // domain — the gateway only searches PANJIT by default. Say so in the log so
    // nobody spends an afternoon resetting a password that was never wrong.
    if (res.status === 401 && (domain || 'PANJIT').toUpperCase() !== 'PANJIT') {
      console.warn(`[Outlook] 401 for domain="${domain}" — verify this domain code is one the gateway knows (${Object.keys(AD_DOMAIN_LABELS).join(', ')}).`);
    }
    return null;
  }

  const data = await res.json() as {
    success: boolean; mail_token?: string; mail_available?: boolean; message?: string; expires_in?: number;
  };
  const mailToken = data.mail_token;
  if (!mailToken) return null;
  // The gateway hands out a token even for accounts with no Exchange mailbox
  // (LDAP-only), then 403s every mail call. Remember the flag AND the reason so
  // the UI can name the right fix instead of claiming the connection expired.
  const mailAvailable = data.mail_available !== false;
  const status = mailAvailable ? null : classifyMailUnavailable(data.message, domain);
  if (status) {
    console.warn(`[Outlook] mail_available=false for ${username}@${domain || 'PANJIT'} → ${status.code}; gateway said: ${data.message || '(no message)'}`);
  }

  // Trust the gateway's own TTL (it grants 3600s today) and keep 5 minutes of
  // headroom so a refresh happens before anything 401s mid-request.
  const ttlSec = typeof data.expires_in === 'number' && data.expires_in > 300 ? data.expires_in : 3600;
  const d = new Date(Date.now() + (ttlSec - 300) * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const expiresAt = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

  const credEnc = encrypt(JSON.stringify({ username, password, domain }));

  return { mailToken, mailAvailable, status, expiresAt, credEnc };
}

/** File an already-fetched token against a user. */
export async function persistOutlookToken(userId: string, r: OutlookAuthResult): Promise<void> {
  await dbRun(
    `INSERT INTO outlook_tokens (user_id, mail_token, expires_at, credentials_enc, mail_available, mail_status_code, mail_status_message)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE mail_token = VALUES(mail_token), expires_at = VALUES(expires_at), credentials_enc = VALUES(credentials_enc),
       mail_available = VALUES(mail_available), mail_status_code = VALUES(mail_status_code), mail_status_message = VALUES(mail_status_message)`,
    userId, r.mailToken, r.expiresAt, r.credEnc, r.mailAvailable ? 1 : 0, r.status?.code || 'ok', r.status?.message || null
  );
  console.log('[Outlook] Token stored for', userId, 'expires_at:', r.expiresAt);
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
        const { username, password, domain } = JSON.parse(decrypt(row.credentials_enc!));
        // Rows written before the domain fix have no domain — fall back to the
        // user's AD domain so a refresh does not silently drop them.
        const adDomain = domain || (await dbGet<{ ad_domain: string | null }>(
          'SELECT ad_domain FROM users WHERE id = ?', userId))?.ad_domain || undefined;
        console.log('[Outlook] Auto-refreshing token for user:', userId);
        const newToken = await authenticateOutlook(userId, username, password, adDomain);
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
 * Whether the user can read mail, and if not, what to tell them.
 *
 * The message is whatever we classified at sign-in time (see
 * classifyMailUnavailable). Rows written before that existed have no stored
 * reason — fall back to the AD domain, which alone already answers it for the
 * plants that have no mail support.
 */
export async function getMailboxStatus(userId: string): Promise<MailStatus> {
  const row = await dbGet<{ mail_available: number; mail_status_code?: string | null; mail_status_message?: string | null }>(
    'SELECT mail_available, mail_status_code, mail_status_message FROM outlook_tokens WHERE user_id = ?', userId
  );
  // No row = never connected. Not a mailbox problem; the caller's own
  // "connect / sign in again" path handles it.
  if (!row) return { available: true, code: 'ok', message: null };
  if (row.mail_available !== 0) return { available: true, code: 'ok', message: null };

  if (row.mail_status_message) {
    return { available: false, code: (row.mail_status_code as MailStatusCode) || 'unknown', message: row.mail_status_message };
  }
  const adDomain = (await dbGet<{ ad_domain: string | null }>('SELECT ad_domain FROM users WHERE id = ?', userId))?.ad_domain || undefined;
  const fallback = classifyMailUnavailable(undefined, adDomain);
  return { available: false, ...fallback };
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
