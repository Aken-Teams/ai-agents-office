/**
 * Security Report service — turns raw audit-log + security-event data into an
 * "extremely professional" Word (.docx) report written by Claude.
 *
 * Flow: gather data (uncapped, optional date range) → digest → Claude writes a
 * structured Markdown report → parse Markdown into docx sections → build .docx.
 *
 * Generation is slow (Claude), so routes run this as an in-memory async job and
 * poll for the result — avoids the customer's proxy idle-timeout on long requests.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { config } from '../config.js';
import { resolveClaudeCliPath } from './resolveClaudeCli.js';
import { acquireAuxAiSlot } from './auxAiConcurrency.js';
import { logAiCall } from './aiCallLog.js';
import { dbAll, dbGet } from '../db.js';
import { buildDocxBuffer, type DocxInput } from '../generators/generate-docx.js';

const REPORT_TIMEOUT_MS = 5 * 60_000;

function isQuotaLimitError(text: string): boolean {
  const t = (text || '').toLowerCase();
  return t.includes('usage limit') || t.includes('quota') || t.includes('rate limit') || t.includes('429');
}

/** Tool-less one-shot Claude spawn that returns plain text (no file tools). */
async function spawnClaudeText(prompt: string, timeoutMs: number): Promise<string | null> {
  // Auxiliary spawn — this local helper never goes through spawnClaude(), so the
  // AI_MAX_CONCURRENT gate does not see it. Held across the api-key retry.
  const releaseAux = await acquireAuxAiSlot();
  return new Promise<string | null>((resolve) => {
    const resolvedCmd = resolveClaudeCliPath(config.claudeCliPath);
    const args = [
      '-p',
      '--verbose',
      '--output-format', 'stream-json',
      '--max-turns', '1',
      '--disallowedTools', 'Bash,Write,Read,Edit,WebSearch,WebFetch,Glob,Grep,Task,TodoWrite,NotebookEdit',
    ];

    const spawnId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const tmpDir = path.join(config.workspaceRoot, '_security_report', spawnId);
    fs.mkdirSync(tmpDir, { recursive: true });
    const cleanup = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} };

    function doSpawn(useApiKey: boolean) {
      const cleanEnv = { ...process.env };
      for (const key of Object.keys(cleanEnv)) {
        if (key.toUpperCase().startsWith('CLAUDE') || key === 'ANTHROPIC_API_KEY') delete cleanEnv[key];
      }
      if (useApiKey && config.anthropicApiKey) cleanEnv['ANTHROPIC_API_KEY'] = config.anthropicApiKey;

      let proc: ReturnType<typeof spawn>;
      try {
        proc = spawn(resolvedCmd.bin, [...resolvedCmd.prefix, ...args], {
          cwd: tmpDir, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: cleanEnv,
        });
      } catch (err) {
        console.error('[SecurityReport] spawn failed:', err);
        cleanup();
        releaseAux();
        resolve(null);
        return;
      }

      proc.stdin!.write(prompt);
      proc.stdin!.end();

      let output = '';
      let stderrOutput = '';
      let stdoutBuffer = '';
      let capturedModel: string | null = null;
      let inTok = 0, outTok = 0;

      proc.stdout!.on('data', (data: Buffer) => {
        stdoutBuffer += data.toString();
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === 'system' && parsed.subtype === 'init' && parsed.model) capturedModel = parsed.model;
            if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta' && parsed.delta.text) {
              output += parsed.delta.text;
            } else if (parsed.type === 'assistant' && Array.isArray(parsed.message?.content)) {
              if (parsed.message?.model) capturedModel = parsed.message.model;
              for (const block of parsed.message.content) if (block.type === 'text' && block.text) output += block.text;
            } else if (parsed.type === 'result') {
              if (parsed.model) capturedModel = parsed.model;
              if (parsed.usage) { inTok = parsed.usage.input_tokens || 0; outTok = parsed.usage.output_tokens || 0; }
              if (typeof parsed.result === 'string' && parsed.result && !output) output = parsed.result;
            }
          } catch { /* skip malformed */ }
        }
      });

      const MAX_STDERR = 16 * 1024;   // cap retention (was unbounded += — leak)
      proc.stderr!.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) {
          stderrOutput += msg + '\n';
          if (stderrOutput.length > MAX_STDERR) stderrOutput = stderrOutput.slice(-MAX_STDERR);
          console.warn(`[SecurityReport CLI stderr] ${msg.substring(0, 300)}`);
        }
      });

      const timeout = setTimeout(() => {
        try { proc.kill(); } catch {}
        console.warn(`[SecurityReport] Claude timed out after ${timeoutMs}ms (outputLen=${output.length})`);
        cleanup();
        releaseAux();   // kill() may not land — never leave the slot held
        resolve(output || null);
      }, timeoutMs);

      proc.on('exit', (code) => {
        clearTimeout(timeout);
        logAiCall({
          role: 'system', skillId: 'security-report',
          model: capturedModel,
          authMode: useApiKey ? 'api_key' : 'account',
          reason: useApiKey ? 'account-quota-fallback' : 'primary',
          inputTokens: inTok, outputTokens: outTok, exitCode: code, success: !!output,
        });
        if (!useApiKey && code !== 0 && !output && isQuotaLimitError(stderrOutput) && config.anthropicApiKey) {
          console.log('[SecurityReport] account quota exhausted, retrying with API key...');
          doSpawn(true);
          return;
        }
        if (!output && (code !== 0 || stderrOutput)) {
          console.error(`[SecurityReport] Claude exited code=${code}, stderr=${stderrOutput.substring(0, 500)}`);
        }
        cleanup();
        releaseAux();
        resolve(output || null);
      });
    }

    doSpawn(false);
  });
}

