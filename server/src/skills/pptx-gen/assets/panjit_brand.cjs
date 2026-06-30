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
// Content box — pushed close to the edges so slides can fill nearly the whole
// page (only the header strip + thin footer are reserved). Use it ALL.
const AREA = { x: 0.5, y: 1.35, w: 12.33, h: 5.55 };

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
// Section divider — a bold left colour band with the title, and a "本章重點"
// agenda on the right so the slide carries information (never an empty big title).
// opts: { kicker?, subtitle?, agenda?: [string,...], color? }  (a string is treated
// as a kicker for backward-compat).
function section(pptx, title, pageNum, opts) {
  if (opts == null || typeof opts !== 'object') opts = {};
  const col = opts.color || BRAND;
  const s = pptx.addSlide();
  s.background = { color: 'FFFFFF' };
  const bw = 5.5;
  s.addShape('rect', { x: 0, y: 0, w: bw, h: H, fill: { color: col } });
  s.addImage({ path: LOGO_IMG, x: W - 1.85, y: 0.45, w: 1.25, h: 0.508 });
  if (opts.kicker) s.addText(String(opts.kicker), { x: 0.75, y: 2.5, w: bw - 1.2, h: 0.5, fontSize: 14, bold: true, color: 'FFFFFF', charSpacing: 3, fontFace: FONT });
  s.addShape('rect', { x: 0.78, y: 3.05, w: 0.85, h: 0.1, fill: { color: 'FFFFFF' } });
  s.addText(title || '', { x: 0.75, y: 3.25, w: bw - 1.1, h: 1.8, fontSize: 30, bold: true, color: 'FFFFFF', valign: 'top', fontFace: FONT });
  if (opts.subtitle) s.addText(String(opts.subtitle), { x: 0.78, y: 5.0, w: bw - 1.2, h: 1.0, fontSize: 13, color: 'FFFFFF', fontFace: FONT });
  const ag = opts.agenda || [];
  if (ag.length) {
    s.addText('本章重點', { x: bw + 0.8, y: 1.85, w: 6, h: 0.5, fontSize: 14, bold: true, color: col, charSpacing: 2, fontFace: FONT });
    const ih = Math.min(1.1, (H - 3.0) / ag.length);
    ag.forEach((it, i) => {
      const y = 2.6 + i * ih;
      s.addText(String(i + 1).padStart(2, '0'), { x: bw + 0.8, y, w: 0.75, h: 0.65, fontSize: 24, bold: true, color: col, fontFace: FONT });
      s.addText(String(it), { x: bw + 1.65, y, w: W - bw - 2.4, h: 0.65, fontSize: 16, color: INK, valign: 'middle', fontFace: FONT });
      if (i < ag.length - 1) s.addShape('rect', { x: bw + 0.8, y: y + ih - 0.18, w: W - bw - 1.6, h: 0.012, fill: { color: LINE } });
    });
  }
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
const SHADOW = { type: 'outer', blur: 9, offset: 3, angle: 90, color: '8AA0B5', opacity: 0.28 };
const HEX = c => '#' + c;

// Build a PANJIT-styled ECharts option from pptxgenjs-style data
// (`[{name,labels,values}, ...]`). Modern look: gradients, rounded bars, clean axes.
function _chartOption(echarts, type, data, opts) {
  const series0 = data[0] || { labels: [], values: [] };
  const cats = series0.labels || [];
  // Palette defaults to brand accents, but the deck author can override per chart
  // (opts.colors) so charts match the slide's own palette — not forced blue.
  const pal = (opts.colors || ACCENTS).map(c => c[0] === '#' ? c : HEX(c));
  const grad = (a, b, x2 = 0, y2 = 1) => new echarts.graphic.LinearGradient(0, 0, x2, y2, [{ offset: 0, color: a }, { offset: 1, color: b }]);
  // lighten a #hex toward white (for a subtle SAME-hue bar gradient, not two clashing colours)
  const lighten = (hex, amt) => { const h = hex.replace('#', ''); const m = i => { const c = parseInt(h.substr(i, 2), 16); return Math.round(c + (255 - c) * amt).toString(16).padStart(2, '0'); }; return '#' + m(0) + m(2) + m(4); };
  const axisCommon = {
    nameTextStyle: { color: HEX(GREY) },
    axisLine: { lineStyle: { color: '#cfd8e0' } },
    axisTick: { show: false },
  };
  // Chart is rendered at 2× then scaled down, so use large font px to stay legible.
  const FS = 26, FSlabel = 26;
  const o = { backgroundColor: '#ffffff', textStyle: { fontFamily: FONT }, color: pal };
  if (type === 'pie' || type === 'doughnut') {
    o.legend = { orient: 'vertical', right: 10, top: 'center', itemGap: 14, textStyle: { color: HEX(INK), fontSize: FS } };
    o.series = [{
      type: 'pie', radius: type === 'doughnut' ? ['46%', '74%'] : ['0%', '74%'], center: ['38%', '50%'],
      avoidLabelOverlap: true, itemStyle: { borderColor: '#fff', borderWidth: 3 },
      label: { color: HEX(INK), fontSize: FS, fontWeight: 'bold', formatter: '{b} {d}%' },
      labelLine: { length: 14, length2: 16 },
      data: cats.map((c, i) => ({ name: c, value: series0.values[i] })),
    }];
  } else if (type === 'line' || type === 'area') {
    o.grid = { left: 72, right: 36, top: 40, bottom: 56 };
    o.xAxis = Object.assign({ type: 'category', data: cats, boundaryGap: type !== 'line', axisLabel: { color: HEX(INK), fontSize: FS } }, axisCommon);
    o.yAxis = Object.assign({ type: 'value', splitLine: { lineStyle: { color: '#eef2f6' } }, axisLabel: { color: HEX(GREY), fontSize: FS }, axisLine: { show: false } }, axisCommon);
    o.series = data.map((d, si) => ({
      name: d.name, type: 'line', smooth: true, symbol: 'circle', symbolSize: 12,
      lineStyle: { width: 4, color: pal[si % pal.length] },
      itemStyle: { color: pal[si % pal.length], borderColor: '#fff', borderWidth: 3 },
      areaStyle: type === 'area' ? { color: grad(pal[si % pal.length] + 'cc', '#ffffff00') } : undefined,
      label: { show: true, position: 'top', color: HEX(INK), fontWeight: 'bold', fontSize: FSlabel },
      data: d.values,
    }));
  } else { // bar
    const horiz = opts.barDir === 'bar';
    const catAxis = Object.assign({ type: 'category', data: cats, axisLabel: { color: HEX(INK), fontSize: FS } }, axisCommon);
    const valAxis = Object.assign({ type: 'value', splitLine: { lineStyle: { color: '#eef2f6' } }, axisLabel: { color: HEX(GREY), fontSize: FS }, axisLine: { show: false } }, axisCommon);
    o.grid = { left: horiz ? 130 : 64, right: 48, top: 32, bottom: 52 };
    o.xAxis = horiz ? valAxis : catAxis;
    o.yAxis = horiz ? Object.assign({}, catAxis, { inverse: true }) : valAxis;
    o.series = data.map((d, si) => {
      const c = pal[si % pal.length], lc = lighten(c, 0.3);
      // subtle SAME-hue gradient along the bar (solid → lighter); rounded ends.
      const fill = horiz ? grad(c, lc, 1, 0) : grad(lc, c, 0, 1);
      return {
        name: d.name, type: 'bar', barWidth: '52%',
        itemStyle: { borderRadius: horiz ? [0, 7, 7, 0] : [7, 7, 0, 0], color: fill },
        label: { show: true, position: horiz ? 'right' : 'top', color: c, fontWeight: 'bold', fontSize: FSlabel },
        data: d.values,
      };
    });
  }
  return o;
}

// Polished chart rendered via ECharts → SVG → PNG (modern, gradient, infographic
// quality). ASYNC — the caller MUST `await` it. Lays the image into `region`.
async function chart(s, type, data, r = AREA, opts = {}) {
  const echarts = require('echarts');
  const sharp = require('sharp');
  const px = 2;
  const inst = echarts.init(null, null, { renderer: 'svg', ssr: true, width: Math.round(r.w * 96 * px), height: Math.round(r.h * 96 * px) });
  inst.setOption(_chartOption(echarts, type, data, opts));
  const svg = inst.renderToSVGString();
  inst.dispose();
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  s.addImage({ data: 'image/png;base64,' + png.toString('base64'), x: r.x, y: r.y, w: r.w, h: r.h });
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
    s.addShape('roundRect', { x, y: r.y, w, h, fill: { color: 'FFFFFF' }, line: { color: LINE, width: 1 }, rectRadius: 0.06, shadow: SHADOW });
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
    s.addShape('roundRect', { x, y, w, h, fill: { color: 'FFFFFF' }, line: { color: LINE, width: 1 }, rectRadius: 0.05, shadow: SHADOW });
    s.addShape('rect', { x, y, w, h: 0.52, fill: { color: BRAND } });
    s.addText(String(c[0]), { x: x + 0.22, y, w: w - 0.4, h: 0.52, fontSize: 14, bold: true, color: 'FFFFFF', valign: 'middle', fontFace: FONT });
    s.addText(String(c[1]), { x: x + 0.22, y: y + 0.66, w: w - 0.44, h: h - 0.85, fontSize: 12, color: BODY, fontFace: FONT, valign: 'top' });
  });
}

