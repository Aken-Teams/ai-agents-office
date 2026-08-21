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

/**
 * True when this deployment can reach KM at all: pro-panjit, with a system key.
 *
 * Capability, not permission — ask kmEnabledFor() before exposing KM to a user.
 */
export function kmEnabled(): boolean {
  return config.deployMode === 'pro-panjit' && !!config.kmApiKey;
}

/**
 * True when KM may be used from a particular surface.
 *
 * The two questions are genuinely separate: whether the deployment holds a KM
 * key, and whether a given product is meant to offer KM. Conflating them meant
 * the Excel add-in could not have KM without the web app also getting it, which
 * is the opposite of what was agreed.
 */
export function kmEnabledFor(surface: 'web' | 'excel' | 'word'): boolean {
  return kmEnabled() && config.kmSurfaces.includes(surface);
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

// ── Direct KM gateway calls (main process, for the KM 助手 widget's 文件 tab) ──
// These mirror what km-mcp does but run in-process so the widget can search /
// open / download WITHOUT spawning an agent (fast, no tokens). The chat tab still
// goes through the agent + km-mcp for AI Q&A. X-API-Key everywhere; X-On-Behalf-Of
// only where KM enforces per-user permission (document detail + download).
function kmHeaders(onBehalf?: string): Record<string, string> {
  const h: Record<string, string> = { 'X-API-Key': config.kmApiKey };
  if (onBehalf) h['X-On-Behalf-Of'] = onBehalf;
  return h;
}

export interface KmSearchResult { ok: boolean; status?: number; data?: any; error?: string }

/** Keyword search (KM /api/search takes only the API key — no on-behalf). */
export async function kmSearch(
  query: string, opts: { folderId?: number; page?: number; pageSize?: number } = {},
): Promise<KmSearchResult> {
  const body: Record<string, any> = { query };
  if (opts.folderId != null) body.folder_id = opts.folderId;
  if (opts.page) body.page = opts.page;
  if (opts.pageSize) body.page_size = Math.min(opts.pageSize, 100);
  const t0 = Date.now();
  try {
    const res = await fetch(`${config.kmApiBase}/api/search`, {
      method: 'POST',
      headers: { ...kmHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // The /search route streams keepalives while we wait, so the proxy won't reset
      // mid-query — we can afford to let even broad terms (「請假」 ~40s) finish.
      signal: AbortSignal.timeout(60_000),
    });
    const ms = Date.now() - t0;
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      console.warn(`[KM] search "${query}" -> ${res.status} in ${ms}ms: ${t.slice(0, 200)}`);
      return { ok: false, status: res.status, error: `KM 搜尋失敗（${res.status}）` };
    }
    const data = await res.json();
    console.log(`[KM] search "${query}" -> 200 in ${ms}ms`);
    return { ok: true, data };
  } catch (e) {
    const ms = Date.now() - t0;
    const timedOut = (e as Error).name === 'TimeoutError' || ms >= 29_000;
    console.warn(`[KM] search "${query}" FAILED in ${ms}ms: ${(e as Error).message}`);
    return { ok: false, error: timedOut ? 'KM 搜尋逾時（此關鍵字結果較多、KM 回應較慢）。請改用更精確的關鍵字（如加上部門或文件名），或稍後再試。' : `KM 搜尋連線失敗：${(e as Error).message}` };
  }
}

/** Document detail (versions / attachments / category / permission). Per-user. */
export async function kmGetDocument(onBehalf: string, documentId: string): Promise<KmSearchResult> {
  try {
    const res = await fetch(`${config.kmApiBase}/api/documents/${encodeURIComponent(documentId)}`, {
      headers: kmHeaders(onBehalf), signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) return { ok: false, status: res.status, error: httpMsg(res.status) };
    return { ok: true, data: await res.json() };
  } catch (e) {
    return { ok: false, error: `KM 取文件失敗：${(e as Error).message}` };
  }
}

export interface KmAttachment { ok: boolean; status?: number; buf?: Buffer; contentType?: string; error?: string }

/** Download one attachment's bytes (per-user permission; 403 = no download right). */
export async function kmFetchAttachment(onBehalf: string, documentId: string, filename: string): Promise<KmAttachment> {
  try {
    const res = await fetch(
      `${config.kmApiBase}/api/documents/${encodeURIComponent(documentId)}/attachments/${encodeURIComponent(filename)}`,
      { headers: kmHeaders(onBehalf), signal: AbortSignal.timeout(60_000) },
    );
    if (!res.ok) return { ok: false, status: res.status, error: httpMsg(res.status) };
    return { ok: true, buf: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') || 'application/octet-stream' };
  } catch (e) {
    return { ok: false, error: `KM 下載附件失敗：${(e as Error).message}` };
  }
}

function httpMsg(status: number): string {
  if (status === 403) return '你沒有這份文件的權限（KM 判定不可閱讀／下載）。';
  if (status === 404) return '找不到這份文件（可能已封存或為草稿）。';
  if (status === 400) return 'KM 請求缺少必要參數。';
  return `KM 服務回應 ${status}。`;
}
