/**
 * LINE Rich Menu generator and uploader.
 *
 * Produces a 2500×1686 "文清" (literary / clean) bento-style rich menu PNG.
 * Layout is asymmetric (one hero tile + 2 medium + 3 small) to establish a
 * clear visual hierarchy around the primary "新對話" action, then publishes
 * it via the Messaging API and pins it as the default rich menu for all
 * users.
 *
 * Bento geometry (2500×1686):
 *   01 新對話    x=0    y=0    1250×1686   (hero,   left full-height)
 *   02 上傳檔案  x=1250 y=0     750×843    (medium, middle top)
 *   03 我的文件  x=1250 y=843   750×843    (medium, middle bottom)
 *   04 我的用量  x=2000 y=0     500×562    (small,  right top)
 *   05 我的記憶  x=2000 y=562   500×562    (small,  right middle)
 *   06 說明      x=2000 y=1124  500×562    (small,  right bottom)
 *
 * Visual spec:
 *   Background: #FCFAF7 (parchment)
 *   Dividers:   #D9D3C5 (1 px)
 *   Heading:    Noto Serif TC 500, size scaled per tile variant, #1F1B16
 *   Caption:    IBM Plex Mono, size scaled, #8B7D6A, uppercase
 *   Number:     IBM Plex Mono 400, tile sequence (01 / 02 / …), #8B7D6A
 *   Icon:       Material Symbols Outlined SVG glyph, #1F1B16
 */

import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { config } from '../../config.js';

export type TileVariant = 'hero' | 'medium' | 'small';

export interface TileBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RichMenuTile {
  id: string;
  iconSvg: string;
  label: string;
  caption: string;
  variant: TileVariant;
  bounds: TileBounds;
  action:
    | { type: 'postback'; data: string; displayText?: string }
    | { type: 'message'; text: string }
    | { type: 'uri'; uri: string };
}

const RICH_MENU_WIDTH = 2500;
const RICH_MENU_HEIGHT = 1686;

const PALETTE = {
  background: '#FCFAF7',
  heroSurface: '#F4EFE5',
  ink: '#1F1B16',
  caption: '#8B7D6A',
  divider: '#D9D3C5',
};

const WEB_BASE = config.line.publicApiBase;

/**
 * Build a LIFF URL for a given site path. When LINE_LIFF_ID is set, tile taps
 * open the page inside LINE's in-app webview instead of jumping to an external
 * browser — staying inside LINE removes a context switch and lets the page
 * read the LINE user identity via the LIFF SDK. Falls back to the plain web
 * URL if no LIFF ID is configured.
 *
 * LIFF sub-path forwarding: liff.line.me/{liffId}/foo opens
 * {endpointUrl}/foo, so the LIFF Endpoint URL in LINE Console must be the
 * site root (e.g. https://agents.theaken.com) — otherwise sub-paths land on
 * the wrong page.
 */
function pageUrl(path: string): string {
  const clean = path.startsWith('/') ? path.slice(1) : path;
  if (config.line.liffId) {
    return `https://liff.line.me/${config.line.liffId}/${clean}`;
  }
  return `${WEB_BASE}/${clean}`;
}

