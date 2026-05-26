/**
 * Email Agent Poller — checks for new emails and generates AI summaries.
 * Layer 1: Lightweight batch summary (auto, on poll).
 * Layer 2: Deep analysis (on-demand, user-triggered).
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { config } from '../config.js';
import { getMailToken, fetchMessages, fetchMessageDetail, type OutlookMessage } from './outlookApi.js';
import { pushEvent, getLastSeenIds, updateLastSeenIds, markTaskActive, markTaskDone } from './emailAgentRegistry.js';
import { buildEmailAgentMemoryContext } from './emailAgentMemory.js';
import { resolveClaudeCliPath } from './resolveClaudeCli.js';
import { dbAll, dbGet, dbRun } from '../db.js';

const LAYER1_TIMEOUT = 25_000; // 25s for batch summary
const LAYER2_TIMEOUT = 60_000; // 60s for deep analysis

export interface EmailSummary {
  emailId: string;
  subject: string;
  from: { name: string; address: string };
  receivedAt: string;
  isRead: boolean;
  hasAttachments: boolean;
  summary: string;
  priority: '高' | '中' | '低';
  category: string;
}

/**
 * Spawn Claude CLI for a one-shot prompt, collect text output.
 */
/**
 * Detect whether stderr indicates an account quota / rate limit error.
 */
function isQuotaLimitError(text: string): boolean {
  if (/you[''\u2019]ve hit your limit/i.test(text)) return true;
  if (/rate.?limit|too many requests|429/i.test(text) && text.length < 500) return true;
  return false;
}

function spawnClaudeOneShot(prompt: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const resolvedCmd = resolveClaudeCliPath(config.claudeCliPath);
    const args = [
      '-p',
      '--verbose',
      '--output-format', 'stream-json',
      '--max-turns', '1',
      '--disallowedTools', 'Bash,Write,Read,Edit,WebSearch,WebFetch,Glob,Grep,Task,TodoWrite,NotebookEdit',
    ];

    // Use unique subdirectory per spawn to avoid conflicts
    const spawnId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const tmpDir = path.join(config.workspaceRoot, '_email_agent', spawnId);
    fs.mkdirSync(tmpDir, { recursive: true });

    function doSpawn(useApiKey: boolean) {
      const cleanEnv = { ...process.env };
      for (const key of Object.keys(cleanEnv)) {
        if (key.toUpperCase().startsWith('CLAUDE') || key === 'ANTHROPIC_API_KEY') {
          delete cleanEnv[key];
        }
      }
      if (useApiKey && config.anthropicApiKey) {
        cleanEnv['ANTHROPIC_API_KEY'] = config.anthropicApiKey;
      }

      const modeLabel = useApiKey ? '(API Key)' : '(account)';

      let proc: ReturnType<typeof spawn>;
      try {
        proc = spawn(resolvedCmd.bin, [...resolvedCmd.prefix, ...args], {
          cwd: tmpDir,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: cleanEnv,
        });
      } catch (err) {
        console.error(`[EmailAgent] Failed to spawn Claude CLI ${modeLabel}:`, err);
        cleanup();
        resolve(null);
        return;
      }

      proc.stdin!.write(prompt);
      proc.stdin!.end();

      let output = '';
      let stderrOutput = '';
      let stdoutBuffer = '';
      let rawLines = 0;

      proc.stdout!.on('data', (data: Buffer) => {
        stdoutBuffer += data.toString();
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          rawLines++;
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === 'content_block_delta') {
              const delta = parsed.delta;
              if (delta?.type === 'text_delta' && delta.text) {
                output += delta.text;
              }
            } else if (parsed.type === 'assistant') {
              const content = parsed.message?.content;
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === 'text' && block.text) output += block.text;
                }
              }
            } else if (parsed.type === 'result') {
              const text = parsed.result;
              if (typeof text === 'string' && text && !output) {
                output = text;
              }
            }
          } catch { /* skip malformed */ }
        }
      });

      proc.stderr!.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) {
          stderrOutput += msg + '\n';
          console.warn(`[EmailAgent CLI stderr] ${msg.substring(0, 300)}`);
        }
      });

      const timeout = setTimeout(() => {
        try { proc.kill(); } catch {}
        console.warn(`[EmailAgent] Claude ${modeLabel} timed out after ${timeoutMs}ms (rawLines=${rawLines}, outputLen=${output.length})`);
        cleanup();
        resolve(output || null);
      }, timeoutMs);

      proc.on('exit', (code) => {
        clearTimeout(timeout);

        // API key fallback: quota hit + no output + API key available → retry
        if (!useApiKey && code !== 0 && !output
            && isQuotaLimitError(stderrOutput) && config.anthropicApiKey) {
          console.log(`[EmailAgent] Account quota exhausted, retrying with API key...`);
          doSpawn(true);
          return;
        }

        if (!output && (code !== 0 || stderrOutput)) {
          console.error(`[EmailAgent] Claude ${modeLabel} exited code=${code}, rawLines=${rawLines}, stderr=${stderrOutput.substring(0, 500)}`);
        }
        cleanup();
        resolve(output || null);
      });
    }

    function cleanup() {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }

    doSpawn(false);
  });
}

