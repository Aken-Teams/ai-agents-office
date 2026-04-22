import { v4 as uuidv4 } from 'uuid';
import { dbGet, dbAll, dbRun } from '../db.js';

interface TokenUsageRecord {
  userId: string;
  conversationId: string | null;
  inputTokens: number;
  outputTokens: number;
  model?: string;
  durationMs?: number;
}

export async function recordTokenUsage(record: TokenUsageRecord): Promise<string> {
  const id = uuidv4();
  await dbRun(
    `INSERT INTO token_usage (id, user_id, conversation_id, input_tokens, output_tokens, model, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    record.userId,
    record.conversationId,
    record.inputTokens,
    record.outputTokens,
    record.model || null,
    record.durationMs || null,
  );
  return id;
}

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
