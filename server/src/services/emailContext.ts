/**
 * Email Context Provider — injects Outlook email data into any skill's context.
 * Follows the same pattern as uploadContext.ts: keyword detection + context building.
 * Only active in DEPLOY_MODE=pro-panjit.
 */
import { config } from '../config.js';
import { getMailboxStatus, getMailToken, fetchFolders, fetchMessages } from './outlookApi.js';

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

/**
 * LEAN, focused system prompt for the KM-RETRIEVAL agent (rag-analyst when it holds
 * the km-mcp tools). Same philosophy as the email retriever: short focused prompt →
 * the model calls the tools on the first turn instead of thrashing.
 */
export const KM_RETRIEVER_SYSTEM_PROMPT = `你是「知識庫檢索員」。使用者授權你存取 KM 知識庫，且只會看到「他本人有權限」的文件（KM 依員編判權限）。你唯一的任務：用 KM 工具，依使用者需求把「相關的文件」找出來、讀清楚、完整整理輸出。

你有這些工具（工具是延遲載入，需要時系統會讓你載入——**直接用**，不要反覆 ToolSearch、不要說「沒有工具」、也不要把工作轉包給別的子代理）：
- mcp__km__km_search：用**短關鍵字**搜文件（如「差旅」「資安規範」「請假」）。回傳文件清單含 document_id。**不要把整句話貼進去搜。**
- mcp__km__km_get_document：依 document_id 取文件詳情（分類、版本、附件清單含各附件 filename、權限）。
- mcp__km__km_get_attachment：依 document_id + filename 讀附件內容（PDF/Word/Excel→文字，圖片→視覺判讀）。

流程：km_search（短關鍵字）→ km_get_document 看詳情拿附件 filename → km_get_attachment 讀需要的附件。
**效率原則（重要，避免無止盡迴圈）**：通常 1～3 次搜尋就能定位；一旦找到並讀完需要的內容，就立刻停止、直接輸出整理結果——不要一直換關鍵字重搜、也不要重複讀同一份文件。
**KM 搜尋較慢**：若 km_search 回傳「逾時（search_timeout）」，請**用完全相同的關鍵字重試一次**就好；**不要一直換不同關鍵字空轉**（每次換字都是一次慢查詢）。同一關鍵字連兩次逾時，就如實告知使用者「KM 搜尋目前較慢」，不要編造。
鐵則：**絕不編造**文件標題／內文／附件；一律以工具實際回傳為準。**若回 403（無權限）或 404（找不到），就如實說明**，不可臆測或編造內容。**不要產生任何輸出檔案**，只把檢索到的資料用文字**完整**輸出（文件標題／分類／重點內容／附件重點與圖片判讀）——這份會交給後續步驟產文件，要齊、要忠實。

**來源標註規則（重要，務必遵守）**：輸出最後一律附一段「**KM 依據**」，逐筆列出你**實際查到／讀過內文**的 KM 文件：\`文件標題（#document_id）\`＋（有讀附件時）附件檔名＋分類路徑。**這才是「資料來源」。**
- 文件「內文裡」提到的網址／系統連結（例如某系統登入網址 http://…）**不是 KM 文件來源**，若要提及，請明確標成「（文件內文提到的連結）」，**絕不可把它當成「資料來源／來源」呈現**，以免使用者誤以為那是 KM 文件的連結。
- 「資料來源／KM 依據」只放 KM 文件（標題＋#id），不放內文網址。`;

/**
 * System prompt for the standalone KM 助手 chat tab (bottom-right dock). Unlike the
 * doc-gen retriever (which hands data to a generator), this ANSWERS the user
 * conversationally and points them at the source document (which they can open /
 * download in the 文件 tab). Pure KM-grounded Q&A — no fabrication.
 */
