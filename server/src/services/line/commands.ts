/**
 * Slash-command parsing and handling for LINE messages.
 *
 * Recognised: `/link <code>`, `/new`, `/help`, `/quota`.
 * Anything else is treated as regular conversation.
 */

import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../../config.js';
import { dbGet, dbAll, dbRun } from '../../db.js';
import { checkUserUsageLimit } from '../usageLimit.js';
import { linkLineUser, LinkError, getLineUser, setLineActiveTeam, setLinePendingSched, type LineUserRow } from './userMapping.js';
import { pushMessage, getUserProfile, type LineTextMessage, type QuickReply } from './client.js';
import { createOrReuseFileShare } from './fileShare.js';
import { peekBindToken, markBindTokenConflict } from './qrAuth.js';
import { buildFileListFlex, buildUsageFlex, buildTeamPickerFlex, buildHelpFlex, buildScheduleListFlex, buildTeamDeleteFlex, buildConfirmTeamDeleteFlex, buildSchedTeamPickerFlex, buildSchedTimeFlex, type FileForFlex, type TeamForFlex, type ScheduleForFlex } from './flex.js';
import { createCustomTeam } from '../teamBuilder.js';
import { computeNextRun, mysqlDateTime } from '../teamScheduler.js';

const DOW = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
const pad2 = (n: number) => String(n).padStart(2, '0');

export interface ParsedCommand {
  kind: 'link' | 'help' | 'quota' | 'teams' | 'solo' | 'newteam' | 'files' | 'schedule' | 'delteam' | 'none';
  args: string;
}

export function parseCommand(text: string): ParsedCommand {
  const trimmed = (text || '').trim();
  if (!trimmed.startsWith('/')) return { kind: 'none', args: '' };
  const m = trimmed.match(/^\/(\w+)\s*(.*)$/);
  if (!m) return { kind: 'none', args: '' };
  const [, verb, rest] = m;
  switch (verb.toLowerCase()) {
    case 'link':  return { kind: 'link',  args: rest.trim() };
    case 'help':  return { kind: 'help',  args: rest.trim() };
    case 'quota': return { kind: 'quota', args: rest.trim() };
    case 'team':  return { kind: 'teams', args: rest.trim() };
    case 'teams': return { kind: 'teams', args: rest.trim() };
    case 'solo':  return { kind: 'solo',  args: rest.trim() };
    case 'newteam':    return { kind: 'newteam', args: rest.trim() };
    case 'createteam': return { kind: 'newteam', args: rest.trim() };
    case 'files': return { kind: 'files', args: rest.trim() };
    case 'file':  return { kind: 'files', args: rest.trim() };
    case 'schedule': return { kind: 'schedule', args: rest.trim() };
    case 'delteam':    return { kind: 'delteam', args: rest.trim() };
    case 'deleteteam': return { kind: 'delteam', args: rest.trim() };
    default:      return { kind: 'none',  args: trimmed };
  }
}

export async function handleHelp(lineUserId: string): Promise<void> {
  await pushMessage(lineUserId, [buildHelpFlex()]);
}

/**
 * Show the team picker. Lists the user's teams as postback buttons; tapping one
 * switches LINE into that team's collaboration mode. The footer returns to the
 * single assistant.
 */
export async function handleTeams(lineUser: LineUserRow): Promise<void> {
  const rows = await dbAll<{ id: string; title: string; topic: string | null; member_count: number }>(
    `SELECT t.id, t.title, t.topic,
            (SELECT COUNT(*) FROM conversations c WHERE c.team_id = t.id AND c.status != 'deleted') AS member_count
     FROM agent_teams t
     WHERE t.user_id = ?
     ORDER BY t.created_at DESC`,
    lineUser.internal_user_id,
  );

  if (rows.length === 0) {
    // No teams yet — drop straight into the guided creation flow instead of
    // telling the user to type a command.
    await startNewTeamFlow(lineUser);
    return;
  }

  const teams: TeamForFlex[] = rows.map(r => ({ id: r.id, title: r.title, topic: r.topic, memberCount: r.member_count }));
  await pushMessage(lineUser.line_user_id, [buildTeamPickerFlex(teams, lineUser.active_team_id)]);
}

/** Example team needs, shown as one-tap Quick Reply chips. Tapping a chip
 *  sends the scenario as a normal message, which the armed new-team wizard
 *  (pending state) then turns into a team — no command typing required. */
