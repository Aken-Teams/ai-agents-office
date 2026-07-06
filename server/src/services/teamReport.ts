/**
 * Formal report writer for team collaboration runs.
 *
 * Turns the raw multi-agent output (coordinator synthesis + each member's
 * analysis) into ONE cohesive, professional report a user can hand to a client
 * or stakeholder — not a transcript of AI viewpoints. Uses the same local
 * Claude CLI spawn as the team members (single-turn, no tools), so it slots
 * into the existing architecture and counts against the user's quota.
 */

import { v4 as uuidv4 } from 'uuid';
import { spawnClaude } from './claudeCli.js';
import { acquireAiSlot } from './aiConcurrency.js';
import { recordTokenUsage } from './tokenTracker.js';
import { dbGet } from '../db.js';
import type { SSEEvent } from '../types.js';

const REPORT_TIMEOUT_MS = 240_000; // formal reports are long; allow up to 4 min

const SYSTEM_PROMPT = `你是一位資深顧問與專業報告撰寫者。你的任務是把「多位顧問針對同一議題的分析」整理成一份**正式、完整、可直接交付給客戶或專業人士的報告**。

嚴格要求：
1. 這是一份**對外正式文件**，語氣專業、客觀、以第三人稱書寫。**絕對不要**出現「AI」「模型」「agent」「成員」「協調者」「以下是」「身為…」這類字眼或對話痕跡。
2. **消化整合**所有材料，重新組織成連貫敘事，不要逐字複製或條列貼上各方論點；有衝突的觀點要整合或權衡後給出結論。
3. 結構（用 Markdown 標題）：
   - 一級標題：報告標題（精煉、專業）
   - ## 執行摘要（3–6 句，先講結論與關鍵建議）
   - ## 背景與目標
   - ## 分析與發現（可再分數個 ### 小節，依議題邏輯切分）
   - ## 結論與建議（具體、可執行；建議用編號清單）
   - ## 後續步驟或風險（如適用）
4. 善用 Markdown：標題、清單、**粗體**重點、必要時用表格整理比較或數據。
5. 內容要充實、具體、有條理；避免空泛口號。保留材料中的關鍵數據、案例與來源。
6. 全程使用**繁體中文**。
7. 只輸出報告本身的 Markdown，不要任何前言、說明或結尾客套（例如不要寫「希望這份報告對您有幫助」）。`;

interface MemberOut { name: string; text?: string; text2?: string }

function buildUserMessage(question: string, synthesis: string, members: MemberOut[]): string {
  const parts: string[] = [];
  parts.push(`# 議題\n${question || '（未提供）'}`);
  if (synthesis?.trim()) parts.push(`# 既有統整結論\n${synthesis.trim()}`);
  const ms = members.filter(m => (m.text || '').trim());
  if (ms.length) {
    parts.push('# 各顧問分析素材');
    ms.forEach((m, i) => {
      parts.push(`## 素材 ${i + 1}：${m.name}\n${(m.text || '').trim()}${m.text2?.trim() ? `\n\n（補充）${m.text2.trim()}` : ''}`);
    });
  }
  parts.push('---\n請依系統指示，將以上素材整理成一份正式完整報告。');
  return parts.join('\n\n');
}

/**
 * Generate the formal report markdown for a saved team run. Loads the run,
 * runs one Claude CLI pass, records token usage, and returns the markdown.
 */
export async function generateFormalReport(opts: {
  userId: string;
  teamId: string;
  runId: string;
  onText?: (chunk: string) => void;
}): Promise<{ markdown: string; inputTokens: number; outputTokens: number }> {
  const run = await dbGet<{ question: string; result: string | null; member_outputs: string | null; status: string }>(
    'SELECT question, result, member_outputs, status FROM team_runs WHERE id = ? AND team_id = ? AND user_id = ?',
    opts.runId, opts.teamId, opts.userId,
  );
  if (!run) throw new Error('Run not found');
  if (run.status !== 'done') throw new Error('Run not finished');

  let members: MemberOut[] = [];
  try { members = JSON.parse(run.member_outputs || '[]'); } catch { /* ignore */ }

  const message = buildUserMessage(run.question, run.result || '', members);

  // Global gate: share the system-wide heavy-AI cap (formal report = full model).
  const release = await acquireAiSlot();
  const result = await new Promise<{ text: string; inputTokens: number; outputTokens: number; model: string }>(resolve => {
    let text = '';
    let inputTokens = 0, outputTokens = 0, model = '';
    let finished = false;
    const { emitter, abort } = spawnClaude(message, SYSTEM_PROMPT, {
      userId: opts.userId,
      conversationId: opts.teamId,
      sessionId: uuidv4(),
      isResume: false,
      sandboxSubdir: '_report',
      role: 'router', // no tools, single-turn reasoning
    });
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      release();
      resolve({ text, inputTokens, outputTokens, model });
    };
    const timer = setTimeout(() => { try { abort(); } catch { /* ignore */ } finish(); }, REPORT_TIMEOUT_MS);
    emitter.on('event', (ev: SSEEvent) => {
      if (ev.type === 'text' && typeof ev.data === 'string') {
        text += ev.data;
        opts.onText?.(ev.data);
      } else if (ev.type === 'usage') {
        const u = ev.data as { inputTokens?: number; outputTokens?: number; model?: string };
        inputTokens = u.inputTokens ?? 0;
        outputTokens = u.outputTokens ?? 0;
        model = u.model ?? '';
      } else if (ev.type === 'done' || ev.type === 'error') {
        finish();
      }
    });
  });

  if (result.inputTokens || result.outputTokens) {
    await recordTokenUsage({
      userId: opts.userId, conversationId: null,
      inputTokens: result.inputTokens, outputTokens: result.outputTokens,
      model: result.model || 'team-report',
    });
  }

  const markdown = result.text.trim();
  if (!markdown) throw new Error('Report generation produced no output');
  return { markdown, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
}
