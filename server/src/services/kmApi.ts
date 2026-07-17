/**
 * KM (knowledge management) integration helpers for the main server process.
 *
 * KM scopes access per user via the `X-On-Behalf-Of: <員編>` header, and the
 * user's AD username IS their 員編 (login is by 工號). So "who is this user to KM"
 * is simply their stored ad_username. This module resolves that; the actual KM
 * calls happen inside the km-mcp subprocess (server/src/mcp/kmMcp.ts), spawned by
 * claudeCli with KM_ON_BEHALF set to this value.
 */
import { config } from '../config.js';
import { dbGet } from '../db.js';

/** True when KM is usable in this deployment (pro-panjit + a system API key set). */
export function kmEnabled(): boolean {
  return config.deployMode === 'pro-panjit' && !!config.kmApiKey;
}

/**
 * Resolve the KM on-behalf value (the user's AD 員編) for a given app user.
 * Returns null if KM isn't enabled or the user has no AD username (e.g. an
 * email/password account that never logged in via AD).
 */
export async function getKmOnBehalf(userId: string): Promise<string | null> {
  if (!kmEnabled()) return null;
  try {
    const row = await dbGet<{ ad_username: string | null }>(
      'SELECT ad_username FROM users WHERE id = ?',
      userId,
    );
    const emp = (row?.ad_username || '').trim();
    return emp || null;
  } catch (err) {
    console.warn('[KM] getKmOnBehalf failed:', err);
    return null;
  }
}
