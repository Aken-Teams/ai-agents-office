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

/**
 * What a million tokens actually cost us, per engine, in USD.
 *
 * Until 2026-08 every row was priced as if it were Claude Sonnet, whatever
 * actually ran it — so DeepSeek work was invoiced at ~10x its real cost, and
 * on-prem work (which costs nothing) would have been invoiced too. Charging for
 * what really happened means knowing the real rate of the engine that answered.
 *
 * The rate is stored ON THE ROW at write time (see recordTokenUsage), never
 * looked up later: providers change their prices, and an old invoice must not
 * move when they do. Rows written before this existed have NULL rates and keep
 * the Sonnet numbers, so no past invoice changes retroactively.
 */
export interface ModelRates { inputPerMTok: number; outputPerMTok: number }

const CLAUDE_RATES: ModelRates = { inputPerMTok: 3, outputPerMTok: 15 };

/**
 * DeepSeek's published rate for the id we send. Overridable because DeepSeek
 * revises pricing (and retires model ids) several times a year — check a real
 * invoice before trusting these defaults.
 */
const DEEPSEEK_RATES: ModelRates = {
  inputPerMTok: parseFloat(process.env.DEEPSEEK_INPUT_USD_PER_MTOK || '') || 0.28,
  outputPerMTok: parseFloat(process.env.DEEPSEEK_OUTPUT_USD_PER_MTOK || '') || 0.42,
};

/**
 * On-prem inference costs nothing per token — but it is NOT free to the customer
 * yet, and deliberately so.
 *
 * The on-prem box is new and its reliability is still being measured (see the
 * 地端/DeepSeek 穩定性 panel in the admin API report). Until it proves it can
 * carry the work, a call that lands there is one Claude would otherwise have
 * done, so it is priced as Claude. If the box turns out to be flaky, the work
 * silently falls through to DeepSeek/Claude anyway and the price is right either
 * way; if it proves solid, this is the single switch that makes it free:
 *
 *     LOCAL_LLM_BILLING=free
 */
const LOCAL_RATES: ModelRates = (process.env.LOCAL_LLM_BILLING || '').toLowerCase() === 'free'
  ? { inputPerMTok: 0, outputPerMTok: 0 }
  : CLAUDE_RATES;

/**
 * Price list for the engine named in `model`. Unknown names fall back to the
 * Claude rate, which is the safe direction: a new engine is over-billed and
 * noticed, rather than under-billed and silently absorbed.
 */
export function ratesForModel(model?: string | null): ModelRates {
  const raw = (model || '').toLowerCase();
  if (!raw) return CLAUDE_RATES;
  // Composite labels ("team-run:local") name the PRODUCT before the colon and the
  // ENGINE after it. The product half has to survive because the usage page
  // groups on `model LIKE 'team%'`; the engine half is what sets the price. A run
  // whose rounds were served by different engines writes one row per engine.
  const engine = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw;
  if (engine === 'local' || engine.startsWith('mlx-community/') || engine.startsWith('local/')) return LOCAL_RATES;
  if (engine.startsWith('deepseek')) return DEEPSEEK_RATES;
  return CLAUDE_RATES;
}

/**
 * The engine half of a model name, for building composite labels.
 * "mlx-community/Qwen3-…" → 'local'; "deepseek-chat" → 'deepseek'; else 'claude'.
 */
export function engineOf(model?: string | null): 'local' | 'deepseek' | 'claude' {
  const m = (model || '').toLowerCase();
  if (m.startsWith('mlx-community/') || m.startsWith('local/')) return 'local';
  if (m.startsWith('deepseek')) return 'deepseek';
  return 'claude';
}

/**
 * The cost expression, for any query that sums money.
 *
 * One definition, used everywhere, so the dashboard, the usage page, the quota
 * check and the invoice can never disagree. COALESCE keeps pre-2026-08 rows on
 * the Sonnet rate they were billed at.
 */
export function costUsdSql(tableAlias = ''): string {
  const p = tableAlias ? `${tableAlias}.` : '';
  return `(${p}input_tokens / 1000000 * COALESCE(${p}input_rate, ${CLAUDE_RATES.inputPerMTok})` +
         ` + ${p}output_tokens / 1000000 * COALESCE(${p}output_rate, ${CLAUDE_RATES.outputPerMTok}))`;
}

