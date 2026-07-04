import { v4 as uuidv4 } from 'uuid';
import { dbGet, dbAll, dbRun } from '../db.js';
import { pricingMarkupSql } from '../config.js';

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
  cost: number;
}>> {
  // Per-day cost is boundary-exact (each record at its era's markup), so summing
  // days over any range gives the same total as every other billing view.
  let query = `
    SELECT
      DATE_FORMAT(created_at, '%Y-%m-%d') as date,
      SUM(input_tokens) as total_input,
      SUM(output_tokens) as total_output,
      COUNT(*) as invocation_count,
      COALESCE(SUM((input_tokens / 1000000 * 3 + output_tokens / 1000000 * 15) * ${pricingMarkupSql('created_at')}), 0) as cost
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

export type UsageCategory = 'document' | 'team' | 'email';
export interface DailyUsage {
  date: string;
  total_input: number;
  total_output: number;
  invocation_count: number;
  cost: number;
}

/**
 * Same daily breakdown as getUserUsageSummary but split into the three product
 * surfaces the user actually uses:
 *   - email    → the 信件助手 conversation (title '信件助手')
 *   - team     → AI 團隊 runs/reports (model 'team-run' / 'team-report')
 *   - document → everything else (this app is fundamentally a document generator)
 */
export async function getUserUsageSummaryByCategory(
  userId: string,
  from?: string,
  to?: string,
): Promise<Record<UsageCategory, DailyUsage[]>> {
  // Category is derived from a CASE; under sql_mode=only_full_group_by we must
  // GROUP BY the full expressions (not the aliases), so define it once.
  const CATEGORY_EXPR = `CASE WHEN c.title = '信件助手' THEN 'email' WHEN tu.model LIKE 'team%' THEN 'team' ELSE 'document' END`;
  let query = `
    SELECT
      DATE_FORMAT(tu.created_at, '%Y-%m-%d') as date,
      ${CATEGORY_EXPR} as category,
      SUM(tu.input_tokens) as total_input,
      SUM(tu.output_tokens) as total_output,
      COUNT(*) as invocation_count,
      COALESCE(SUM((tu.input_tokens / 1000000 * 3 + tu.output_tokens / 1000000 * 15) * ${pricingMarkupSql('tu.created_at')}), 0) as cost
    FROM token_usage tu
    LEFT JOIN conversations c ON c.id = tu.conversation_id
    WHERE tu.user_id = ?
  `;
  const params: unknown[] = [userId];
  if (from) { query += ' AND tu.created_at >= ?'; params.push(from); }
  if (to)   { query += ' AND tu.created_at <= ?'; params.push(to); }
  query += ` GROUP BY DATE_FORMAT(tu.created_at, '%Y-%m-%d'), ${CATEGORY_EXPR} ORDER BY date DESC`;

  const rows = await dbAll<DailyUsage & { category: UsageCategory }>(query, ...params);
  const out: Record<UsageCategory, DailyUsage[]> = { document: [], team: [], email: [] };
  for (const r of rows) {
    const { category, ...daily } = r;
    (out[category] ?? out.document).push(daily);
  }
  return out;
}

/**
 * Invocation counts split by product surface (document / team / email). Same
 * categorisation as getUserUsageSummaryByCategory. Used by the dashboard's
 * "本月文件生成" stat (which should count DOCUMENTS only, with a hover breakdown).
 */
export async function getUserCategoryCounts(
  userId: string,
  monthlyOnly = false,
): Promise<Record<UsageCategory, number>> {
  const CATEGORY_EXPR = `CASE WHEN c.title = '信件助手' THEN 'email' WHEN tu.model LIKE 'team%' THEN 'team' ELSE 'document' END`;
  let query = `
    SELECT ${CATEGORY_EXPR} as category, COUNT(*) as n
    FROM token_usage tu
    LEFT JOIN conversations c ON c.id = tu.conversation_id
    WHERE tu.user_id = ?`;
  const params: unknown[] = [userId];
  if (monthlyOnly) {
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    query += ' AND tu.created_at >= ?';
    params.push(monthStart);
  }
  query += ` GROUP BY ${CATEGORY_EXPR}`;
  const rows = await dbAll<{ category: UsageCategory; n: number }>(query, ...params);
  const out: Record<UsageCategory, number> = { document: 0, team: 0, email: 0 };
  for (const r of rows) out[r.category] = Number(r.n);
  return out;
}

export async function getUserTotalUsage(userId: string, monthlyOnly = false): Promise<{
  totalInput: number;
  totalOutput: number;
  totalInvocations: number;
  cost: number;
}> {
  let query = `SELECT
    COALESCE(SUM(input_tokens), 0) as total_input,
    COALESCE(SUM(output_tokens), 0) as total_output,
    COUNT(*) as total_invocations,
    COALESCE(SUM((input_tokens / 1000000 * 3 + output_tokens / 1000000 * 15) * ${pricingMarkupSql('created_at')}), 0) as cost
  FROM token_usage
  WHERE user_id = ?`;
  const params: unknown[] = [userId];

  if (monthlyOnly) {
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    query += ' AND created_at >= ?';
    params.push(monthStart);
  }

  const result = await dbGet<{ total_input: number; total_output: number; total_invocations: number; cost: number }>(
    query, ...params
  );

  return {
    totalInput: result?.total_input ?? 0,
    totalOutput: result?.total_output ?? 0,
    totalInvocations: result?.total_invocations ?? 0,
    cost: result?.cost ?? 0,
  };
}
