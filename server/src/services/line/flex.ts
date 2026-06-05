/**
 * Flex Message builders.
 *
 * Produces JSON payloads that LINE renders as native rich cards inside the
 * chat thread (no webview). Three card types:
 *
 *  • buildFileListFlex          — carousel of recent files for the
 *                                  "我的文件" rich-menu tile
 *  • buildGeneratedFilesFlex    — single-or-carousel of files the orchestrator
 *                                  just produced, replacing the plain-text URL
 *                                  list that used to follow the assistant's
 *                                  reply
 *  • buildUsageFlex             — single dashboard bubble for the
 *                                  "我的用量" rich-menu tile
 *
 * Visual language mirrors the bento rich menu + web UI: parchment background
 * (#FCFAF7), ink text (#1F1B16), sepia captions (#8B7D6A), thin sepia
 * dividers, IBM Plex Mono mono captions, Noto Serif TC titles where size
 * allows.
 *
 * LINE Flex spec reference:
 *   https://developers.line.biz/en/reference/messaging-api/#flex-message
 */

import type { LineFlexMessage } from './client.js';
import { config } from '../../config.js';

const PALETTE = {
  background: '#FCFAF7',
  ink: '#1F1B16',
  caption: '#8B7D6A',
  divider: '#D9D3C5',
  track: '#E8E4D9',
  accent: '#1F1B16',
  warn: '#B45309',
};

const WEB_BASE = config.line.publicApiBase;

const MAX_CAROUSEL = 10;

export interface FileForFlex {
  filename: string;
  fileType: string;
  url: string;
  token?: string;
  createdAt?: Date | string | null;
  sizeBytes?: number | null;
}

/* ============================================================
   File cards
   ============================================================ */

/**
 * Carousel of file bubbles for the rich-menu "我的文件" tile.
 */
export function buildFileListFlex(files: FileForFlex[]): LineFlexMessage {
  const trimmed = files.slice(0, MAX_CAROUSEL);
  return {
    type: 'flex',
    altText: `您的文件（${trimmed.length} 個）`,
    contents: {
      type: 'carousel',
      contents: trimmed.map(f => fileBubble(f, { compact: true })),
    },
  };
}

/**
 * Cards for files the orchestrator just generated. One bubble when single,
 * a carousel when many.
 */
export function buildGeneratedFilesFlex(files: FileForFlex[]): LineFlexMessage {
  const trimmed = files.slice(0, MAX_CAROUSEL);
  if (trimmed.length === 1) {
    return {
      type: 'flex',
      altText: `已產生：${trimmed[0].filename}`,
      contents: fileBubble(trimmed[0], { compact: false, headline: '已產生' }),
    };
  }
  return {
    type: 'flex',
    altText: `已產生 ${trimmed.length} 個檔案`,
    contents: {
      type: 'carousel',
      contents: trimmed.map(f => fileBubble(f, { compact: false, headline: '已產生' })),
    },
  };
}

function fileBubble(
  f: FileForFlex,
  opts: { compact: boolean; headline?: string },
): Record<string, unknown> {
  const ext = (f.fileType || extFromFilename(f.filename)).toUpperCase();
  const created = formatTimestamp(f.createdAt);
  const size = formatBytes(f.sizeBytes ?? null);
  const meta = [created, size].filter(Boolean).join(' · ') || ext;
  const footerButtons = buildFileButtons(f);

  return {
    type: 'bubble',
    size: 'kilo',
    body: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: PALETTE.background,
      paddingAll: '20px',
      contents: [
        ...(opts.headline
          ? [
              {
                type: 'text',
                text: opts.headline,
                size: 'xxs',
                color: PALETTE.caption,
              },
              { type: 'separator', margin: 'sm', color: PALETTE.divider },
            ]
          : []),
        {
          type: 'text',
          text: ext,
          size: 'xxs',
          color: PALETTE.caption,
          margin: opts.headline ? 'md' : 'none',
        },
        {
          type: 'text',
          text: f.filename,
          weight: 'bold',
          size: 'md',
          color: PALETTE.ink,
          wrap: true,
          margin: 'sm',
        },
        { type: 'separator', margin: 'lg', color: PALETTE.divider },
        {
          type: 'text',
          text: meta,
          size: 'xs',
          color: PALETTE.caption,
          margin: 'md',
        },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      paddingAll: '12px',
      backgroundColor: PALETTE.background,
      contents: footerButtons,
    },
    styles: {
      footer: { separator: true, separatorColor: PALETTE.divider },
    },
  };
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);
const OFFICE_EXTS = new Set(['docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt']);

