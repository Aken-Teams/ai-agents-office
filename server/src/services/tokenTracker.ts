import { v4 as uuidv4 } from 'uuid';
import db from '../db.js';

interface TokenUsageRecord {
  userId: string;
  conversationId: string | null;
  inputTokens: number;
  outputTokens: number;
  model?: string;
  durationMs?: number;
}

export function recordTokenUsage(record: TokenUsageRecord): string {
  const id = uuidv4();
  db.prepare(`
    INSERT INTO token_usage (id, user_id, conversation_id, input_tokens, output_tokens, model, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
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

export function getUserUsageSummary(
  userId: string,
  from?: string,
  to?: string
): Array<{
  date: string;
  total_input: number;
  total_output: number;
  invocation_count: number;
}> {
  let query = `
    SELECT
      date(created_at) as date,
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

  query += ' GROUP BY date(created_at) ORDER BY date DESC';

  return db.prepare(query).all(...params) as Array<{
    date: string;
    total_input: number;
    total_output: number;
    invocation_count: number;
  }>;
}

export function getUserTotalUsage(userId: string): {
  totalInput: number;
  totalOutput: number;
  totalInvocations: number;
} {
  const result = db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens), 0) as total_input,
      COALESCE(SUM(output_tokens), 0) as total_output,
      COUNT(*) as total_invocations
    FROM token_usage
    WHERE user_id = ?
  `).get(userId) as { total_input: number; total_output: number; total_invocations: number };

  return {
    totalInput: result.total_input,
    totalOutput: result.total_output,
    totalInvocations: result.total_invocations,
  };
}