function newTeamQuickReply(): QuickReply {
  const examples: Array<[string, string]> = [
    ['📈 台股盤勢分析', '每小時幫我分析台股盤勢與我持股的風險'],
    ['🎤 活動企劃', '幫我規劃一場 100 人的產品發表會'],
    ['🔍 市場/競品研究', '幫我持續追蹤競品動態與市場趨勢'],
    ['✍️ 內容行銷', '幫我每週產出社群與部落格的內容企劃'],
    ['💡 創業點子評估', '幫我評估一個新創點子的市場與風險'],
  ];
  return {
    items: examples.map(([label, text]) => ({
      type: 'action',
      action: { type: 'message', label, text },
    })),
  };
}

/** Next-step chips shown after a team is created, so follow-up actions are
 *  taps rather than remembered commands. */
function afterTeamQuickReply(): QuickReply {
  return {
    items: [
      { type: 'action', action: { type: 'postback', label: '🔀 切換團隊', data: 'action=teams', displayText: '切換團隊' } },
      { type: 'action', action: { type: 'postback', label: '⏰ 設定排程', data: 'action=schedule', displayText: '設定排程' } },
      { type: 'action', action: { type: 'postback', label: '🤖 回單一助手', data: 'action=solo', displayText: '回到單一助手' } },
    ],
  };
}

/**
 * Start the guided team-creation flow. Instead of telling the user to type
 * `/newteam <描述>` (which they routinely re-type as a prefix and get wrong),
 * we *arm* a pending state and ask them to simply describe what they want —
 * their next plain message becomes the team. Quick-reply chips offer one-tap
 * examples. The pending state is shared with the schedule wizard via the
 * `pending_sched` column, discriminated by `kind`.
 */
export async function startNewTeamFlow(lineUser: LineUserRow): Promise<void> {
  await setLinePendingSched(lineUser.line_user_id, JSON.stringify({ kind: 'newteam', ts: Date.now() }));
  await pushMessage(lineUser.line_user_id, [{
    type: 'text',
    text: '想要哪一種 AI 團隊？\n\n直接打字描述你的需求就好（不用輸入任何指令），我就會幫你組一個專屬團隊。例如：「每小時幫我分析台股 (2481) 盤勢與風險」。\n\n也可以直接點下方範例 👇',
    quickReply: newTeamQuickReply(),
  }]);
}

/**
 * AI-build a team from a free-form scenario, switch the user into it, and
 * surface follow-up actions as chips. Shared by the typed `/newteam <描述>`
 * path and the pending-wizard path. Reuses the same team designer as the web
 * "AI 自訂團隊".
 */
async function buildTeamFromTopic(lineUser: LineUserRow, topic: string): Promise<void> {
  await pushMessage(lineUser.line_user_id, [{
    type: 'text',
    text: '🛠 正在用 AI 幫你組建團隊，請稍候約 10～20 秒…',
  }]);

  let result;
  try {
    result = await createCustomTeam(lineUser.internal_user_id, topic);
  } catch (err) {
    console.error('[LINE commands] createCustomTeam failed:', err);
    result = null;
  }

  if (!result) {
    await pushMessage(lineUser.line_user_id, [{
      type: 'text',
      text: '⚠️ 團隊建立失敗（AI 服務未設定或暫時無回應），請稍後重試，或到網頁用範本建立。',
      quickReply: { items: [{ type: 'action', action: { type: 'postback', label: '🔁 重試建立', data: 'action=new_team', displayText: '重新建立團隊' } }] },
    }]);
    return;
  }

  await setLineActiveTeam(lineUser.line_user_id, result.teamId);
  await pushMessage(lineUser.line_user_id, [{
    type: 'text',
    text: `✅ 已建立團隊「${result.title}」（${result.memberCount} 位成員）並切換到它。\n\n直接傳訊息問問題，整個團隊就會協作分析、再給你一份統整結論。`,
    quickReply: afterTeamQuickReply(),
  }]);
}

/**
 * Entry from `/newteam`. With a scenario, build straight away (power-user
 * path). Without one, start the guided, button-driven flow.
 */
export async function handleNewTeam(lineUser: LineUserRow, scenario: string): Promise<void> {
  const topic = scenario.trim();
  if (!topic) {
    await startNewTeamFlow(lineUser);
    return;
  }
  // A typed scenario supersedes any half-started wizard.
  await setLinePendingSched(lineUser.line_user_id, null);
  await buildTeamFromTopic(lineUser, topic);
}