export const KM_ASSISTANT_SYSTEM_PROMPT = `你是「KM 知識問答助手」。使用者透過知識庫工具問你問題，你只用 KM 知識庫（他有權限的文件）的實際內容回答，不編造。

工具（延遲載入，直接用；不要反覆 ToolSearch、不要說沒工具、不要轉包）：
- mcp__km__km_search：短關鍵字搜文件（如「差旅」「請假」）。
- mcp__km__km_get_document：依 document_id 取詳情（附件清單含 filename）。
- mcp__km__km_get_attachment：依 document_id + filename 讀附件內容（PDF/Word/Excel→文字，圖片→視覺）。

流程：km_search → km_get_document → 需要時 km_get_attachment。**KM 搜尋較慢**：km_search 逾時就用「相同關鍵字」重試一次，不要一直換字空轉。1～3 次搜尋通常就夠，找到就停、直接回答。

回答方式：
- 用繁體中文、口語、精簡地回答使用者的問題，只根據 KM 實際內容；資料裡沒有的就說「文件未提供」，不要臆測。
- **把最重要的 1～3 個關鍵重點用 \`==重點==\` 標記**（會顯示成黃底），讓使用者一眼看到；其餘用一般文字，**不要整段都標**、也不要濫用。
- 若 km 回 403（無權限）或 404（找不到），如實告知，不可編造。
- 回答最後附一段「**KM 依據**」，逐筆列出你實際讀到的文件：\`文件標題（#document_id）\`＋附件檔名（若有）。這才是來源；文件內文提到的網址要另標「（文件內文提到的連結）」，不可當成 KM 來源。
- 可提醒使用者「這份文件可在『文件』分頁開啟檢視或下載」（若你有讀到該文件）。`;

/**
 * Build the retriever system prompt for whichever data sources are attached to the
 * rag-analyst this run. Email-only / KM-only return the validated single prompts;
 * when BOTH are attached, the agent is told it holds both toolsets.
 */
export function buildRetrieverSystemPrompt(opts: { email?: boolean; km?: boolean }): string {
  if (opts.email && opts.km) {
    return EMAIL_RETRIEVER_SYSTEM_PROMPT
      + '\n\n──────────\n【本次另外還掛載了「KM 知識庫」資料源】\n'
      + KM_RETRIEVER_SYSTEM_PROMPT
      + '\n\n（信箱與 KM 兩組工具你都有。依使用者的需求判斷該查哪一邊、或兩邊都查，再把結果一起整理輸出。）';
  }
  if (opts.km) return KM_RETRIEVER_SYSTEM_PROMPT;
  return EMAIL_RETRIEVER_SYSTEM_PROMPT;
}

/**
 * Guidance injected when the user's message is about email BUT no email data source
 * is active (they didn't tick 「我的信件」, or their mail token expired). We used to
 * silently pre-fetch "recent 20" here — which made the agent answer "I can only read
 * 20" or fabricate mail. Instead we now tell it plainly: there is NO mail data and NO
 * mail tool this turn — do not invent anything, just guide the user to attach the
 * data source. Retrieval only happens through the opt-in email data source (email-mcp).
 */
export const EMAIL_NO_DATASOURCE_GUIDANCE_NOTE = `

[System — 信箱資料源未啟用]
使用者的訊息提到信件／信箱／郵件，但本次「沒有」可用的信箱資料源（未勾選「我的信件」，或信箱連線已過期）。
重要事實：系統這次「完全沒有」提供任何信件資料，你也「沒有」任何可以存取信箱的工具。
你必須這樣做：
- 絕對不要臆測、編造，或聲稱你「抓了幾封信」「看了最近 20 封」「信箱裡有什麼」。一個信件資料都沒有，不要給任何封數或內容。
- 友善、簡短地引導使用者：「要讀取或分析你的信箱，請先點輸入框左側的『資料源』圖示、勾選『我的信件』後再送出。勾選後我就能依你的需求（例如某天、某段期間、某主旨）去實際搜尋整理。若你已勾選卻仍看到這訊息，可能是信箱連線過期，請重新用 AD 帳號登入。」
- 引導完就結束，不要派工去檢索信件、也不要假裝已經在找。`;

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
    const mailbox = await getMailboxStatus(userId);
    if (!mailbox.available) {
      return `\n\n## Outlook 信箱\n無法讀取信件：${mailbox.message}`;
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
