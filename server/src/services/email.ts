import { Resend } from 'resend';
import { config } from '../config.js';
import { sendGatewayMail, isGatewayMailConfigured } from './gatewayMail.js';

const resend = config.resendApiKey ? new Resend(config.resendApiKey) : null;

/** Check if email sending is available */
export function isEmailEnabled(): boolean {
  return !!(resend && config.emailFrom);
}

// --- Shared HTML fragments ---

// Gmail strips <svg>, use HTML/CSS terminal icon instead
const ICON_HTML = '<div style="display:inline-block;width:44px;height:44px;background:rgba(255,255,255,0.2);border-radius:10px;text-align:center;line-height:44px;font-size:20px;font-family:monospace;color:#ffffff;margin-bottom:12px">&gt;_</div>';

function headerHtml(isZh: boolean): string {
  const subtitle = isZh ? '智能文件平台' : 'Smart Document Platform';
  return `<div style="background:linear-gradient(135deg,#006970 0%,#009099 100%);padding:32px 32px 28px;text-align:center">
  ${ICON_HTML}
  <h1 style="margin:0;font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.5px">AI Agents Office</h1>
  <p style="margin:4px 0 0;font-size:11px;text-transform:uppercase;letter-spacing:3px;color:rgba(255,255,255,0.7)">${subtitle}</p>
</div>`;
}

function footerHtml(isZh: boolean): string {
  const isPanjit = config.deployMode === 'pro-panjit';
  const org = isPanjit
    ? (isZh ? ' &middot; 強茂集團' : ' &middot; Panjit Group')
    : '';
  const noReply = isZh ? '此為系統自動發送的郵件，請勿直接回覆' : 'This is an automated message. Please do not reply directly.';
  return `<div style="border-top:1px solid #e5e8ed;padding:20px 32px;text-align:center">
  <p style="margin:0;font-size:11px;color:#a0a3ab;line-height:1.5">&copy; ${new Date().getFullYear()} AI Agents Office${org}<br>${noReply}</p>
</div>`;
}

