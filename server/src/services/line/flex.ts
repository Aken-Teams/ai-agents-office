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
  const ext = (f.fileType || extFromFilename(f.filename)).toLowerCase();
  if (ext === 'pdf' || IMAGE_EXTS.has(ext)) {
    return [uriButton('觀看', f.url, true), uriButton('下載', downloadUrl(f.url), false)];
  }
  if (OFFICE_EXTS.has(ext)) {
    return [uriButton('線上預覽', officeViewerUrl(f.url), true), uriButton('下載', f.url, false)];
  }
  return [uriButton('下載', f.url, true)];
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
        backgroundColor: PALETTE.background,
        contents: [
          {
            type: 'button',
            style: activeTeamId ? 'secondary' : 'primary',
            ...(activeTeamId ? {} : { color: PALETTE.accent }),
            height: 'sm',
            action: {
              type: 'postback',
              label: activeTeamId ? '回到單一助手' : '✓ 單一助手（目前）',
              data: 'action=solo',
              displayText: '回到單一助手',
            },
          },
        ],
      },
      styles: { footer: { separator: true, separatorColor: PALETTE.divider } },
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
