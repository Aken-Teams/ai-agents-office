/**
 * QR code mint for the "bind my existing account to LINE" flow.
 *
 * A logged-in web user requests a QR; we mint a one-shot, short-lived bind
 * token tied to THEIR internal user id (stored in `line_link_tokens`), build
 * a LINE deep link with `/link <code>` pre-filled, and render a QR PNG. When
 * the user scans it and sends the message, the bot binds their LINE account
 * to this existing internal user (see userMapping.linkLineUser).
 *
 * There is no "register a new account from LINE" path — accounts are created
 * on the web; LINE only ever binds to an existing one.
 */

import QRCode from 'qrcode';
import { dbGet, dbRun } from '../../db.js';
import { config } from '../../config.js';

/* ============================================================
   In-memory per-IP rate limit. Simple sliding window: max 5
   QR mints / 60 sec / IP. Defence-in-depth on top of the
   per-request auth the bind endpoint already enforces.
   ============================================================ */
const ipBuckets = new Map<string, { count: number; windowStart: number }>();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 5;

export function checkQrRateLimit(ip: string): boolean {
  const now = Date.now();
  const existing = ipBuckets.get(ip);
  if (!existing || now - existing.windowStart >= WINDOW_MS) {
    ipBuckets.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (existing.count >= MAX_PER_WINDOW) return false;
  existing.count += 1;
  return true;
}

export function pruneQrIpBuckets(): void {
  const cutoff = Date.now() - WINDOW_MS * 2;
  for (const [ip, bucket] of ipBuckets) {
    if (bucket.windowStart < cutoff) ipBuckets.delete(ip);
  }
}

/* ============================================================
   Bind-token generation. Same alphabet as the invite codes
   (no I/O/0/1) so it's easy to type / read on a small screen.
   ============================================================ */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes

function mysqlNow(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Mint a one-shot bind token tied to `userId`, persisted in line_link_tokens.
 * Retries on the (astronomically rare) primary-key collision.
 */
async function mintBindToken(userId: string): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    let code = '';
    for (let i = 0; i < 8; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    try {
      await dbRun(
        'INSERT INTO line_link_tokens (code, user_id, expires_at) VALUES (?, ?, ?)',
        code, userId, mysqlNow(TOKEN_TTL_MS),
      );
      return code;
    } catch (err) {
      if ((err as { code?: string }).code === 'ER_DUP_ENTRY' && attempt < 4) continue;
      throw err;
    }
  }
  throw new Error('Failed to mint bind token after retries');
}

export interface QrMintResult {
  code: string;
  lineUrl: string;
  qrDataUrl: string;
}

/**
 * Build a LINE deep link. Per LINE docs:
 *   https://line.me/R/oaMessage/<basicId>/?<encoded message>
 * Even if the recipient hasn't added the bot, LINE prompts them to add it
 * before opening the chat with the message pre-filled. The "?" after the
 * trailing slash is *required*; the message body is URI-encoded.
 */
export function buildLineDeepLink(code: string): string {
  const basicId = config.line.botBasicId || '';
  if (!basicId) throw new Error('LINE_BOT_BASIC_ID not configured');
  const message = `/link ${code}`;
  return `https://line.me/R/oaMessage/${encodeURIComponent(basicId)}/?${encodeURIComponent(message)}`;
}

/**
 * Mint a bind code for `userId` + deep link + base64 QR PNG. Returns the data
 * URL ready to drop into an <img src=…> tag.
 */
export async function mintBindQrCode(userId: string): Promise<QrMintResult> {
  const code = await mintBindToken(userId);
  const lineUrl = buildLineDeepLink(code);
  const qrDataUrl = await QRCode.toDataURL(lineUrl, {
    margin: 1,
    width: 360,
    errorCorrectionLevel: 'M',
    color: { dark: '#1F1B16', light: '#FCFAF7' },
  });
  return { code, lineUrl, qrDataUrl };
}

/**
 * Resolve a bind token to its target user id, if the token is valid (exists,
 * unused, not expired). Marks it used atomically so it can't be replayed.
 * Returns null if the code is not a (valid) bind token.
 */
export async function consumeBindToken(code: string): Promise<string | null> {
  const row = await dbGet<{ user_id: string }>(
    'SELECT user_id FROM line_link_tokens WHERE code = ? AND used = 0 AND expires_at > NOW()',
    code,
  );
  if (!row) return null;
  // Atomic claim — only the first caller flips used 0→1 and gets the binding.
  const result = await dbRun(
    'UPDATE line_link_tokens SET used = 1 WHERE code = ? AND used = 0',
    code,
  ) as { affectedRows?: number };
  if (!result.affectedRows) return null;
  return row.user_id;
}
