import { config } from '../config.js';

/**
 * PANJIT internal mail gateway (apigw.panjit.com.tw /ldap/api/v1/mail/send).
 * Used in pro-panjit deployments to notify internal staff (e.g. quota-request
 * reviewers) over internal SMTP. Requires the AD API key to carry the
 * `mail:send` scope — if it doesn't, the gateway returns 403 and we surface
 * that so the caller can log it (notifications are best-effort, never blocking).
 */

export interface GatewayMailAttachment {
  filename: string;
  content: string; // base64, no data: prefix
  cid?: string;
}

export interface GatewayMailInput {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  bodyType?: 'text' | 'html';
  attachments?: GatewayMailAttachment[];
}

export interface GatewayMailResult {
  ok: boolean;
  status: number;
  detail?: string;
}

export function isGatewayMailConfigured(): boolean {
  return !!config.adApiKey && !!config.adApiUrl;
}

export async function sendGatewayMail(input: GatewayMailInput): Promise<GatewayMailResult> {
  if (!isGatewayMailConfigured()) {
    return { ok: false, status: 0, detail: 'Gateway mail not configured (AD_API / AD_API_URL missing)' };
  }
  const to = (input.to || []).map(s => s.trim()).filter(Boolean);
  if (!to.length) return { ok: false, status: 0, detail: 'No recipients' };

  const payload: Record<string, unknown> = {
    to,
    subject: input.subject,
    body: input.body,
    body_type: input.bodyType || 'html',
  };
  if (input.cc?.length) payload.cc = input.cc.map(s => s.trim()).filter(Boolean);
  if (input.attachments?.length) payload.attachments = input.attachments;

  try {
    const upstream = await fetch(`${config.adApiUrl}/mail/send`, {
      method: 'POST',
      headers: { 'X-API-Key': config.adApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    let detail: string | undefined;
    try {
      const data = await upstream.json() as Record<string, unknown>;
      detail = typeof data.detail === 'string' ? data.detail : JSON.stringify(data);
    } catch { /* non-JSON body */ }
    return { ok: upstream.ok, status: upstream.status, detail };
  } catch (err) {
    return { ok: false, status: 0, detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Resolve an AD username to its real mailbox address via the gateway user
 * directory. Returns null if the account has no mail or the lookup fails.
 */
export async function resolveAdEmail(username: string, domain: string): Promise<{ email: string | null; displayName: string | null }> {
  if (!isGatewayMailConfigured()) return { email: null, displayName: null };
  try {
    const det = await fetch(`${config.adApiUrl}/users/${encodeURIComponent(username)}?domain=${encodeURIComponent(domain)}`,
      { headers: { 'X-API-Key': config.adApiKey }, signal: AbortSignal.timeout(8000) });
    if (!det.ok) return { email: null, displayName: null };
    const d = await det.json() as { mail?: string; displayName?: string };
    return { email: d.mail ? d.mail.toLowerCase().trim() : null, displayName: d.displayName || null };
  } catch {
    return { email: null, displayName: null };
  }
}
