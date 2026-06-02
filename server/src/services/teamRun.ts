/**
 * Team collaboration run — the "coordinator fan-out + synthesize" engine.
 *
 * Token design (the whole point): each member runs ONCE as a single-turn,
 * no-tool reasoning agent (cheapest + predictable). Each member's output is
 * truncated before being handed to the coordinator, so the synthesis input is
 * bounded. Cost is linear (N members + 1 synthesis), never N². A rolling
 * `agent_teams.shared_memory` carries distilled context across runs without
 * growing unbounded.
 *
 * Progress is streamed to the frontend via the injected `writer` so the user
 * watches each member analyse, then the coordinator synthesise.
 */

import { v4 as uuidv4 } from 'uuid';
import { spawnClaude } from './claudeCli.js';
import { truncateResultForRouter } from './taskParser.js';
import { dbGet, dbAll, dbRun } from '../db.js';
import { recordTokenUsage } from './tokenTracker.js';
import type { SSEEvent } from '../types.js';

export interface TeamRunEvent { type: string; data?: unknown }
export type TeamRunWriter = (event: TeamRunEvent) => void;

interface TeamRow { id: string; user_id: string; title: string; topic: string | null; shared_memory: string | null }
interface MemberRow { id: string; title: string; icon: string | null; skill_id: string | null; system_prompt: string | null }

const MEMBER_TRUNCATE = 1500;      // chars of each member output fed to the coordinator
const SHARED_MEMORY_MAX = 2000;    // chars of rolling team memory kept across runs
const MEMBER_CONCURRENCY = 3;      // parallel Claude processes (memory cap)
const MEMBER_TIMEOUT_MS = 150_000;
const SYNTH_TIMEOUT_MS = 180_000;

/**
 * Rough pre-run token estimate so the UI can warn before spending. Heuristic,
 * deliberately a little generous.
 */
export function estimateRunTokens(memberCount: number): { inputTokens: number; outputTokens: number } {
  const perMemberIn = 900, perMemberOut = 1200;
  const synthIn = 700 + memberCount * 450, synthOut = 1500;
  return {
    inputTokens: memberCount * perMemberIn + synthIn,
    outputTokens: memberCount * perMemberOut + synthOut,
  };
}

/** Display cost (USD) — mirrors the app's 10× markup on Sonnet pricing. */
export function estimateCostUsd(inputTokens: number, outputTokens: number): number {
  return Math.round(((inputTokens / 1_000_000) * 3 + (outputTokens / 1_000_000) * 15) * 10 * 100) / 100;
}

function buildMemberSystemPrompt(member: MemberRow, sharedMemory: string): string {
  const role = (member.system_prompt || `你是「${member.title}」。`).trim();
  const mem = sharedMemory.trim()
    ? `\n\n【團隊先前的共識與記憶】\n${sharedMemory.trim()}\n（可參考，但以本次議題為主）`
    : '';
  return `你是一個 AI 團隊的成員之一，名稱是「${member.title}」。
${role}${mem}

請針對使用者提出的議題，從你的專業角度提出分析與觀點：聚焦、具體、有明確結論。
直接輸出純文字分析即可，不需要產生檔案、不需要客套開場白。`;
}

