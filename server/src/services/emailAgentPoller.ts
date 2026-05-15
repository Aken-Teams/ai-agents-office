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
import { pushEvent, getLastSeenIds, updateLastSeenIds } from './emailAgentRegistry.js';
import { buildEmailAgentMemoryContext } from './emailAgentMemory.js';
import { resolveClaudeCliPath } from './resolveClaudeCli.js';
import { dbAll } from '../db.js';

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

    const cleanEnv = { ...process.env };
    for (const key of Object.keys(cleanEnv)) {
      if (key.toUpperCase().startsWith('CLAUDE')) delete cleanEnv[key];
    }

    let proc;
    try {
      proc = spawn(resolvedCmd.bin, [...resolvedCmd.prefix, ...args], {
        cwd: tmpDir,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: cleanEnv,
      });
    } catch (err) {
      console.error('[EmailAgent] Failed to spawn Claude CLI:', err);
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
          // Handle all known event types from Claude CLI stream-json
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
            // Newer Claude CLI versions emit a final 'result' event
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

    function cleanup() {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }

    const timeout = setTimeout(() => {
      try { proc.kill(); } catch {}
      console.warn(`[EmailAgent] Claude timed out after ${timeoutMs}ms (rawLines=${rawLines}, outputLen=${output.length})`);
      cleanup();
      resolve(output || null);
    }, timeoutMs);

    proc.on('exit', (code) => {
      clearTimeout(timeout);
      if (!output && (code !== 0 || stderrOutput)) {
        console.error(`[EmailAgent] Claude exited code=${code}, rawLines=${rawLines}, stderr=${stderrOutput.substring(0, 500)}`);
      }
      cleanup();
      resolve(output || null);
    });
  });
}

/**
 * Poll for new emails and push Layer 1 summaries to the user.
 * @param isInitial — true on first connect: always send recent unread as a welcome batch
 */
export async function pollNewEmails(userId: string, isInitial = false): Promise<void> {
  let token = await getMailToken(userId);

  // On initial connect, the AD login may still be authenticating Outlook (fire-and-forget).
  // Retry a few times with a short delay before giving up.
  if (!token && isInitial) {
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise(r => setTimeout(r, 3000));
      token = await getMailToken(userId);
      if (token) break;
    }
  }

  if (!token) {
    pushEvent(userId, { type: 'error', data: { code: 'no_token', message: 'Outlook 連線已過期，請重新登入' } });
    return;
  }

  const { messages, total } = await fetchMessages(token, 'Inbox', 30, 0);
  if (!messages.length) return;

  const lastSeenIds = getLastSeenIds(userId);
  if (!lastSeenIds) return;

  // Count total unread
  const totalUnread = messages.filter(m => !m.is_read).length;

  // On initial connect: send recent unread as welcome batch (even if already "seen")
  // On subsequent polls: only send genuinely new emails
  const emailsToSummarize = isInitial
    ? messages.filter(m => !m.is_read).slice(0, 20)
    : messages.filter(m => !lastSeenIds.has(m.id));

  // Update last-seen IDs (keep the latest 50)
  const currentIds = new Set(messages.map(m => m.id));
  for (const id of lastSeenIds) currentIds.add(id);
  const trimmedIds = new Set([...currentIds].slice(0, 50));
  updateLastSeenIds(userId, trimmedIds);

  if (emailsToSummarize.length === 0) {
    // No emails to show — just send unread count update
    pushEvent(userId, { type: 'status', data: { totalUnread, total } });
    return;
  }

  console.log(`[EmailAgent] ${emailsToSummarize.length} emails to summarize for user ${userId} (initial=${isInitial})`);

  // Generate Layer 1 summaries + overview
  const { summaries, overview } = await generateLayer1Summary(userId, emailsToSummarize);

  pushEvent(userId, {
    type: 'new_emails',
    data: { emails: summaries, totalUnread, total, overview },
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

  const emailList = emails.map((e, i) => `[${i + 1}]
Subject: ${e.subject}
From: ${e.from.name} <${e.from.address}>
Preview: ${(e.preview || '').substring(0, 300)}`).join('\n\n');

  const prompt = `你是一位貼心的 AI 信件秘書。為以下新信件各生成一行繁體中文摘要和優先級。
同時，用 1-2 句話生成一段親切的整體概覽，像是在跟老闆簡報信件狀況。語氣自然、重點明確。

優先級規則：
- 高：VIP、合約、緊急期限、資安警告、客戶投訴
- 中：會議邀請、專案更新、需要行動的請求
- 低：電子報、自動通知、僅供參考
${memoryBlock}

信件列表：
${emailList}

回傳 JSON（不要 markdown 包裝，直接 JSON）：
{"overview":"親切的整體概覽","emails":[{"emailId":"填入編號","summary":"一行摘要","priority":"高|中|低","category":"分類如:會議/客戶/通知/資安"}]}`;

  const output = await spawnClaudeOneShot(prompt, LAYER1_TIMEOUT);

  // Parse AI output — supports both new {overview, emails} and legacy array format
  let emailResults: Array<{ emailId: string; summary: string; priority: string; category: string }> = [];
  let overview = '';
  if (output) {
    try {
      const objMatch = output.match(/\{[\s\S]*"emails"[\s\S]*\}/);
      if (objMatch) {
        const parsed = JSON.parse(objMatch[0]);
        emailResults = parsed.emails || [];
        overview = parsed.overview || '';
      } else {
        // Fallback: legacy array format
        const arrMatch = output.match(/\[[\s\S]*\]/);
        if (arrMatch) emailResults = JSON.parse(arrMatch[0]);
      }
    } catch {
      console.warn('[EmailAgent] Failed to parse Layer 1 output');
    }
  }

  // Map parsed results back to emails
  const summaries = emails.map((email, i) => {
    const aiResult = emailResults.find(p => p.emailId === String(i + 1)) || emailResults[i];
    return {
      emailId: email.id,
      subject: email.subject,
      from: email.from,
      receivedAt: email.received_at,
      isRead: email.is_read,
      hasAttachments: email.has_attachments,
      summary: aiResult?.summary || email.subject,
      priority: (['高', '中', '低'].includes(aiResult?.priority) ? aiResult.priority : '中') as '高' | '中' | '低',
      category: aiResult?.category || '一般',
    };
  });

  return { summaries, overview };
}

/**
 * Layer 2: Deep analysis of a single email (on-demand).
 * Streams result through SSE.
 */
export async function generateLayer2Analysis(userId: string, messageId: string): Promise<void> {
  try {
    const token = await getMailToken(userId);
    if (!token) {
      pushEvent(userId, { type: 'ai_analysis', data: { emailId: messageId, analysis: '❌ Outlook 連線已過期，請重新登入' } });
      return;
    }

    console.log(`[EmailAgent] Layer 2 analysis for message ${messageId}`);
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
3. **資安標記**：是否有可疑連結、外部寄件者、敏感資訊等風險
4. **緊急程度**：高/中/低，說明原因
5. **建議回覆**：如需回覆，給出簡短草稿方向`;

    const output = await spawnClaudeOneShot(prompt, LAYER2_TIMEOUT);
    console.log(`[EmailAgent] Layer 2 result: ${output ? output.substring(0, 100) + '...' : 'NULL'}`);

    pushEvent(userId, {
      type: 'ai_analysis',
      data: {
        emailId: messageId,
        analysis: output || '⚠️ AI 分析暫時無法回應，請稍後再試',
      },
    });
  } catch (err) {
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