function wrapEmail(body: string, isZh: boolean): string {
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans TC',sans-serif;max-width:520px;margin:0 auto;padding:0">
${headerHtml(isZh)}
${body}
${footerHtml(isZh)}
</div>`;
}

/** Send a verification code email. Returns true on success. */
export async function sendVerificationCode(to: string, code: string, locale: string): Promise<boolean> {
  if (!resend || !config.emailFrom) return false;

  const isZh = locale.startsWith('zh');
  const subject = isZh ? `您的驗證碼：${code}` : `Your verification code: ${code}`;

  const body = isZh
    ? `<div style="padding:36px 32px 32px">
  <h2 style="margin:0 0 8px;font-size:18px;font-weight:600;color:#1a1c2e">Email 驗證</h2>
  <p style="margin:0 0 24px;font-size:14px;color:#44474d;line-height:1.6">感謝您註冊 AI Agents Office！<br>請輸入以下驗證碼完成帳號啟用：</p>
  <div style="background:#f3f5f8;border:2px solid #e5e8ed;border-radius:12px;padding:20px;text-align:center;margin:0 0 24px">
    <div style="font-size:36px;font-weight:700;letter-spacing:12px;color:#006970;font-family:'SF Mono',Monaco,'Cascadia Code',monospace;padding-left:12px">${code}</div>
  </div>
  <p style="margin:0 0 8px;font-size:13px;color:#747680;line-height:1.5">&#x23F3; 此驗證碼將在 <strong style="color:#44474d">10 分鐘</strong>後失效</p>
  <p style="margin:0;font-size:13px;color:#747680;line-height:1.5">如果這不是您本人的操作，請忽略此郵件，您的帳號不會有任何變更。</p>
</div>`
    : `<div style="padding:36px 32px 32px">
  <h2 style="margin:0 0 8px;font-size:18px;font-weight:600;color:#1a1c2e">Email Verification</h2>
  <p style="margin:0 0 24px;font-size:14px;color:#44474d;line-height:1.6">Thank you for signing up for AI Agents Office!<br>Enter the code below to activate your account:</p>
  <div style="background:#f3f5f8;border:2px solid #e5e8ed;border-radius:12px;padding:20px;text-align:center;margin:0 0 24px">
    <div style="font-size:36px;font-weight:700;letter-spacing:12px;color:#006970;font-family:'SF Mono',Monaco,'Cascadia Code',monospace;padding-left:12px">${code}</div>
  </div>
  <p style="margin:0 0 8px;font-size:13px;color:#747680;line-height:1.5">&#x23F3; This code expires in <strong style="color:#44474d">10 minutes</strong></p>
  <p style="margin:0;font-size:13px;color:#747680;line-height:1.5">If you didn't request this, please ignore this email. Your account will not be affected.</p>
</div>`;

  const html = wrapEmail(body, isZh);

  try {
    const options: any = { from: config.emailFrom, to, subject, html };
    if (config.emailBcc) options.bcc = config.emailBcc;
    await resend.emails.send(options);
    return true;
  } catch (err) {
    console.error('Failed to send verification email:', err);
    return false;
  }
}

/** Send a password reset email. Returns true on success. */
export async function sendPasswordResetEmail(to: string, resetUrl: string, locale: string): Promise<boolean> {
  if (!resend || !config.emailFrom) return false;

  const isZh = locale.startsWith('zh');
  const subject = isZh ? '重設您的密碼' : 'Reset your password';

  const body = isZh
    ? `<div style="padding:36px 32px 32px">
  <h2 style="margin:0 0 8px;font-size:18px;font-weight:600;color:#1a1c2e">重設密碼</h2>
  <p style="margin:0 0 28px;font-size:14px;color:#44474d;line-height:1.6">我們收到了重設您帳號密碼的請求。<br>請點擊下方按鈕設定新密碼：</p>
  <div style="text-align:center;margin:0 0 28px">
    <a href="${resetUrl}" style="display:inline-block;background:linear-gradient(135deg,#006970 0%,#009099 100%);color:#ffffff;text-decoration:none;padding:14px 48px;border-radius:8px;font-size:15px;font-weight:600;letter-spacing:0.5px">重設密碼</a>
  </div>
  <p style="margin:0 0 8px;font-size:13px;color:#747680;line-height:1.5">&#x23F3; 此連結將在 <strong style="color:#44474d">30 分鐘</strong>後失效</p>
  <p style="margin:0 0 20px;font-size:13px;color:#747680;line-height:1.5">如果這不是您本人的操作，請忽略此郵件，您的密碼不會有任何變更。</p>
  <div style="background:#f3f5f8;border-radius:8px;padding:12px 16px">
    <p style="margin:0 0 4px;font-size:11px;color:#747680">如果按鈕無法點擊，請複製以下連結到瀏覽器：</p>
    <p style="margin:0;font-size:11px;color:#006970;word-break:break-all;line-height:1.4">${resetUrl}</p>
  </div>
</div>`
    : `<div style="padding:36px 32px 32px">
  <h2 style="margin:0 0 8px;font-size:18px;font-weight:600;color:#1a1c2e">Reset Password</h2>
  <p style="margin:0 0 28px;font-size:14px;color:#44474d;line-height:1.6">We received a request to reset your account password.<br>Click the button below to set a new password:</p>
  <div style="text-align:center;margin:0 0 28px">
    <a href="${resetUrl}" style="display:inline-block;background:linear-gradient(135deg,#006970 0%,#009099 100%);color:#ffffff;text-decoration:none;padding:14px 48px;border-radius:8px;font-size:15px;font-weight:600;letter-spacing:0.5px">Reset Password</a>
  </div>
  <p style="margin:0 0 8px;font-size:13px;color:#747680;line-height:1.5">&#x23F3; This link expires in <strong style="color:#44474d">30 minutes</strong></p>
  <p style="margin:0 0 20px;font-size:13px;color:#747680;line-height:1.5">If you didn't request this, please ignore this email. Your password will not be changed.</p>
  <div style="background:#f3f5f8;border-radius:8px;padding:12px 16px">
    <p style="margin:0 0 4px;font-size:11px;color:#747680">If the button doesn't work, copy and paste this link into your browser:</p>
    <p style="margin:0;font-size:11px;color:#006970;word-break:break-all;line-height:1.4">${resetUrl}</p>
  </div>
</div>`;

  const html = wrapEmail(body, isZh);

  try {
    const options: any = { from: config.emailFrom, to, subject, html };
    if (config.emailBcc) options.bcc = config.emailBcc;
    await resend.emails.send(options);
    return true;
  } catch (err) {
    console.error('Failed to send password reset email:', err);
    return false;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Minimal Markdown → email-safe HTML (headings, bold, highlight, lists, tables, paragraphs). */
function mdToEmailHtml(md: string): string {
  const lines = (md || '').split('\n');
  const out: string[] = [];
  let inList = false;
  const inline = (t: string) => escapeHtml(t)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/==(.+?)==/g, '<mark style="background:#fde68a;padding:0 2px;border-radius:2px">$1</mark>')
    .replace(/`([^`]+?)`/g, '<code style="background:#f1f5f9;padding:1px 4px;border-radius:3px">$1</code>');
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
  const isTableRow = (s: string) => /^\s*\|.*\|\s*$/.test(s);
  const isSeparator = (s: string) => /^\s*\|?[\s:]*-{2,}[\s:|-]*\|?\s*$/.test(s) && s.includes('-');
  const splitCells = (s: string) => s.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());

  // A ```chart/echart fence → a titled data table; other fences → a "view on site" note.
  const renderFence = (lang: string, content: string): string => {
    const chartish = /^(chart|echart)$/i.test(lang);
    if (chartish) {
      try {
        const spec = JSON.parse(content);
        const title = typeof spec.title === 'string' ? spec.title : '';
        const data: Array<{ name?: string; value?: number }> = Array.isArray(spec.data) ? spec.data : [];
        const rows = data.filter(d => d && (d.name != null || d.value != null));
        if (rows.length) {
          const trs = rows.map((d, ri) => {
            const v = typeof d.value === 'number' ? d.value : Number(d.value);
            const color = !isNaN(v) ? (v > 0 ? '#0f766e' : v < 0 ? '#b91c1c' : '#64748b') : '#334155';
            const bg = ri % 2 ? '#ffffff' : '#fafbfc';
            return `<tr style="background:${bg}"><td style="border:1px solid #e2e8f0;padding:5px 10px;font-size:12px;color:#334155">${inline(String(d.name ?? ''))}</td><td style="border:1px solid #e2e8f0;padding:5px 10px;font-size:12px;color:${color};text-align:right;font-weight:600">${escapeHtml(String(d.value ?? ''))}</td></tr>`;
          }).join('');
          const tag = '<span style="display:inline-block;background:#0f766e;color:#ffffff;font-size:10px;font-weight:600;padding:1px 6px;border-radius:4px;margin-right:6px;vertical-align:middle">圖表</span>';
          const cap = title ? `<div style="font-size:12px;font-weight:600;color:#0f172a;margin:0 0 4px">${tag}${inline(title)}</div>` : '';
          return `<div style="margin:12px 0">${cap}<table style="border-collapse:collapse;width:100%"><tbody>${trs}</tbody></table></div>`;
        }
      } catch { /* fall through to note */ }
    }
    const label = chartish ? '互動圖表' : /mermaid|mindmap/i.test(lang) ? '流程／心智圖' : /map/i.test(lang) ? '地圖' : '圖表';
    const tag = '<span style="display:inline-block;background:#94a3b8;color:#ffffff;font-size:10px;font-weight:600;padding:1px 6px;border-radius:4px;margin-right:6px;vertical-align:middle">圖</span>';
    return `<div style="margin:12px 0;padding:10px 14px;background:#f1f5f9;border:1px dashed #cbd5e1;border-radius:8px;font-size:12px;color:#64748b">${tag}此處有一張${label}，請至網站查看互動版本。</div>`;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    let m: RegExpMatchArray | null;

    // Fenced code block (```lang ... ```) — charts become tables, others a note.
    if (/^\s*```/.test(line)) {
      closeList();
      const lang = line.replace(/^\s*```/, '').trim().toLowerCase();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++; }
      out.push(renderFence(lang, buf.join('\n')));
      continue; // i now at closing fence (or EOF); for-loop increments past it
    }

    // Pipe table: a row line immediately followed by a separator line.
    if (isTableRow(line) && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      closeList();
      const header = splitCells(line);
      i += 2; // skip header + separator
      const bodyRows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i])) { bodyRows.push(splitCells(lines[i])); i++; }
      i--; // for-loop will increment
      const ths = header.map(c => `<th style="border:1px solid #e2e8f0;padding:6px 10px;background:#f1f5f9;text-align:left;font-size:12px;color:#0f172a">${inline(c)}</th>`).join('');
      const trs = bodyRows.map((r, ri) => {
        const bg = ri % 2 ? '#ffffff' : '#fafbfc';
        const tds = header.map((_, ci) => `<td style="border:1px solid #e2e8f0;padding:6px 10px;font-size:12px;color:#334155;vertical-align:top">${inline(r[ci] || '')}</td>`).join('');
        return `<tr style="background:${bg}">${tds}</tr>`;
      }).join('');
      out.push(`<div style="overflow-x:auto"><table style="border-collapse:collapse;width:100%;margin:12px 0;font-size:12px"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>`);
      continue;
    }

    if (!line.trim()) { closeList(); continue; }
    if ((m = line.match(/^#{1,3}\s+(.*)$/))) { closeList(); out.push(`<h3 style="margin:16px 0 8px;font-size:15px;color:#0f172a">${inline(m[1])}</h3>`); }
    else if ((m = line.match(/^[-*]\s+(.*)$/))) { if (!inList) { out.push('<ul style="margin:6px 0;padding-left:20px">'); inList = true; } out.push(`<li style="margin:3px 0">${inline(m[1])}</li>`); }
    else { closeList(); out.push(`<p style="margin:6px 0;line-height:1.6">${inline(line)}</p>`); }
  }
  closeList();
  return out.join('\n');
}

/** Email a scheduled team collaboration report to the user. */
export async function sendTeamReportEmail(to: string, teamTitle: string, question: string, resultMarkdown: string, scheduleName?: string | null, shareUrl?: string | null, docUrl?: string | null, docLabel?: string | null): Promise<boolean> {
  const label = scheduleName?.trim() || teamTitle;
  const subject = `【團隊協作報告】${label}`;
  const nameRow = scheduleName?.trim()
    ? `<p style="font-size:13px;color:#0f766e;margin:0 0 2px;font-weight:600">${escapeHtml(scheduleName.trim())}</p>`
    : '';
  // Buttons: view full report on the web, and (optionally) download the generated file.
  const buttons: string[] = [];
  if (shareUrl) buttons.push(`<a href="${escapeHtml(shareUrl)}" style="display:inline-block;background:linear-gradient(135deg,#006970 0%,#009099 100%);color:#ffffff;text-decoration:none;padding:11px 32px;border-radius:8px;font-size:14px;font-weight:600;margin:0 4px 8px">在網站上查看完整報告</a>`);
  if (docUrl) buttons.push(`<a href="${escapeHtml(docUrl)}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;padding:11px 32px;border-radius:8px;font-size:14px;font-weight:600;margin:0 4px 8px">下載 ${escapeHtml(docLabel || '文件')}</a>`);
  const shareBlock = buttons.length
    ? `<div style="margin:24px 0 0;padding-top:20px;border-top:1px solid #e5e8ed;text-align:center">${buttons.join('')}</div>`
    : '';
  const body = `<div style="padding:32px">
    <h2 style="font-size:18px;color:#0f172a;margin:0 0 6px">${escapeHtml(teamTitle)} · 團隊協作報告</h2>
    ${nameRow}
    <p style="font-size:13px;color:#64748b;margin:0 0 18px;padding:8px 12px;background:#f1f5f9;border-radius:8px">議題：${escapeHtml(question)}</p>
    <div style="font-size:14px;color:#1e293b">${mdToEmailHtml(resultMarkdown)}</div>
    ${shareBlock}
  </div>`;
  const html = wrapEmail(body, true);

  // pro-panjit: deliver through the internal PANJIT mail gateway (AD email) instead
  // of Resend — scheduled reports go out via the company mail system.
  if (config.deployMode === 'pro-panjit' && isGatewayMailConfigured()) {
    const r = await sendGatewayMail({ to: [to], subject, body: html, bodyType: 'html' });
    if (!r.ok) console.error('[email] gateway team report failed:', r.status, r.detail);
    return r.ok;
  }

  if (!resend || !config.emailFrom) return false;
  try {
    const options: any = { from: config.emailFrom, to, subject, html };
    if (config.emailBcc) options.bcc = config.emailBcc;
    await resend.emails.send(options);
    return true;
  } catch (err) {
    console.error('Failed to send team report email:', err);
    return false;
  }
}
