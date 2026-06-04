/**
 * LINE user ↔ internal user mapping.
 *
 * Accounts are created on the web. LINE only ever *binds* to an existing
 * internal user: a logged-in user mints a bind token (line_link_tokens), and
 * running `/link <token>` in LINE attaches their LINE account to that user.
 * There is no LINE-side account registration.
 *
 * Once bound, the LINE user uses the same internal `users.id` so all the
 * normal flows (memory, files, quota, orchestrator) work without modification.
 */

import { dbGet, dbRun } from '../../db.js';
import { consumeBindToken } from './qrAuth.js';

export interface LineUserRow {
  line_user_id: string;
  internal_user_id: string;
  display_name: string | null;
  linked_via: string;
  current_conv_id: string | null;
  active_team_id: string | null;
  pending_sched: string | null;
  disabled: number;
  last_message_at: string;
  created_at: string;
}

export async function getLineUser(lineUserId: string): Promise<LineUserRow | null> {
  const row = await dbGet<LineUserRow>(
    'SELECT line_user_id, internal_user_id, display_name, linked_via, current_conv_id, active_team_id, pending_sched, disabled, last_message_at, created_at FROM line_users WHERE line_user_id = ?',
    lineUserId,
  );
  return row ?? null;
}

/** Store (or clear) the pending multi-step state JSON for this LINE user. */
export async function setLinePendingSched(lineUserId: string, value: string | null): Promise<void> {
  await dbRun('UPDATE line_users SET pending_sched = ? WHERE line_user_id = ?', value, lineUserId);
}

/**
 * Admin "suspend / restore" a LINE user. The binding is kept intact — a
 * disabled user simply can't chat until re-enabled, then returns to exactly the
 * state (account, team, history) they had before.
 */
export async function setLineUserDisabled(lineUserId: string, disabled: boolean): Promise<void> {
  await dbRun('UPDATE line_users SET disabled = ? WHERE line_user_id = ?', disabled ? 1 : 0, lineUserId);
}

/**
 * Switch which "brain" handles this LINE user's messages: a team id routes
 * through that team's collaboration; null returns to the single rolling
 * assistant. The team is validated for ownership by the caller.
 */
export async function setLineActiveTeam(lineUserId: string, teamId: string | null): Promise<void> {
  await dbRun(
    'UPDATE line_users SET active_team_id = ? WHERE line_user_id = ?',
    teamId, lineUserId,
  );
}

/**
 * Errors thrown by the bind flow, carrying a `code` field so the caller can
 * map to friendly LINE replies.
 */
export class LinkError extends Error {
  code: 'already_linked' | 'invalid_code' | 'user_already_bound' | 'blocked';
  constructor(code: LinkError['code'], message: string) {
    super(message);
    this.code = code;
    this.name = 'LinkError';
  }
}

/**
 * Bind a LINE account to an existing internal user via a one-shot bind token.
 * The token (line_link_tokens) is minted by a logged-in web user; this never
 * creates a new account. Returns the resulting mapping row.
 */
export async function linkLineUser(opts: {
  lineUserId: string;
  inviteCode: string; // the bind token from the QR / `/link <token>`
  displayName: string | null;
}): Promise<LineUserRow> {
  const existing = await getLineUser(opts.lineUserId);
  if (existing) {
    throw new LinkError('already_linked', 'LINE 帳號已綁定');
  }

  // Validate + atomically consume the bind token → target internal user id.
  const internalUserId = await consumeBindToken(opts.inviteCode.trim());
  if (!internalUserId) {
    throw new LinkError('invalid_code', '綁定碼無效或已過期，請回網頁重新產生');
  }

  // One internal user ↔ one LINE account: if this account already had a
  // different LINE bound, reject rather than silently re-pointing it.
  const alreadyBound = await dbGet<{ line_user_id: string }>(
    'SELECT line_user_id FROM line_users WHERE internal_user_id = ?',
    internalUserId,
  );
  if (alreadyBound) {
    throw new LinkError('user_already_bound', '此帳號已綁定其他 LINE，請先在網頁解除綁定');
  }

  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  await dbRun(
    'INSERT INTO line_users (line_user_id, internal_user_id, display_name, linked_via, last_message_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    opts.lineUserId,
    internalUserId,
    opts.displayName,
    'account_bind',
    now,
    now,
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
