/**
 * Slash-command parsing and handling for LINE messages.
 *
 * Recognised: `/link <code>`, `/new`, `/help`, `/quota`.
 * Anything else is treated as regular conversation.
 */

import jwt from 'jsonwebtoken';
import { config } from '../../config.js';
import { dbGet, dbAll } from '../../db.js';
import { checkUserUsageLimit } from '../usageLimit.js';
import { linkLineUser, LinkError, getLineUser, setLineActiveTeam, type LineUserRow } from './userMapping.js';
import { getOrCreateLineConversation } from './conversationRouter.js';
import { pushMessage, getUserProfile, type LineTextMessage } from './client.js';
import { createOrReuseFileShare } from './fileShare.js';
import { buildFileListFlex, buildUsageFlex, buildTeamPickerFlex, type FileForFlex, type TeamForFlex } from './flex.js';

export interface ParsedCommand {
  kind: 'link' | 'new' | 'help' | 'quota' | 'teams' | 'solo' | 'none';
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
    case 'new':   return { kind: 'new',   args: rest.trim() };
    case 'help':  return { kind: 'help',  args: rest.trim() };
    case 'quota': return { kind: 'quota', args: rest.trim() };
    case 'team':  return { kind: 'teams', args: rest.trim() };
    case 'teams': return { kind: 'teams', args: rest.trim() };
    case 'solo':  return { kind: 'solo',  args: rest.trim() };
    default:      return { kind: 'none',  args: trimmed };
  }
}

const HELP_TEXT = [
  '✨ 您好，這是 AI Agents Office 助理',
  '',
  '直接傳訊息即可開始對話。',
  '我會記住您先前的對話脈絡，並能協助：',
  '• 撰寫文件、簡報、報表',
  '• 整理研究與分析資料',
  '• 回答跨對話的問題',
  '',
  '可用指令：',
  '• /teams — 選擇用哪個團隊協作回答',
  '• /solo — 回到單一助手（預設）',
  '• /new — 開始新的對話',
  '• /quota — 查看本月用量',
  '• /help — 顯示這則說明',
  '• /link <綁定碼> — 綁定網頁帳號（請從網頁產生 QR）',
].join('\n');

export async function handleHelp(lineUserId: string): Promise<void> {
  await pushMessage(lineUserId, [{ type: 'text', text: HELP_TEXT }]);
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
      text: '你還沒有任何團隊。請先到網頁的「AI 助手」建立一個團隊，再回來用 /teams 切換。',
    }]);
    return;
  }

  const teams: TeamForFlex[] = rows.map(r => ({ id: r.id, title: r.title, topic: r.topic, memberCount: r.member_count }));
  await pushMessage(lineUser.line_user_id, [buildTeamPickerFlex(teams, lineUser.active_team_id)]);
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
    text: '✅ 綁定成功！您的 LINE 已連結到您的帳號，現在可以直接在這裡傳訊息使用 AI 助理。',
  }]);
}

export async function handleNew(lineUser: LineUserRow): Promise<void> {
  await getOrCreateLineConversation(lineUser, { forceNew: true });
  await pushMessage(lineUser.line_user_id, [{
    type: 'text',
    text: '🆕 已開啟新的對話。先前的脈絡會收進記憶供日後參考。',
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