/**
 * Poll for new emails and push Layer 1 summaries to the user.
 * @param isInitial — true on first connect: always send recent unread as a welcome batch
 */
export async function pollNewEmails(userId: string, isInitial = false): Promise<void> {
  let token = await getMailToken(userId);

  // On initial connect, the AD login may still be authenticating Outlook (fire-and-forget).
  // Only retry if the user has stored credentials (AD user) but token isn't ready yet.
  if (!token && isInitial) {
    const hasCredentials = await dbGet<{ credentials_enc: string | null }>(
      'SELECT credentials_enc FROM outlook_tokens WHERE user_id = ?', userId
    );
    if (hasCredentials?.credentials_enc) {
      // AD user — token is being created, wait briefly
      for (let attempt = 0; attempt < 2; attempt++) {
        await new Promise(r => setTimeout(r, 2000));
        token = await getMailToken(userId);
        if (token) break;
      }
    }
  }

  if (!token) {
    pushEvent(userId, { type: 'error', data: { code: 'no_token', message: 'Outlook 連線已過期，請重新登入' } });
    return;
  }

  const { messages: rawMessages, total } = await fetchMessages(token, 'Inbox', 50, 0);
  if (!rawMessages.length) {
    console.log(`[EmailAgent] No messages returned for user ${userId} (initial=${isInitial})`);
    return;
  }
  // Sort newest first — don't rely on API ordering
  const messages = [...rawMessages].sort((a, b) =>
    new Date(b.received_at).getTime() - new Date(a.received_at).getTime()
  );

  const lastSeenIds = getLastSeenIds(userId);
  if (!lastSeenIds) {
    console.warn(`[EmailAgent] No connection found for user ${userId} during poll, skipping`);
    return;
  }

  // Count total unread
  const totalUnread = messages.filter(m => !m.is_read).length;

  // On initial connect: send ALL recent emails (read + unread) so user sees latest inbox
  // On subsequent polls: only send genuinely new emails
  const emailsToSummarize = isInitial
    ? messages.slice(0, 50)
    : messages.filter(m => !lastSeenIds.has(m.id));

  // Update last-seen IDs (keep the latest 50)
  const currentIds = new Set(messages.map(m => m.id));
  for (const id of lastSeenIds) currentIds.add(id);
  const trimmedIds = new Set([...currentIds].slice(0, 100));
  updateLastSeenIds(userId, trimmedIds);

  if (emailsToSummarize.length === 0) {
    // No emails to show — just send unread count update
    pushEvent(userId, { type: 'status', data: { totalUnread, total } });
    return;
  }

  console.log(`[EmailAgent] ${emailsToSummarize.length} emails to summarize for user ${userId} (initial=${isInitial})`);

  // ── Check cache for already-summarized emails ──
  const emailIds = emailsToSummarize.map(e => e.id);
  const cached = await dbAll<{ email_id: string; summary: string; priority: string; category: string; analysis: string | null }>(
    `SELECT email_id, summary, priority, category, analysis FROM email_summary_cache WHERE user_id = ? AND email_id IN (${emailIds.map(() => '?').join(',')})`,
    userId, ...emailIds
  );
  const cacheMap = new Map(cached.map(c => [c.email_id, c]));

  const uncachedEmails = emailsToSummarize.filter(e => !cacheMap.has(e.id));

  // Build summaries from cache (include analysis if available)
  const cachedSummaries: (EmailSummary & { analysis?: string })[] = emailsToSummarize
    .filter(e => cacheMap.has(e.id))
    .map(email => {
      const c = cacheMap.get(email.id)!;
      return {
        emailId: email.id,
        subject: email.subject,
        from: email.from,
        receivedAt: email.received_at,
        isRead: email.is_read,
        hasAttachments: email.has_attachments,
        summary: c.summary,
        priority: (['高', '中', '低'].includes(c.priority) ? c.priority : '中') as '高' | '中' | '低',
        category: c.category,
        ...(c.analysis ? { analysis: c.analysis } : {}),
      };
    });

  // All emails cached — send cached data immediately, no AI call needed
  if (uncachedEmails.length === 0) {
    const state = await dbGet<{ last_overview: string | null }>(
      'SELECT last_overview FROM email_agent_state WHERE user_id = ?', userId
    );
    console.log(`[EmailAgent] All ${emailsToSummarize.length} emails served from cache for user ${userId}`);
    pushEvent(userId, {
      type: 'new_emails',
      data: { emails: cachedSummaries, totalUnread, total, overview: state?.last_overview || '' },
    });
    return;
  }

  console.log(`[EmailAgent] ${uncachedEmails.length}/${emailsToSummarize.length} emails need AI summary for user ${userId}`);

  // Send cached + basic placeholders for uncached immediately (fast spinner exit)
  if (isInitial) {
    const basicForUncached: EmailSummary[] = uncachedEmails.map(email => ({
      emailId: email.id,
      subject: email.subject,
      from: email.from,
      receivedAt: email.received_at,
      isRead: email.is_read,
      hasAttachments: email.has_attachments,
      summary: email.subject,
      priority: '中' as const,
      category: '一般',
    }));
    pushEvent(userId, {
      type: 'new_emails',
      data: { emails: [...cachedSummaries, ...basicForUncached], totalUnread, total, overview: '' },
    });
  }

  // Generate AI summaries only for uncached emails
  const { summaries: freshSummaries, overview } = await generateLayer1Summary(userId, uncachedEmails);

  // Save fresh summaries to cache (fire-and-forget)
  for (const s of freshSummaries) {
    dbRun(
      `INSERT INTO email_summary_cache (user_id, email_id, summary, priority, category) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE summary = VALUES(summary), priority = VALUES(priority), category = VALUES(category)`,
      userId, s.emailId, s.summary, s.priority, s.category
    ).catch(() => {});
  }

  // Save overview (fire-and-forget)
  if (overview) {
    dbRun(
      `INSERT INTO email_agent_state (user_id, last_overview) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE last_overview = VALUES(last_overview)`,
      userId, overview
    ).catch(() => {});
  }

  // Merge cached + fresh and push
  const allSummaries = [...cachedSummaries, ...freshSummaries];
  pushEvent(userId, {
    type: 'new_emails',
    data: { emails: allSummaries, totalUnread, total, overview },
  });
}