function runOneClaude(
  userId: string,
  conversationId: string,
  sandboxSubdir: string,
  message: string,
  systemPrompt: string,
  timeoutMs: number,
  onText: (chunk: string) => void,
): Promise<{ text: string; inputTokens: number; outputTokens: number; model: string }> {
  return new Promise(resolve => {
    let text = '';
    let inputTokens = 0, outputTokens = 0, model = '';
    let finished = false;

    // role:'router' → no tools + single turn. Perfect for cheap, predictable,
    // file-free reasoning. We override the sandbox to keep team work isolated.
    const { emitter, abort } = spawnClaude(message, systemPrompt, {
      userId,
      conversationId,
      sessionId: uuidv4(),
      isResume: false,
      role: 'router',
      sandboxSubdir,
    });

    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ text, inputTokens, outputTokens, model });
    };
    const timer = setTimeout(() => { try { abort(); } catch { /* ignore */ } finish(); }, timeoutMs);

    emitter.on('event', (ev: SSEEvent) => {
      if (ev.type === 'text' && typeof ev.data === 'string') {
        text += ev.data;
        onText(ev.data);
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
}

interface MemberResult { member: MemberRow; text: string; inputTokens: number; outputTokens: number }

export interface TeamRunResult { runId: string; result: string; inputTokens: number; outputTokens: number; model: string }

/**
 * Run a full team collaboration. Streams progress via `writer`; resolves with
 * the final synthesis + token totals. Never throws for member-level failures
 * (a failed member just contributes empty findings).
 */
export async function runTeam(opts: { userId: string; teamId: string; question: string; writer: TeamRunWriter }): Promise<TeamRunResult> {
  const { userId, teamId, question, writer } = opts;

  const team = await dbGet<TeamRow>('SELECT id, user_id, title, topic, shared_memory FROM agent_teams WHERE id = ? AND user_id = ?', teamId, userId);
  if (!team) throw new Error('Team not found');

  const members = await dbAll<MemberRow>(
    "SELECT id, title, icon, skill_id, system_prompt FROM conversations WHERE team_id = ? AND user_id = ? AND status != 'deleted' ORDER BY created_at ASC",
    teamId, userId,
  );
  if (members.length === 0) throw new Error('Team has no members');

  const runId = uuidv4();
  await dbRun(
    'INSERT INTO team_runs (id, team_id, user_id, question, status) VALUES (?, ?, ?, ?, ?)',
    runId, teamId, userId, question, 'running',
  );

  const est = estimateRunTokens(members.length);
  writer({
    type: 'team_run_start',
    data: {
      runId,
      members: members.map(m => ({ memberId: m.id, name: m.title, icon: m.icon, skillId: m.skill_id })),
      estimate: { ...est, costUsd: estimateCostUsd(est.inputTokens, est.outputTokens) },
    },
  });

  const sharedMemory = team.shared_memory || '';

  // ── Fan out to members (batched for a concurrency cap) ──────────────────
  const results: MemberResult[] = [];
  for (let i = 0; i < members.length; i += MEMBER_CONCURRENCY) {
    const batch = members.slice(i, i + MEMBER_CONCURRENCY);
    const batchResults = await Promise.all(batch.map(async member => {
      writer({ type: 'member_status', data: { memberId: member.id, status: 'running' } });
      const sys = buildMemberSystemPrompt(member, sharedMemory);
      const r = await runOneClaude(
        userId, member.id, `_team/${member.id}`, question, sys, MEMBER_TIMEOUT_MS,
        chunk => writer({ type: 'member_stream', data: { memberId: member.id, content: chunk } }),
      );
      const ok = !!r.text.trim();
      writer({
        type: 'member_done',
        data: { memberId: member.id, status: ok ? 'done' : 'failed', tokens: { inputTokens: r.inputTokens, outputTokens: r.outputTokens } },
      });
      return { member, text: r.text.trim(), inputTokens: r.inputTokens, outputTokens: r.outputTokens } as MemberResult;
    }));
    results.push(...batchResults);
  }

  // ── Coordinator synthesis ───────────────────────────────────────────────
  writer({ type: 'synthesis_status', data: { status: 'running' } });

  const findingsBlock = results
    .map(r => `### ${r.member.title}\n${r.text ? truncateResultForRouter(r.text, MEMBER_TRUNCATE) : '（此成員未提供分析）'}`)
    .join('\n\n');

  const synthSystem = `你是一個 AI 團隊的協調者。團隊成員已各自針對議題提出分析，你的任務是整合成一份對使用者有用的最終結論：
- 點出各方的共識、分歧與最關鍵的洞察
- 給出明確、可行動的建議
- 不要逐字複述每位成員，要融會貫通
- 繁體中文、避免冗詞

請用 Markdown 格式輸出，讓結論清楚易讀：
- 用 ## 小標題分段（例如：## 共識 / ## 分歧 / ## 核心洞察 / ## 建議）
- 重點用條列清單（- 或 1.）
- 需要比較多個項目時用 Markdown 表格（| 欄 | 欄 |）`;

  const synthMessage = `議題：${question}

以下是各成員的分析：

${findingsBlock}

請整合以上分析，輸出最終結論與建議。`;

  const synth = await runOneClaude(
    userId, teamId, `_team/_coordinator`, synthMessage, synthSystem, SYNTH_TIMEOUT_MS,
    chunk => writer({ type: 'synthesis_stream', data: { content: chunk } }),
  );

  const finalText = synth.text.trim() || '（統整未產生內容，請重試）';

  const totalIn = results.reduce((s, r) => s + r.inputTokens, 0) + synth.inputTokens;
  const totalOut = results.reduce((s, r) => s + r.outputTokens, 0) + synth.outputTokens;

  writer({ type: 'synthesis_done', data: { result: finalText, tokens: { inputTokens: synth.inputTokens, outputTokens: synth.outputTokens } } });

  // ── Persist run + record tokens ─────────────────────────────────────────
  const memberOutputs = results.map(r => ({ memberId: r.member.id, name: r.member.title, icon: r.member.icon, text: r.text }));
  await dbRun(
    'UPDATE team_runs SET result = ?, member_outputs = ?, input_tokens = ?, output_tokens = ?, status = ? WHERE id = ?',
    finalText, JSON.stringify(memberOutputs), totalIn, totalOut, 'done', runId,
  );

  if (totalIn > 0 || totalOut > 0) {
    await recordTokenUsage({ userId, conversationId: null, inputTokens: totalIn, outputTokens: totalOut, model: synth.model || 'team-run' });
  }

  // ── Update rolling shared memory (Phase 3) — no extra LLM call ───────────
  const distilled = `【議題】${question}\n【結論】${truncateResultForRouter(finalText, 700)}`;
  const newMemory = (distilled + (sharedMemory ? `\n\n---\n${sharedMemory}` : '')).slice(0, SHARED_MEMORY_MAX);
  await dbRun('UPDATE agent_teams SET shared_memory = ? WHERE id = ?', newMemory, teamId);

  writer({
    type: 'team_run_done',
    data: { runId, inputTokens: totalIn, outputTokens: totalOut, costUsd: estimateCostUsd(totalIn, totalOut) },
  });

  return { runId, result: finalText, inputTokens: totalIn, outputTokens: totalOut, model: synth.model };
}