/** Append ?dl=1 (or &dl=1) so the share endpoint forces a download. */
function downloadUrl(url: string): string {
  return url + (url.includes('?') ? '&' : '?') + 'dl=1';
}

/** Microsoft's public Office viewer — renders pptx/docx/xlsx from a public URL. */
function officeViewerUrl(url: string): string {
  return `https://view.officeapps.live.com/op/view.aspx?src=${encodeURIComponent(url)}`;
}

function uriButton(label: string, uri: string, primary: boolean): Record<string, unknown> {
  return {
    type: 'button',
    style: primary ? 'primary' : 'secondary',
    ...(primary ? { color: PALETTE.accent } : {}),
    height: 'sm',
    action: { type: 'uri', label, uri },
  };
}

/**
 * Action buttons for a file card, by type:
 *  • PDF / image  → 觀看 (inline) + 下載
 *  • Office doc    → 線上預覽 (Office viewer) + 下載
 *  • other         → 下載
 */
function buildFileButtons(f: FileForFlex): Record<string, unknown>[] {
  const downloadBtn = uriButton('下載', downloadUrl(f.url), false);
  // Primary: open the branded share page (a clean, forwardable URL that previews
  // the file — Office viewer / PDF / image — and offers download).
  if (f.token) {
    return [uriButton('開啟報告', `${WEB_BASE}/share/file/${f.token}`, true), downloadBtn];
  }
  // Fallback when no token is available — per-type direct viewer.
  const ext = (f.fileType || extFromFilename(f.filename)).toLowerCase();
  if (ext === 'pdf' || IMAGE_EXTS.has(ext)) return [uriButton('觀看', f.url, true), downloadBtn];
  if (OFFICE_EXTS.has(ext)) return [uriButton('線上預覽', officeViewerUrl(f.url), true), downloadBtn];
  return [uriButton('下載', f.url, true)];
}

/* ============================================================
   Help / tutorial
   ============================================================ */

function helpEyebrow(text: string): Record<string, unknown> {
  return { type: 'text', text, size: 'xxs', color: PALETTE.caption };
}
function helpTitle(text: string): Record<string, unknown> {
  return { type: 'text', text, size: 'lg', weight: 'bold', color: PALETTE.ink, margin: 'sm' };
}
/** A sample line ("「幫我做一份 PPT」") rendered as a soft chip. */
function helpSample(text: string): Record<string, unknown> {
  return {
    type: 'box', layout: 'vertical', margin: 'sm', paddingAll: '8px', backgroundColor: PALETTE.track, cornerRadius: '6px',
    contents: [{ type: 'text', text, size: 'sm', color: PALETTE.ink, wrap: true }],
  };
}
/** A command row: mono-ish command on top, caption description below. */
function helpCmd(cmd: string, desc: string): Record<string, unknown> {
  return {
    type: 'box', layout: 'vertical', margin: 'md', spacing: 'none',
    contents: [
      { type: 'text', text: cmd, size: 'sm', weight: 'bold', color: PALETTE.ink, wrap: true },
      { type: 'text', text: desc, size: 'xs', color: PALETTE.caption, wrap: true },
    ],
  };
}
function helpBubble(contents: Record<string, unknown>[]): Record<string, unknown> {
  return {
    type: 'bubble', size: 'mega',
    body: { type: 'box', layout: 'vertical', backgroundColor: PALETTE.background, paddingAll: '20px', contents },
  };
}

