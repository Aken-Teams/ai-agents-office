/**
 * file_shares — public, time-bounded download tokens for generated files
 * delivered through LINE (no JWT available in chat context).
 *
 * Mirrors the conversation_shares pattern from routes/share.ts: 8-byte
 * base62 token, INSERT IGNORE on collision (probabilistically impossible at
 * 62^8 ≈ 218 trillion combos, but cheap to guard against). Adds expiry +
 * download-cap so a forwarded URL has finite blast radius.
 */

import crypto from 'crypto';
import { dbGet, dbRun } from '../../db.js';
import { config } from '../../config.js';
import { getLineFileShareTtlDays } from '../lineSettings.js';

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

interface MintArgs {
  fileId: string;
  userId: string;
  source?: string;
  ttlDays?: number;
  downloadCap?: number;
}

function randomToken(): string {
  const bytes = crypto.randomBytes(8);
  return Array.from(bytes).map(b => CHARS[b % CHARS.length]).join('');
}

/**
 * Insert a new file_shares row. Returns the token. If the file already has a
 * non-expired share token from the same user + source, reuse it instead of
 * creating duplicates.
 */
export async function createOrReuseFileShare(args: MintArgs): Promise<{ token: string; url: string }> {
  const source = args.source ?? 'line';
  const ttlDays = args.ttlDays ?? getLineFileShareTtlDays();
  const downloadCap = args.downloadCap ?? 50;

  const existing = await dbGet<{ token: string; expires_at: string }>(
    `SELECT token, expires_at FROM file_shares
     WHERE file_id = ? AND user_id = ? AND source = ? AND expires_at > NOW()
     ORDER BY created_at DESC LIMIT 1`,
    args.fileId, args.userId, source,
  );
  if (existing) {
    return { token: existing.token, url: buildShareUrl(existing.token) };
  }

  // Tiny retry loop guards the absurdly unlikely collision case.
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = randomToken();
    try {
      await dbRun(
        `INSERT INTO file_shares (token, file_id, user_id, source, expires_at, download_cap)
         VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? DAY), ?)`,
        token, args.fileId, args.userId, source, ttlDays, downloadCap,
      );
      return { token, url: buildShareUrl(token) };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'ER_DUP_ENTRY' && attempt < 2) continue;
      throw err;
    }
  }
  throw new Error('Failed to mint file share token after retries');
}

function buildShareUrl(token: string): string {
  const base = config.line.publicApiBase;
  return `${base}/api/files/share/${token}`;
}

export interface FileShareRow {
  token: string;
  file_id: string;
  user_id: string;
  expires_at: string;
  download_count: number;
  download_cap: number;
}

/**
 * Look up + validate a token. Returns null when token is unknown, expired, or
 * over the download cap. Caller is responsible for incrementing download_count
 * via `consumeShareToken` once the stream actually starts.
 */
export async function findValidShare(token: string): Promise<FileShareRow | null> {
  const row = await dbGet<FileShareRow>(
    `SELECT token, file_id, user_id, expires_at, download_count, download_cap
     FROM file_shares
     WHERE token = ? AND expires_at > NOW()
     LIMIT 1`,
    token,
  );
  if (!row) return null;
  if (row.download_count >= row.download_cap) return null;
  return row;
}

export async function bumpDownloadCount(token: string): Promise<void> {
  await dbRun(
    'UPDATE file_shares SET download_count = download_count + 1 WHERE token = ?',
    token,
  );
}
