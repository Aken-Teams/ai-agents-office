/**
 * Public QR code mint for the web "log in / register via LINE" flow.
 *
 * On request, atomically: create a one-shot invite code, build a deep link
 * back to the LINE chat with `/link <code>` pre-filled, and render a QR PNG.
 * Per-IP rate-limited (5 requests/min) so a bored attacker can't spam the
 * invite-code table.
 */

import { v4 as uuidv4 } from 'uuid';
import QRCode from 'qrcode';
import { dbRun } from '../../db.js';
import { config } from '../../config.js';

/* ============================================================
   In-memory per-IP rate limit. Simple sliding window: max 5
   QR mints / 60 sec / IP. The map is pruned by the existing
   `pruneExpiredBuckets` interval in rateLimit.ts (same pattern).
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
   Invite-code generation. Same alphabet as
   /api/admin/invite-codes/personal (no I/O/0/1) for the same
   reason: easier to type, easier to read on a small screen.
   ============================================================ */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

async function mintInviteCode(label: string): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    let code = '';
    for (let i = 0; i < 8; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    try {
      await dbRun(
        'INSERT INTO invite_codes (id, code, label, is_active) VALUES (?, ?, ?, 1)',
        uuidv4(), code, label,
      );
      return code;
    } catch (err) {
      if ((err as { code?: string }).code === 'ER_DUP_ENTRY' && attempt < 4) continue;
      throw err;
    }
  }
  throw new Error('Failed to mint invite code after retries');
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
 * Mint a code + deep link + base64 QR PNG. Returns the data URL ready to
 * drop into an <img src=…> tag.
 */
export async function mintQrCode(label = 'LINE QR 註冊'): Promise<QrMintResult> {
  const code = await mintInviteCode(label);
  const lineUrl = buildLineDeepLink(code);
  const qrDataUrl = await QRCode.toDataURL(lineUrl, {
    margin: 1,
    width: 360,
    errorCorrectionLevel: 'M',
    color: { dark: '#1F1B16', light: '#FCFAF7' },
  });
  return { code, lineUrl, qrDataUrl };
}
