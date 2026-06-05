/**
 * Personalization helpers for proactive (scheduled) notifications.
 *
 * Two jobs, both aimed at making a scheduled team run feel like a personal
 * assistant proactively reaching out rather than a cron job dumping a report:
 *
 *  - getUserPersonaContext(): a compact block of who the user is and what they
 *    care about (display name + extracted memories), injected into the team's
 *    prompts so the analysis is *for them*, not generic.
 *
 *  - generateLineBriefing(): a single cheap LLM pass that compares this run to
 *    the previous one and produces a short, personal LINE opener (greeting +
 *    TL;DR + 2-3 bullets) plus a `significant` flag. The scheduler uses the
 *    flag to decide whether the update is worth a full push or just a quiet
 *    one-liner — i.e. only "interrupt" the user when there's something to say.
 */

import { EventEmitter } from 'events';
import { spawnClaude } from './claudeCli.js';
import { dbGet, dbAll } from '../db.js';
import { truncateResultForRouter } from './taskParser.js';
import { v4 as uuidv4 } from 'uuid';
import type { SSEEvent } from '../types.js';

const BRIEFING_TIMEOUT_MS = 30_000;
// A small, fast model is plenty for "compare two reports + write 4 lines".
const BRIEFING_MODEL = 'claude-haiku-4-5-20251001';

/**
 * One-shot, tool-free Claude completion. Mirrors the team engine's
 * `runOneClaude` but standalone (router role → no tools, single turn).
 */
function oneShot(userId: string, system: string, message: string, model?: string): Promise<string> {
  return new Promise(resolve => {
    let text = '';
    let finished = false;
    let emitter: EventEmitter;
    let abort: () => void;
    try {
      ({ emitter, abort } = spawnClaude(message, system, {
        userId,
        conversationId: 'personalization',
        sessionId: uuidv4(),
        isResume: false,
        sandboxSubdir: '_personalization',
        role: 'router',
        ...(model ? { model } : {}),
      }));
    } catch {
      resolve('');
      return;
    }
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(text);
    };
    const timer = setTimeout(() => { try { abort(); } catch { /* ignore */ } finish(); }, BRIEFING_TIMEOUT_MS);
    emitter.on('event', (ev: SSEEvent) => {
      if (ev.type === 'text' && typeof ev.data === 'string') text += ev.data;
      else if (ev.type === 'done' || ev.type === 'error') finish();
    });
  });
}

/**
 * A compact persona block for the user, or '' if we know nothing about them.
 * Pulls the display name and the user's extracted preference / work-log
 * memories (the same store the web assistant personalizes from).
 */
export async function getUserPersonaContext(userId: string): Promise<string> {
  const user = await dbGet<{ display_name: string | null }>('SELECT display_name FROM users WHERE id = ?', userId);
  const memories = await dbAll<{ content: string }>(
    "SELECT content FROM user_memories WHERE user_id = ? AND memory_type IN ('preference','work_log') ORDER BY created_at DESC LIMIT 12",
    userId,
  );

  const name = user?.display_name?.trim();
  const facts = memories.map(m => m.content.trim()).filter(Boolean);
  if (!name && facts.length === 0) return '';

  const lines: string[] = [];
  if (name) lines.push(`- 稱呼：${name}`);
  for (const f of facts) lines.push(`- ${f}`);

  return `\n\n【關於這位使用者（請貼合他的情境與在意的重點，但仍以本次議題為主；不要為了帶到而硬湊）】\n${lines.join('\n')}`;
}

export interface LineBriefing {
  significant: boolean;   // worth a full proactive push vs. a quiet one-liner
  headline: string;       // one-line TL;DR (may address the user by name)
  bullets: string[];      // 2-3 key points
}

/**
 * Compare this scheduled run to the previous one and produce a short, personal
 * LINE opener. First run (no previous) is always significant. Falls back to a
 * safe default (significant=true, no bullets) if the model call fails, so a
 * delivery is never silently dropped because briefing failed.
 */
export async function generateLineBriefing(opts: {
  userId: string;
  userName: string | null;
  teamTitle: string;
  question: string;
  currentResult: string;
  previousResult: string | null;
}): Promise<LineBriefing> {
  const { userId, userName, teamTitle, question, currentResult, previousResult } = opts;

  const namePart = userName?.trim() ? `使用者稱呼：「${userName.trim()}」。` : '';
  const prevPart = previousResult?.trim()
    ? `【上一次的結論（用來比較有沒有實質變化）】\n${truncateResultForRouter(previousResult, 1500)}`
    : '【上一次的結論】（無，這是第一次執行）';

  const system = `你是一個貼心的個人助理，正準備把「${teamTitle}」團隊的最新一次定期分析，用 LINE 主動通知使用者。${namePart}
你的任務：把冗長的分析濃縮成「一眼就懂、像朋友主動報訊」的開場，並判斷這次的更新值不值得主動打擾使用者。

判斷 significant（是否值得主動推播）的原則：
- 和上一次相比，有「實質變化、新重點、需要注意或行動」的事 → true
- 只是重複、無明顯變化、無新意 → false
- 若沒有上一次紀錄（第一次），一律 true

請只輸出 JSON（不要 markdown 圍欄、不要多餘文字）：
{"significant": true 或 false, "headline": "一句話講最重要的事（30 字內，可自然地帶到稱呼，繁體中文）", "bullets": ["重點一", "重點二", "重點三"]}
bullets 各 30 字內、最多 3 條，挑最值得知道的；口吻自然、像真人助理，不要客套廢話。`;

  const message = `議題：${question}

${prevPart}

【這一次的最新結論】
${truncateResultForRouter(currentResult, 2500)}

請依上面規則輸出 JSON。`;

  const raw = await oneShot(userId, system, message, BRIEFING_MODEL);
  const parsed = parseBriefing(raw);
  if (parsed) return parsed;

  // Model failed / unparsable — don't drop the notification, just send it plainly.
  return { significant: true, headline: '', bullets: [] };
}

function parseBriefing(text: string): LineBriefing | null {
  try {
    const match = text.match(/\{[\s\S]*"significant"[\s\S]*\}/);
    if (!match) return null;
    const p = JSON.parse(match[0]);
    return {
      significant: p.significant !== false, // default to true unless explicitly false
      headline: typeof p.headline === 'string' ? p.headline.trim().slice(0, 80) : '',
      bullets: Array.isArray(p.bullets)
        ? p.bullets.filter((b: unknown): b is string => typeof b === 'string' && b.trim().length > 0)
            .map((b: string) => b.trim().slice(0, 60))
            .slice(0, 3)
        : [],
    };
  } catch {
    return null;
  }
}