/**
 * The user is mid-way through the guided team-creation flow and just sent the
 * scenario as a plain message. Build the team from it. Returns false (without
 * acting) if there's no armed new-team pending state or it has expired (30 min),
 * so the caller can treat the message as a normal question instead.
 */
export async function createTeamFromPending(lineUser: LineUserRow, text: string): Promise<boolean> {
  if (!lineUser.pending_sched) return false;
  let pend: { kind?: string; ts?: number };
  try {
    pend = JSON.parse(lineUser.pending_sched);
  } catch {
    return false; // not valid JSON — leave it for the schedule path to clear
  }
  if (pend.kind !== 'newteam') return false; // a different wizard owns the slot
  if (!pend.ts || Date.now() - pend.ts > 30 * 60 * 1000) {
    await setLinePendingSched(lineUser.line_user_id, null);
    return false; // expired — fall through to a normal message
  }

  await setLinePendingSched(lineUser.line_user_id, null);
  const topic = text.trim();
  if (!topic) {
    await startNewTeamFlow(lineUser); // empty — re-prompt with examples
    return true;
  }
  await buildTeamFromTopic(lineUser, topic);
  return true;
}

/**
 * Switch into a specific team (validated for ownership). Subsequent messages
 * run through that team's collaboration instead of the single assistant.
 */
export async function handleSetTeam(lineUser: LineUserRow, teamId: string): Promise<void> {
  const team = await dbGet<{ id: string; title: string }>(
    'SELECT id, title FROM agent_teams WHERE id = ? AND user_id = ?',
    teamId, lineUser.internal_user_id,
  );
  if (!team) {
    await pushMessage(lineUser.line_user_id, [{ type: 'text', text: '找不到這個團隊，可能已被刪除。請用 /teams 重新選擇。' }]);
    return;
  }
  await setLineActiveTeam(lineUser.line_user_id, team.id);
  await pushMessage(lineUser.line_user_id, [{
    type: 'text',
    text: `✅ 已切換到團隊「${team.title}」。\n接下來你問的問題會由整個團隊協作分析、再給你一份統整結論（較花時間與用量）。\n隨時可從下方選單切回單一助手。`,
    quickReply: afterTeamQuickReply(),
  }]);
}

/** Return to the single rolling assistant (clears the active team). */
export async function handleSolo(lineUser: LineUserRow): Promise<void> {
  await setLineActiveTeam(lineUser.line_user_id, null);
  await pushMessage(lineUser.line_user_id, [{
    type: 'text',
    text: '✅ 已回到單一助手模式。直接傳訊息即可對話。需要團隊協作時，點下方選單的「團隊協作」即可。',
  }]);
}

export async function handleLink(lineUserId: string, args: string): Promise<void> {
  const inviteCode = args.split(/\s+/)[0] || '';

  // One LINE ↔ one account. If this LINE is already bound, a scan carrying a
  // bind code for a DIFFERENT account is a conflict → fail clearly (and flag the
  // token so the other account's web QR page shows the failure too).
  const existing = await getLineUser(lineUserId);
  if (existing) {
    const target = inviteCode ? await peekBindToken(inviteCode) : null;
    if (target && target !== existing.internal_user_id) {
      await markBindTokenConflict(inviteCode);
      await pushMessage(lineUserId, [{
        type: 'text',
        text: '❌ 綁定失敗：此 LINE 已綁定其他帳號。\n\n一個 LINE 只能綁定一個帳號。若要改綁，請先到原帳號的網頁解除綁定後再試。',
      }]);
      return;
    }
    await pushMessage(lineUserId, [{
      type: 'text',
      text: '✅ 您的 LINE 已綁定帳號，直接傳訊息即可開始對話。',
    }]);
    return;
  }

  if (!inviteCode) {
    await pushMessage(lineUserId, [{
      type: 'text',
      text: '請帶上綁定碼，例如：/link ABC123\n（請先在網頁登入，產生綁定 QR 後掃描，系統會自動帶入此指令）',
    }]);
    return;
  }

  let displayName: string | null = null;
  try {
    const profile = await getUserProfile(lineUserId);
    displayName = profile.displayName;
  } catch {
    // Profile fetch is non-essential — proceed without a name.
  }

  try {
    await linkLineUser({ lineUserId, inviteCode, displayName });
  } catch (err) {
    if (err instanceof LinkError) {
      await pushMessage(lineUserId, [{
        type: 'text',
        text: `綁定失敗：${err.message}`,
      }]);
      return;
    }
    throw err;
  }

  // Bind-only model: the user is already logged in on the web (that's where
  // they generated the QR). Just confirm — no web-login link. The web page is
  // polling and will flip to "已綁定" on its own.
  await pushMessage(lineUserId, [{
    type: 'text',
    text: '✅ 綁定成功！您的 LINE 已連結到您的帳號。\n\n直接傳訊息就能開始用，例如「幫我分析…」「幫我做一份 PPT」。\n輸入 /help 可看完整教學、/newteam 可請 AI 幫你建專家團隊。',
  }]);
}

