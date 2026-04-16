import { dbGet, dbRun } from '../db.js';

/**
 * Get the global per-user usage limit in display dollars (x10 markup).
 * Configurable by admin via system_settings table.
 */
export async function getUserUsageLimitUsd(): Promise<number> {
  const row = await dbGet<{ value: string }>("SELECT value FROM system_settings WHERE `key` = 'user_usage_limit_usd'");
  return row ? parseFloat(row.value) : 50;
}

/**
 * Set the global per-user usage limit.
 */
export async function setUserUsageLimitUsd(value: number): Promise<void> {
  await dbRun(
    "REPLACE INTO system_settings (`key`, value) VALUES (?, ?)",
    'user_usage_limit_usd', String(value)
  );
}

/**
 * Calculate user's total cost in display dollars (x10 markup).
 * Claude Sonnet 4 pricing: $3/M input, $15/M output, then x10 billing markup.
 */
export async function getUserDisplayCost(userId: string): Promise<number> {
  const row = await dbGet<{ total_input: number; total_output: number }>(
    'SELECT COALESCE(SUM(input_tokens), 0) AS total_input, COALESCE(SUM(output_tokens), 0) AS total_output FROM token_usage WHERE user_id = ?',
    userId
  );
  if (!row) return 0;
  return ((row.total_input / 1_000_000) * 3 + (row.total_output / 1_000_000) * 15) * 10;
}

/**
 * Get the effective usage limit for a specific user.
 * Checks for per-user quota_override first (available in all deploy modes).
 * Falls back to global limit.
 */
export async function getEffectiveUserLimit(userId: string): Promise<number> {
  const user = await dbGet<{ quota_override: number | null }>(
    'SELECT quota_override FROM users WHERE id = ?', userId
  );
  if (user?.quota_override != null) {
    return user.quota_override;
  }
  return getUserUsageLimitUsd();
}

/**
 * Check if user has exceeded their usage limit.
 * Returns { exceeded, cost, limit }
 */
export async function checkUserUsageLimit(userId: string): Promise<{ exceeded: boolean; cost: number; limit: number }> {
  const limit = await getEffectiveUserLimit(userId);
  const cost = await getUserDisplayCost(userId);
  return { exceeded: cost >= limit, cost, limit };
}

// --- Storage Quota Settings ---

export async function getStorageQuotaGb(): Promise<number> {
  const row = await dbGet<{ value: string }>("SELECT value FROM system_settings WHERE `key` = 'storage_quota_gb'");
  return row ? parseFloat(row.value) : 2;
}

export async function setStorageQuotaGb(value: number): Promise<void> {
  await dbRun(
    "REPLACE INTO system_settings (`key`, value) VALUES (?, ?)",
    'storage_quota_gb', String(value)
  );
}

export async function getUploadQuotaMb(): Promise<number> {
  const row = await dbGet<{ value: string }>("SELECT value FROM system_settings WHERE `key` = 'upload_quota_mb'");
  return row ? parseFloat(row.value) : 500;
}

export async function setUploadQuotaMb(value: number): Promise<void> {
  await dbRun(
    "REPLACE INTO system_settings (`key`, value) VALUES (?, ?)",
    'upload_quota_mb', String(value)
  );
}
