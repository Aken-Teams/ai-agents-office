/**
 * Email Context Provider — injects Outlook email data into any skill's context.
 * Follows the same pattern as uploadContext.ts: keyword detection + context building.
 * Only active in DEPLOY_MODE=pro-panjit.
 */
import { config } from '../config.js';
import { getMailToken, fetchFolders, fetchMessages } from './outlookApi.js';

// Email-related keywords (zh-TW, zh-CN, en)
const EMAIL_KEYWORDS = [
  '信箱', '信件', '郵件', '收件匣', '看信', '查信', '寄件', '未讀',
  'email', 'mail', 'inbox', 'outlook', '邮件', '邮箱', '收件箱',
];

/**
 * Check if a user message mentions email-related topics.
 */
export function messageNeedsEmail(message: string): boolean {
  if (config.deployMode !== 'pro-panjit') return false;
  const lower = message.toLowerCase();
  return EMAIL_KEYWORDS.some(kw => lower.includes(kw));
}

/**
 * Fetch email data and return formatted markdown context.
 * Returns empty string if unavailable (no token, wrong deploy mode, etc.)
 */
export async function getEmailContextForPrompt(
  userId: string,
  message: string,
): Promise<string> {
  if (config.deployMode !== 'pro-panjit') return '';

  try {
    const mailToken = await getMailToken(userId);
    if (!mailToken) {
      return '\n\n## Outlook 信箱\nOutlook 信箱連線已過期，請重新用 AD 帳號登入以使用信箱功能。';
    }

    const folders = await fetchFolders(mailToken);
    // Auto-detect folder from message keywords
    const folderNames = folders.map(f => f.name);
    const requestedFolder = folderNames.find(f =>
      message.toLowerCase().includes(f.toLowerCase())
    ) || 'Inbox';
    const messages = await fetchMessages(mailToken, requestedFolder, 20);

    if (folders.length === 0 && messages.length === 0) {
      return '\n\n## Outlook 信箱\n無法取得信箱資料，請稍後再試。';
    }

    return [
      '\n\n## Pre-fetched Email Data',
      '\n### Email Folders',
      ...folders.map(f => `- ${f.displayName} (${f.name}): ${f.unreadCount} 未讀 / ${f.totalCount} 總計`),
      `\n### Messages in ${requestedFolder} (最近 ${messages.length} 封)`,
      ...messages.map(m =>
        `\n**${m.subject}**\n- From: ${m.from.name} <${m.from.address}>\n- Date: ${m.received_at}\n- Read: ${m.is_read ? '已讀' : '未讀'}${m.has_attachments ? ' | 📎 附件' : ''}\n- Preview: ${(m.preview || '').substring(0, 300)}`
      ),
    ].join('\n');
  } catch (err) {
    console.error('[EmailContext] Pre-fetch failed:', err);
    return '\n\n## Outlook 信箱\n無法取得信箱資料，請稍後再試。';
  }
}
