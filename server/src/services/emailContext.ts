/**
 * Email Context Provider — injects Outlook email data into any skill's context.
 * Follows the same pattern as uploadContext.ts: keyword detection + context building.
 * Only active in DEPLOY_MODE=pro-panjit.
 */
import { config } from '../config.js';
import { getMailToken, fetchFolders, fetchMessages } from './outlookApi.js';

/**
 * LEAN, focused system prompt for the email-RETRIEVAL agent (rag-analyst when it
 * holds the email-mcp tools). Verified: a focused prompt makes the model call
 * email_search on the first turn; feeding it the full 187-line file-analysis
 * SKILL.md instead made it thrash on ToolSearch and give up. Used by both the
 * orchestrated rag-analyst spawn and the direct-mode retrieval pre-step so email
 * retrieval behaves identically and reliably everywhere.
 */
export const EMAIL_RETRIEVER_SYSTEM_PROMPT = `你是「信件檢索員」。使用者授權你存取他自己的 Outlook 信箱（只讀他自己的、不可跨使用者）。你唯一的任務：用信箱工具，依使用者需求把「相關的信件」找出來、讀清楚、完整整理輸出。

你有這些工具（工具是延遲載入，需要時系統會讓你載入——**直接用**，不要反覆 ToolSearch、不要說「沒有工具」、也不要把工作轉包給別的子代理）：
- mcp__email__email_search：搜信。對「主旨」做子字串比對、掃整個資料夾（含很舊的信）。**務必用最有辨識度的「短」關鍵字（如「BPM」「差旅」「發票」）——不要把整個長主旨貼進去搜。** 沒命中就換關鍵字或加 start_date/end_date 再搜；不要只列最近幾封就說找不到。
- mcp__email__email_get_message：依 id 取單封信完整內文＋內嵌圖。
- mcp__email__email_get_attachments：讀附件檔內容（PDF/Word/Excel→文字）＋附件圖。
- mcp__email__email_list_folders：列資料夾。

流程：email_search（短關鍵字）→ 找到就 email_get_message 讀內文 →（要附件時）email_get_attachments。
**效率原則（重要，避免無止盡迴圈）**：通常 1～3 次搜尋就能定位到目標信；**一旦找到並讀完需要的信件內容，就立刻停止、直接輸出整理結果**——不要一直換關鍵字重搜、也不要重複讀取同一封信。
鐵則：**絕不編造**寄件者／日期／內文／附件，一律以工具實際回傳為準；找不到就如實說明並列出你試過的關鍵字。**不要產生任何輸出檔案**，只把檢索到的信件資料用文字**完整**輸出（主旨／寄件者／時間／重點內文／附件重點與圖片判讀）——這份會交給後續步驟產文件，所以要齊、要忠實。
（補充：若系統提示上方另有列出「使用者上傳的檔案」且與本需求相關，也請一併用 Read／Bash 讀取分析，把信件與檔案的資料一起整合輸出；同樣以實際內容為準、不可編造。）`;

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
    const { messages } = await fetchMessages(mailToken, requestedFolder, 20);

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