/** A swipeable 3-card tutorial for /help. */
export function buildHelpFlex(): LineFlexMessage {
  const card1 = helpBubble([
    helpEyebrow('GETTING STARTED'),
    helpTitle('直接打字就能用'),
    { type: 'text', text: '把想做的事直接傳給我，例如：', size: 'xs', color: PALETTE.caption, wrap: true, margin: 'md' },
    helpSample('幫我分析台積電最近的營運'),
    helpSample('幫我做一份產品簡報 PPT'),
    helpSample('把上面結論整理成 Word'),
    { type: 'separator', margin: 'lg', color: PALETTE.divider },
    { type: 'text', text: '完成的檔案會直接傳給你，並記住對話脈絡可接續追問。', size: 'xs', color: PALETTE.caption, wrap: true, margin: 'md' },
  ]);

  const card2 = helpBubble([
    helpEyebrow('TWO MODES'),
    helpTitle('兩種模式'),
    { type: 'box', layout: 'vertical', margin: 'md', paddingAll: '10px', backgroundColor: PALETTE.track, cornerRadius: '8px', contents: [
      { type: 'text', text: '① 單一助手（預設）', size: 'sm', weight: 'bold', color: PALETTE.ink },
      { type: 'text', text: '快、省、有記憶，適合日常問答與產檔。', size: 'xs', color: PALETTE.caption, wrap: true, margin: 'sm' },
    ] },
    { type: 'box', layout: 'vertical', margin: 'md', paddingAll: '10px', backgroundColor: PALETTE.track, cornerRadius: '8px', contents: [
      { type: 'text', text: '② 團隊協作', size: 'sm', weight: 'bold', color: PALETTE.ink },
      { type: 'text', text: '多位 AI 專家一起分析再給統整結論，適合需要多角度的深入題目（較花時間與用量），附網頁完整報告連結。', size: 'xs', color: PALETTE.caption, wrap: true, margin: 'sm' },
    ] },
    { type: 'text', text: '用 /newteam 或 /teams 切換到團隊；/solo 回單一助手。', size: 'xs', color: PALETTE.caption, wrap: true, margin: 'lg' },
  ]);

  const card3 = helpBubble([
    helpEyebrow('COMMANDS'),
    helpTitle('指令速查'),
    helpCmd('/newteam <描述>', '用 AI 幫你建一個團隊並切換'),
    helpCmd('/teams', '列出你的團隊，點按鈕切換'),
    helpCmd('/solo', '切回單一助手'),
    helpCmd('/schedule 09:00 議題', '設定團隊每天定時自動分析並寄報告'),
    helpCmd('/schedule', '查看 / 刪除你的排程'),
    helpCmd('/delteam', '刪除團隊'),
    helpCmd('/files', '列出我幫你產生過的檔案'),
    helpCmd('/quota', '查本月用量與額度'),
  ]);

  const card4 = helpBubble([
    helpEyebrow('MENU BUTTONS'),
    helpTitle('下方選單怎麼用'),
    { type: 'text', text: '不想打指令？點聊天室下方的圖文選單：', size: 'xs', color: PALETTE.caption, wrap: true, margin: 'md' },
    helpCmd('團隊協作', '打開團隊選單，切換或查看你的團隊'),
    helpCmd('單一助手', '切回單一助手模式'),
    helpCmd('我的檔案', '列出我幫你產生過的檔案'),
    helpCmd('本月用量', '查看本月用量與剩餘額度'),
    helpCmd('使用教學', '再打開這份教學'),
    helpCmd('排程', '新增 / 查看 / 刪除定時排程'),
  ]);

  return {
    type: 'flex',
    altText: '使用教學：直接打字就能用，/newteam 建團隊、/teams 切換、/files 看檔案',
    contents: { type: 'carousel', contents: [card1, card2, card3, card4] },
  };
}

/* ============================================================
   Team report link
   ============================================================ */