export const DEFAULT_TILES: RichMenuTile[] = [
  {
    id: 'teams',
    iconSvg:
      '<path d="M12 12.75c1.63 0 3.07.39 4.24.9 1.08.48 1.76 1.56 1.76 2.73V18H6v-1.61c0-1.18.68-2.26 1.76-2.73 1.17-.52 2.61-.91 4.24-.91zM4 13c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm1.13 1.1c-.37-.06-.74-.1-1.13-.1-.99 0-1.93.21-2.78.58A2.01 2.01 0 0 0 0 16.43V18h4.5v-1.61c0-.83.23-1.61.63-2.29zM20 13c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm2.78 1.58A6.95 6.95 0 0 0 20 14c-.39 0-.76.04-1.13.1.4.68.63 1.46.63 2.29V18H24v-1.57c0-.81-.48-1.53-1.22-1.85zM12 6c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3z"/>',
    label: '團隊協作',
    caption: 'TEAMS',
    variant: 'hero',
    bounds: { x: 0, y: 0, width: 1250, height: 1686 },
    action: { type: 'postback', data: 'action=teams', displayText: '團隊協作' },
  },
  {
    id: 'solo',
    iconSvg:
      '<path d="M20 9V7c0-1.1-.9-2-2-2h-3c0-1.66-1.34-3-3-3S9 3.34 9 5H6c-1.1 0-2 .9-2 2v2c-1.66 0-3 1.34-3 3s1.34 3 3 3v4c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2v-4c1.66 0 3-1.34 3-3s-1.34-3-3-3zM7.5 11.5C7.5 10.67 8.17 10 9 10s1.5.67 1.5 1.5S9.83 13 9 13s-1.5-.67-1.5-1.5zM16 17H8v-2h8v2zm-1-4c-.83 0-1.5-.67-1.5-1.5S14.17 10 15 10s1.5.67 1.5 1.5S15.83 13 15 13z"/>',
    label: '單一助手',
    caption: 'ASSISTANT',
    variant: 'medium',
    bounds: { x: 1250, y: 0, width: 750, height: 843 },
    action: { type: 'postback', data: 'action=solo', displayText: '單一助手' },
  },
  {
    id: 'my_files',
    iconSvg:
      '<path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V6h5.17l2 2H20v10z"/>',
    label: '我的檔案',
    caption: 'MY FILES',
    variant: 'medium',
    bounds: { x: 1250, y: 843, width: 750, height: 843 },
    action: { type: 'postback', data: 'action=list_files', displayText: '我的檔案' },
  },
  {
    id: 'usage',
    iconSvg:
      '<path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.11 0 2-.9 2-2V5c0-1.1-.89-2-2-2zm-7 14l-4-4 1.41-1.41L12 14.17l4.59-4.58L18 11l-6 6z"/>',
    label: '本月用量',
    caption: 'USAGE',
    variant: 'small',
    bounds: { x: 2000, y: 0, width: 500, height: 562 },
    action: { type: 'postback', data: 'action=quota', displayText: '本月用量' },
  },
  {
    id: 'help',
    iconSvg:
      '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75l-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z"/>',
    label: '使用教學',
    caption: 'HELP',
    variant: 'small',
    bounds: { x: 2000, y: 562, width: 500, height: 562 },
    action: { type: 'postback', data: 'action=help', displayText: '使用教學' },
  },
  {
    id: 'web',
    iconSvg:
      '<path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zm6.93 6h-2.95a15.65 15.65 0 0 0-1.38-3.56A8.03 8.03 0 0 1 18.92 8zM12 4.04c.83 1.2 1.48 2.53 1.91 3.96h-3.82c.43-1.43 1.08-2.76 1.91-3.96zM4.26 14C4.1 13.36 4 12.69 4 12s.1-1.36.26-2h3.38c-.08.66-.14 1.32-.14 2 0 .68.06 1.34.14 2H4.26zm.82 2h2.95c.32 1.25.78 2.45 1.38 3.56A7.987 7.987 0 0 1 5.08 16zm2.95-8H5.08a7.987 7.987 0 0 1 4.33-3.56A15.65 15.65 0 0 0 8.03 8zM12 19.96c-.83-1.2-1.48-2.53-1.91-3.96h3.82c-.43 1.43-1.08 2.76-1.91 3.96zM14.34 14H9.66c-.09-.66-.16-1.32-.16-2 0-.68.07-1.35.16-2h4.68c.09.65.16 1.32.16 2 0 .68-.07 1.34-.16 2zm.25 5.56c.6-1.11 1.06-2.31 1.38-3.56h2.95a8.03 8.03 0 0 1-4.33 3.56zM16.36 14c.08-.66.14-1.32.14-2 0-.68-.06-1.34-.14-2h3.38c.16.64.26 1.31.26 2s-.1 1.36-.26 2h-3.38z"/>',
    label: '開啟網頁',
    caption: 'WEB',
    variant: 'small',
    bounds: { x: 2000, y: 1124, width: 500, height: 562 },
    action: { type: 'uri', uri: pageUrl('/dashboard') },
  },
];