/**
 * Layer 1: Lightweight batch summary using Claude CLI.
 * Returns individual summaries + a conversational overview.
 */
async function generateLayer1Summary(userId: string, emails: OutlookMessage[]): Promise<{ summaries: EmailSummary[], overview: string }> {
  // Load email agent memories for personalization
  const memories = await dbAll<{ content: string }>(
    "SELECT content FROM user_memories WHERE user_id = ? AND memory_type = 'email_agent' ORDER BY created_at DESC LIMIT 10",
    userId
  );
  const memoryBlock = buildEmailAgentMemoryContext(memories);

  // Process in batches of 5 using keyed tags (A-E) for reliable mapping
  const BATCH_SIZE = 5;
  const TAGS = 'ABCDEFGHIJ';
  const allSummaries: EmailSummary[] = [];
  let lastOverview = '';

  for (let batchStart = 0; batchStart < emails.length; batchStart += BATCH_SIZE) {
    const batch = emails.slice(batchStart, batchStart + BATCH_SIZE);
    const isLastBatch = batchStart + BATCH_SIZE >= emails.length;

    // Each email gets a unique letter tag
    const emailList = batch.map((e, i) => `--- 信件 ${TAGS[i]} ---
Subject: ${e.subject}
From: ${e.from.name} <${e.from.address}>
Preview: ${(e.preview || '').substring(0, 300)}`).join('\n\n');

    const overviewInstruction = isLastBatch
      ? '\n同時，用 1-2 句話生成一段親切的整體概覽，像是在跟老闆簡報信件狀況。語氣自然、重點明確。'
      : '';

    const tagKeys = batch.map((_, i) => `"${TAGS[i]}":{"summary":"...","priority":"高|中|低","category":"..."}`).join(',');

    const prompt = `你是一位貼心的 AI 信件秘書。為以下 ${batch.length} 封信件各生成一行繁體中文摘要和優先級。${overviewInstruction}

優先級規則：
- 高：VIP、合約、緊急期限、資安警告、客戶投訴
- 中：會議邀請、專案更新、需要行動的請求
- 低：電子報、自動通知、僅供參考
${memoryBlock}

信件列表：
${emailList}

回傳 JSON（不要 markdown 包裝，直接 JSON），用信件代碼作為 key：
{"overview":"${isLastBatch ? '整體概覽' : ''}",${tagKeys}}

重要：每個 key（${batch.map((_, i) => TAGS[i]).join(', ')}）必須對應到上面相同代碼的信件。`;

    const output = await spawnClaudeOneShot(prompt, LAYER1_TIMEOUT);

    const tagMap = new Map<string, { summary: string; priority: string; category: string }>();
    if (output) {
      try {
        const objMatch = output.match(/\{[\s\S]*\}/);
        if (objMatch) {
          const parsed = JSON.parse(objMatch[0]);
          if (parsed.overview) lastOverview = parsed.overview;
          for (let i = 0; i < batch.length; i++) {
            const tag = TAGS[i];
            if (parsed[tag]) tagMap.set(tag, parsed[tag]);
          }
        }
      } catch {
        console.warn(`[EmailAgent] Failed to parse Layer 1 output for batch starting at ${batchStart}`);
      }
    }

    // Map by tag — each email gets its tagged result
    for (let i = 0; i < batch.length; i++) {
      const email = batch[i];
      const aiResult = tagMap.get(TAGS[i]);
      allSummaries.push({
        emailId: email.id,
        subject: email.subject,
        from: email.from,
        receivedAt: email.received_at,
        isRead: email.is_read,
        hasAttachments: email.has_attachments,
        summary: aiResult?.summary || email.subject,
        priority: (aiResult?.priority && ['高', '中', '低'].includes(aiResult.priority) ? aiResult.priority : '中') as '高' | '中' | '低',
        category: aiResult?.category || '一般',
      });
    }
  }

  return { summaries: allSummaries, overview: lastOverview };
}