export async function handleQuota(lineUser: LineUserRow): Promise<void> {
  const usage = await checkUserUsageLimit(lineUser.internal_user_id);
  const overrideRow = await dbGet<{ quota_override: number | null }>(
    'SELECT quota_override FROM users WHERE id = ?',
    lineUser.internal_user_id,
  );
  const limit = overrideRow?.quota_override ?? usage.limit;

  await pushMessage(lineUser.line_user_id, [
    buildUsageFlex({ usedUsd: usage.cost, limitUsd: limit, exceeded: usage.exceeded }),
  ]);
}

/**
 * Schedules. `/schedule` lists all the user's team schedules; `/schedule HH:MM
 * <議題>` creates a daily schedule for the currently-active team, emailing the
 * report to the account email. (Weekly / other emails can be set on the web.)
 */
export async function handleSchedule(lineUser: LineUserRow, args: string): Promise<void> {
  const a = (args || '').trim();

  if (!a) {
    const rows = await dbAll<{ id: string; name: string | null; question: string; frequency: string; hour: number; minute: number; day_of_week: number | null; email: string; enabled: number; team_title: string }>(
      `SELECT s.id, s.name, s.question, s.frequency, s.hour, s.minute, s.day_of_week, s.email, s.enabled, t.title AS team_title
       FROM team_schedules s JOIN agent_teams t ON t.id = s.team_id
       WHERE s.user_id = ? ORDER BY s.created_at DESC`,
      lineUser.internal_user_id,
    );
    const items: ScheduleForFlex[] = rows.map(r => ({
      id: r.id,
      teamTitle: r.team_title,
      summary: r.name || r.question,
      when: `${r.frequency === 'weekly' && r.day_of_week != null ? DOW[r.day_of_week] : '每天'} ${pad2(r.hour)}:${pad2(r.minute)}`,
      email: r.email,
      enabled: !!r.enabled,
    }));
    await pushMessage(lineUser.line_user_id, [buildScheduleListFlex(items)]);
    return;
  }

  // Create: "HH:MM <議題>"
  const m = a.match(/^(\d{1,2}):(\d{2})\s+([\s\S]+)$/);
  if (!m) {
    await pushMessage(lineUser.line_user_id, [{
      type: 'text',
      text: '設定排程格式：\n/schedule 09:00 你要每天定期分析的議題\n\n（會用你目前切換的團隊、每天該時間自動分析並寄到你的信箱。先用選單切到一個團隊。）',
    }]);
    return;
  }
  const hour = Math.max(0, Math.min(23, Number(m[1])));
  const minute = Math.max(0, Math.min(59, Number(m[2])));
  const question = m[3].trim();

  if (!lineUser.active_team_id) {
    await pushMessage(lineUser.line_user_id, [{ type: 'text', text: '請先用 /teams（或選單）切換到一個團隊，再設定排程。' }]);
    return;
  }
  const team = await dbGet<{ id: string; title: string }>('SELECT id, title FROM agent_teams WHERE id = ? AND user_id = ?', lineUser.active_team_id, lineUser.internal_user_id);
  if (!team) {
    await pushMessage(lineUser.line_user_id, [{ type: 'text', text: '目前的團隊已不存在，請用 /teams 重新選擇。' }]);
    return;
  }
  const userRow = await dbGet<{ email: string }>('SELECT email FROM users WHERE id = ?', lineUser.internal_user_id);
  if (!userRow?.email) {
    await pushMessage(lineUser.line_user_id, [{ type: 'text', text: '找不到你的帳號 email，無法寄送排程報告，請聯繫管理員。' }]);
    return;
  }

  const next = computeNextRun('daily', hour, minute, null);
  const id = uuidv4();
  await dbRun(
    'INSERT INTO team_schedules (id, team_id, user_id, name, question, frequency, hour, minute, day_of_week, email, next_run_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, team.id, lineUser.internal_user_id, question.slice(0, 255), question, 'daily', hour, minute, null, userRow.email, mysqlDateTime(next),
  );
  await pushMessage(lineUser.line_user_id, [{
    type: 'text',
    text: `✅ 已設定排程：團隊「${team.title}」每天 ${pad2(hour)}:${pad2(minute)} 自動分析\n議題：${question}\n結果會寄到 ${userRow.email}，並推送到這裡。\n下次執行：${next.toLocaleString()}\n\n用 /schedule 可查看或刪除排程。`,
  }]);
}