// left/right: { title, color?, items: [[t, d], ...] }
function twoPanel(s, left, right, r = AREA) {
  [[r.x, left, left.color || RED], [r.x + r.w / 2 + 0.2, right, right.color || GREEN]].forEach(arr => {
    const x = arr[0], p = arr[1], col = arr[2], pw = r.w / 2 - 0.2;
    s.addShape('roundRect', { x, y: r.y, w: pw, h: r.h, fill: { color: 'FFFFFF' }, line: { color: col, width: 1.25 }, rectRadius: 0.05, shadow: SHADOW });
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

// callout / insight bar — brand-tinted box with an accent edge, for takeaways.
function callout(s, text, r = AREA, color = BRAND) {
  s.addShape('roundRect', { x: r.x, y: r.y, w: r.w, h: r.h, fill: { color: LIGHT }, line: { color: 'FFFFFF', width: 0 }, rectRadius: 0.04 });
  s.addShape('rect', { x: r.x, y: r.y, w: 0.13, h: r.h, fill: { color } });
  s.addText(text, { x: r.x + 0.35, y: r.y, w: r.w - 0.6, h: r.h, fontSize: 13, color: INK, valign: 'middle', fontFace: FONT });
}

// compact bullet list (for side panels) — items: [string, ...] or [[t,d],...]
function points(s, items, r = AREA) {
  const ih = r.h / items.length;
  items.forEach((it, i) => {
    const y = r.y + i * ih, t = Array.isArray(it) ? it[0] : it, d = Array.isArray(it) ? it[1] : '';
    s.addShape('ellipse', { x: r.x, y: y + 0.1, w: 0.18, h: 0.18, fill: { color: BRAND } });
    s.addText([{ text: t + (d ? '  ' : ''), options: { bold: true, color: INK } }, { text: d || '', options: { color: BODY } }],
      { x: r.x + 0.32, y, w: r.w - 0.4, h: ih - 0.05, fontSize: 12.5, fontFace: FONT, valign: 'top' });
  });
}

// before → after: two boxes + arrow + optional big-number outcome under each.
// left/right: { label, value }  (value optional, shown big)
function beforeAfter(s, left, right, r = AREA) {
  const bw = (r.w - 1.2) / 2, by = r.y + 0.1, bh = Math.min(2.6, r.h - 0.2);
  const box = (x, p, col) => {
    s.addShape('roundRect', { x, y: by, w: bw, h: bh, fill: { color: 'FFFFFF' }, line: { color: col, width: 1.5 }, rectRadius: 0.06, shadow: SHADOW });
    s.addText(p.label, { x: x + 0.2, y: by + 0.25, w: bw - 0.4, h: 0.6, fontSize: 16, bold: true, color: col, align: 'center', fontFace: FONT });
    if (p.value != null) s.addText(String(p.value), { x: x + 0.2, y: by + 0.95, w: bw - 0.4, h: bh - 1.1, fontSize: 40, bold: true, color: col, align: 'center', valign: 'middle', fontFace: FONT });
  };
  box(r.x, left, GREY);
  box(r.x + bw + 1.2, right, BRAND);
  s.addShape('rightArrow', { x: r.x + bw + 0.2, y: by + bh / 2 - 0.35, w: 0.8, h: 0.7, fill: { color: BRAND } });
}

// process flow: chevron steps left→right. steps: [[title, desc], ...]
function processFlow(s, steps, r = AREA) {
  const n = steps.length, gap = 0.18, w = (r.w - gap * (n - 1)) / n, h = Math.min(1.9, r.h), y = r.y + (r.h - h) / 2;
  steps.forEach((st, i) => {
    const x = r.x + i * (w + gap);
    s.addShape(i === n - 1 ? 'roundRect' : 'chevron', { x, y, w: w + (i === n - 1 ? 0 : 0.3), h, fill: { color: i % 2 ? '17A2D6' : BRAND }, rectRadius: 0.04 });
    s.addText(String(i + 1), { x: x + 0.15, y: y + 0.15, w: 0.7, h: 0.5, fontSize: 20, bold: true, color: 'FFFFFF', fontFace: FONT });
    s.addText(st[0], { x: x + 0.15, y: y + 0.62, w: w - 0.5, h: 0.5, fontSize: 14, bold: true, color: 'FFFFFF', fontFace: FONT });
    s.addText(st[1], { x: x + 0.15, y: y + 1.08, w: w - 0.5, h: h - 1.15, fontSize: 10.5, color: 'EAF4FB', fontFace: FONT });
  });
}

// hero stat: one giant number + (optional) supporting points. value, label, points:[[t,d]]
function heroStat(s, value, label, points = [], r = AREA) {
  let L = r;
  if (points && points.length) { const sp = splitH(s, 0.42, 0.5, r); L = sp[0]; numbered(s, points, sp[1]); }
  s.addShape('roundRect', { x: L.x, y: L.y, w: L.w, h: L.h, fill: { color: LIGHT }, line: { color: BRAND, width: 1 }, rectRadius: 0.08, shadow: SHADOW });
  const vsize = String(value).length <= 4 ? 54 : String(value).length <= 6 ? 44 : 34;
  s.addText(String(value), { x: L.x + 0.1, y: L.y + L.h * 0.24, w: L.w - 0.2, h: L.h * 0.42, fontSize: vsize, bold: true, color: BRAND, align: 'center', valign: 'middle', fontFace: FONT, wrap: false });
  s.addText(label, { x: L.x + 0.1, y: L.y + L.h * 0.66, w: L.w - 0.2, h: L.h * 0.26, fontSize: 16, color: BODY, align: 'center', fontFace: FONT });
}

module.exports = {
  init, cover, content, section, closing,
  chart, table, kpiRow, cards, twoPanel, timeline, numbered, lead,
  beforeAfter, processFlow, heroStat, callout, points,
  splitH, splitV, below,
  BRAND, DARK, INK, BODY, GREY, LIGHT, LINE, PANEL, RED, GREEN, AMBER, ACCENTS, FONT, AREA, W, H,
};