/** A card linking to the full team-collaboration report (with charts) on the web. */
export function buildTeamReportFlex(shareUrl: string, title?: string): LineFlexMessage {
  return {
    type: 'flex',
    altText: `團隊協作報告：${title || ''}`.trim(),
    contents: {
      type: 'bubble', size: 'kilo',
      body: {
        type: 'box', layout: 'vertical', backgroundColor: PALETTE.background, paddingAll: '20px',
        contents: [
          { type: 'text', text: '📊 TEAM REPORT', size: 'xxs', color: PALETTE.caption },
          { type: 'text', text: title || '團隊協作報告', size: 'lg', weight: 'bold', color: PALETTE.ink, wrap: true, margin: 'sm' },
          { type: 'separator', margin: 'md', color: PALETTE.divider },
          { type: 'text', text: '完整統整、各成員觀點與圖表都在網頁版報告。', size: 'xs', color: PALETTE.caption, wrap: true, margin: 'md' },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', paddingAll: '12px', backgroundColor: PALETTE.background,
        contents: [
          { type: 'button', style: 'primary', color: PALETTE.accent, height: 'sm',
            action: { type: 'uri', label: '查看完整報告', uri: shareUrl } },
        ],
      },
      styles: { footer: { separator: true, separatorColor: PALETTE.divider } },
    },
  };
}

/* ============================================================
   Team picker
   ============================================================ */

export interface TeamForFlex {
  id: string;
  title: string;
  topic?: string | null;
  memberCount?: number | null;
}

/**
 * A single bubble listing the user's teams. Each team is a postback button
 * (`action=set_team&team=<id>`) that switches LINE into that team's
 * collaboration mode. A footer button returns to the single assistant. The
 * currently-active team is marked with a check.
 */
export function buildTeamPickerFlex(teams: TeamForFlex[], activeTeamId: string | null): LineFlexMessage {
  const trimmed = teams.slice(0, MAX_CAROUSEL);
  const teamButtons = trimmed.map(tm => {
    const active = tm.id === activeTeamId;
    const meta = tm.memberCount ? `（${tm.memberCount} 位）` : '';
    return {
      type: 'button',
      style: active ? 'primary' : 'secondary',
      ...(active ? { color: PALETTE.accent } : {}),
      height: 'sm',
      action: {
        type: 'postback',
        label: `${active ? '✓ ' : ''}${tm.title}${meta}`.slice(0, 40),
        data: `action=set_team&team=${encodeURIComponent(tm.id)}`,
        displayText: `切換到團隊：${tm.title}`,
      },
    } as Record<string, unknown>;
  });

  return {
    type: 'flex',
    altText: `選擇要協作的團隊（${trimmed.length} 個）`,
    contents: {
      type: 'bubble',
      size: 'mega',
      body: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: PALETTE.background,
        paddingAll: '20px',
        spacing: 'sm',
        contents: [
          { type: 'text', text: 'CHOOSE A TEAM', size: 'xxs', color: PALETTE.caption },
          { type: 'text', text: '選擇要協作的團隊', size: 'lg', weight: 'bold', color: PALETTE.ink, margin: 'sm' },
          { type: 'text', text: '選團隊後，你問的問題會由整個團隊協作分析、再給你一份統整結論。', size: 'xs', color: PALETTE.caption, wrap: true, margin: 'sm' },
          { type: 'separator', margin: 'lg', color: PALETTE.divider },
          ...(teamButtons.length
            ? teamButtons
            : [{ type: 'text', text: '你還沒有任何團隊，請先到網頁建立。', size: 'sm', color: PALETTE.caption, wrap: true, margin: 'md' }]),
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '12px',
        spacing: 'sm',
        backgroundColor: PALETTE.background,
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: PALETTE.accent,
            height: 'sm',
            action: {
              type: 'postback',
              label: '＋ 建立新團隊',
              data: 'action=new_team',
              displayText: '建立新團隊',
            },
          },
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            action: {
              type: 'postback',
              label: activeTeamId ? '回到單一助手' : '✓ 單一助手（目前）',
              data: 'action=solo',
              displayText: '回到單一助手',
            },
          },
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            action: {
              type: 'postback',
              label: '🗑 刪除團隊',
              data: 'action=delteam',
              displayText: '刪除團隊',
            },
          },
        ],
      },
      styles: { footer: { separator: true, separatorColor: PALETTE.divider } },
    },
  };
}

/* ============================================================
   Schedules
   ============================================================ */

export interface ScheduleForFlex {
  id: string;
  teamTitle: string;
  summary: string;   // schedule name or question
  when: string;      // e.g. "每天 09:00"
  email: string;
  enabled: boolean;
}

