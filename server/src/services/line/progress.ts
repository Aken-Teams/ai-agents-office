/**
 * LINE progress notifier — keeps the single-assistant chat from going silent
 * while the orchestrator runs.
 *
 * LINE only has a subtle "typing…" loading animation (and it caps at 60s), so
 * users often can't tell whether the bot is actually working. This notifier
 * pushes at most two short, content-aware progress messages:
 *
 *   1. A "working on it" reassurance — sent the moment we know real work was
 *      dispatched (e.g. a file generator started), or as a fallback once the
 *      run has been going for FIRST_MS without finishing. Fast conversational
 *      replies finish before the fallback fires, so they send nothing extra —
 *      no quota cost, no chat clutter.
 *   2. A "still working" nudge for genuinely long runs (SECOND_MS), since file
 *      generation can take 1–3 minutes and silence after the first hint feels
 *      like the bot stalled.
 *
 * The wording reflects what the orchestrator is doing (planning vs. generating
 * a specific document) so the hint feels like guidance, not a canned spinner.
 */

import { pushMessage } from './client.js';
import type { SSEEvent } from '../../types.js';

/** Friendly zh-TW labels for what each worker skill is doing, for progress copy. */
const SKILL_LABELS: Record<string, string> = {
  'pptx-gen': '製作 PowerPoint 簡報',
  'docx-gen': '撰寫 Word 文件',
  'xlsx-gen': '整理 Excel 試算表',
  'pdf-gen': '製作 PDF 文件',
  'slides-gen': '製作網頁簡報',
  'webapp-gen': '製作互動網頁',
  'research': '搜尋與研究資料',
  'planner': '規劃內容大綱',
  'reviewer': '審閱與校對內容',
  'data-analyst': '分析數據',
  'rag-analyst': '閱讀你提供的檔案',
};

// Fallback delay before reassuring on a slow run. Quick chat replies usually
// finish well under this, so they trigger no extra message.
const FIRST_MS = 6000;
// Long-run nudge — file generation commonly runs past this.
const SECOND_MS = 50000;

export interface ProgressNotifier {
  /** Feed every orchestrator SSE event so the copy can reflect current work. */
  onEvent(event: SSEEvent): void;
  /** Cancel pending hints — call when the run finishes (in a finally). */
  stop(): void;
}

/**
 * Arm a progress notifier for one LINE conversation turn. Returns immediately;
 * messages (if any) are pushed asynchronously and are best-effort.
 */
export function startProgressNotifier(lineUserId: string): ProgressNotifier {
  let done = false;
  let firstSent = false;
  let orchestrated = false;
  const activeSkills = new Set<string>();

  const push = (text: string): void => {
    if (done) return;
    pushMessage(lineUserId, [{ type: 'text', text }]).catch(() => {});
  };

  const skillLabels = (): string[] =>
    [...activeSkills].map(s => SKILL_LABELS[s]).filter(Boolean);

  const composeFirst = (): string => {
    const labels = skillLabels();
    if (labels.length > 0) {
      return `⏳ 收到了！我正在${labels.join('、')}，完成後會把結果傳給你 🙌`;
    }
    if (orchestrated) {
      return '⏳ 收到了！這個需求我會分成幾個步驟處理，需要一點時間，完成後會傳給你 🙌';
    }
    return '⏳ 收到了！正在幫你思考與處理中，完成後會把結果傳給你 🙌';
  };

  const sendFirst = (): void => {
    if (firstSent || done) return;
    firstSent = true;
    push(composeFirst());
  };

  const first = setTimeout(sendFirst, FIRST_MS);
  first.unref?.();

  const second = setTimeout(() => {
    // Only nudge again if we already reassured once and we're still running.
    if (!firstSent || done) return;
    const labels = skillLabels();
    const detail = labels.length > 0 ? `（${labels.join('、')}）` : '';
    push(`⌛ 還在處理中${detail}，內容比較豐富需要多一點時間，請再稍等一下～`);
  }, SECOND_MS);
  second.unref?.();

  return {
    onEvent(event: SSEEvent) {
      if (done) return;
      if (event.type === 'task_dispatched') {
        const skillId = (event.data as { skillId?: string } | undefined)?.skillId;
        if (skillId) activeSkills.add(skillId);
        orchestrated = true;
        // Real work was dispatched — reassure right away with a specific label
        // instead of waiting out the fallback timer.
        sendFirst();
      } else if (event.type === 'router_plan' || event.type === 'pipeline_started') {
        orchestrated = true;
      }
    },
    stop() {
      done = true;
      clearTimeout(first);
      clearTimeout(second);
    },
  };
}