// ── Data gathering ─────────────────────────────────────────────────────────
export interface SecurityDigest {
  from: string | null;
  to: string | null;
  stats: {
    totalUsers: number;
    suspendedUsers: number;
    totalConversations: number;
    totalFiles: number;
    securityEvents: number;
    highSeverityEvents: number;
    newRegistrations: number;
    adminActions: number;
  };
  severityBreakdown: { severity: string; count: number }[];
  eventTypeBreakdown: { event_type: string; count: number }[];
  topEventUsers: { email: string; count: number }[];
  recentEvents: { severity: string; event_type: string; email: string; detail: string; created_at: string }[];
  recentAdminActions: { action: string; admin: string; detail: string; created_at: string }[];
}

/** Builds SQL range conditions on a given column for an optional YYYY-MM-DD from/to. */
function rangeCond(col: string, from: string | null, to: string | null): { clause: string; params: string[] } {
  const parts: string[] = [];
  const params: string[] = [];
  if (from) { parts.push(`${col} >= ?`); params.push(`${from} 00:00:00`); }
  if (to) { parts.push(`${col} <= ?`); params.push(`${to} 23:59:59`); }
  return { clause: parts.length ? parts.join(' AND ') : '1=1', params };
}

export async function gatherSecurityData(from: string | null, to: string | null): Promise<SecurityDigest> {
  const se = rangeCond('se.created_at', from, to);
  const u = rangeCond('created_at', from, to);

  const totalUsers = (await dbGet<{ c: number }>("SELECT COUNT(*) c FROM users WHERE role != 'admin'"))?.c ?? 0;
  const suspendedUsers = (await dbGet<{ c: number }>("SELECT COUNT(*) c FROM users WHERE status = 'suspended'"))?.c ?? 0;
  const newRegistrations = (await dbGet<{ c: number }>(`SELECT COUNT(*) c FROM users WHERE role != 'admin' AND ${u.clause}`, ...u.params))?.c ?? 0;

  const convCond = rangeCond('created_at', from, to);
  const totalConversations = (await dbGet<{ c: number }>(`SELECT COUNT(*) c FROM conversations WHERE ${convCond.clause}`, ...convCond.params))?.c ?? 0;
  const fileCond = rangeCond('created_at', from, to);
  const totalFiles = (await dbGet<{ c: number }>(`SELECT COUNT(*) c FROM generated_files WHERE ${fileCond.clause}`, ...fileCond.params))?.c ?? 0;

  const securityEvents = (await dbGet<{ c: number }>(`SELECT COUNT(*) c FROM security_events se WHERE ${se.clause}`, ...se.params))?.c ?? 0;
  const highSeverityEvents = (await dbGet<{ c: number }>(`SELECT COUNT(*) c FROM security_events se WHERE se.severity IN ('high','critical') AND ${se.clause}`, ...se.params))?.c ?? 0;

  const alCond = rangeCond('al.created_at', from, to);
  const adminActions = (await dbGet<{ c: number }>(`SELECT COUNT(*) c FROM admin_audit_log al WHERE ${alCond.clause}`, ...alCond.params))?.c ?? 0;

  const severityBreakdown = await dbAll<{ severity: string; count: number }>(
    `SELECT se.severity, COUNT(*) count FROM security_events se WHERE ${se.clause} GROUP BY se.severity ORDER BY count DESC`, ...se.params);
  const eventTypeBreakdown = await dbAll<{ event_type: string; count: number }>(
    `SELECT se.event_type, COUNT(*) count FROM security_events se WHERE ${se.clause} GROUP BY se.event_type ORDER BY count DESC LIMIT 15`, ...se.params);
  const topEventUsers = await dbAll<{ email: string; count: number }>(
    `SELECT COALESCE(usr.email, se.user_id) email, COUNT(*) count
     FROM security_events se LEFT JOIN users usr ON usr.id = se.user_id
     WHERE ${se.clause} GROUP BY se.user_id, usr.email ORDER BY count DESC LIMIT 10`, ...se.params);
  const recentEvents = await dbAll<{ severity: string; event_type: string; email: string; detail: string; created_at: string }>(
    `SELECT se.severity, se.event_type, COALESCE(usr.email, se.user_id) email,
            COALESCE(se.detail, '') detail, se.created_at
     FROM security_events se LEFT JOIN users usr ON usr.id = se.user_id
     WHERE ${se.clause} ORDER BY se.created_at DESC LIMIT 40`, ...se.params);
  const recentAdminActions = await dbAll<{ action: string; admin: string; detail: string; created_at: string }>(
    `SELECT al.action, COALESCE(adm.email, al.admin_id) admin, COALESCE(al.details, '') detail, al.created_at
     FROM admin_audit_log al LEFT JOIN users adm ON adm.id = al.admin_id
     WHERE ${alCond.clause} ORDER BY al.created_at DESC LIMIT 30`, ...alCond.params);

  return {
    from, to,
    stats: { totalUsers, suspendedUsers, totalConversations, totalFiles, securityEvents, highSeverityEvents, newRegistrations, adminActions },
    severityBreakdown, eventTypeBreakdown, topEventUsers, recentEvents, recentAdminActions,
  };
}