/** Delete a schedule (from the /schedule list's delete button). */
export async function handleDelSchedule(lineUser: LineUserRow, scheduleId: string): Promise<void> {
  await dbRun('DELETE FROM team_schedules WHERE id = ? AND user_id = ?', scheduleId, lineUser.internal_user_id);
  await pushMessage(lineUser.line_user_id, [{ type: 'text', text: '✅ 已刪除該排程。' }]);
}

const DAILY_UPDATE_QUESTION = '請針對本團隊負責的主題，提供今天最新的觀察、重點變化與可行動建議。';

/** Button flow step 1: pick a team to schedule. */
export async function handleSchedNew(lineUser: LineUserRow): Promise<void> {
  const rows = await dbAll<{ id: string; title: string }>('SELECT id, title FROM agent_teams WHERE user_id = ? ORDER BY created_at DESC', lineUser.internal_user_id);
  if (rows.length === 0) {
    await pushMessage(lineUser.line_user_id, [{
      type: 'text',
      text: '排程需要先有一個團隊。先建立一個，之後就能排定每天自動分析並寄到你的信箱。',
      quickReply: { items: [{ type: 'action', action: { type: 'postback', label: '✨ 建立團隊', data: 'action=new_team', displayText: '建立團隊' } }] },
    }]);
    return;
  }
  await pushMessage(lineUser.line_user_id, [buildSchedTeamPickerFlex(rows.map(r => ({ id: r.id, title: r.title })))]);
}

/** Button flow step 2: pick a time for the chosen team. */
export async function handleSchedTeam(lineUser: LineUserRow, teamId: string): Promise<void> {
  const team = await dbGet<{ id: string; title: string }>('SELECT id, title FROM agent_teams WHERE id = ? AND user_id = ?', teamId, lineUser.internal_user_id);
  if (!team) {
    await pushMessage(lineUser.line_user_id, [{ type: 'text', text: '找不到這個團隊，可能已被刪除。請用 /schedule 重新開始。' }]);
    return;
  }
  await pushMessage(lineUser.line_user_id, [buildSchedTimeFlex(team.id, team.title)]);
}

/** Button flow step 3: time chosen → ask what to analyse (free text). The
 *  team + time are stashed in pending_sched; the next message is the topic. */
export async function handleSchedSet(lineUser: LineUserRow, teamId: string, hhmm: string): Promise<void> {
  const m = /^(\d{2})(\d{2})$/.exec(hhmm);
  if (!m) { await pushMessage(lineUser.line_user_id, [{ type: 'text', text: '時間格式錯誤，請用 /schedule 重新開始。' }]); return; }
  const hour = Math.max(0, Math.min(23, Number(m[1])));
  const minute = Math.max(0, Math.min(59, Number(m[2])));

  const team = await dbGet<{ id: string; title: string }>('SELECT id, title FROM agent_teams WHERE id = ? AND user_id = ?', teamId, lineUser.internal_user_id);
  if (!team) { await pushMessage(lineUser.line_user_id, [{ type: 'text', text: '找不到這個團隊，可能已被刪除。' }]); return; }

  await setLinePendingSched(lineUser.line_user_id, JSON.stringify({ teamId: team.id, hour, minute, ts: Date.now() }));
  await pushMessage(lineUser.line_user_id, [{
    type: 'text',
    text: `好，最後一步！\n團隊「${team.title}」每天 ${pad2(hour)}:${pad2(minute)} 要分析什麼？\n\n直接打字輸入議題，例如：「今天的台股盤勢與我持股的風險」。\n（想用團隊原本的主題就回覆「預設」。）`,
  }]);
}

