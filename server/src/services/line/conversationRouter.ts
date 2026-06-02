/**
 * Decides which conversation a LINE message attaches to.
 *
 * Strategy: one rolling "assistant" conversation per LINE user. Reused as long
 * as the user has been active within LINE_CONVERSATION_IDLE_HOURS. Idle past
 * that threshold → start a new conversation so the orchestrator's memory
 * extraction can summarize the prior thread cleanly. Slash command `/new`
 * forces a rotation regardless of idle time.
 *
 * Always uses `category='assistant'` so the orchestrator pulls in cross-
 * conversation summaries and treats the LINE thread as a personal-assistant
 * dialogue, not a one-shot document request.
 */

import { v4 as uuidv4 } from 'uuid';
import { dbGet, dbRun } from '../../db.js';
import { getLineIdleHours } from '../lineSettings.js';
import type { Conversation } from '../../types.js';
import { touchLineUser, type LineUserRow } from './userMapping.js';

const IDLE_MS = () => getLineIdleHours() * 60 * 60 * 1000;

export async function getOrCreateLineConversation(
  lineUser: LineUserRow,
  opts: { forceNew?: boolean } = {},
): Promise<Conversation> {
  const internalUserId = lineUser.internal_user_id;

  if (!opts.forceNew && lineUser.current_conv_id) {
    const idleMs = Date.now() - new Date(lineUser.last_message_at + 'Z').getTime();
    if (idleMs >= 0 && idleMs < IDLE_MS()) {
      const conv = await dbGet<Conversation>(
        "SELECT * FROM conversations WHERE id = ? AND user_id = ? AND status != 'deleted'",
        lineUser.current_conv_id,
        internalUserId,
      );
      if (conv) return conv;
    }
  }

  const id = uuidv4();
  await dbRun(
    'INSERT INTO conversations (id, user_id, title, skill_id, mode, category) VALUES (?, ?, ?, ?, ?, ?)',
    id,
    internalUserId,
    'LINE 對話',
    null,
    null,
    'assistant',
  );

  await touchLineUser(lineUser.line_user_id, id);

  const conv = await dbGet<Conversation>('SELECT * FROM conversations WHERE id = ?', id);
  if (!conv) throw new Error('Failed to fetch newly created conversation');
  return conv;
}
