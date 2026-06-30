/**
 * PANJIT (強茂) brand kit for pptxgenjs — a component library.
 *
 * The corporate FRAME (circuit cover, logo, brand blue, footer + page number) is
 * fixed. On top of it you compose polished, pre-styled COMPONENTS — charts, KPI
 * rows, cards, two-panel comparisons, timelines, tables, numbered lists — that
 * already look good and never overlap. Fill the deck by calling these; only drop
 * to raw shapes for something truly custom.
 *
 *   const B = require('<assetsDir>/panjit_brand.cjs');
 *   const pptx = new PptxGenJS(); B.init(pptx);
 *   B.cover(pptx, '主標題', '副標題');
 *   let s = B.content(pptx, '頁面標題', 2);
 *   B.lead(s, '一句重點導言。');
 *   const [L, R] = B.splitH(s, 0.42);            // split content area, no overlap
 *   B.table(s, ['欄1','欄2'], [['a','b']], L);
 *   B.chart(s, 'doughnut', [{labels:['x','y'],values:[60,40]}], R);
 *   B.closing(pptx, 'Thank You', '強茂 PANJIT Semiconductor');
 */
const path = require('path');
const DIR = __dirname;
const COVER_IMG = path.join(DIR, 'panjit-cover.jpg');
const LOGO_IMG = path.join(DIR, 'panjit-logo.png');

const BRAND = '0075C2', DARK = '124E78', INK = '1C2B36', BODY = '44515C', GREY = '8A93A0';
const LIGHT = 'EAF4FB', LINE = 'D9E6F2', PANEL = 'F4F9FD';
const RED = 'C0392B', GREEN = '2E9E5B', AMBER = 'E08A1E';
const ACCENTS = ['0075C2', '17A2D6', '5BC2E7', '124E78', '2E9E5B', 'E08A1E'];
const FONT = 'Arial';
const COPYRIGHT = 'Copyright© 2020 PANJIT International Inc. All rights reserved.';
const W = 13.333, H = 7.5;
const AREA = { x: 0.6, y: 1.55, w: 12.13, h: 5.05 };

function init(pptx) {
  pptx.defineLayout({ name: 'PANJIT16x9', width: W, height: H });
  pptx.layout = 'PANJIT16x9';
  pptx.theme = { headFontFace: FONT, bodyFontFace: FONT };
}

// ── region splitting (prevents overlap) ──────────────────────────────────────
function splitH(_s, frac = 0.5, gap = 0.4, r = AREA) {
  const lw = (r.w - gap) * frac;
  return [{ x: r.x, y: r.y, w: lw, h: r.h }, { x: r.x + lw + gap, y: r.y, w: r.w - lw - gap, h: r.h }];
}
function splitV(_s, frac = 0.5, gap = 0.35, r = AREA) {
  const th = (r.h - gap) * frac;
  return [{ x: r.x, y: r.y, w: r.w, h: th }, { x: r.x, y: r.y + th + gap, w: r.w, h: r.h - th - gap }];
}
function below(_s, hasLead = true, r = AREA) { // area under a lead sentence
  const dy = hasLead ? 0.65 : 0;
  return { x: r.x, y: r.y + dy, w: r.w, h: r.h - dy };
}

function lead(s, text) {
  s.addText(text, { x: AREA.x, y: AREA.y, w: AREA.w, h: 0.5, fontSize: 14, color: BODY, italic: true, fontFace: FONT });
}

