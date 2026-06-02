/**
 * Admin-controlled runtime LINE bot settings, persisted in `system_settings`
 * and cached in-process for synchronous reads (the LINE message path reads
 * these per-message). Each value defaults to its config.line (env) value, so
 * behaviour is unchanged until an admin overrides it from the web UI.
 *
 * Keys: line_max_msg_per_min, line_conversation_idle_hours,
 *       line_file_share_ttl_days, line_default_quota_usd
 *
 * Mirrors the cached pattern in llmSettings.ts (loaded at startup, refreshed
 * on admin write) so consumers can read synchronously.
 */
import { dbGet, dbRun } from '../db.js';
import { config } from '../config.js';

export interface LineSettings {
  maxMsgPerMin: number;
  conversationIdleHours: number;
  fileShareTtlDays: number;
  defaultQuotaUsd: number;
}

const KEY: Record<keyof LineSettings, string> = {
  maxMsgPerMin: 'line_max_msg_per_min',
  conversationIdleHours: 'line_conversation_idle_hours',
  fileShareTtlDays: 'line_file_share_ttl_days',
  defaultQuotaUsd: 'line_default_quota_usd',
};

// Defaults come from env (config.line); overridden by system_settings on load.
let cache: LineSettings = {
  maxMsgPerMin: config.line.maxMsgPerMin,
  conversationIdleHours: config.line.conversationIdleHours,
  fileShareTtlDays: config.line.fileShareTtlDays,
  defaultQuotaUsd: config.line.defaultQuotaUsd,
};

async function readNum(key: string, fallback: number): Promise<number> {
  const row = await dbGet<{ value: string }>('SELECT value FROM system_settings WHERE `key` = ?', key);
  if (!row) return fallback;
  const n = parseFloat(row.value);
  return Number.isFinite(n) ? n : fallback;
}

/** Load overrides from system_settings into the in-process cache (call at startup). */
export async function loadLineSettings(): Promise<void> {
  cache = {
    maxMsgPerMin: await readNum(KEY.maxMsgPerMin, config.line.maxMsgPerMin),
    conversationIdleHours: await readNum(KEY.conversationIdleHours, config.line.conversationIdleHours),
    fileShareTtlDays: await readNum(KEY.fileShareTtlDays, config.line.fileShareTtlDays),
    defaultQuotaUsd: await readNum(KEY.defaultQuotaUsd, config.line.defaultQuotaUsd),
  };
}

export function getLineSettings(): LineSettings {
  return { ...cache };
}

export function getLineMaxMsgPerMin(): number { return cache.maxMsgPerMin; }
export function getLineIdleHours(): number { return cache.conversationIdleHours; }
export function getLineFileShareTtlDays(): number { return cache.fileShareTtlDays; }
export function getLineDefaultQuotaUsd(): number { return cache.defaultQuotaUsd; }

/** Persist one setting and refresh the cache so the change takes effect immediately. */
export async function setLineSetting(key: keyof LineSettings, value: number): Promise<void> {
  await dbRun('REPLACE INTO system_settings (`key`, value) VALUES (?, ?)', KEY[key], String(value));
  cache[key] = value;
}