/** A bubble listing the user's team schedules, each with a delete button. */
export function buildScheduleListFlex(items: ScheduleForFlex[]): LineFlexMessage {
  const rows = items.slice(0, MAX_CAROUSEL).map(s => ({
    type: 'box', layout: 'horizontal', margin: 'md', spacing: 'sm',
    contents: [
      { type: 'box', layout: 'vertical', flex: 1, contents: [
        { type: 'text', text: s.summary, size: 'sm', weight: 'bold', color: PALETTE.ink, wrap: true },
        { type: 'text', text: `${s.teamTitle}　${s.when}${s.enabled ? '' : '（已停用）'}`, size: 'xs', color: PALETTE.caption, wrap: true },
        { type: 'text', text: s.email, size: 'xxs', color: PALETTE.caption, wrap: true },
      ] },
      { type: 'button', style: 'secondary', height: 'sm', gravity: 'center',
        action: { type: 'postback', label: '刪除', data: `action=del_schedule&sid=${encodeURIComponent(s.id)}`, displayText: '刪除排程' } },
    ],
  } as Record<string, unknown>));

  return {
    type: 'flex',
    altText: `你的排程（${items.length} 個）`,
    contents: {
      type: 'bubble', size: 'mega',
      body: { type: 'box', layout: 'vertical', backgroundColor: PALETTE.background, paddingAll: '20px', contents: [
        { type: 'text', text: 'SCHEDULES', size: 'xxs', color: PALETTE.caption },
        { type: 'text', text: '我的排程', size: 'lg', weight: 'bold', color: PALETTE.ink, margin: 'sm' },
        { type: 'separator', margin: 'lg', color: PALETTE.divider },
        ...(rows.length ? rows : [{ type: 'text', text: '目前沒有排程。', size: 'sm', color: PALETTE.caption, margin: 'md' }]),
      ] },
      footer: { type: 'box', layout: 'vertical', paddingAll: '12px', backgroundColor: PALETTE.background, contents: [
        { type: 'button', style: 'primary', color: PALETTE.accent, height: 'sm',
          action: { type: 'postback', label: '＋ 新增排程', data: 'action=sched_new', displayText: '新增排程' } },
      ] },
      styles: { footer: { separator: true, separatorColor: PALETTE.divider } },
    },
  };
}

/** Step 1 of button-driven schedule creation: pick which team to schedule. */
export function buildSchedTeamPickerFlex(teams: TeamForFlex[]): LineFlexMessage {
  const rows = teams.slice(0, MAX_CAROUSEL).map(tm => ({
    type: 'button', style: 'secondary', height: 'sm', margin: 'sm',
    action: { type: 'postback', label: tm.title.slice(0, 40), data: `action=sched_team&team=${encodeURIComponent(tm.id)}`, displayText: `排程：${tm.title}` },
  } as Record<string, unknown>));
  return {
    type: 'flex',
    altText: '新增排程：選擇團隊',
    contents: {
      type: 'bubble', size: 'mega',
      body: { type: 'box', layout: 'vertical', backgroundColor: PALETTE.background, paddingAll: '20px', contents: [
        { type: 'text', text: 'NEW SCHEDULE · 1/2', size: 'xxs', color: PALETTE.caption },
        { type: 'text', text: '要排程哪個團隊？', size: 'lg', weight: 'bold', color: PALETTE.ink, margin: 'sm' },
        { type: 'text', text: '系統會用這個團隊原本的主題當每日分析議題。', size: 'xs', color: PALETTE.caption, wrap: true, margin: 'sm' },
        { type: 'separator', margin: 'lg', color: PALETTE.divider },
        ...(rows.length ? rows : [{ type: 'text', text: '你還沒有任何團隊，請先用 /newteam 建立。', size: 'sm', color: PALETTE.caption, wrap: true, margin: 'md' }]),
      ] },
    },
  };
}

const SCHED_TIMES: Array<[number, number, string]> = [
  [8, 0, '08:00'], [9, 0, '09:00'], [12, 0, '12:00'], [13, 0, '13:00'],
  [18, 0, '18:00'], [20, 0, '20:00'], [21, 0, '21:00'], [22, 0, '22:00'],
];