// ── frame slides ─────────────────────────────────────────────────────────────
function _footer(s, pageNum) {
  s.addText(COPYRIGHT, { x: 2, y: H - 0.4, w: W - 4, h: 0.3, fontSize: 8, color: 'A9B2BC', align: 'center', fontFace: FONT });
  if (pageNum != null) {
    s.addShape('rect', { x: W - 0.95, y: H - 0.45, w: 0.95, h: 0.45, fill: { color: BRAND } });
    s.addText(String(pageNum), { x: W - 0.95, y: H - 0.45, w: 0.95, h: 0.45, fontSize: 10, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle', fontFace: FONT });
  }
}
function cover(pptx, title, subtitle) {
  const s = pptx.addSlide();
  s.addImage({ path: COVER_IMG, x: 0, y: 0, w: W, h: H });
  s.addText(title || '', { x: 3.3, y: 2.85, w: 9.4, h: 1.5, fontSize: 30, bold: true, color: BRAND, fontFace: FONT, valign: 'top' });
  if (subtitle) s.addText(subtitle, { x: 3.3, y: 4.25, w: 9.4, h: 0.7, fontSize: 18, bold: true, color: BRAND, fontFace: FONT });
  return s;
}
function content(pptx, title, pageNum) {
  const s = pptx.addSlide();
  s.background = { color: 'FFFFFF' };
  s.addText(title || '', { x: 0.6, y: 0.32, w: 9.6, h: 0.7, fontSize: 24, bold: true, color: BRAND, fontFace: FONT, valign: 'middle' });
  s.addShape('rect', { x: 0.6, y: 1.06, w: W - 1.2, h: 0.035, fill: { color: BRAND } });
  s.addImage({ path: LOGO_IMG, x: W - 1.85, y: 0.32, w: 1.25, h: 0.508 });
  _footer(s, pageNum);
  return s;
}
// Section divider WITH a visual: big tinted index panel + label.
function section(pptx, title, pageNum, index) {
  const s = pptx.addSlide();
  s.background = { color: 'FFFFFF' };
  s.addImage({ path: LOGO_IMG, x: W - 1.85, y: 0.4, w: 1.25, h: 0.508 });
  s.addShape('rect', { x: 0, y: 0, w: 0.35, h: H, fill: { color: BRAND } });
  s.addShape('roundRect', { x: 1.4, y: 2.35, w: 2.8, h: 2.8, fill: { color: LIGHT }, line: { color: BRAND, width: 1.25 }, rectRadius: 0.1 });
  s.addText(index != null ? String(index) : '', { x: 1.4, y: 2.35, w: 2.8, h: 2.8, fontSize: 110, bold: true, color: BRAND, align: 'center', valign: 'middle', fontFace: FONT });
  s.addShape('rect', { x: 4.9, y: 3.05, w: 0.9, h: 0.12, fill: { color: BRAND } });
  s.addText(title || '', { x: 4.9, y: 3.25, w: 7.4, h: 1.4, fontSize: 34, bold: true, color: INK, fontFace: FONT, valign: 'top' });
  _footer(s, pageNum);
  return s;
}
function closing(pptx, title, subtitle) {
  const s = pptx.addSlide();
  s.addImage({ path: COVER_IMG, x: 0, y: 0, w: W, h: H });
  s.addText(title || 'Thank You', { x: 3.3, y: 2.85, w: 9.4, h: 1.3, fontSize: 34, bold: true, color: BRAND, fontFace: FONT });
  if (subtitle) s.addText(subtitle, { x: 3.3, y: 4.15, w: 9.4, h: 0.7, fontSize: 18, bold: true, color: BRAND, fontFace: FONT });
  return s;
}

// ── components ───────────────────────────────────────────────────────────────
// Polished chart with brand defaults per type (clean axes, data labels, palette).
function chart(s, type, data, r = AREA, opts = {}) {
  const base = {
    x: r.x, y: r.y, w: r.w, h: r.h, chartColors: ACCENTS, fontFace: FONT, showLegend: false,
    showValue: true, dataLabelColor: INK, dataLabelFontFace: FONT, dataLabelFontSize: 11, dataLabelFontBold: true,
    catAxisLabelColor: INK, catAxisLabelFontFace: FONT, catAxisLabelFontSize: 11,
    valAxisHidden: true, catAxisLineShow: false, valAxisLineShow: false,
    valGridLine: { style: 'none' }, catGridLine: { style: 'none' },
  };
  if (type === 'bar') { base.barGapWidthPct = 45; }
  else if (type === 'pie' || type === 'doughnut') {
    Object.assign(base, { showValue: false, showPercent: true, dataLabelColor: 'FFFFFF', dataLabelFontBold: true,
      showLegend: true, legendPos: 'r', legendColor: INK, legendFontFace: FONT, legendFontSize: 11,
      valAxisHidden: false });
    delete base.valGridLine; delete base.catGridLine;
    if (type === 'doughnut') base.holeSize = 58;
  } else if (type === 'line' || type === 'area') {
    Object.assign(base, { lineSmooth: true, lineDataSymbol: 'circle', lineDataSymbolSize: 6, lineSize: 2.5,
      valAxisHidden: false, valAxisLabelColor: GREY, valAxisLabelFontFace: FONT,
      valGridLine: { style: 'solid', color: 'EEF2F6', size: 1 } });
  }
  return s.addChart(type, data, Object.assign(base, opts));
}

function table(s, head, rows, r = AREA, colW) {
  const hdr = head.map(t => ({ text: String(t), options: { fill: BRAND, color: 'FFFFFF', bold: true, valign: 'middle' } }));
  const body = rows.map((row, i) => row.map(c => ({ text: String(c), options: { fill: i % 2 ? LIGHT : 'FFFFFF' } })));
  const rowH = Math.max(0.38, Math.min(0.6, r.h / (rows.length + 1)));
  return s.addTable([hdr, ...body], { x: r.x, y: r.y, w: r.w, colW, fontSize: 12.5, fontFace: FONT, color: BODY,
    border: { type: 'solid', color: LINE, pt: 1 }, align: 'left', valign: 'middle', rowH });
}

// items: [[value, label], ...]
function kpiRow(s, items, r = AREA) {
  const n = items.length, gap = 0.3, w = (r.w - gap * (n - 1)) / n, h = Math.min(2.0, r.h);
  items.forEach((k, i) => {
    const x = r.x + i * (w + gap);
    s.addShape('roundRect', { x, y: r.y, w, h, fill: { color: PANEL }, line: { color: LINE, width: 1 }, rectRadius: 0.06 });
    s.addShape('rect', { x, y: r.y, w, h: 0.1, fill: { color: BRAND } });
    s.addText(String(k[0]), { x, y: r.y + h * 0.18, w, h: h * 0.5, fontSize: 32, bold: true, color: BRAND, align: 'center', fontFace: FONT });
    s.addText(String(k[1]), { x, y: r.y + h * 0.68, w, h: h * 0.28, fontSize: 12.5, color: BODY, align: 'center', fontFace: FONT });
  });
}

// items: [[title, desc], ...]
function cards(s, items, cols = 3, r = AREA) {
  const rows = Math.ceil(items.length / cols), gx = 0.3, gy = 0.3;
  const w = (r.w - gx * (cols - 1)) / cols, h = (r.h - gy * (rows - 1)) / rows;
  items.forEach((c, i) => {
    const x = r.x + (i % cols) * (w + gx), y = r.y + Math.floor(i / cols) * (h + gy);
    s.addShape('roundRect', { x, y, w, h, fill: { color: PANEL }, line: { color: BRAND, width: 1 }, rectRadius: 0.05 });
    s.addShape('rect', { x, y, w, h: 0.52, fill: { color: BRAND } });
    s.addText(String(c[0]), { x: x + 0.22, y, w: w - 0.4, h: 0.52, fontSize: 14, bold: true, color: 'FFFFFF', valign: 'middle', fontFace: FONT });
    s.addText(String(c[1]), { x: x + 0.22, y: y + 0.66, w: w - 0.44, h: h - 0.85, fontSize: 12, color: BODY, fontFace: FONT, valign: 'top' });
  });
}

// left/right: { title, color?, items: [[t, d], ...] }
function twoPanel(s, left, right, r = AREA) {
  [[r.x, left, left.color || RED], [r.x + r.w / 2 + 0.2, right, right.color || GREEN]].forEach(arr => {
    const x = arr[0], p = arr[1], col = arr[2], pw = r.w / 2 - 0.2;
    s.addShape('roundRect', { x, y: r.y, w: pw, h: r.h, fill: { color: PANEL }, line: { color: col, width: 1.25 }, rectRadius: 0.05 });
    s.addShape('rect', { x, y: r.y, w: pw, h: 0.6, fill: { color: col } });
    s.addText(p.title, { x: x + 0.28, y: r.y, w: pw - 0.5, h: 0.6, fontSize: 14, bold: true, color: 'FFFFFF', valign: 'middle', fontFace: FONT });
    const ih = (r.h - 0.95) / p.items.length;
    p.items.forEach((it, i) => {
      const iy = r.y + 0.85 + i * ih;
      s.addShape('rect', { x: x + 0.3, y: iy + 0.05, w: 0.5, h: 0.5, fill: { color: col } });
      s.addText(String(i + 1), { x: x + 0.3, y: iy + 0.05, w: 0.5, h: 0.5, fontSize: 13, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle', fontFace: FONT });
      s.addText(it[0], { x: x + 1.0, y: iy, w: pw - 1.2, h: 0.4, fontSize: 13.5, bold: true, color: INK, fontFace: FONT });
      s.addText(it[1], { x: x + 1.0, y: iy + 0.4, w: pw - 1.25, h: ih - 0.45, fontSize: 11, color: GREY, fontFace: FONT });
    });
  });
}

// milestones: [[label, detail], ...]
function timeline(s, ms, r = AREA) {
  const ly = r.y + r.h / 2, x0 = r.x + 0.6, dx = (r.w - 1.2) / (ms.length - 1);
  s.addShape('line', { x: x0, y: ly, w: dx * (ms.length - 1), h: 0, line: { color: BRAND, width: 2.5 } });
  ms.forEach((m, i) => {
    const cx = x0 + i * dx, up = i % 2 === 0, cardH = 1.25, cy = up ? ly - 0.45 - cardH : ly + 0.45;
    s.addShape('rect', { x: cx - 1.05, y: cy, w: 2.1, h: 0.07, fill: { color: BRAND } });
    s.addShape('roundRect', { x: cx - 1.05, y: cy + 0.07, w: 2.1, h: cardH - 0.07, fill: { color: PANEL }, line: { color: LINE, width: 1 }, rectRadius: 0.04 });
    s.addText(m[0], { x: cx - 0.95, y: cy + 0.16, w: 1.9, h: 0.45, fontSize: 12, bold: true, color: BRAND, fontFace: FONT });
    s.addText(m[1], { x: cx - 0.95, y: cy + 0.6, w: 1.9, h: 0.55, fontSize: 10, color: GREY, fontFace: FONT });
    s.addShape('ellipse', { x: cx - 0.17, y: ly - 0.17, w: 0.34, h: 0.34, fill: { color: BRAND }, line: { color: 'FFFFFF', width: 2.5 } });
  });
}

// items: [[title, desc], ...] — vertical numbered list with brand index boxes
function numbered(s, items, r = AREA) {
  const ih = r.h / items.length;
  items.forEach((it, i) => {
    const y = r.y + i * ih;
    s.addShape('roundRect', { x: r.x, y: y + 0.05, w: 0.62, h: 0.62, fill: { color: BRAND }, rectRadius: 0.08 });
    s.addText(String(i + 1).padStart(2, '0'), { x: r.x, y: y + 0.05, w: 0.62, h: 0.62, fontSize: 14, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle', fontFace: FONT });
    s.addText(it[0], { x: r.x + 0.85, y, w: r.w - 1.0, h: 0.45, fontSize: 15, bold: true, color: INK, fontFace: FONT });
    s.addText(it[1], { x: r.x + 0.85, y: y + 0.42, w: r.w - 1.0, h: ih - 0.5, fontSize: 12, color: BODY, fontFace: FONT });
  });
}

module.exports = {
  init, cover, content, section, closing,
  chart, table, kpiRow, cards, twoPanel, timeline, numbered, lead,
  splitH, splitV, below,
  BRAND, DARK, INK, BODY, GREY, LIGHT, LINE, PANEL, RED, GREEN, AMBER, ACCENTS, FONT, AREA, W, H,
};
