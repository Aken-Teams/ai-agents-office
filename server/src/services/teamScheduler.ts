/**
 * Team-run scheduler. A 60s interval finds due schedules (enabled + next_run_at
 * in the past), runs the team collaboration with no SSE sink, emails the result,
 * and rolls next_run_at forward. Single-process; on restart, overdue schedules
 * run on the next tick (catch-up).
 */

import crypto from 'crypto';
import { dbAll, dbGet, dbRun } from '../db.js';
import { config } from '../config.js';
import { runTeam } from './teamRun.js';
import { sendTeamReportEmail } from './email.js';
import { checkUserUsageLimit } from './usageLimit.js';
import { pushMessage, type LineMessage, type QuickReply } from './line/client.js';
import { splitForLine } from './line/formatter.js';
import { buildTeamReportFlex } from './line/flex.js';
import { generateLineBriefing, type LineBriefing } from './personalization.js';

/** Mint (once) a public share token for a run and return its full website URL. */
async function buildShareUrl(runId: string): Promise<string> {
  const token = crypto.randomBytes(8).toString('hex');
  await dbRun('UPDATE team_runs SET share_token = ? WHERE id = ? AND share_token IS NULL', token, runId);
  const row = await dbGet<{ share_token: string | null }>('SELECT share_token FROM team_runs WHERE id = ?', runId);
  return `${config.publicWebUrl}/share/team/${row?.share_token || token}`;
}

/** Follow-up chips so a notification can turn into a conversation with one tap. */
function followUpQuickReply(teamId: string): QuickReply {
  return {
    items: [
      { type: 'action', action: { type: 'postback', label: '💬 追問這個團隊', data: `action=set_team&team=${encodeURIComponent(teamId)}`, displayText: '切換到這個團隊提問' } },
      { type: 'action', action: { type: 'postback', label: '⏰ 排程設定', data: 'action=schedule', displayText: '排程設定' } },
    ],
  };
}

/**
 * Push the scheduled report to LINE as a *personal, proactive* notification:
 * a greeting + TL;DR headline + key bullets, then the full synthesis only when
 * the run is materially different from last time. When nothing noteworthy
 * changed (briefing.significant === false) we send a single quiet line instead
 * of dumping the whole report — less noise, less push quota. Email always
 * carries the full report regardless, so nothing is lost.
 * Best-effort — failures are logged and swallowed.
 */
async function pushReportToLine(opts: {
  userId: string;
  teamId: string;
  label: string;
  briefing: LineBriefing;
  resultText: string;
  shareUrl: string;
}): Promise<void> {
  const { userId, teamId, label, briefing, resultText, shareUrl } = opts;
  try {
    const row = await dbGet<{ line_user_id: string }>('SELECT line_user_id FROM line_users WHERE internal_user_id = ?', userId);
    if (!row?.line_user_id) return;

    const bullets = briefing.bullets.length ? '\n' + briefing.bullets.map(b => `・${b}`).join('\n') : '';
    const flex = shareUrl ? buildTeamReportFlex(shareUrl, `${label}・完整報告`) : null;
    const chips = followUpQuickReply(teamId);

    let messages: LineMessage[];
    if (briefing.significant) {
      const headline = briefing.headline || `排程「${label}」有新的更新`;
      const lead = `📬 ${headline}${bullets}`;
      // Lead + up to 2 chunks of the full synthesis + the report card (chips on
      // the last message). Kept within LINE's 5-message-per-push cap.
      const body = splitForLine(resultText).slice(0, flex ? 2 : 3);
      messages = [{ type: 'text', text: lead }, ...body];
      if (flex) messages.push({ ...flex, quickReply: chips });
      else if (messages.length) (messages[messages.length - 1] as { quickReply?: QuickReply }).quickReply = chips;
    } else {
      // Quiet update — one line, no report dump. Link still available to tap.
      const headline = briefing.headline || '今天沒有重大變化，已幫你留意 ✅';
      const lead = `🟢 ${headline}${bullets}`;
      messages = [{ type: 'text', text: lead }];
      if (flex) messages.push({ ...flex, quickReply: chips });
      else (messages[0] as { quickReply?: QuickReply }).quickReply = chips;
    }

    await pushMessage(row.line_user_id, messages.slice(0, 5));
  } catch (err) {
    console.error('[scheduler] LINE push failed:', err);
  }
}

/**
 * Build the personalized briefing (relevance-gated against the previous run)
 * and push it to LINE. Shared by the scheduled tick and the manual "run now".
 */
async function deliverLineNotification(
  s: ScheduleRow,
  teamTitle: string,
  runId: string,
  resultText: string,
  shareUrl: string,
): Promise<void> {
  try {
    const user = await dbGet<{ display_name: string | null }>('SELECT display_name FROM users WHERE id = ?', s.user_id);
    const prev = await dbGet<{ result: string | null }>(
      "SELECT result FROM team_runs WHERE schedule_id = ? AND id != ? AND status = 'done' AND result IS NOT NULL ORDER BY created_at DESC LIMIT 1",
      s.id, runId,
    );
    const briefing = await generateLineBriefing({
      userId: s.user_id,
      userName: user?.display_name ?? null,
      teamTitle,
      question: s.question,
      currentResult: resultText,
      previousResult: prev?.result ?? null,
    });
    await pushReportToLine({ userId: s.user_id, teamId: s.team_id, label: s.name || s.question, briefing, resultText, shareUrl });
  } catch (err) {
    console.error('[scheduler] LINE notification failed:', err);
  }
}