/**
 * Layer 2: Deep analysis of a single email (on-demand).
 * Streams result through SSE.
 */
export async function generateLayer2Analysis(userId: string, messageId: string): Promise<void> {
  try {
    // ── Check cache first ──
    const cached = await dbGet<{ analysis: string | null }>(
      'SELECT analysis FROM email_summary_cache WHERE user_id = ? AND email_id = ?',
      userId, messageId
    );
    if (cached?.analysis) {
      console.log(`[EmailAgent] Layer 2 cache hit for message ${messageId}`);
      pushEvent(userId, {
        type: 'ai_analysis',
        data: { emailId: messageId, analysis: cached.analysis },
      });
      return;
    }

    const token = await getMailToken(userId);
    if (!token) {
      pushEvent(userId, { type: 'ai_analysis', data: { emailId: messageId, analysis: '❌ Outlook 連線已過期，請重新登入' } });
      return;
    }

    console.log(`[EmailAgent] Layer 2 analysis for message ${messageId}`);
    markTaskActive(userId, `analyze:${messageId}`);
    const message = await fetchMessageDetail(token, messageId);
    if (!message) {
      pushEvent(userId, { type: 'ai_analysis', data: { emailId: messageId, analysis: '❌ 找不到信件，可能已被刪除' } });
      return;
    }

    // Load email agent memories
    const memories = await dbAll<{ content: string }>(
      "SELECT content FROM user_memories WHERE user_id = ? AND memory_type = 'email_agent' ORDER BY created_at DESC LIMIT 10",
      userId
    );
    const memoryBlock = buildEmailAgentMemoryContext(memories);

    // Strip HTML tags for text analysis
    const bodyText = message.body
      ? message.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').substring(0, 3000)
      : '(無內容)';

    console.log(`[EmailAgent] Layer 2: subject="${message.subject}", bodyLen=${bodyText.length}`);

    const prompt = `你是專業信件分析助手。請深度分析以下信件，用繁體中文回覆。
${memoryBlock}

信件資訊：
- 主旨: ${message.subject}
- 寄件者: ${message.from.name} <${message.from.address}>
- 收件時間: ${message.received_at}
- 附件: ${message.attachments?.length || 0} 個
${message.to?.length ? `- 收件者: ${message.to.map(t => t.name || t.address).join(', ')}` : ''}

內容:
${bodyText}

請提供：
1. **摘要**：2-3 句話說明重點
2. **行動建議**：需要做什麼？（列點）
3. **資安標記**：仔細檢查是否有以下真實風險跡象，只有確實存在才標記：
   - 釣魚：寄件者地址與顯示名稱不符、偽裝知名品牌、要求點擊連結輸入密碼或個資
   - 惡意附件：可執行檔(.exe/.bat/.scr)、偽裝副檔名、加密壓縮檔要求密碼
   - 詐騙：緊急匯款要求、偽裝主管/CEO、變更匯款帳號
   - 可疑連結：短網址、與信件內容無關的外部連結、IP 位址連結
   如果寄件者是公司內部正常信箱且內容合理，請明確寫「無資安風險」
4. **緊急程度**：高/中/低，說明原因
5. **建議回覆**：如需回覆，給出簡短草稿方向

最後一行請輸出風險標籤（擇一，不需解釋）：
[RISK:NONE] — 無資安疑慮
[RISK:HIGH] — 確實存在釣魚/惡意/詐騙等資安風險`;

    const output = await spawnClaudeOneShot(prompt, LAYER2_TIMEOUT);
    console.log(`[EmailAgent] Layer 2 result: ${output ? output.substring(0, 100) + '...' : 'NULL'}`);

    const analysis = output || '⚠️ AI 分析暫時無法回應，請稍後再試';

    // Save analysis to cache (fire-and-forget)
    if (output) {
      dbRun(
        `INSERT INTO email_summary_cache (user_id, email_id, summary, analysis) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE analysis = VALUES(analysis)`,
        userId, messageId, '', output
      ).catch(() => {});
    }

    markTaskDone(userId, `analyze:${messageId}`);
    pushEvent(userId, {
      type: 'ai_analysis',
      data: { emailId: messageId, analysis },
    });
  } catch (err) {
    markTaskDone(userId, `analyze:${messageId}`);
    console.error(`[EmailAgent] Layer 2 error for ${messageId}:`, err);
    pushEvent(userId, {
      type: 'ai_analysis',
      data: {
        emailId: messageId,
        analysis: `❌ 分析錯誤: ${(err as Error).message || '未知錯誤'}`,
      },
    });
  }
}
