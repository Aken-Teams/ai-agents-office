/**
 * Format orchestrator output for LINE delivery.
 *
 * LINE constraints:
 *  - LINE text messages render as plain UTF-8 — markdown syntax (asterisks,
 *    hashes, pipes) shows up literally and looks like garbage. Claude defaults
 *    to markdown, so we strip it before chunking.
 *  - One text message ≤ 5000 chars
 *  - One reply/push call ≤ 5 messages
 *  - We aim for 4500 to leave headroom for trailing URLs etc.
 */

import type { LineTextMessage } from './client.js';

const SOFT_LIMIT = 4500;
const HARD_LIMIT = 5000;
const MAX_MESSAGES = 5;

/**
 * Splits `text` into ≤5 chunks, each ≤4500 chars, after first transforming
 * markdown into LINE-friendly plain text. Tries to break on paragraph
 * boundaries first, then sentences, then hard-truncates at HARD_LIMIT. If the
 * total content exceeds 5 chunks worth, the last chunk gets a "…（內容過長已截斷）"
 * suffix.
 */
export function splitForLine(text: string): LineTextMessage[] {
  // Strip chart blocks before generic markdown — caller will render them
  // separately. If the caller didn't extract them, drop the JSON so it
  // doesn't show up as raw text on LINE.
  const { textWithoutCharts } = extractChartBlocks(text || '');
  const clean = stripMarkdown(textWithoutCharts).trim();
  if (!clean) return [];

  if (clean.length <= SOFT_LIMIT) {
    return [{ type: 'text', text: clean }];
  }

  const chunks: string[] = [];
  let remaining = clean;

  while (remaining.length > SOFT_LIMIT && chunks.length < MAX_MESSAGES - 1) {
    const idx = findBreakpoint(remaining, SOFT_LIMIT);
    chunks.push(remaining.slice(0, idx).trim());
    remaining = remaining.slice(idx).trim();
  }

  if (remaining.length > HARD_LIMIT) {
    const truncated = remaining.slice(0, HARD_LIMIT - 16).trim() + '\n…（內容過長已截斷）';
    chunks.push(truncated);
  } else if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks.map(text => ({ type: 'text' as const, text }));
}

/**
 * Convert common markdown syntax into plain text that reads well on LINE.
 * Exported so callers can use the same conversion for things they push
 * outside the normal split flow (e.g. canned messages).
 */