// ── Prompt + Markdown → docx ─────────────────────────────────────────────────
function buildPrompt(d: SecurityDigest): string {
  const range = d.from || d.to ? `${d.from || '不限'} ~ ${d.to || '不限'}` : '全部歷史資料';
  const sev = d.severityBreakdown.map(s => `${s.severity}: ${s.count}`).join('、') || '無';
  const types = d.eventTypeBreakdown.map(s => `${s.event_type}(${s.count})`).join('、') || '無';
  const topUsers = d.topEventUsers.map(s => `${s.email}(${s.count})`).join('、') || '無';
  const events = d.recentEvents.slice(0, 40).map(e =>
    `- [${e.severity}] ${e.event_type} | ${e.email} | ${(e.detail || '').replace(/\s+/g, ' ').slice(0, 160)} | ${e.created_at}`).join('\n') || '（無資安事件）';
  const admin = d.recentAdminActions.slice(0, 30).map(a =>
    `- ${a.action} | ${a.admin} | ${(a.detail || '').replace(/\s+/g, ' ').slice(0, 120)} | ${a.created_at}`).join('\n') || '（無管理操作）';

  return `你是一位資深資訊安全稽核顧問，正在為企業客戶「強茂集團 (PANJIT)」的 AI 文件生成平台撰寫一份**極度專業、正式**的資訊安全稽核報告。

請完全使用**繁體中文**撰寫，語氣專業、客觀、具備稽核與治理高度。這份報告將直接呈交給客戶的資安與管理階層，因此務必條理分明、具體且具行動指引。

## 報告涵蓋期間
${range}

## 平台統計數據
- 一般使用者總數：${d.stats.totalUsers}
- 已停權使用者：${d.stats.suspendedUsers}
- 期間內新註冊：${d.stats.newRegistrations}
- 對話總數：${d.stats.totalConversations}
- 產生檔案數：${d.stats.totalFiles}
- 資安事件總數：${d.stats.securityEvents}
- 高風險 (high/critical) 事件數：${d.stats.highSeverityEvents}
- 管理者操作次數：${d.stats.adminActions}

## 資安事件嚴重度分布
${sev}

## 資安事件類型分布（前 15）
${types}

## 觸發資安事件最多的使用者（前 10）
${topUsers}

## 近期資安事件明細（最多 40 筆）
${events}

## 近期管理者操作紀錄（最多 30 筆）
${admin}

---

請依下列結構撰寫報告，**直接輸出 Markdown**（不要有任何前言、說明或程式碼區塊圍欄）：

# 資訊安全稽核報告

## 一、執行摘要
（3-5 段，概述本期整體資安態勢、風險等級判定、最重要的發現與結論）

## 二、稽核範圍與方法
（說明資料來源：系統活動稽核日誌、輸入防護 (inputGuard) 資安事件、管理者操作日誌；涵蓋期間；稽核方法）

## 三、整體統計概覽
（用一個 Markdown 表格呈現上述平台統計數據，並加以解讀）

## 四、資安事件分析
（分析嚴重度分布、事件類型分布；用表格呈現嚴重度分布與類型分布；解讀高風險事件的意義）

## 五、重點事件與異常行為
（針對高風險事件與觸發最多的使用者進行分析，指出是否存在濫用、提示注入 (prompt injection) 或異常存取的跡象）

## 六、管理與治理活動
（分析管理者操作紀錄，評估權限治理與帳號管理是否落實）

## 七、風險評估與發現
（列出主要發現，每項標註風險等級：高/中/低）

## 八、改善建議與行動方案
（提供具體、可執行的資安強化建議，依優先順序排列）

## 九、結論
（總結本期資安狀態並給出整體評級）

要求：
1. 表格請使用標準 Markdown 表格語法（| 欄位 | 欄位 |）。
2. 若某類資料為空（例如無資安事件），仍須專業地說明「本期間未偵測到相關事件，顯示……」，不可略過章節。
3. 內容須基於上方實際數據，不可捏造不存在的數字。
4. 全文使用繁體中文。`;
}

