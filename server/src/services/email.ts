import { Resend } from 'resend';
import { config } from '../config.js';

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