export function stripMarkdown(text: string): string {
  let s = text;

  s = s.replace(/```[a-zA-Z0-9_+-]*\n?/g, '');
  s = s.replace(/```/g, '');

  s = convertTables(s);

  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, url) => `🖼 ${alt ? alt + ' ' : ''}${url}`);
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1（$2）');

  s = s.replace(/`([^`\n]+)`/g, '$1');

  // LINE has no highlight (==mark==). Flatten any bold inside the highlight,
  // then wrap the phrase in 〔〕 so it still reads as the key point without the
  // raw == markers leaking through. Done before bold so we don't double-bracket.
  s = s.replace(/==\s*(.+?)\s*==/g, (_m, inner: string) =>
    `〔${inner.replace(/\*\*([^*\n]+?)\*\*/g, '$1').replace(/__([^_\n]+?)__/g, '$1')}〕`);

  // LINE has no bold / italic — substitute Chinese brackets so emphasized
  // text still reads as visually distinct rather than blending into the
  // surrounding plain text.
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, '【$1】');
  s = s.replace(/__([^_\n]+?)__/g, '【$1】');
  s = s.replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?![*\w])/g, '$1《$2》');
  s = s.replace(/(^|[^_\w])_(?!\s)([^_\n]+?)_(?![_\w])/g, '$1《$2》');

  s = s
    .split('\n')
    .map(line => {
      const m = line.match(/^(\s*)(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (!m) return line;
      const level = m[2].length;
      const content = m[3];
      if (level === 1) return `${m[1]}■ ${content}`;
      if (level === 2) return `${m[1]}▎${content}`;
      if (level === 3) return `${m[1]}· ${content}`;
      return `${m[1]}${content}`;
    })
    .join('\n');

  s = s.replace(/^(\s*)[-*+]\s+/gm, '$1• ');
  s = s.replace(/^(\s*)>\s+/gm, '$1｜ ');
  s = s.replace(/^(\s*)(-{3,}|\*{3,}|_{3,})\s*$/gm, '$1——————');

  s = s.replace(/\n{3,}/g, '\n\n');

  return s;
}

/**
 * Convert pipe-delimited markdown tables into vertical key:value blocks that
 * read cleanly in LINE. If the first column looks like an index (number,
 * letter, Chinese numeral 1–10), it becomes a 【N】 section marker and the
 * remaining columns are rendered as key:value pairs underneath. Otherwise
 * every column is rendered as key:value.
 */
function convertTables(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    if (
      isTableRow(lines[i]) &&
      i + 1 < lines.length &&
      isTableSeparator(lines[i + 1])
    ) {
      const headers = parseTableCells(lines[i]);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i]) && !isTableSeparator(lines[i])) {
        rows.push(parseTableCells(lines[i]));
        i++;
      }
      out.push(...renderTable(headers, rows));
      out.push('');
    } else {
      out.push(lines[i]);
      i++;
    }
  }

  return out.join('\n');
}

function isTableRow(line: string): boolean {
  return /^\s*\|.+\|\s*$/.test(line);
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|') || !trimmed.includes('-')) return false;
  return /^\|?[\s\-:|]+\|?$/.test(trimmed);
}

function parseTableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(c => stripCellMarkdown(c.trim()));
}

function stripCellMarkdown(cell: string): string {
  return cell
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
}

function renderTable(headers: string[], rows: string[][]): string[] {
  const out: string[] = [];
  const isIndexLike = (s: string): boolean =>
    /^[\dA-Za-z一二三四五六七八九十]{1,3}$/.test(s);

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const firstCell = row[0] ?? '';

    if (isIndexLike(firstCell) && headers.length > 1) {
      out.push(`【${firstCell}】`);
      for (let c = 1; c < headers.length; c++) {
        const value = row[c] ?? '';
        if (value) out.push(`${headers[c]}：${value}`);
      }
    } else {
      for (let c = 0; c < headers.length; c++) {
        const value = row[c] ?? '';
        if (value) out.push(`${headers[c]}：${value}`);
      }
    }
    if (r < rows.length - 1) out.push('');
  }
  return out;
}

function findBreakpoint(text: string, limit: number): number {
  // Prefer a paragraph (double newline) within the last 25% of the limit window.
  const minWindow = Math.floor(limit * 0.75);
  const para = text.lastIndexOf('\n\n', limit);
  if (para >= minWindow) return para;
  const line = text.lastIndexOf('\n', limit);
  if (line >= minWindow) return line;
  // Sentence-ish break — Chinese full-stop or punctuation.
  for (let i = limit; i >= minWindow; i--) {
    const ch = text[i];
    if (ch === '。' || ch === '？' || ch === '！' || ch === '.' || ch === '?' || ch === '!') {
      return i + 1;
    }
  }
  return limit;
}

/**
 * Build LINE-friendly markdown for a list of share URLs. LINE doesn't support
 * markdown so we just stringify as plain text; URLs auto-link in the LINE app.
 */
export function formatShareUrls(items: Array<{ filename: string; url: string }>): string {
  if (items.length === 0) return '';
  const lines = ['📂 已產生檔案：', ''];
  for (const it of items) {
    lines.push(`• ${it.filename}`);
    lines.push(`  ${it.url}`);
  }
  return lines.join('\n');
}

export interface ExtractedChart {
  /** Code-fence language (chart / echart / mermaid / visual / mindmap / map) */
  kind: string;
  /** Raw block content — JSON for chart/echart, source code for others */
  body: string;
  /** Parsed JSON for chart/echart blocks (null when parse failed) */
  spec: unknown;
}

export interface ExtractedChartResult {
  charts: ExtractedChart[];
  /** Original text with the extracted chart blocks removed. */
  textWithoutCharts: string;
}

const CHART_FENCE_RE = /```(chart|echart|mermaid|visual|mindmap|map)\s*\n([\s\S]*?)```/g;

/**
 * Pull every typed code-fence block (`\`\`\`chart`, `\`\`\`echart`, etc.)
 * out of the model's output so the LINE handler can render them to PNG
 * separately. JSON parse failures yield `spec: null` — callers should fall
 * back to a text summary in that case.
 */
export function extractChartBlocks(text: string): ExtractedChartResult {
  const charts: ExtractedChart[] = [];
  const textWithoutCharts = text.replace(CHART_FENCE_RE, (_m, kind: string, body: string) => {
    let spec: unknown = null;
    if (kind === 'chart' || kind === 'echart') {
      try { spec = JSON.parse(body.trim()); } catch { spec = null; }
    }
    charts.push({ kind, body: body.trim(), spec });
    return ''; // remove the fence from the running text
  });
  return { charts, textWithoutCharts };
}
