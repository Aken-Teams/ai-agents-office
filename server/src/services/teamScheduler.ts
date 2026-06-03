/**
 * Team-run scheduler. A 60s interval finds due schedules (enabled + next_run_at
 * in the past), runs the team collaboration with no SSE sink, emails the result,
 * and rolls next_run_at forward. Single-process; on restart, overdue schedules
 * run on the next tick (catch-up).
 */

import { dbAll, dbGet, dbRun } from '../db.js';
import { runTeam } from './teamRun.js';
import { sendTeamReportEmail } from './email.js';
import { checkUserUsageLimit } from './usageLimit.js';

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

  const result = await runTeam({ userId: s.user_id, teamId: s.team_id, question: s.question, writer: () => {}, scheduleId: s.id });
  const ok = await sendTeamReportEmail(s.email, team.title, s.question, result.result, s.name);
  await dbRun('UPDATE team_runs SET emailed = ? WHERE id = ?', ok ? 1 : 0, result.runId);
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
  const result = await runTeam({ userId, teamId: s.team_id, question: s.question, writer: () => {}, scheduleId: s.id });
  const ok = await sendTeamReportEmail(s.email, team.title, s.question, result.result, s.name);
  await dbRun('UPDATE team_runs SET emailed = ? WHERE id = ?', ok ? 1 : 0, result.runId);
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