export async function recordTokenUsage(record: TokenUsageRecord): Promise<string> {
  const id = uuidv4();
  const rates = ratesForModel(record.model);
  await dbRun(
    `INSERT INTO token_usage (id, user_id, conversation_id, input_tokens, output_tokens, model, duration_ms, input_rate, output_rate)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    record.userId,
    record.conversationId,
    record.inputTokens,
    record.outputTokens,
    record.model || null,
    record.durationMs || null,
    rates.inputPerMTok,
    rates.outputPerMTok,
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
      COALESCE(SUM(${costUsdSql()} * ${pricingMarkupSql('created_at')}), 0) as cost
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

export type UsageCategory = 'document' | 'team' | 'email' | 'km';
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
  const CATEGORY_EXPR = `CASE WHEN c.title = '信件助手' THEN 'email' WHEN c.title = 'KM 助手' THEN 'km' WHEN tu.model LIKE 'team%' THEN 'team' ELSE 'document' END`;
  let query = `
    SELECT
      DATE_FORMAT(tu.created_at, '%Y-%m-%d') as date,
      ${CATEGORY_EXPR} as category,
      SUM(tu.input_tokens) as total_input,
      SUM(tu.output_tokens) as total_output,
      COUNT(*) as invocation_count,
      COALESCE(SUM(${costUsdSql('tu')} * ${pricingMarkupSql('tu.created_at')}), 0) as cost
    FROM token_usage tu
    LEFT JOIN conversations c ON c.id = tu.conversation_id
    WHERE tu.user_id = ?
  `;
  const params: unknown[] = [userId];
  if (from) { query += ' AND tu.created_at >= ?'; params.push(from); }
  if (to)   { query += ' AND tu.created_at <= ?'; params.push(to); }
  query += ` GROUP BY DATE_FORMAT(tu.created_at, '%Y-%m-%d'), ${CATEGORY_EXPR} ORDER BY date DESC`;

  const rows = await dbAll<DailyUsage & { category: UsageCategory }>(query, ...params);
  const out: Record<UsageCategory, DailyUsage[]> = { document: [], team: [], email: [], km: [] };
  for (const r of rows) {
    const { category, ...daily } = r;
    (out[category] ?? out.document).push(daily);
  }
  return out;
}

/**
 * Per-record usage ledger — one row per generation (not daily rollups), with its
 * product category + boundary-exact cost. Powers the front usage page's detailed
 * "by record" view. Capped to keep the payload bounded.
 */
export async function getUserUsageRecords(
  userId: string,
  from?: string,
  to?: string,
): Promise<Array<{ id: string; created_at: string; category: UsageCategory; input_tokens: number; output_tokens: number; cost: number }>> {
  const CATEGORY_EXPR = `CASE WHEN c.title = '信件助手' THEN 'email' WHEN c.title = 'KM 助手' THEN 'km' WHEN tu.model LIKE 'team%' THEN 'team' ELSE 'document' END`;
  // Format created_at in SQL to a plain string (DB stores Taipei local time) so
  // mysql2's Date parsing + JSON serialization can't shift the displayed time.
  let query = `
    SELECT tu.id, DATE_FORMAT(tu.created_at, '%Y-%m-%d %H:%i:%s') as created_at, ${CATEGORY_EXPR} as category,
      tu.input_tokens, tu.output_tokens,
      ${costUsdSql('tu')} * ${pricingMarkupSql('tu.created_at')} as cost
    FROM token_usage tu
    LEFT JOIN conversations c ON c.id = tu.conversation_id
    WHERE tu.user_id = ?`;
  const params: unknown[] = [userId];
  if (from) { query += ' AND tu.created_at >= ?'; params.push(from); }
  if (to)   { query += ' AND tu.created_at <= ?'; params.push(to); }
  query += ' ORDER BY tu.created_at DESC LIMIT 2000';
  return dbAll(query, ...params);
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
  const CATEGORY_EXPR = `CASE WHEN c.title = '信件助手' THEN 'email' WHEN c.title = 'KM 助手' THEN 'km' WHEN tu.model LIKE 'team%' THEN 'team' ELSE 'document' END`;
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
  const out: Record<UsageCategory, number> = { document: 0, team: 0, email: 0, km: 0 };
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
    COALESCE(SUM(${costUsdSql()} * ${pricingMarkupSql('created_at')}), 0) as cost
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
