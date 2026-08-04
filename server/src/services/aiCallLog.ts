/**
 * Per-spawn AI call ledger — records, for EVERY Claude CLI spawn, whether it ran
 * on the ACCOUNT (subscription / OAuth, no API bill) or fell back to the API KEY
 * (billed), which model, and WHY it fell back. This is the ground-truth audit the
 * business needs to explain the daily API-key spend.
 *
 * Accuracy guarantees:
 *  - `auth_mode` comes from spawnClaude's own `useApiKey` flag — the single source
 *    of truth. A row is 'api_key' ONLY when the CLI was actually run with
 *    ANTHROPIC_API_KEY injected; otherwise 'account'. We never guess.
 *  - `reason` explains why this attempt was spawned: 'primary' (normal account
 *    run), the fallback reason (e.g. account rate/usage limit), or a
 *    session-recovery restart.
 *  - One row per spawn ATTEMPT, so an account attempt that fails and retries on the
 *    API key produces two honest rows (account:failed, then api_key:succeeded).
 *
 * Writing is fire-and-forget and fully swallowed on error — logging must never
 * affect or slow the actual AI call. DB import is lazy so this module (and
 * claudeCli) stay importable without a DB connection (e.g. in tests).
 */
import { randomUUID } from 'crypto';

export interface AiCallRecord {
  userId?: string;
  conversationId?: string;
  role?: string;
  skillId?: string;
  model?: string | null;
  authMode: 'account' | 'api_key';
  reason?: string;          // 'primary' | fallback reason | 'session-recovery:...'
  inputTokens: number;
  outputTokens: number;
  exitCode: number | null;
  success: boolean;         // produced tokens (i.e. a real, billable/served call)
}

let ensured = false;
async function ensureTable(dbRun: (sql: string, ...p: any[]) => Promise<unknown>): Promise<void> {
  if (ensured) return;
  await dbRun(`
    CREATE TABLE IF NOT EXISTS ai_call_log (
      id              CHAR(36) PRIMARY KEY,
      created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      user_id         VARCHAR(36),
      conversation_id VARCHAR(36),
      role            VARCHAR(20),
      skill_id        VARCHAR(50),
      model           VARCHAR(100),
      auth_mode       VARCHAR(20) NOT NULL,
      reason          VARCHAR(120),
      input_tokens    INT DEFAULT 0,
      output_tokens   INT DEFAULT 0,
      exit_code       INT,
      success         TINYINT(1) DEFAULT 0,
      INDEX idx_aicall_created (created_at),
      INDEX idx_aicall_auth (auth_mode),
      INDEX idx_aicall_model (model)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  ensured = true;
}

/** Fire-and-forget: record one spawn attempt. Never throws, never blocks. */
export function logAiCall(rec: AiCallRecord): void {
  void (async () => {
    try {
      const { dbRun } = await import('../db.js');
      await ensureTable(dbRun);
      await dbRun(
        `INSERT INTO ai_call_log
          (id, user_id, conversation_id, role, skill_id, model, auth_mode, reason, input_tokens, output_tokens, exit_code, success)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        randomUUID(),
        rec.userId || null,
        rec.conversationId || null,
        rec.role || null,
        rec.skillId || null,
        rec.model || null,
        rec.authMode,
        rec.reason || null,
        rec.inputTokens || 0,
        rec.outputTokens || 0,
        rec.exitCode,
        rec.success ? 1 : 0,
      );
    } catch { /* logging must never affect the AI call */ }
  })();
}
