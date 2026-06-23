import { dbGet, dbRun } from '../db.js';
import { config } from '../config.js';
import { sendGatewayMail } from './gatewayMail.js';

/**
 * Quota-request email notifications (pro-panjit).
 *
 * Instead of a "reviewer" role, an admin binds a list of recipients (picked via
 * AD search) who should be emailed whenever a user submits a quota-increase
 * request. The list lives in system_settings as JSON.
 */

const SETTING_KEY = 'quota_notify_recipients';

export interface QuotaNotifyRecipient {
  email: string;
  name?: string;
}

export async function getQuotaNotifyRecipients(): Promise<QuotaNotifyRecipient[]> {
  const row = await dbGet<{ value: string }>("SELECT value FROM system_settings WHERE `key` = ?", SETTING_KEY);
  if (!row?.value) return [];
  try {
    const parsed = JSON.parse(row.value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((r: any) => r && typeof r.email === 'string' && r.email.includes('@'))
      .map((r: any) => ({ email: String(r.email).trim().toLowerCase(), name: r.name ? String(r.name) : undefined }));
  } catch {
    return [];
  }
}

export async function setQuotaNotifyRecipients(list: QuotaNotifyRecipient[]): Promise<void> {
  // De-dupe by email, keep first-seen name.
  const seen = new Map<string, QuotaNotifyRecipient>();
  for (const r of list) {
    const email = String(r?.email || '').trim().toLowerCase();
    if (!email.includes('@')) continue;
    if (!seen.has(email)) seen.set(email, { email, name: r.name ? String(r.name).slice(0, 100) : undefined });
  }
  await dbRun(
    "REPLACE INTO system_settings (`key`, value) VALUES (?, ?)",
    SETTING_KEY, JSON.stringify([...seen.values()])
  );
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || c));
}

export interface QuotaRequestEmailParams {
  requesterName: string;
  requesterEmail: string;
  reason: string;
  currentLimit: number;
  currentCost: number;
  adminUrl?: string;
  isTest?: boolean;
}

/**
 * Build the quota-request notification email (subject + HTML body). Shared by
 * the live notification and the admin "test send" so the test mail looks
 * exactly like the real thing.
 */
export function buildQuotaRequestEmail(params: QuotaRequestEmailParams): { subject: string; body: string } {
  const subject = `${params.isTest ? '【測試】' : ''}【額度申請】${params.requesterName} 提出額度調整申請`;
  const reviewLink = params.adminUrl ? `${params.adminUrl.replace(/\/$/, '')}/admin/quota-requests` : '';
  const body = `
    <div style="font-family:'Microsoft JhengHei',Arial,sans-serif;font-size:14px;color:#222;line-height:1.7;max-width:520px;">
      ${params.isTest ? '<div style="background:#fff7e6;border:1px solid #ffd591;color:#ad6800;font-size:12px;border-radius:6px;padding:8px 12px;margin-bottom:14px;">這是一封測試信，內容為範例資料。實際申請時會帶入真實申請人資訊。</div>' : ''}
      <h2 style="margin:0 0 12px;font-size:18px;">有新的額度調整申請待審核</h2>
      <table style="border-collapse:collapse;margin:8px 0 16px;">
        <tr><td style="padding:4px 12px 4px 0;color:#666;">申請人</td><td style="padding:4px 0;font-weight:bold;">${esc(params.requesterName)}（${esc(params.requesterEmail)}）</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666;">目前額度</td><td style="padding:4px 0;">$${params.currentLimit.toFixed(2)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666;">目前用量</td><td style="padding:4px 0;">$${params.currentCost.toFixed(2)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666;vertical-align:top;">申請理由</td><td style="padding:4px 0;white-space:pre-wrap;">${esc(params.reason)}</td></tr>
      </table>
      ${reviewLink ? `<p><a href="${reviewLink}" style="display:inline-block;background:#0b6;color:#fff;text-decoration:none;padding:8px 18px;border-radius:6px;font-weight:bold;">前往審核</a></p>` : ''}
      <p style="color:#999;font-size:12px;margin-top:18px;">此信由 AI Agents Office 系統自動發送，請勿直接回覆。</p>
    </div>`;
  return { subject, body };
}

/**
 * Email the bound recipients about a new quota request. Best-effort: returns the
 * gateway result but never throws, so a mail failure can't break the request.
 */
export async function notifyQuotaRequest(params: QuotaRequestEmailParams): Promise<{ sent: boolean; recipients: number; detail?: string }> {
  // Internal-only feature.
  if (config.deployMode !== 'pro-panjit') return { sent: false, recipients: 0, detail: 'not pro-panjit' };

  const recipients = await getQuotaNotifyRecipients();
  if (!recipients.length) return { sent: false, recipients: 0, detail: 'no recipients configured' };

  const { subject, body } = buildQuotaRequestEmail(params);
  const result = await sendGatewayMail({
    to: recipients.map(r => r.email),
    subject,
    body,
    bodyType: 'html',
  });
  if (!result.ok) {
    console.warn(`[quotaNotify] mail send failed (status ${result.status}): ${result.detail}`);
  }
  return { sent: result.ok, recipients: recipients.length, detail: result.detail };
}