/** Parse the LLM Markdown report into generate-docx section blocks. */
export function markdownToSections(md: string): { title: string; sections: DocxInput['sections'] } {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let title = '資訊安全稽核報告';
  const sections: DocxInput['sections'] = [];

  let paraBuf: string[] = [];
  let bulletBuf: string[] = [];
  let tableBuf: string[] = [];

  const flushPara = () => {
    if (paraBuf.length) { sections.push({ type: 'paragraph', content: paraBuf.join('\n') }); paraBuf = []; }
  };
  const flushBullets = () => {
    if (bulletBuf.length) { sections.push({ type: 'bullets', items: bulletBuf.slice() }); bulletBuf = []; }
  };
  const flushTable = () => {
    if (!tableBuf.length) return;
    const rows = tableBuf
      .filter(r => !/^\s*\|?\s*:?-{2,}/.test(r.replace(/\|/g, '').trim() ? r : '') && !/^[\s|:-]+$/.test(r))
      .map(r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim()));
    if (rows.length) {
      const headers = rows[0];
      const body = rows.slice(1);
      sections.push({ type: 'table', headers, rows: body });
    }
    tableBuf = [];
  };
  const flushAll = () => { flushPara(); flushBullets(); flushTable(); };

  const inlineClean = (s: string) => s.replace(/\*\*/g, '').replace(/`/g, '').trim();

  for (const raw of lines) {
    const line = raw.replace(/\t/g, '  ');
    const trimmed = line.trim();

    // Table rows
    if (/^\|.*\|/.test(trimmed) || (trimmed.includes('|') && tableBuf.length)) {
      flushPara(); flushBullets();
      // Skip pure separator rows (---|---)
      if (/^[\s|:-]+$/.test(trimmed)) continue;
      tableBuf.push(inlineClean(trimmed));
      continue;
    } else if (tableBuf.length) {
      flushTable();
    }

    if (!trimmed) { flushPara(); flushBullets(); continue; }

    // Headings
    const h = trimmed.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushAll();
      const level = h[1].length;
      const text = inlineClean(h[2]);
      if (level === 1) { title = text || title; continue; }
      sections.push({ type: 'heading', title: text, level: Math.max(1, level - 1) });
      continue;
    }

    // Bullets
    const b = trimmed.match(/^[-*+]\s+(.*)$/) || trimmed.match(/^\d+[.)]\s+(.*)$/);
    if (b) { flushPara(); bulletBuf.push(inlineClean(b[1])); continue; }

    // Paragraph text
    flushBullets();
    paraBuf.push(inlineClean(trimmed));
  }
  flushAll();

  return { title, sections };
}

export async function buildSecurityReportDocx(from: string | null, to: string | null): Promise<{ buffer: Buffer; filename: string }> {
  const digest = await gatherSecurityData(from, to);
  const md = await spawnClaudeText(buildPrompt(digest), REPORT_TIMEOUT_MS);
  if (!md || md.trim().length < 100) {
    throw new Error('AI 未能產生報告內容，請稍後再試');
  }
  const { title, sections } = markdownToSections(md);
  if (!sections.length) throw new Error('報告內容解析失敗');

  const buffer = await buildDocxBuffer({ title, author: 'AI Agents Office 資安稽核', style: 'formal', sections });
  const stamp = new Date().toISOString().slice(0, 10);
  const range = from || to ? `_${from || 'all'}_${to || 'all'}` : '';
  return { buffer, filename: `security_report${range}_${stamp}.docx` };
}