export interface ScheduleSpec {
  frequency: 'daily' | 'weekly';
  hour: number;
  minute: number;
  dayOfWeek: number | null;
}

interface ScheduleRow extends ScheduleSpec {
  id: string;
  team_id: string;
  user_id: string;
  name: string | null;
  question: string;
  email: string;
  day_of_week: number | null;
}

const pad = (n: number) => String(n).padStart(2, '0');
export function mysqlDateTime(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Next occurrence (local time) of the schedule strictly after `from`. */
export function computeNextRun(frequency: string, hour: number, minute: number, dayOfWeek: number | null, from = new Date()): Date {
  const next = new Date(from);
  next.setHours(hour, minute, 0, 0);
  if (frequency === 'weekly' && dayOfWeek != null) {
    let diff = (dayOfWeek - next.getDay() + 7) % 7;
    if (diff === 0 && next <= from) diff = 7;
    next.setDate(next.getDate() + diff);
  } else {
    if (next <= from) next.setDate(next.getDate() + 1);
  }
  return next;
}

const running = new Set<string>();

async function processSchedule(s: ScheduleRow): Promise<void> {
  // Roll next_run_at forward first so a long run isn't re-picked next tick.
  const next = computeNextRun(s.frequency, s.hour, s.minute, s.day_of_week, new Date());
  await dbRun('UPDATE team_schedules SET next_run_at = ?, last_run_at = NOW() WHERE id = ?', mysqlDateTime(next), s.id);

  const usage = await checkUserUsageLimit(s.user_id);
  if (usage.exceeded) { console.warn(`[scheduler] skip ${s.id} — user quota exceeded`); return; }

  const team = await dbGet<{ title: string }>('SELECT title FROM agent_teams WHERE id = ? AND user_id = ?', s.team_id, s.user_id);
  if (!team) return;

  const result = await runTeam({ userId: s.user_id, teamId: s.team_id, question: s.question, writer: () => {}, scheduleId: s.id, personalized: true });
  const shareUrl = await buildShareUrl(result.runId);
  const ok = await sendTeamReportEmail(s.email, team.title, s.question, result.result, s.name, shareUrl);
  await dbRun('UPDATE team_runs SET emailed = ? WHERE id = ?', ok ? 1 : 0, result.runId);
  await deliverLineNotification(s, team.title, result.runId, result.result, shareUrl);
  console.log(`[scheduler] ran team "${team.title}" → email ${ok ? 'sent' : 'FAILED'} to ${s.email}`);
}

async function runDueSchedules(): Promise<void> {
  let due: ScheduleRow[];
  try {
    due = await dbAll<ScheduleRow>('SELECT * FROM team_schedules WHERE enabled = 1 AND next_run_at <= NOW() ORDER BY next_run_at ASC LIMIT 10');
  } catch (err) {
    console.error('[scheduler] query failed:', err);
    return;
  }
  for (const s of due) {
    if (running.has(s.id)) continue;
    running.add(s.id);
    processSchedule(s)
      .catch(err => console.error(`[scheduler] schedule ${s.id} failed:`, err))
      .finally(() => running.delete(s.id));
  }
}

/** Run one schedule immediately (manual test). Does not change next_run_at. */
export async function runScheduleNow(scheduleId: string, userId: string): Promise<boolean> {
  const s = await dbGet<ScheduleRow>('SELECT * FROM team_schedules WHERE id = ? AND user_id = ?', scheduleId, userId);
  if (!s) return false;
  const team = await dbGet<{ title: string }>('SELECT title FROM agent_teams WHERE id = ? AND user_id = ?', s.team_id, userId);
  if (!team) return false;
  const result = await runTeam({ userId, teamId: s.team_id, question: s.question, writer: () => {}, scheduleId: s.id, personalized: true });
  const shareUrl = await buildShareUrl(result.runId);
  const ok = await sendTeamReportEmail(s.email, team.title, s.question, result.result, s.name, shareUrl);
  await dbRun('UPDATE team_runs SET emailed = ? WHERE id = ?', ok ? 1 : 0, result.runId);
  await deliverLineNotification(s, team.title, result.runId, result.result, shareUrl);
  await dbRun('UPDATE team_schedules SET last_run_at = NOW() WHERE id = ?', s.id);
  console.log(`[scheduler] manual test "${team.title}" → email ${ok ? 'sent' : 'FAILED'} to ${s.email}`);
  return ok;
}

export function startTeamScheduler(): void {
  const timer = setInterval(() => { runDueSchedules().catch(() => {}); }, 60_000);
  timer.unref();
  // A short delay after boot catches anything overdue while the server was down.
  const kick = setTimeout(() => { runDueSchedules().catch(() => {}); }, 8000);
  kick.unref();
  console.log('Team scheduler started (checks every 60s)');
}
