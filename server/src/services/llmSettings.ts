/**
 * Admin-controlled runtime toggles for the local LLM, persisted in
 * `system_settings`. The value is cached in-process for synchronous reads
 * (isLocalLlmEnabled stays sync), refreshed on startup and on admin write.
 *
 * Key: 'local_llm_enabled'  — boolean stored as 'true' / 'false'.
 *   Default (key absent): true — preserves prior env-only behaviour.
 */

import { dbGet, dbRun } from '../db.js';

let cachedEnabled: boolean = true;
let loaded = false;

export async function loadLlmSettings(): Promise<void> {
  const row = await dbGet<{ value: string }>(
    "SELECT value FROM system_settings WHERE `key` = 'local_llm_enabled'",
  );
  // Absent → default ON; otherwise honour the stored value.
  cachedEnabled = row ? row.value !== 'false' : true;
  loaded = true;
}

export function isLocalLlmEnabledSetting(): boolean {
  // If not yet loaded (e.g. very early request), be permissive — env-level
  // checks downstream still gate by baseUrl/apiKey availability.
  if (!loaded) return true;
  return cachedEnabled;
}

export async function setLocalLlmEnabledSetting(enabled: boolean): Promise<void> {
  await dbRun(
    "REPLACE INTO system_settings (`key`, value) VALUES (?, ?)",
    'local_llm_enabled', String(enabled),
  );
  cachedEnabled = enabled;
  loaded = true;
}
