import db from '../db.js';

/**
 * Get the per-user usage limit in display dollars (x10 markup).
 * Configurable by admin via system_settings table.
 */
export function getUserUsageLimitUsd(): number {
  const row = db.prepare("SELECT value FROM system_settings WHERE key = 'user_usage_limit_usd'").get() as { value: string } | undefined;
  return row ? parseFloat(row.value) : 50;
}

/**
 * Set the per-user usage limit.
 */
export function setUserUsageLimitUsd(value: number): void {
  db.prepare("INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)").run('user_usage_limit_usd', String(value));
}

/**
 * Calculate user's total cost in display dollars (x10 markup).
 * Claude Sonnet 4 pricing: $3/M input, $15/M output, then x10 billing markup.
 */
export function getUserDisplayCost(userId: string): number {
  const row = db.prepare(
    'SELECT COALESCE(SUM(input_tokens), 0) AS total_input, COALESCE(SUM(output_tokens), 0) AS total_output FROM token_usage WHERE user_id = ?'
  ).get(userId) as { total_input: number; total_output: number };

  return ((row.total_input / 1_000_000) * 3 + (row.total_output / 1_000_000) * 15) * 10;
}

/**
 * Check if user has exceeded their usage limit.
 * Returns { exceeded, cost, limit }
 */
export function checkUserUsageLimit(userId: string): { exceeded: boolean; cost: number; limit: number } {
  const limit = getUserUsageLimitUsd();
  const cost = getUserDisplayCost(userId);
  return { exceeded: cost >= limit, cost, limit };
}
