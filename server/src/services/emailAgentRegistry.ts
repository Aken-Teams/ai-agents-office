/**
 * Email Agent Connection Registry — manages persistent SSE connections
 * and per-user polling timers for proactive email monitoring.
 * Only active in DEPLOY_MODE=pro-panjit.
 */
import type { Response } from 'express';
import { dbGet, dbRun } from '../db.js';
import { pollNewEmails } from './emailAgentPoller.js';

const KEEPALIVE_INTERVAL = 10_000;   // 10s
const POLL_INTERVAL = 3 * 60_000;    // 3 min

export interface EmailAgentEvent {
  type: 'new_emails' | 'ai_analysis' | 'ai_response_delta' | 'ai_response_done'
      | 'error' | 'status' | 'keepalive';
  data?: unknown;
}

interface UserConnection {
  res: Response;
  pollTimer: NodeJS.Timeout;
  keepaliveTimer: NodeJS.Timeout;
  lastSeenIds: Set<string>;
}

const connections = new Map<string, UserConnection>();

/**
 * Register a new SSE connection for a user.
 * If a stale connection exists, close it first.
 */
export async function registerConnection(userId: string, res: Response): Promise<void> {
  // Close stale connection if any
  if (connections.has(userId)) {
    unregisterConnection(userId);
  }

  // Load last-seen IDs from DB
  const state = await dbGet<{ last_seen_ids: string | null }>(
    'SELECT last_seen_ids FROM email_agent_state WHERE user_id = ?', userId
  );
  const lastSeenIds = new Set<string>(
    state?.last_seen_ids ? JSON.parse(state.last_seen_ids) : []
  );

  // Keepalive timer
  const keepaliveTimer = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch { /* closed */ }
  }, KEEPALIVE_INTERVAL);

  // Poll timer — initial poll sends welcome batch, then regular polls every 3 min
  const doRegularPoll = () => {
    pollNewEmails(userId, false).catch(err =>
      console.error(`[EmailAgent] Poll error for ${userId}:`, err)
    );
  };
  // Initial poll: always send recent unread emails
  pollNewEmails(userId, true).catch(err =>
    console.error(`[EmailAgent] Initial poll error for ${userId}:`, err)
  );
  const pollTimer = setInterval(doRegularPoll, POLL_INTERVAL);

  connections.set(userId, { res, pollTimer, keepaliveTimer, lastSeenIds });

  // Send connected status
  pushEvent(userId, { type: 'status', data: { connected: true } });
  console.log(`[EmailAgent] User ${userId} connected (${connections.size} total)`);
}

/**
 * Unregister a user's SSE connection, persist state, clean up timers.
 */
export function unregisterConnection(userId: string): void {
  const conn = connections.get(userId);
  if (!conn) return;

  clearInterval(conn.keepaliveTimer);
  clearInterval(conn.pollTimer);

  // Persist last-seen IDs (fire-and-forget)
  const idsArray = [...conn.lastSeenIds].slice(0, 50); // cap stored IDs
  dbRun(
    `INSERT INTO email_agent_state (user_id, last_seen_ids, last_poll_at)
     VALUES (?, ?, NOW())
     ON DUPLICATE KEY UPDATE last_seen_ids = VALUES(last_seen_ids), last_poll_at = NOW()`,
    userId, JSON.stringify(idsArray)
  ).catch(() => {});

  connections.delete(userId);
  console.log(`[EmailAgent] User ${userId} disconnected (${connections.size} total)`);
}

/**
 * Push an SSE event to a connected user.
 */
export function pushEvent(userId: string, event: EmailAgentEvent): void {
  const conn = connections.get(userId);
  if (!conn) return;
  try {
    conn.res.write(`data: ${JSON.stringify(event)}\n\n`);
  } catch {
    // Connection broken — clean up
    unregisterConnection(userId);
  }
}

/**
 * Get the last-seen IDs set for a connected user.
 */
export function getLastSeenIds(userId: string): Set<string> | null {
  return connections.get(userId)?.lastSeenIds ?? null;
}

/**
 * Update the last-seen IDs for a connected user.
 */
export function updateLastSeenIds(userId: string, ids: Set<string>): void {
  const conn = connections.get(userId);
  if (conn) conn.lastSeenIds = ids;
}

export function isConnected(userId: string): boolean {
  return connections.has(userId);
}