/** Step 2: pick a time. Each button creates a daily schedule for the team. */
export function buildSchedTimeFlex(teamId: string, teamTitle: string): LineFlexMessage {
  const pairs: Array<[number, number, string]>[] = [];
  for (let i = 0; i < SCHED_TIMES.length; i += 2) pairs.push(SCHED_TIMES.slice(i, i + 2));
  const rows = pairs.map(pair => ({
    type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'sm',
    contents: pair.map(([h, m, label]) => ({
      type: 'button', style: 'secondary', height: 'sm', flex: 1,
      action: { type: 'postback', label, data: `action=sched_set&team=${encodeURIComponent(teamId)}&t=${pad2(h)}${pad2(m)}`, displayText: `每天 ${label} 自動分析` },
    })),
  } as Record<string, unknown>));
  return {
    type: 'flex',
    altText: '新增排程：選擇時間',
    contents: {
      type: 'bubble', size: 'mega',
      body: { type: 'box', layout: 'vertical', backgroundColor: PALETTE.background, paddingAll: '20px', contents: [
        { type: 'text', text: 'NEW SCHEDULE · 2/2', size: 'xxs', color: PALETTE.caption },
        { type: 'text', text: '每天幾點自動分析？', size: 'lg', weight: 'bold', color: PALETTE.ink, margin: 'sm' },
        { type: 'text', text: `團隊：${teamTitle}`, size: 'xs', color: PALETTE.caption, wrap: true, margin: 'sm' },
        { type: 'separator', margin: 'lg', color: PALETTE.divider },
        ...rows,
        { type: 'text', text: '想要其他時間或自訂議題？輸入：/schedule 07:30 你的議題', size: 'xxs', color: PALETTE.caption, wrap: true, margin: 'lg' },
      ] },
    },
  };
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/* ============================================================
   Team delete
   ============================================================ */

/** A bubble listing teams, each with a delete button (asks to confirm). */
export function buildTeamDeleteFlex(teams: TeamForFlex[]): LineFlexMessage {
  const rows = teams.slice(0, MAX_CAROUSEL).map(tm => ({
    type: 'button', style: 'secondary', height: 'sm', margin: 'sm',
    action: { type: 'postback', label: `🗑 ${tm.title}`.slice(0, 40), data: `action=del_team&team=${encodeURIComponent(tm.id)}`, displayText: `刪除團隊：${tm.title}` },
  } as Record<string, unknown>));

  return {
    type: 'flex',
    altText: '刪除團隊',
    contents: {
      type: 'bubble', size: 'mega',
      body: { type: 'box', layout: 'vertical', backgroundColor: PALETTE.background, paddingAll: '20px', contents: [
        { type: 'text', text: 'DELETE TEAM', size: 'xxs', color: PALETTE.caption },
        { type: 'text', text: '刪除團隊', size: 'lg', weight: 'bold', color: PALETTE.ink, margin: 'sm' },
        { type: 'text', text: '選一個要刪除的團隊（會再跟你確認一次）：', size: 'xs', color: PALETTE.caption, wrap: true, margin: 'sm' },
        { type: 'separator', margin: 'lg', color: PALETTE.divider },
        ...(rows.length ? rows : [{ type: 'text', text: '你還沒有任何團隊。', size: 'sm', color: PALETTE.caption, margin: 'md' }]),
      ] },
    },
  };
}

/** A confirm bubble before actually deleting a team. */
export function buildConfirmTeamDeleteFlex(teamId: string, teamTitle: string): LineFlexMessage {
  return {
    type: 'flex',
    altText: `確定刪除團隊「${teamTitle}」？`,
    contents: {
      type: 'bubble', size: 'kilo',
      body: { type: 'box', layout: 'vertical', backgroundColor: PALETTE.background, paddingAll: '20px', contents: [
        { type: 'text', text: `確定刪除團隊「${teamTitle}」？`, size: 'md', weight: 'bold', color: PALETTE.ink, wrap: true },
        { type: 'text', text: '團隊與其中的成員助手都會被移除（已產生的協作報告會保留）。此動作無法復原。', size: 'xs', color: PALETTE.caption, wrap: true, margin: 'md' },
      ] },
      footer: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '12px', backgroundColor: PALETTE.background, contents: [
        { type: 'button', style: 'primary', color: PALETTE.warn, height: 'sm',
          action: { type: 'postback', label: '確定刪除', data: `action=del_team_confirm&team=${encodeURIComponent(teamId)}`, displayText: '確定刪除團隊' } },
      ] },
    },
  };
}

