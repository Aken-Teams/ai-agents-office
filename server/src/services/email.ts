import { Resend } from 'resend';
import { config } from '../config.js';

const resend = config.resendApiKey ? new Resend(config.resendApiKey) : null;

/** Check if email sending is available */
export function isEmailEnabled(): boolean {
  return !!(resend && config.emailFrom);
}

/** Send a verification code email. Returns true on success. */
export async function sendVerificationCode(to: string, code: string, locale: string): Promise<boolean> {
  if (!resend || !config.emailFrom) return false;

  const isZh = locale.startsWith('zh');
  const subject = isZh ? `您的驗證碼：${code}` : `Your verification code: ${code}`;
  const html = isZh
    ? `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2 style="margin:0 0 16px">Email 驗證</h2>
        <p>您的驗證碼為：</p>
        <div style="font-size:32px;font-weight:bold;letter-spacing:8px;text-align:center;padding:16px;background:#f5f5f5;border-radius:8px;margin:16px 0">${code}</div>
        <p style="color:#666;font-size:14px">此驗證碼將在 10 分鐘後失效。如非本人操作，請忽略此信。</p>
      </div>`
    : `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2 style="margin:0 0 16px">Email Verification</h2>
        <p>Your verification code is:</p>
        <div style="font-size:32px;font-weight:bold;letter-spacing:8px;text-align:center;padding:16px;background:#f5f5f5;border-radius:8px;margin:16px 0">${code}</div>
        <p style="color:#666;font-size:14px">This code expires in 10 minutes. If you didn't request this, please ignore this email.</p>
      </div>`;

  try {
    const options: any = {
      from: config.emailFrom,
      to,
      subject,
      html,
    };
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
  const html = isZh
    ? `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2 style="margin:0 0 16px">重設密碼</h2>
        <p>請點擊下方按鈕重設您的密碼：</p>
        <div style="text-align:center;margin:24px 0">
          <a href="${resetUrl}" style="display:inline-block;background:#6750A4;color:white;text-decoration:none;padding:12px 32px;border-radius:4px;font-weight:bold">重設密碼</a>
        </div>
        <p style="color:#666;font-size:14px">此連結將在 30 分鐘後失效。如非本人操作，請忽略此信。</p>
        <p style="color:#999;font-size:12px;word-break:break-all">連結：${resetUrl}</p>
      </div>`
    : `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2 style="margin:0 0 16px">Reset Password</h2>
        <p>Click the button below to reset your password:</p>
        <div style="text-align:center;margin:24px 0">
          <a href="${resetUrl}" style="display:inline-block;background:#6750A4;color:white;text-decoration:none;padding:12px 32px;border-radius:4px;font-weight:bold">Reset Password</a>
        </div>
        <p style="color:#666;font-size:14px">This link expires in 30 minutes. If you didn't request this, please ignore this email.</p>
        <p style="color:#999;font-size:12px;word-break:break-all">Link: ${resetUrl}</p>
      </div>`;

  try {
    const options: any = {
      from: config.emailFrom,
      to,
      subject,
      html,
    };
    if (config.emailBcc) options.bcc = config.emailBcc;
    await resend.emails.send(options);
    return true;
  } catch (err) {
    console.error('Failed to send password reset email:', err);
    return false;
  }
}