interface TileTypography {
  iconSize: number;
  iconY: number;
  labelSize: number;
  labelLetterSpacing: number;
  captionSize: number;
  captionLetterSpacing: number;
  numberSize: number;
  rulerWidth: number;
}

function typographyFor(variant: TileVariant): TileTypography {
  switch (variant) {
    case 'hero':
      return {
        iconSize: 240,
        iconY: -440,
        labelSize: 180,
        labelLetterSpacing: 24,
        captionSize: 32,
        captionLetterSpacing: 8,
        numberSize: 28,
        rulerWidth: 220,
      };
    case 'medium':
      return {
        iconSize: 140,
        iconY: -250,
        labelSize: 92,
        labelLetterSpacing: 12,
        captionSize: 22,
        captionLetterSpacing: 5,
        numberSize: 22,
        rulerWidth: 120,
      };
    case 'small':
      return {
        iconSize: 76,
        iconY: -140,
        labelSize: 60,
        labelLetterSpacing: 8,
        captionSize: 16,
        captionLetterSpacing: 4,
        numberSize: 18,
        rulerWidth: 80,
      };
  }
}

/**
 * Render one bento tile into SVG fragments.
 *
 * Each tile is positioned at the centre of its bounds; the hero gets an extra
 * tinted surface and a brand wordmark; small tiles stack icon-over-label with
 * a tighter ruler.
 */
function renderTile(tile: RichMenuTile, sequence: string): string {
  const t = typographyFor(tile.variant);
  const { x, y, width, height } = tile.bounds;
  const cx = x + width / 2;
  const cy = y + height / 2;

  const heroSurface =
    tile.variant === 'hero'
      ? `<rect x="${x + 40}" y="${y + 40}" width="${width - 80}" height="${height - 80}" fill="${PALETTE.heroSurface}" rx="2"/>`
      : '';

  const numberMark = `
    <text x="${x + 36}" y="${y + 56}"
          font-family="'IBM Plex Mono', 'Menlo', monospace"
          font-size="${t.numberSize}" letter-spacing="3"
          fill="${PALETTE.caption}">No. ${sequence}</text>
    <rect x="${x + 36}" y="${y + 70}" width="44" height="1" fill="${PALETTE.caption}"/>
  `;

  const brandMark =
    tile.variant === 'hero'
      ? `<text x="${x + width - 60}" y="${y + height - 80}"
              text-anchor="end"
              font-family="'IBM Plex Mono', 'Menlo', monospace"
              font-size="22" letter-spacing="6"
              fill="${PALETTE.caption}">AKEN AGENTS · 2026</text>`
      : '';

  const iconHalf = t.iconSize / 2;
  const iconX = cx - iconHalf;
  const iconY = cy + t.iconY;

  const labelY = cy + (tile.variant === 'hero' ? -20 : tile.variant === 'medium' ? -10 : 0);
  const rulerY = labelY + (tile.variant === 'hero' ? 60 : tile.variant === 'medium' ? 38 : 26);
  const captionY = rulerY + (tile.variant === 'hero' ? 64 : tile.variant === 'medium' ? 42 : 30);

  return `
    ${heroSurface}
    ${numberMark}
    <g transform="translate(${iconX}, ${iconY})">
      <svg width="${t.iconSize}" height="${t.iconSize}" viewBox="0 0 24 24" fill="${PALETTE.ink}">
        ${tile.iconSvg}
      </svg>
    </g>
    <text x="${cx}" y="${labelY}"
          text-anchor="middle"
          font-family="'Noto Serif TC', 'Source Han Serif TC', serif"
          font-weight="500" font-size="${t.labelSize}"
          letter-spacing="${t.labelLetterSpacing}"
          fill="${PALETTE.ink}">${escapeXml(tile.label)}</text>
    <rect x="${cx - t.rulerWidth / 2}" y="${rulerY}" width="${t.rulerWidth}" height="1" fill="${PALETTE.divider}"/>
    <text x="${cx}" y="${captionY}"
          text-anchor="middle"
          font-family="'IBM Plex Mono', 'Menlo', monospace"
          font-size="${t.captionSize}" letter-spacing="${t.captionLetterSpacing}"
          fill="${PALETTE.caption}">${escapeXml(tile.caption)}</text>
    ${brandMark}
  `;
}