/**
 * The user typed the analysis topic for a pending schedule (set by
 * handleSchedSet). Creates the daily schedule. Returns false (without acting)
 * if the pending state is missing or older than 30 min, so the caller can treat
 * the message as a normal question instead.
 */
export async function createScheduleFromPending(lineUser: LineUserRow, topicText: string): Promise<boolean> {
  if (!lineUser.pending_sched) return false;
  let pend: { teamId?: string; hour?: number; minute?: number; ts?: number };
  try { pend = JSON.parse(lineUser.pending_sched); } catch { await setLinePendingSched(lineUser.line_user_id, null); return false; }
  if (!pend.teamId || pend.hour == null || pend.minute == null || !pend.ts || Date.now() - pend.ts > 30 * 60 * 1000) {
    await setLinePendingSched(lineUser.line_user_id, null);
    return false;
  }

  const team = await dbGet<{ id: string; title: string; topic: string | null }>('SELECT id, title, topic FROM agent_teams WHERE id = ? AND user_id = ?', pend.teamId, lineUser.internal_user_id);
  const userRow = await dbGet<{ email: string }>('SELECT email FROM users WHERE id = ?', lineUser.internal_user_id);
  await setLinePendingSched(lineUser.line_user_id, null);
  if (!team) { await pushMessage(lineUser.line_user_id, [{ type: 'text', text: '找不到該團隊，排程已取消，請重新設定。' }]); return true; }
  if (!userRow?.email) { await pushMessage(lineUser.line_user_id, [{ type: 'text', text: '找不到你的帳號 email，無法寄送排程報告，請聯繫管理員。' }]); return true; }

  const raw = topicText.trim();
  const usePreset = /^(預設|preset|default|主題)$/i.test(raw) || !raw;
  const question = usePreset ? (team.topic?.trim() || DAILY_UPDATE_QUESTION) : raw;

  const next = computeNextRun('daily', pend.hour, pend.minute, null);
  await dbRun(
    'INSERT INTO team_schedules (id, team_id, user_id, name, question, frequency, hour, minute, day_of_week, email, next_run_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    uuidv4(), team.id, lineUser.internal_user_id, `${team.title} 每日更新`, question, 'daily', pend.hour, pend.minute, null, userRow.email, mysqlDateTime(next),
  );
  await pushMessage(lineUser.line_user_id, [{
    type: 'text',
    text: `✅ 已設定：團隊「${team.title}」每天 ${pad2(pend.hour)}:${pad2(pend.minute)} 自動分析\n議題：${question}\n結果會寄到 ${userRow.email} 並推送到這裡。\n下次執行：${next.toLocaleString()}\n\n用 /schedule 可查看或刪除。`,
  }]);
  return true;
}

/** Show the team list with delete buttons (`/delteam`). */
export async function handleDelTeam(lineUser: LineUserRow): Promise<void> {
  const rows = await dbAll<{ id: string; title: string }>('SELECT id, title FROM agent_teams WHERE user_id = ? ORDER BY created_at DESC', lineUser.internal_user_id);
  if (rows.length === 0) {
    await pushMessage(lineUser.line_user_id, [{ type: 'text', text: '你還沒有任何團隊。' }]);
    return;
  }
  await pushMessage(lineUser.line_user_id, [buildTeamDeleteFlex(rows.map(r => ({ id: r.id, title: r.title })))]);
}

/** Step 1 of team delete: confirm. */
export async function handleDelTeamPrompt(lineUser: LineUserRow, teamId: string): Promise<void> {
  const team = await dbGet<{ id: string; title: string }>('SELECT id, title FROM agent_teams WHERE id = ? AND user_id = ?', teamId, lineUser.internal_user_id);
  if (!team) {
    await pushMessage(lineUser.line_user_id, [{ type: 'text', text: '找不到這個團隊，可能已被刪除。' }]);
    return;
  }
  await pushMessage(lineUser.line_user_id, [buildConfirmTeamDeleteFlex(team.id, team.title)]);
}

