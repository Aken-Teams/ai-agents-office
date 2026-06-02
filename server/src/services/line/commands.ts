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
import { linkLineUser, LinkError, getLineUser, type LineUserRow } from './userMapping.js';
import { getOrCreateLineConversation } from './conversationRouter.js';
import { pushMessage, getUserProfile, type LineTextMessage } from './client.js';
import { createOrReuseFileShare } from './fileShare.js';
import { buildFileListFlex, buildUsageFlex, type FileForFlex } from './flex.js';

export interface ParsedCommand {
  kind: 'link' | 'new' | 'help' | 'quota' | 'none';
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
  '• /new — 開始新的對話',
  '• /quota — 查看本月用量',
  '• /help — 顯示這則說明',
  '• /link <邀請碼> — 綁定帳號（首次使用）',
].join('\n');

export async function handleHelp(lineUserId: string): Promise<void> {
  await pushMessage(lineUserId, [{ type: 'text', text: HELP_TEXT }]);
}

export async function handleLink(lineUserId: string, args: string): Promise<void> {
  const inviteCode = args.split(/\s+/)[0] || '';

  // Already-linked → treat the command as a re-login. The QR-code flow
  // re-uses this path: a user who scans the login QR while already linked
  // should immediately get a magic link back, not an error.
  const existing = await getLineUser(lineUserId);
  if (existing) {
    await handleWebLink(existing);
    return;
  }

  if (!inviteCode) {
    await pushMessage(lineUserId, [{
      type: 'text',
      text: '請帶上邀請碼，例如：/link ABC123\n（邀請碼請向管理員索取，或從網頁掃 QR Code）',
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

  await pushMessage(lineUserId, [{
    type: 'text',
    text: '✅ 綁定成功！直接傳訊息即可開始對話。底下會再傳一個網頁登入連結。',
  }]);

  // Hand off to the same magic-link path used by the rich-menu "Open Web"
  // tile so the user can hop to the browser immediately.
  const fresh = await getLineUser(lineUserId);
  if (fresh) {
    try { await handleWebLink(fresh); } catch (err) { console.error('[LINE] post-link magic link failed:', err); }
  }
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
      '👋 您好！您尚未綁定帳號。',
      '',
      `請至 ${config.line.publicApiBase || 'https://agents.theaken.com'} 取得邀請碼，`,
      '再回到 LINE 輸入：',
      '/link <邀請碼>',
      '',
      '完成綁定後即可開始對話。',
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

  const base = (config.line.publicApiBase || 'https://agents.theaken.com').replace(/\/$/, '');
  const url = `${base}/auto-login?t=${encodeURIComponent(token)}`;

  await pushMessage(lineUser.line_user_id, [{
    type: 'text',
    text: ['🌐 5 分鐘內有效的網頁登入連結：', '', url, '', '點擊後會自動登入網頁版。'].join('\n'),
  }]);
}

export { getLineUser };
