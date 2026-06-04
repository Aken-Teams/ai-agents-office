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
import { linkLineUser, LinkError, getLineUser, setLineActiveTeam, type LineUserRow } from './userMapping.js';
import { pushMessage, getUserProfile, type LineTextMessage } from './client.js';
import { createOrReuseFileShare } from './fileShare.js';
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
    await pushMessage(lineUser.line_user_id, [{
      type: 'text',
      text: '你還沒有任何團隊。\n\n直接用 AI 幫你建一個：\n輸入「/newteam 你的需求」\n例如：/newteam 每天幫我分析台股盤勢與我持股的風險\n\n或到網頁的「AI 助手」建立。',
    }]);
    return;
  }

  const teams: TeamForFlex[] = rows.map(r => ({ id: r.id, title: r.title, topic: r.topic, memberCount: r.member_count }));
  await pushMessage(lineUser.line_user_id, [buildTeamPickerFlex(teams, lineUser.active_team_id)]);
}

/**
 * AI-build a team from a free-form scenario typed in LINE (`/newteam <描述>`),
 * then switch the user into it so the next message runs the team. Reuses the
 * same DeepSeek team designer as the web "AI 自訂團隊".
 */
export async function handleNewTeam(lineUser: LineUserRow, scenario: string): Promise<void> {
  const topic = scenario.trim();
  if (!topic) {
    await pushMessage(lineUser.line_user_id, [{
      type: 'text',
      text: '請描述你的需求，我就用 AI 幫你組一個團隊。\n例如：\n/newteam 每天幫我分析台股盤勢與我持股的風險\n/newteam 幫我規劃一場 100 人的產品發表會',
    }]);
    return;
  }

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
    }]);
    return;
  }

  await setLineActiveTeam(lineUser.line_user_id, result.teamId);
  await pushMessage(lineUser.line_user_id, [{
    type: 'text',
    text: `✅ 已建立團隊「${result.title}」（${result.memberCount} 位成員）並切換到它。\n\n直接傳訊息問問題，整個團隊會協作分析、再給你一份統整結論。\n\n/teams 可切換團隊、/solo 回到單一助手。`,
  }]);
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
    text: `✅ 已切換到團隊「${team.title}」。\n接下來你問的問題會由整個團隊協作分析、再給你一份統整結論（較花時間與用量）。\n隨時可用 /solo 回到單一助手。`,
  }]);
}

/** Return to the single rolling assistant (clears the active team). */
export async function handleSolo(lineUser: LineUserRow): Promise<void> {
  await setLineActiveTeam(lineUser.line_user_id, null);
  await pushMessage(lineUser.line_user_id, [{
    type: 'text',
    text: '✅ 已回到單一助手模式。直接傳訊息即可對話。需要團隊協作時用 /teams 切換。',
  }]);
}

export async function handleLink(lineUserId: string, args: string): Promise<void> {
  const inviteCode = args.split(/\s+/)[0] || '';

  // Already-linked → just confirm. No web-login link: the account was bound
  // from an already-logged-in web session, so there's nothing to log into.
  const existing = await getLineUser(lineUserId);
  if (existing) {
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
    await pushMessage(lineUser.line_user_id, [{ type: 'text', text: '你還沒有任何團隊。請先用 /newteam 描述需求建立一個團隊，再來排程。' }]);
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

/** Button flow step 3: create a daily schedule at the chosen time. Question
 *  defaults to the team's original topic so no typing is needed. */
export async function handleSchedSet(lineUser: LineUserRow, teamId: string, hhmm: string): Promise<void> {
  const m = /^(\d{2})(\d{2})$/.exec(hhmm);
  if (!m) { await pushMessage(lineUser.line_user_id, [{ type: 'text', text: '時間格式錯誤，請用 /schedule 重新開始。' }]); return; }
  const hour = Math.max(0, Math.min(23, Number(m[1])));
  const minute = Math.max(0, Math.min(59, Number(m[2])));

  const team = await dbGet<{ id: string; title: string; topic: string | null }>('SELECT id, title, topic FROM agent_teams WHERE id = ? AND user_id = ?', teamId, lineUser.internal_user_id);
  if (!team) { await pushMessage(lineUser.line_user_id, [{ type: 'text', text: '找不到這個團隊，可能已被刪除。' }]); return; }
  const userRow = await dbGet<{ email: string }>('SELECT email FROM users WHERE id = ?', lineUser.internal_user_id);
  if (!userRow?.email) { await pushMessage(lineUser.line_user_id, [{ type: 'text', text: '找不到你的帳號 email，無法寄送排程報告，請聯繫管理員。' }]); return; }

  const question = team.topic?.trim() || DAILY_UPDATE_QUESTION;
  const next = computeNextRun('daily', hour, minute, null);
  const id = uuidv4();
  await dbRun(
    'INSERT INTO team_schedules (id, team_id, user_id, name, question, frequency, hour, minute, day_of_week, email, next_run_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, team.id, lineUser.internal_user_id, `${team.title} 每日更新`, question, 'daily', hour, minute, null, userRow.email, mysqlDateTime(next),
  );
  await pushMessage(lineUser.line_user_id, [{
    type: 'text',
    text: `✅ 已設定：團隊「${team.title}」每天 ${pad2(hour)}:${pad2(minute)} 自動分析\n議題：${question}\n結果會寄到 ${userRow.email} 並推送到這裡。\n下次執行：${next.toLocaleString()}\n\n用 /schedule 可查看或刪除。`,
  }]);
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
      const { url } = await createOrReuseFileShare({
        fileId: f.id,
        userId: lineUser.internal_user_id,
      });
      items.push({
        filename: f.filename,
        fileType: f.file_type,
        url,
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
