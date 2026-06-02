import { v4 as uuidv4 } from 'uuid';
import { dbGet, dbAll, dbRun } from '../db.js';

/**
 * Token usage tracking. `provider` separates billing buckets:
 *   - 'claude'    → Anthropic Claude CLI (主力 orchestration)
 *   - 'local-llm' → 地端 OpenAI-compatible LLM (簡單對話 fast-path)
 *   - 'deepseek'  → DeepSeek admin classification (legacy)
 *
 * 同一個 conversation 可能在不同 turn 走不同 provider，因此每筆 record 都各自記。
 */
export type TokenProvider = 'claude' | 'local-llm' | 'deepseek';

interface TokenUsageRecord {
  userId: string;
  conversationId: string | null;
  inputTokens: number;
  outputTokens: number;
  model?: string;
  provider?: TokenProvider;
  durationMs?: number;
}

export async function recordTokenUsage(record: TokenUsageRecord): Promise<string> {
  const id = uuidv4();
  await dbRun(
    `INSERT INTO token_usage (id, user_id, conversation_id, input_tokens, output_tokens, model, provider, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    record.userId,
    record.conversationId,
    record.inputTokens,
    record.outputTokens,
    record.model || null,
    record.provider || inferProvider(record.model),
    record.durationMs || null,
  );
  return id;
}

/**
 * Fallback for callers that forget to pass `provider`.
 * Matches the same heuristic as the DB migration backfill.
 */
function inferProvider(model?: string): TokenProvider {
  if (!model) return 'claude';
  const m = model.toLowerCase();
  if (m.startsWith('claude')) return 'claude';
  if (m.startsWith('mlx') || m.startsWith('local') || m.startsWith('ollama')) return 'local-llm';
  if (m.startsWith('deepseek')) return 'deepseek';
  return 'claude';
}

/* ============================================================
   Daily aggregates (per user, total — kept for backwards compat)
   ============================================================ */

export async function getUserUsageSummary(
  userId: string,
  from?: string,
  to?: string
): Promise<Array<{
  date: string;
  total_input: number;
  total_output: number;
  invocation_count: number;
}>> {
  let query = `
    SELECT
      DATE_FORMAT(created_at, '%Y-%m-%d') as date,
      SUM(input_tokens) as total_input,
      SUM(output_tokens) as total_output,
      COUNT(*) as invocation_count
    FROM token_usage
    WHERE user_id = ?
  `;
  const params: unknown[] = [userId];

  if (from) {
    query += ' AND created_at >= ?';
    params.push(from);
  }
  if (to) {
    query += ' AND created_at <= ?';
    params.push(to);
  }

  query += ' GROUP BY DATE_FORMAT(created_at, \'%Y-%m-%d\') ORDER BY date DESC';

  return await dbAll(query, ...params);
}

/* ============================================================
   Split-by-provider summaries (used by usage page + admin)
   ============================================================ */

export async function getUserUsageSummaryByProvider(
  userId: string,
  from?: string,
  to?: string
): Promise<Array<{
  date: string;
  provider: string;
  total_input: number;
  total_output: number;
  invocation_count: number;
}>> {
  let query = `
    SELECT
      DATE_FORMAT(created_at, '%Y-%m-%d') as date,
      COALESCE(provider, 'claude') as provider,
      SUM(input_tokens) as total_input,
      SUM(output_tokens) as total_output,
      COUNT(*) as invocation_count
    FROM token_usage
    WHERE user_id = ?
  `;
  const params: unknown[] = [userId];
  if (from) { query += ' AND created_at >= ?'; params.push(from); }
  if (to)   { query += ' AND created_at <= ?'; params.push(to); }
  query += ` GROUP BY DATE_FORMAT(created_at, '%Y-%m-%d'), provider ORDER BY date DESC, provider`;
  return await dbAll(query, ...params);
}

export async function getUserTotalUsage(userId: string): Promise<{
  totalInput: number;
  totalOutput: number;
  totalInvocations: number;
}> {
  const result = await dbGet<{ total_input: number; total_output: number; total_invocations: number }>(
    `SELECT
      COALESCE(SUM(input_tokens), 0) as total_input,
      COALESCE(SUM(output_tokens), 0) as total_output,
      COUNT(*) as total_invocations
    FROM token_usage
    WHERE user_id = ?`,
    userId
  );

  return {
    totalInput: result?.total_input ?? 0,
    totalOutput: result?.total_output ?? 0,
    totalInvocations: result?.total_invocations ?? 0,
  };
}

export async function getUserTotalUsageByProvider(userId: string): Promise<Array<{
  provider: string;
  totalInput: number;
  totalOutput: number;
  totalInvocations: number;
}>> {
  const rows = await dbAll<{
    provider: string;
    total_input: number;
    total_output: number;
    total_invocations: number;
  }>(
    `SELECT
      COALESCE(provider, 'claude') as provider,
      COALESCE(SUM(input_tokens), 0) as total_input,
      COALESCE(SUM(output_tokens), 0) as total_output,
      COUNT(*) as total_invocations
    FROM token_usage
    WHERE user_id = ?
    GROUP BY provider
    ORDER BY total_input + total_output DESC`,
    userId
  );

  return rows.map(r => ({
    provider: r.provider,
    totalInput: r.total_input,
    totalOutput: r.total_output,
    totalInvocations: r.total_invocations,
  }));
}