/* ============================================================
   Usage dashboard
   ============================================================ */

export interface UsageForFlex {
  usedUsd: number;
  limitUsd: number;
  exceeded: boolean;
}

/**
 * Single bubble showing this month's spend vs limit with a progress bar.
 */
export function buildUsageFlex(usage: UsageForFlex): LineFlexMessage {
  const limit = usage.limitUsd > 0 ? usage.limitUsd : 1;
  const used = Math.max(0, usage.usedUsd);
  const remaining = Math.max(0, usage.limitUsd - used);
  const percent = Math.min(100, Math.round((used / limit) * 100));
  const barColor = usage.exceeded ? PALETTE.warn : PALETTE.accent;
  const altText = `本月用量 USD $${used.toFixed(3)} / $${usage.limitUsd.toFixed(2)}（${percent}%）`;

  return {
    type: 'flex',
    altText,
    contents: {
      type: 'bubble',
      size: 'kilo',
      body: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: PALETTE.background,
        paddingAll: '24px',
        contents: [
          {
            type: 'text',
            text: 'MY USAGE',
            size: 'xxs',
            color: PALETTE.caption,
          },
          {
            type: 'text',
            text: '本月用量',
            size: 'xs',
            color: PALETTE.caption,
            margin: 'sm',
          },
          {
            type: 'text',
            text: `USD $${used.toFixed(3)}`,
            size: 'xxl',
            weight: 'bold',
            color: PALETTE.ink,
            margin: 'sm',
          },
          {
            type: 'text',
            text: `of $${usage.limitUsd.toFixed(2)} （${percent}%）`,
            size: 'xs',
            color: PALETTE.caption,
          },
          progressBar(percent, barColor),
          { type: 'separator', margin: 'xl', color: PALETTE.divider },
          statsRow('剩餘額度', `USD $${remaining.toFixed(3)}`),
          statsRow('本月上限', `USD $${usage.limitUsd.toFixed(2)}`),
          ...(usage.exceeded
            ? [
                { type: 'separator', margin: 'lg', color: PALETTE.divider },
                {
                  type: 'text',
                  text: '⚠ 已達上限，請待下個月或聯繫管理員',
                  size: 'xs',
                  color: PALETTE.warn,
                  wrap: true,
                  margin: 'md',
                },
              ]
            : []),
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '12px',
        backgroundColor: PALETTE.background,
        contents: [
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            action: {
              type: 'uri',
              label: '在網頁查看詳細',
              uri: `${WEB_BASE}/usage`,
            },
          },
        ],
      },
      styles: {
        footer: { separator: true, separatorColor: PALETTE.divider },
      },
    },
  };
}

function progressBar(percent: number, fillColor: string): Record<string, unknown> {
  const clamped = Math.max(2, Math.min(100, percent));
  return {
    type: 'box',
    layout: 'vertical',
    margin: 'xl',
    height: '6px',
    backgroundColor: PALETTE.track,
    cornerRadius: '3px',
    contents: [
      {
        type: 'box',
        layout: 'vertical',
        width: `${clamped}%`,
        backgroundColor: fillColor,
        cornerRadius: '3px',
        contents: [{ type: 'filler' }],
      },
    ],
  };
}

function statsRow(label: string, value: string): Record<string, unknown> {
  return {
    type: 'box',
    layout: 'horizontal',
    margin: 'lg',
    contents: [
      { type: 'text', text: label, size: 'sm', color: PALETTE.caption, flex: 0 },
      {
        type: 'text',
        text: value,
        size: 'sm',
        color: PALETTE.ink,
        weight: 'bold',
        align: 'end',
      },
    ],
  };
}

/* ============================================================
   helpers
   ============================================================ */

function extFromFilename(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return 'FILE';
  return filename.slice(dot + 1).toLowerCase();
}

function formatTimestamp(value: Date | string | null | undefined): string {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}/${dd} ${hh}:${mi}`;
}

function formatBytes(bytes: number | null): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