/** Step 2 of team delete: actually remove the team + its member agents. */
export async function handleDelTeamConfirm(lineUser: LineUserRow, teamId: string): Promise<void> {
  const team = await dbGet<{ id: string; title: string }>('SELECT id, title FROM agent_teams WHERE id = ? AND user_id = ?', teamId, lineUser.internal_user_id);
  if (!team) {
    await pushMessage(lineUser.line_user_id, [{ type: 'text', text: '找不到這個團隊，可能已被刪除。' }]);
    return;
  }
  await dbRun("UPDATE conversations SET status = 'deleted' WHERE team_id = ? AND user_id = ?", team.id, lineUser.internal_user_id);
  await dbRun('DELETE FROM agent_teams WHERE id = ? AND user_id = ?', team.id, lineUser.internal_user_id);
  if (lineUser.active_team_id === team.id) await setLineActiveTeam(lineUser.line_user_id, null);
  await pushMessage(lineUser.line_user_id, [{ type: 'text', text: `✅ 已刪除團隊「${team.title}」。` }]);
}

/**
 * Greeting for un-linked users. Sent as the first reply to any message from
 * a stranger so onboarding is obvious.
 */
export async function handleUnlinkedGreeting(lineUserId: string): Promise<void> {
  const messages: LineTextMessage[] = [{
    type: 'text',
    text: [
      '👋 您好！您的 LINE 尚未綁定帳號。',
      '',
      `請先到 ${config.line.publicApiBase} 登入您的帳號，`,
      '在頁面上產生「綁定 LINE」的 QR Code 並掃描，',
      '系統會自動帶入綁定指令完成綁定。',
      '',
      '綁定完成後即可在這裡直接傳訊息開始對話。',
    ].join('\n'),
  }];
  await pushMessage(lineUserId, messages);
}

/**
 * List the most recent generated files for the linked user, with fresh share
 * URLs (existing tokens get reused). Rich-menu "我的文件" tile lands here.
 */
export async function handleListFiles(lineUser: LineUserRow): Promise<void> {
  const rows = await dbAll<{
    id: string;
    filename: string;
    file_type: string;
    file_size: number | null;
    created_at: string;
  }>(
    `SELECT id, filename, file_type, file_size, created_at FROM generated_files
     WHERE user_id = ?
     ORDER BY created_at DESC
     LIMIT 10`,
    lineUser.internal_user_id,
  );

  if (rows.length === 0) {
    await pushMessage(lineUser.line_user_id, [{
      type: 'text',
      text: '📂 您目前還沒有生成過文件。在對話中告訴我「幫我做一份…」，完成後檔案會出現在這裡。',
    }]);
    return;
  }

  const items: FileForFlex[] = [];
  for (const f of rows) {
    try {
      const { url, token } = await createOrReuseFileShare({
        fileId: f.id,
        userId: lineUser.internal_user_id,
      });
      items.push({
        filename: f.filename,
        fileType: f.file_type,
        url,
        token,
        createdAt: f.created_at,
        sizeBytes: f.file_size,
      });
    } catch (err) {
      console.error('[LINE commands] handleListFiles share mint failed:', err);
    }
  }

  if (items.length === 0) {
    await pushMessage(lineUser.line_user_id, [{
      type: 'text',
      text: '📂 載入文件清單時發生問題，請稍後重試。',
    }]);
    return;
  }

  await pushMessage(lineUser.line_user_id, [buildFileListFlex(items)]);
}

/**
 * Mint a 5-minute magic-link JWT that auto-logs the user into the web UI.
 * The frontend's /auto-login route (added separately) validates the token,
 * sets localStorage["token"], and redirects to /dashboard.
 */
export async function handleWebLink(lineUser: LineUserRow): Promise<void> {
  const user = await dbGet<{ id: string; email: string; role: string }>(
    'SELECT id, email, role FROM users WHERE id = ?',
    lineUser.internal_user_id,
  );
  if (!user) {
    await pushMessage(lineUser.line_user_id, [{
      type: 'text',
      text: '找不到對應的網頁帳號，請聯繫管理員。',
    }]);
    return;
  }

  // Short-lived single-use token. The audience field marks it as a magic
  // link so the regular auth middleware can reject it for non-login routes.
  const token = jwt.sign(
    { userId: user.id, email: user.email, role: user.role, magic: true },
    config.jwtSecret,
    { expiresIn: '5m', audience: 'line-magic-link' },
  );

  const base = config.line.publicApiBase;
  const url = `${base}/auto-login?t=${encodeURIComponent(token)}`;

  await pushMessage(lineUser.line_user_id, [{
    type: 'text',
    text: ['🌐 5 分鐘內有效的網頁登入連結：', '', url, '', '點擊後會自動登入網頁版。'].join('\n'),
  }]);
}

export { getLineUser };
