/**
 * Email Agent Connection Registry — manages persistent SSE connections
 * and per-user polling timers for proactive email monitoring.
 * Only active in DEPLOY_MODE=pro-panjit.
 */
import type { Response } from 'express';
import { dbGet, dbRun } from '../db.js';
import { pollNewEmails } from './emailAgentPoller.js';

const KEEPALIVE_INTERVAL = 10_000;   // 10s
const POLL_INTERVAL = 60_000;         // 1 min

export interface EmailAgentEvent {
  type: 'new_emails' | 'ai_analysis' | 'ai_response_delta' | 'ai_response_done'
      | 'error' | 'status' | 'keepalive';
  data?: unknown;
}

interface UserConnection {
  id: number;          // unique connection ID to prevent stale close handlers
  res: Response;
  pollTimer: ReturnType<typeof setTimeout>;
  keepaliveTimer: ReturnType<typeof setInterval>;
  lastSeenIds: Set<string>;
  aiEnabled: boolean;  // false = pure-view (no AI summaries, no tokens)
}

// Track active AI tasks per user so reconnecting clients can restore animation state.
// Keys are task descriptors like "analyze:<emailId>" or "chat".
const activeTasks = new Map<string, Set<string>>();

let nextConnId = 1;

const connections = new Map<string, UserConnection>();

/** Schedule the next regular poll using setTimeout (self-rescheduling). */
function scheduleNextPoll(userId: string): void {
  const conn = connections.get(userId);
  if (!conn) return;

  conn.pollTimer = setTimeout(async () => {
    if (!connections.has(userId)) return;
    console.log(`[EmailAgent] Regular poll tick for user ${userId}`);
    try {
      await pollNewEmails(userId, false, conn.aiEnabled);
    } catch (err) {
      console.error(`[EmailAgent] Poll error for ${userId}:`, err);
    }
    // Schedule next poll (self-rescheduling chain)
    scheduleNextPoll(userId);
  }, POLL_INTERVAL);
}

/**
 * Register a new SSE connection for a user.
 * If a stale connection exists, close it first.
 */
export async function registerConnection(userId: string, res: Response, aiEnabled = true): Promise<void> {
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

  // Keepalive timer — detect dead connections
  const keepaliveTimer = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch {
      console.warn(`[EmailAgent] Keepalive write failed for ${userId}, cleaning up`);
      unregisterConnection(userId);
    }
  }, KEEPALIVE_INTERVAL);

  // Store connection FIRST so pollNewEmails can find it via getLastSeenIds
  const connId = nextConnId++;
  const conn: UserConnection = { id: connId, res, pollTimer: null as any, keepaliveTimer, lastSeenIds, aiEnabled };
  connections.set(userId, conn);

  // Send connected status (include any active AI tasks so client can restore animation)
  const currentTasks = getActiveTasks(userId);
  pushEvent(userId, { type: 'status', data: { connected: true, activeTasks: currentTasks } });
  console.log(`[EmailAgent] User ${userId} connected (${connections.size} total, activeTasks=${currentTasks.length})`);

  // Initial poll: stream the inbox. AI summaries only when the user opted in;
  // otherwise pure-view (list only, no AI, no tokens).
  pollNewEmails(userId, true, aiEnabled).catch(err =>
    console.error(`[EmailAgent] Initial poll error for ${userId}:`, err)
  );

  // Start the recurring poll chain (self-rescheduling setTimeout)
  scheduleNextPoll(userId);
}

/**
 * Unregister a user's SSE connection, persist state, clean up timers.
 */
export function unregisterConnection(userId: string): void {
  const conn = connections.get(userId);
  if (!conn) return;

  clearInterval(conn.keepaliveTimer);
  clearTimeout(conn.pollTimer);

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
 * Returns false if the write failed (connection likely dead).
 */
export function pushEvent(userId: string, event: EmailAgentEvent): boolean {
  const conn = connections.get(userId);
  if (!conn) return false;
  try {
    conn.res.write(`data: ${JSON.stringify(event)}\n\n`);
    return true;
  } catch {
    // Connection broken — log but don't unregister here.
    // The keepalive timer or req.on('close') will handle cleanup.
    // This prevents killing poll timers mid-flight.
    console.warn(`[EmailAgent] pushEvent write failed for ${userId} (event=${event.type})`);
    return false;
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

/**
 * Get the current connection ID for a user.
 * Used by the route close handler to avoid killing a newer connection.
 */
export function getConnectionId(userId: string): number | null {
  return connections.get(userId)?.id ?? null;
}

/**
 * Safely unregister only if the connection ID matches (prevents stale close handlers
 * from killing a newer connection that replaced the old one).
 */
export function unregisterIfMatch(userId: string, connId: number): void {
  const conn = connections.get(userId);
  if (conn && conn.id === connId) {
    unregisterConnection(userId);
  }
}

/** Mark an AI task as active for a user. */
export function markTaskActive(userId: string, taskKey: string): void {
  let tasks = activeTasks.get(userId);
  if (!tasks) { tasks = new Set(); activeTasks.set(userId, tasks); }
  tasks.add(taskKey);
  pushEvent(userId, { type: 'status', data: { activeTasks: [...tasks] } });
}

/** Mark an AI task as completed for a user. */
export function markTaskDone(userId: string, taskKey: string): void {
  const tasks = activeTasks.get(userId);
  if (tasks) {
    tasks.delete(taskKey);
    if (tasks.size === 0) activeTasks.delete(userId);
  }
  pushEvent(userId, { type: 'status', data: { activeTasks: tasks ? [...tasks] : [] } });
}

/** Get current active tasks for a user (used on reconnect). */
export function getActiveTasks(userId: string): string[] {
  return [...(activeTasks.get(userId) ?? [])];
}