/**
 * Build the rich-menu SVG. Dividers are computed from the actual tile bounds
 * so the bento grid stays in sync with whatever DEFAULT_TILES is set to.
 */
export function buildRichMenuSvg(tiles: RichMenuTile[]): string {
  const cells = tiles
    .slice(0, 6)
    .map((tile, i) => renderTile(tile, String(i + 1).padStart(2, '0')))
    .join('\n');

  const dividers = buildDividers(tiles.slice(0, 6));

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${RICH_MENU_WIDTH}" height="${RICH_MENU_HEIGHT}" viewBox="0 0 ${RICH_MENU_WIDTH} ${RICH_MENU_HEIGHT}">
  <rect width="${RICH_MENU_WIDTH}" height="${RICH_MENU_HEIGHT}" fill="${PALETTE.background}"/>
  ${dividers}
  ${cells}
</svg>`;
}

/**
 * Compute unique vertical/horizontal divider lines along tile edges so we
 * don't over-draw the same line twice or paint a divider on the canvas edge.
 */
function buildDividers(tiles: RichMenuTile[]): string {
  const verticals = new Set<number>();
  const horizontals = new Set<number>();
  for (const tile of tiles) {
    const right = tile.bounds.x + tile.bounds.width;
    const bottom = tile.bounds.y + tile.bounds.height;
    if (tile.bounds.x > 0) verticals.add(tile.bounds.x);
    if (right < RICH_MENU_WIDTH) verticals.add(right);
    if (tile.bounds.y > 0) horizontals.add(tile.bounds.y);
    if (bottom < RICH_MENU_HEIGHT) horizontals.add(bottom);
  }
  const parts: string[] = [];
  for (const vx of verticals) {
    parts.push(
      `<rect x="${vx - 0.5}" y="0" width="1" height="${RICH_MENU_HEIGHT}" fill="${PALETTE.divider}"/>`,
    );
  }
  for (const hy of horizontals) {
    parts.push(
      `<rect x="${RICH_MENU_WIDTH - 500}" y="${hy - 0.5}" width="500" height="1" fill="${PALETTE.divider}"/>`,
    );
  }
  parts.push(
    `<rect x="1250" y="843" width="750" height="1" fill="${PALETTE.divider}"/>`,
  );
  parts.push(
    `<rect x="1249.5" y="0" width="1" height="${RICH_MENU_HEIGHT}" fill="${PALETTE.divider}"/>`,
  );
  parts.push(
    `<rect x="1999.5" y="0" width="1" height="${RICH_MENU_HEIGHT}" fill="${PALETTE.divider}"/>`,
  );
  return parts.join('\n');
}

function escapeXml(str: string): string {
  return str.replace(/[<>&"']/g, ch => {
    switch (ch) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '"': return '&quot;';
      case "'": return '&apos;';
      default: return ch;
    }
  });
}

/**
 * Render SVG to PNG at the exact LINE-required dimensions. Writes the file
 * to `outputPath` and returns the byte buffer for chaining to the upload API.
 */
export async function renderRichMenuPng(tiles: RichMenuTile[], outputPath: string): Promise<Buffer> {
  const svg = buildRichMenuSvg(tiles);
  const buffer = await sharp(Buffer.from(svg, 'utf-8'))
    .png({ compressionLevel: 9 })
    .toBuffer();
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, buffer);
  return buffer;
}

/* ============================================================
   LINE Rich Menu Messaging API helpers
   ============================================================ */

const LINE_API = 'https://api.line.me';

function lineAuth(): Record<string, string> {
  return { Authorization: `Bearer ${config.line.channelAccessToken}` };
}

interface RichMenuCreateResponse { richMenuId: string }

/**
 * Build the request body that LINE expects, using each tile's explicit bounds
 * so the tappable hit-boxes match the rendered bento layout exactly.
 */
export function buildRichMenuLayout(tiles: RichMenuTile[]): unknown {
  const areas = tiles.slice(0, 6).map(tile => ({
    bounds: { ...tile.bounds },
    action: tile.action,
  }));

  return {
    size: { width: RICH_MENU_WIDTH, height: RICH_MENU_HEIGHT },
    selected: true,
    name: 'AI Agents Office — Bento Menu',
    chatBarText: '功能選單',
    areas,
  };
}

/**
 * Full deploy flow: create the rich menu → upload the PNG → set as default.
 */
export async function deployRichMenu(pngBuffer: Buffer, tiles: RichMenuTile[]): Promise<string> {
  const layout = buildRichMenuLayout(tiles);
  const createRes = await fetch(`${LINE_API}/v2/bot/richmenu`, {
    method: 'POST',
    headers: { ...lineAuth(), 'Content-Type': 'application/json' },
    body: JSON.stringify(layout),
  });
  if (!createRes.ok) {
    const txt = await createRes.text().catch(() => '');
    throw new Error(`Rich menu create failed: ${createRes.status} ${txt.slice(0, 500)}`);
  }
  const { richMenuId } = (await createRes.json()) as RichMenuCreateResponse;

  const uploadRes = await fetch(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
    method: 'POST',
    headers: { ...lineAuth(), 'Content-Type': 'image/png' },
    body: pngBuffer as unknown as BodyInit,
  });
  if (!uploadRes.ok) {
    const txt = await uploadRes.text().catch(() => '');
    throw new Error(`Rich menu image upload failed: ${uploadRes.status} ${txt.slice(0, 500)}`);
  }

  const defaultRes = await fetch(`${LINE_API}/v2/bot/user/all/richmenu/${richMenuId}`, {
    method: 'POST',
    headers: lineAuth(),
  });
  if (!defaultRes.ok) {
    const txt = await defaultRes.text().catch(() => '');
    throw new Error(`Rich menu set-default failed: ${defaultRes.status} ${txt.slice(0, 500)}`);
  }

  return richMenuId;
}

export interface RichMenuListEntry {
  richMenuId: string;
  name: string;
  chatBarText: string;
}

/**
 * List every rich menu currently registered on the LINE channel — used by
 * the cleanup script to find orphans.
 */
export async function listRichMenus(): Promise<RichMenuListEntry[]> {
  const res = await fetch(`${LINE_API}/v2/bot/richmenu/list`, {
    method: 'GET',
    headers: lineAuth(),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Rich menu list failed: ${res.status} ${txt.slice(0, 500)}`);
  }
  const body = (await res.json()) as { richmenus?: RichMenuListEntry[] };
  return body.richmenus ?? [];
}

/**
 * Delete a single rich menu by id. LINE returns 200 with empty body on
 * success and 404 if it was already removed — both are treated as a no-op.
 */
export async function deleteRichMenu(richMenuId: string): Promise<void> {
  const res = await fetch(`${LINE_API}/v2/bot/richmenu/${richMenuId}`, {
    method: 'DELETE',
    headers: lineAuth(),
  });
  if (!res.ok && res.status !== 404) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Rich menu delete failed: ${res.status} ${txt.slice(0, 500)}`);
  }
}
