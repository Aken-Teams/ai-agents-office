/**
 * LINE user ↔ internal user mapping.
 *
 * The bot uses invite codes (reusing the existing `invite_codes` table) as the
 * single point of entry. Until a LINE user runs `/link <code>` and that code
 * validates, their messages are politely refused.
 *
 * Once linked, the LINE user is bound to an internal `users.id` so all the
 * normal flows (memory, files, quota, orchestrator) work without modification.
 */

import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcrypt';
import { dbGet, dbRun } from '../../db.js';
import { config } from '../../config.js';
import { getLineDefaultQuotaUsd } from '../lineSettings.js';

export interface LineUserRow {
  line_user_id: string;
  internal_user_id: string;
  display_name: string | null;
  linked_via: string;
  current_conv_id: string | null;
  last_message_at: string;
  created_at: string;
}

export async function getLineUser(lineUserId: string): Promise<LineUserRow | null> {
  const row = await dbGet<LineUserRow>(
    'SELECT line_user_id, internal_user_id, display_name, linked_via, current_conv_id, last_message_at, created_at FROM line_users WHERE line_user_id = ?',
    lineUserId,
  );
  return row ?? null;
}

/**
 * Validates the invite code, provisions or finds an internal user, and
 * persists the LINE ↔ user mapping. Returns the resulting mapping row.
 *
 * Errors throw with `code` field so the caller can map to friendly LINE replies.
 */
export class LinkError extends Error {
  code: 'already_linked' | 'invalid_code' | 'inactive_code';
  constructor(code: LinkError['code'], message: string) {
    super(message);
    this.code = code;
    this.name = 'LinkError';
  }
}

export async function linkLineUser(opts: {
  lineUserId: string;
  inviteCode: string;
  displayName: string | null;
}): Promise<LineUserRow> {
  const existing = await getLineUser(opts.lineUserId);
  if (existing) {
    throw new LinkError('already_linked', 'LINE 帳號已綁定');
  }

  const code = await dbGet<{ id: string; is_active: number; label: string }>(
    'SELECT id, is_active, label FROM invite_codes WHERE code = ?',
    opts.inviteCode.trim(),
  );
  if (!code) throw new LinkError('invalid_code', '邀請碼不存在');
  if (!code.is_active) throw new LinkError('inactive_code', '邀請碼已停用');

  // Auto-provision an internal user. The placeholder email is unique per LINE
  // user; password_hash uses an unguessable random salt — login via web only
  // works after the user manually links their LINE account in the web UI (TBD).
  const internalUserId = uuidv4();
  const placeholderEmail = `line:${opts.lineUserId}@bot.local`;
  const password = uuidv4();
  const hash = await bcrypt.hash(password, config.bcryptRounds);
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

  await dbRun(
    `INSERT INTO users
       (id, email, password_hash, display_name, role, status, quota_override, invite_code_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'user', 'active', ?, ?, ?, ?)`,
    internalUserId,
    placeholderEmail,
    hash,
    opts.displayName ?? 'LINE User',
    getLineDefaultQuotaUsd(),
    code.id,
    now,
    now,
  );

  await dbRun(
    'INSERT INTO line_users (line_user_id, internal_user_id, display_name, linked_via, last_message_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    opts.lineUserId,
    internalUserId,
    opts.displayName,
    'invite_code',
    now,
    now,
  );

  await dbRun(
    'UPDATE invite_codes SET used_count = used_count + 1 WHERE id = ?',
    code.id,
  );

  return (await getLineUser(opts.lineUserId))!;
}

/**
 * Updates the active conversation pointer and last-message timestamp.
 * Used by the conversation router after each successful turn.
 */
export async function touchLineUser(lineUserId: string, conversationId: string | null): Promise<void> {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  if (conversationId) {
    await dbRun(
      'UPDATE line_users SET current_conv_id = ?, last_message_at = ? WHERE line_user_id = ?',
      conversationId, now, lineUserId,
    );
  } else {
    await dbRun(
      'UPDATE line_users SET last_message_at = ? WHERE line_user_id = ?',
      now, lineUserId,
    );
  }
}
