#!/usr/bin/env node
/**
 * PPTX Generator Script
 * Usage: node --import tsx generate-pptx.ts <input.json> <output.pptx>
 *
 * Input JSON format:
 * {
 *   "title": "Presentation Title",
 *   "author": "Author Name",
 *   "style": "minimal-pro" | "tech-dark" | "corporate" | "creative",
 *   "slides": [
 *     { "type": "title", "title": "...", "subtitle": "..." },
 *     { "type": "content", "title": "...", "subtitle": "...", "bullets": ["..."] },
 *     { "type": "two-column", "title": "...", "left": {...}, "right": {...} },
 *     { "type": "section", "title": "..." },
 *     { "type": "stats", "title": "...", "subtitle": "...", "stats": [...], "bullets": [...] },
 *     { "type": "three-column", "title": "...", "columns": [...] },
 *     { "type": "quote", "quote": "...", "author": "...", "role": "..." },
 *     { "type": "image", "title": "...", "imagePath": "..." }
 *   ]
 * }
 */

import PptxGenJSModule from 'pptxgenjs';
import fs from 'fs';

// Handle ESM/CJS interop - pptxgenjs may double-wrap the default export
const PptxGenJS = (PptxGenJSModule as unknown as { default?: typeof PptxGenJSModule }).default || PptxGenJSModule;

// ── Stat card colors (used for stats slide) ──────────────────
const STAT_COLORS = ['2B6CB0', 'E84855', '38A169', 'D69E2E', '805AD5', 'DD6B20'];

// ── Style Presets ──────────────────────────────────────────────
interface StylePreset {
  bg: string;
  titleSlideBg: string;
  sectionSlideBg: string;
  titleColor: string;
  titleSlideTextColor: string;
  subtitleColor: string;
  headingColor: string;
  bodyColor: string;
  accentColor: string;
  accentColor2: string;
  topBarColor: string;          // thin accent bar at very top of content slides
  titleFontSize: number;
  headingFontSize: number;
  bodyFontSize: number;
  fontFace?: string;
  sidebarWidth: number;
  showFooter: boolean;
  showSidebar: boolean;
  showTopBar: boolean;          // thin colored bar at top of content slides
}

const STYLES: Record<string, StylePreset> = {
  'minimal-pro': {
    bg: 'FFFFFF', titleSlideBg: 'FFFFFF', sectionSlideBg: 'F5F5F5',
    titleColor: '2D2D2D', titleSlideTextColor: '2D2D2D',
    subtitleColor: '999999', headingColor: '333333',
    bodyColor: '555555', accentColor: 'BBBBBB', accentColor2: 'F5F5F5',
    topBarColor: 'BBBBBB',
    titleFontSize: 36, headingFontSize: 26, bodyFontSize: 17,
    sidebarWidth: 0, showFooter: false, showSidebar: false, showTopBar: false,
  },
  'tech-dark': {
    bg: '0F0F23', titleSlideBg: '080818', sectionSlideBg: '0A0A1E',
    titleColor: '00F0FF', titleSlideTextColor: '00F0FF',
    subtitleColor: '8888AA', headingColor: 'E0E0FF',
    bodyColor: 'AAAACC', accentColor: '00F0FF', accentColor2: '1A1A3E',
    topBarColor: '00F0FF',
    titleFontSize: 38, headingFontSize: 28, bodyFontSize: 17,
    fontFace: 'Consolas',
    sidebarWidth: 0, showFooter: true, showSidebar: false, showTopBar: true,
  },
  'corporate': {
    bg: 'F8F9FC', titleSlideBg: '1B2A4A', sectionSlideBg: '1B2A4A',
    titleColor: '1B2A4A', titleSlideTextColor: 'FFFFFF',
    subtitleColor: 'A0B4D0', headingColor: '1B2A4A',
    bodyColor: '3D3D3D', accentColor: '2B6CB0', accentColor2: 'EDF2F8',
    topBarColor: 'E84855',
    titleFontSize: 36, headingFontSize: 26, bodyFontSize: 17,
    sidebarWidth: 0, showFooter: true, showSidebar: false, showTopBar: true,
  },
  'creative': {
    bg: 'FFF8F0', titleSlideBg: '2D2B55', sectionSlideBg: '2D2B55',
    titleColor: 'E84855', titleSlideTextColor: 'FFFFFF',
    subtitleColor: 'C8B0FF', headingColor: '2D2B55',
    bodyColor: '444444', accentColor: 'FF6B35', accentColor2: 'FFF0E6',
    topBarColor: 'FF6B35',
    titleFontSize: 40, headingFontSize: 28, bodyFontSize: 17,
    sidebarWidth: 0, showFooter: true, showSidebar: false, showTopBar: true,
  },
};

const DEFAULT_STYLE = STYLES['corporate'];

// ── Types ──────────────────────────────────────────────────────
interface StatItem {
  value: string;
  unit?: string;
  label: string;
  color?: string;
}

interface ColumnItem {
  heading?: string;
  title?: string;       // agent uses `title` for column/pane headings
  bullets?: string[];
  chart?: ChartItem;    // a column/pane may hold a chart instead of bullets
}

interface KpiItem {
  value: string;
  label: string;
  unit?: string;
  color?: string;
}

interface ChartItem {
  kind?: string;   // bar | line | area | pie | donut (agent uses `kind`)
  type?: string;   // some data uses `type` instead — accept both
  title?: string;
  labels?: string[];
  values?: number[];
  slices?: { label: string; value: number; color?: string }[];
  bars?: { label: string; value: number; color?: string }[];
  colors?: string[];
}

interface SlideData {
  // Kept as a free string: the agent emits many type variants (and underscore
  // vs hyphen spellings). We normalize before switching.
  type: string;
  title?: string;
  subtitle?: string;
  bullets?: string[];
  text?: string;
  left?: ColumnItem;
  right?: ColumnItem;
  columns?: ColumnItem[];
  stats?: StatItem[];
  kpis?: KpiItem[];        // agent's stats slides use `kpis`
  charts?: ChartItem[];    // 0–2 charts under a stats slide
  chart?: ChartItem;       // standalone chart slide
  quote?: string;
  author?: string;
  role?: string;
  imagePath?: string;
  // Per-slide style overrides (set by block regenerator AI)
  backgroundColor?: string;
  textColor?: string;
  titleColor?: string;
  subtitleColor?: string;
  accentColor?: string;
  accentColor2?: string;
}

/** Merge per-slide color overrides into the global style preset */
function resolveSlideStyle(base: StylePreset, slide: SlideData): StylePreset {
  const hasOverride = slide.backgroundColor || slide.textColor || slide.titleColor ||
    slide.subtitleColor || slide.accentColor || slide.accentColor2;
  if (!hasOverride) return base;

  const strip = (c?: string) => c?.replace('#', '') || '';
  const bg = strip(slide.backgroundColor) || base.bg;
  const accent = strip(slide.accentColor) || base.accentColor;
  const heading = strip(slide.titleColor) || base.headingColor;
  const body = strip(slide.textColor) || base.bodyColor;
  const subtitle = strip(slide.subtitleColor) || base.subtitleColor;
  const accent2 = strip(slide.accentColor2) || base.accentColor2;

  // Determine if the overridden bg is dark (for title/section slide text)
  const isDark = parseInt(bg.substring(0, 2), 16) < 100;
  const lightText = isDark ? 'FFFFFF' : heading;

  return {
    ...base,
    bg,
    titleSlideBg: isDark ? bg : base.titleSlideBg,
    sectionSlideBg: isDark ? bg : base.sectionSlideBg,
    titleColor: heading,
    titleSlideTextColor: lightText,
    subtitleColor: subtitle,
    headingColor: heading,
    bodyColor: body,
    accentColor: accent,
    accentColor2: accent2,
    topBarColor: accent,
  };
}

interface PptxInput {
  title: string;
  author?: string;
  style?: string;
  slides: SlideData[];
}

// ── Content Limits (prevent overflow in .pptx) ────────────────
const LIMITS = { bullets: 6, bulletsCompact: 4, stats: 4, columns: 3 };

function sanitizeSlide(slide: SlideData): SlideData {
  const s = { ...slide };
  if (s.bullets && s.bullets.length > LIMITS.bullets) {
    s.bullets = s.bullets.slice(0, LIMITS.bullets);
  }
  if (s.left?.bullets && s.left.bullets.length > LIMITS.bulletsCompact) {
    s.left = { ...s.left, bullets: s.left.bullets.slice(0, LIMITS.bulletsCompact) };
  }
  if (s.right?.bullets && s.right.bullets.length > LIMITS.bulletsCompact) {
    s.right = { ...s.right, bullets: s.right.bullets.slice(0, LIMITS.bulletsCompact) };
  }
  if (s.stats && s.stats.length > LIMITS.stats) {
    s.stats = s.stats.slice(0, LIMITS.stats);
  }
  if (s.kpis && s.kpis.length > LIMITS.stats) {
    s.kpis = s.kpis.slice(0, LIMITS.stats);
  }
  if (s.columns && s.columns.length > LIMITS.columns) {
    s.columns = s.columns.slice(0, LIMITS.columns);
  }
  return s;
}

async function generatePptx(inputPath: string, outputPath: string) {
  const input: PptxInput = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
  const baseStyle = STYLES[input.style || ''] || DEFAULT_STYLE;
  const pptx = new PptxGenJS();

  pptx.title = input.title;
  if (input.author) pptx.author = input.author;

  const totalSlides = input.slides.length;
  const presTitle = input.title;

  for (let slideIdx = 0; slideIdx < totalSlides; slideIdx++) {
    const slideData = sanitizeSlide(input.slides[slideIdx]);
    const s = resolveSlideStyle(baseStyle, slideData); // per-slide style with overrides
    const slide = pptx.addSlide();

    // ── Helper: top accent bar ──
    const addTopBar = () => {
      if (!s.showTopBar) return;
      slide.addShape(pptx.ShapeType.rect, {
        x: 0, y: 0, w: '100%', h: 0.06,
        fill: { color: s.topBarColor },
      });
    };

    // ── Helper: footer bar with title + page number ──
    const addFooter = () => {
      if (!s.showFooter) return;
      slide.addShape(pptx.ShapeType.rect, {
        x: 0, y: '93%', w: '100%', h: '7%',
        fill: { color: s.titleSlideBg },
      });
      slide.addText(presTitle, {
        x: '3%', y: '93.8%', w: '70%', h: '5%',
        fontSize: 9, color: 'FFFFFF', align: 'left',
        fontFace: s.fontFace,
      });
      slide.addText(`${slideIdx + 1} / ${totalSlides}`, {
        x: '80%', y: '93.8%', w: '17%', h: '5%',
        fontSize: 9, color: 'FFFFFF', align: 'right',
        fontFace: s.fontFace,
      });
    };

    // ── Helper: deterministic native chart (pptxgenjs addChart) ──
    // Renders bar/line/area/pie/donut from {kind|type, labels, values} (or
    // slices/bars). This is what makes chart edits reliable — the type is
    // honored exactly, no AI re-invention.
    const CHART_TYPE_MAP: Record<string, string> = {
      bar: pptx.ChartType.bar, column: pptx.ChartType.bar,
      line: pptx.ChartType.line, area: pptx.ChartType.area,
      pie: pptx.ChartType.pie, donut: pptx.ChartType.doughnut, doughnut: pptx.ChartType.doughnut,
    };
    const renderChart = (chart: ChartItem, box: { x: number; y: number; w: number; h: number }) => {
      const kind = String(chart.kind || chart.type || 'bar').toLowerCase();
      const ctype = CHART_TYPE_MAP[kind] || pptx.ChartType.bar;
      const items = chart.slices || chart.bars;
      const labels = chart.labels || items?.map(i => i.label) || [];
      const values = chart.values || items?.map(i => i.value) || [];
      if (!labels.length || !values.length) return;
      const circular = ctype === pptx.ChartType.pie || ctype === pptx.ChartType.doughnut;
      const palette = (chart.colors && chart.colors.length ? chart.colors : STAT_COLORS).map(c => c.replace('#', ''));
      slide.addChart(ctype as any, [{ name: chart.title || 'Series', labels, values }], {
        x: box.x, y: box.y, w: box.w, h: box.h,
        chartColors: palette,
        showTitle: !!chart.title, title: chart.title || '', titleFontSize: 11, titleColor: s.headingColor,
        showLegend: circular, legendPos: 'r', legendFontSize: 9, legendColor: s.bodyColor,
        showValue: false,
        showPercent: circular,
        dataLabelColor: circular ? 'FFFFFF' : s.bodyColor, dataLabelFontSize: 9,
        catAxisLabelColor: s.bodyColor, catAxisLabelFontSize: 9,
        valAxisLabelColor: s.bodyColor, valAxisLabelFontSize: 9,
        valGridLine: { style: 'none' },
        barDir: 'col',
        holeSize: kind === 'donut' || kind === 'doughnut' ? 55 : undefined,
        chartColorsOpacity: 95,
      } as any);
    };

    // Normalize type: agent emits underscore variants (two_column) and many
    // spellings; map to the canonical hyphen form the switch uses.
    const ntype = String(slideData.type || 'content').replace(/_/g, '-');

    switch (ntype) {
      // ═══════════════════════════════════════════════════════
      // TITLE SLIDE — dark bg, centered, decorative lines
      // ═══════════════════════════════════════════════════════
      case 'title': {
        slide.background = { color: s.titleSlideBg };
        // Top-right accent bar
        slide.addShape(pptx.ShapeType.rect, {
          x: '70%', y: 0, w: '30%', h: 0.08,
          fill: { color: s.accentColor },
        });
        // Bottom-left accent bar
        slide.addShape(pptx.ShapeType.rect, {
          x: 0, y: '92%', w: '35%', h: 0.08,
          fill: { color: s.accentColor },
        });
        // Title
        slide.addText(slideData.title || '', {
          x: '8%', y: '25%', w: '84%', h: '25%',
          fontSize: s.titleFontSize, bold: true, align: 'center',
          color: s.titleSlideTextColor, fontFace: s.fontFace,
        });
        // Accent divider
        slide.addShape(pptx.ShapeType.rect, {
          x: '30%', y: '53%', w: '40%', h: 0.06,
          fill: { color: s.accentColor },
        });
        // Subtitle
        if (slideData.subtitle) {
          slide.addText(slideData.subtitle, {
            x: '10%', y: '57%', w: '80%', h: '12%',
            fontSize: 20, align: 'center', color: s.subtitleColor,
            fontFace: s.fontFace,
          });
        }
        break;
      }

      // ═══════════════════════════════════════════════════════
      // SECTION DIVIDER — dark bg, centered text
      // ═══════════════════════════════════════════════════════
      case 'section': {
        slide.background = { color: s.sectionSlideBg };
        slide.addShape(pptx.ShapeType.rect, {
          x: 0, y: '46%', w: '7%', h: 0.06,
          fill: { color: s.accentColor },
        });
        slide.addShape(pptx.ShapeType.rect, {
          x: '93%', y: '54%', w: '7%', h: 0.06,
          fill: { color: s.accentColor },
        });
        slide.addText(slideData.title || '', {
          x: '10%', y: '30%', w: '80%', h: '40%',
          fontSize: s.headingFontSize + 6, bold: true, align: 'center',
          color: s.titleSlideTextColor, fontFace: s.fontFace,
        });
        break;
      }

      // ═══════════════════════════════════════════════════════
      // STATS SLIDE — title/subtitle + stat cards + optional bullets
      // ═══════════════════════════════════════════════════════
      case 'stats': {
        slide.background = { color: s.bg };
        addTopBar();

        // Title + subtitle (top-left)
        const titleY = 0.4;
        if (slideData.title) {
          slide.addText(slideData.title, {
            x: '5%', y: titleY, w: '90%', h: 0.5,
            fontSize: s.headingFontSize, bold: true, color: s.headingColor,
            fontFace: s.fontFace,
          });
        }
        if (slideData.subtitle) {
          slide.addText(slideData.subtitle, {
            x: '5%', y: titleY + 0.5, w: '90%', h: 0.35,
            fontSize: 16, color: s.accentColor,
            fontFace: s.fontFace,
          });
        }

        // KPI cards — agent slides use `kpis`; older data used `stats`.
        const kpis = (slideData.kpis || slideData.stats || []) as KpiItem[];
        const hasCharts = !!(slideData.charts && slideData.charts.length);
        const cardCount = kpis.length || 1;
        const cardGap = 0.2;
        const totalCardWidth = 8.6; // inches usable
        const cardW = (totalCardWidth - cardGap * (cardCount - 1)) / cardCount;
        const cardY = 1.5;
        // Compact cards when charts share the slide so nothing overflows.
        const cardH = hasCharts ? 1.2 : 1.7;

        for (let ci = 0; ci < kpis.length; ci++) {
          const stat = kpis[ci];
          const cardX = 0.7 + ci * (cardW + cardGap);
          const color = stat.color?.replace('#', '') || STAT_COLORS[ci % STAT_COLORS.length];

          slide.addShape(pptx.ShapeType.rect, {
            x: cardX, y: cardY, w: cardW, h: cardH,
            fill: { color: 'FFFFFF' },
            shadow: { type: 'outer', blur: 6, offset: 2, color: '000000', opacity: 0.1 },
            rectRadius: 0.05,
          });
          slide.addShape(pptx.ShapeType.rect, {
            x: cardX, y: cardY, w: cardW, h: 0.06, fill: { color }, rectRadius: 0.05,
          });
          slide.addText(stat.value, {
            x: cardX, y: cardY + 0.16, w: cardW, h: hasCharts ? 0.5 : 0.65,
            fontSize: hasCharts ? 26 : 36, bold: true, align: 'center', color, fontFace: s.fontFace,
          });
          if (stat.unit) {
            slide.addText(stat.unit, {
              x: cardX, y: cardY + (hasCharts ? 0.6 : 0.8), w: cardW, h: 0.3,
              fontSize: 12, align: 'center', color: '999999', fontFace: s.fontFace,
            });
          }
          slide.addText(stat.label, {
            x: cardX, y: cardY + (hasCharts ? (stat.unit ? 0.88 : 0.7) : (stat.unit ? 1.1 : 0.9)), w: cardW, h: 0.4,
            fontSize: hasCharts ? 11 : 13, bold: true, align: 'center', color: s.bodyColor, fontFace: s.fontFace,
          });
        }

        // Charts (0–2) below the KPI cards — deterministic, honors each chart's kind.
        if (hasCharts) {
          const charts = slideData.charts!.slice(0, 2);
          const chartsY = cardY + cardH + 0.3;
          const chartH = Math.max(1.6, 4.95 - chartsY); // keep above the footer
          const cgap = 0.4;
          const chartW = charts.length > 1 ? (totalCardWidth - cgap) / 2 : totalCardWidth;
          charts.forEach((c, i) => renderChart(c, { x: 0.7 + i * (chartW + cgap), y: chartsY, w: chartW, h: chartH }));
        } else if (slideData.bullets && slideData.bullets.length > 0) {
          const bulletY = cardY + cardH + 0.35;
          slide.addShape(pptx.ShapeType.rect, {
            x: 0.7, y: bulletY, w: totalCardWidth, h: 2.6,
            fill: { color: 'FFFFFF' },
            shadow: { type: 'outer', blur: 4, offset: 1, color: '000000', opacity: 0.08 },
            rectRadius: 0.05,
          });
          slide.addText(
            slideData.bullets.map(b => ({
              text: b,
              options: { bullet: { type: 'bullet' as const, style: '●' }, breakLine: true, color: s.bodyColor },
            })),
            {
              x: 0.9, y: bulletY + 0.15, w: totalCardWidth - 0.4, h: 2.3,
              fontSize: 14, color: s.bodyColor, fontFace: s.fontFace, lineSpacingMultiple: 1.6, autoFit: true,
            }
          );
        }

        addFooter();
        break;
      }

      // ═══════════════════════════════════════════════════════
      // CONTENT SLIDE — title + subtitle + bullets/text
      // ═══════════════════════════════════════════════════════
      case 'content': {
        slide.background = { color: s.bg };
        addTopBar();

        let headingBottom = 0;
        if (slideData.title) {
          slide.addText(slideData.title, {
            x: '5%', y: '4%', w: '90%', h: '10%',
            fontSize: s.headingFontSize, bold: true, color: s.headingColor,
            fontFace: s.fontFace,
          });
          headingBottom = 0.14;
          // Accent underline
          slide.addShape(pptx.ShapeType.rect, {
            x: '5%', y: headingBottom, w: 1.5, h: 0.04,
            fill: { color: s.accentColor },
          });
        }
        if (slideData.subtitle) {
          slide.addText(slideData.subtitle, {
            x: '5%', y: headingBottom + 0.01, w: '90%', h: '6%',
            fontSize: 15, color: s.accentColor,
            fontFace: s.fontFace,
          });
          headingBottom += 0.06;
        }

        const contentYPct = headingBottom > 0 ? `${Math.round((headingBottom + 0.06) * 100)}%` : '18%';

        if (slideData.bullets) {
          slide.addText(
            slideData.bullets.map(b => ({ text: b, options: { bullet: true, breakLine: true } })),
            {
              x: '5%', y: contentYPct as unknown as number, w: '90%', h: '65%',
              fontSize: s.bodyFontSize, color: s.bodyColor,
              fontFace: s.fontFace, lineSpacingMultiple: 1.4,
              autoFit: true,
            }
          );
        }
        if (slideData.text) {
          slide.addText(slideData.text, {
            x: '5%', y: contentYPct as unknown as number, w: '90%', h: '65%',
            fontSize: s.bodyFontSize, color: s.bodyColor,
            fontFace: s.fontFace, autoFit: true,
          });
        }
        addFooter();
        break;
      }

      // ═══════════════════════════════════════════════════════
      // TWO-COLUMN — title + two card panels
      // ═══════════════════════════════════════════════════════
      case 'two-column': {
        slide.background = { color: s.bg };
        addTopBar();

        if (slideData.title) {
          slide.addText(slideData.title, {
            x: '5%', y: '4%', w: '90%', h: '10%',
            fontSize: s.headingFontSize, bold: true, color: s.headingColor,
            fontFace: s.fontFace,
          });
          slide.addShape(pptx.ShapeType.rect, {
            x: '5%', y: '14%', w: 1.5, h: 0.04,
            fill: { color: s.accentColor },
          });
        }
        // Column pane renderer: heading + (chart OR bullets). xPct is the panel
        // left edge in %; chartBox is the inch-based area for a chart.
        const renderPane = (pane: ColumnItem, xPct: string, headXPct: string, chartBox: { x: number; y: number; w: number; h: number }) => {
          slide.addShape(pptx.ShapeType.rect, {
            x: xPct as any, y: '18%', w: '44%', h: '67%', fill: { color: s.accentColor2 }, rectRadius: 0.08,
          });
          const head = pane.heading || pane.title || '';
          if (head) {
            slide.addText(head, {
              x: headXPct as any, y: '20%', w: '40%', h: '7%',
              fontSize: 20, bold: true, color: s.headingColor, fontFace: s.fontFace,
            });
          }
          if (pane.chart) {
            renderChart(pane.chart, chartBox);
          } else if (pane.bullets) {
            slide.addText(
              pane.bullets.map(b => ({ text: b, options: { bullet: true, breakLine: true } })),
              {
                x: headXPct as any, y: '28%', w: '40%', h: '55%',
                fontSize: s.bodyFontSize, color: s.bodyColor, fontFace: s.fontFace,
                lineSpacingMultiple: 1.4, autoFit: true,
              }
            );
          }
        };
        if (slideData.left) renderPane(slideData.left, '4%', '6%', { x: 0.55, y: 1.75, w: 4.0, h: 2.8 });
        if (slideData.right) renderPane(slideData.right, '52%', '54%', { x: 5.35, y: 1.75, w: 4.0, h: 2.8 });
        addFooter();
        break;
      }

      // ═══════════════════════════════════════════════════════
      // THREE-COLUMN — title + three card panels
      // ═══════════════════════════════════════════════════════
      case 'three-column': {
        slide.background = { color: s.bg };
        addTopBar();

        if (slideData.title) {
          slide.addText(slideData.title, {
            x: '5%', y: '4%', w: '90%', h: '10%',
            fontSize: s.headingFontSize, bold: true, color: s.headingColor,
            fontFace: s.fontFace,
          });
          slide.addShape(pptx.ShapeType.rect, {
            x: '5%', y: '14%', w: 1.5, h: 0.04,
            fill: { color: s.accentColor },
          });
        }

        const cols = slideData.columns || [];
        const colColors = [s.accentColor, '38A169', 'D69E2E'];
        for (let ci = 0; ci < Math.min(cols.length, 3); ci++) {
          const col = cols[ci];
          const colX = 0.5 + ci * 3.2;
          const colW = 2.9;

          // Card panel
          slide.addShape(pptx.ShapeType.rect, {
            x: colX, y: 1.4, w: colW, h: 4.3,
            fill: { color: 'FFFFFF' },
            shadow: { type: 'outer', blur: 4, offset: 1, color: '000000', opacity: 0.08 },
            rectRadius: 0.08,
          });
          // Colored top strip
          slide.addShape(pptx.ShapeType.rect, {
            x: colX, y: 1.4, w: colW, h: 0.06,
            fill: { color: colColors[ci] },
            rectRadius: 0.08,
          });
          // Column heading
          const colHead = col.heading || col.title || '';
          if (colHead) {
            slide.addText(colHead, {
              x: colX + 0.2, y: 1.65, w: colW - 0.4, h: 0.4,
              fontSize: 17, bold: true, color: s.headingColor, fontFace: s.fontFace,
            });
          }
          // Column content: chart or bullets
          if (col.chart) {
            renderChart(col.chart, { x: colX + 0.15, y: 2.2, w: colW - 0.3, h: 3.0 });
          } else if (col.bullets) {
            slide.addText(
              col.bullets.slice(0, 5).map(b => ({ text: b, options: { bullet: true, breakLine: true } })),
              {
                x: colX + 0.2, y: 2.2, w: colW - 0.4, h: 3.3,
                fontSize: 14, color: s.bodyColor, fontFace: s.fontFace,
                lineSpacingMultiple: 1.4, autoFit: true,
              }
            );
          }
        }
        addFooter();
        break;
      }

      // ═══════════════════════════════════════════════════════
      // QUOTE SLIDE — centered quote with attribution
      // ═══════════════════════════════════════════════════════
      case 'quote': {
        slide.background = { color: s.bg };
        addTopBar();

        // Large quote mark
        slide.addText('\u201C', {
          x: '10%', y: '12%', w: '10%', h: '18%',
          fontSize: 72, color: s.accentColor,
          fontFace: s.fontFace, bold: true,
        });
        // Quote text
        slide.addText(slideData.quote || '', {
          x: '10%', y: '28%', w: '80%', h: '35%',
          fontSize: 22, italic: true, align: 'center',
          color: s.headingColor, fontFace: s.fontFace,
          lineSpacingMultiple: 1.5,
        });
        // Accent divider
        slide.addShape(pptx.ShapeType.rect, {
          x: '40%', y: '65%', w: '20%', h: 0.04,
          fill: { color: s.accentColor },
        });
        // Attribution
        if (slideData.author) {
          const attribution = slideData.role
            ? `${slideData.author}\n${slideData.role}`
            : slideData.author;
          slide.addText(attribution, {
            x: '15%', y: '68%', w: '70%', h: '14%',
            fontSize: 16, align: 'center',
            color: s.bodyColor, fontFace: s.fontFace,
          });
        }
        addFooter();
        break;
      }

      // ═══════════════════════════════════════════════════════
      // CHART SLIDE — title + one full-width chart
      // ═══════════════════════════════════════════════════════
      case 'chart': {
        slide.background = { color: s.bg };
        addTopBar();
        if (slideData.title) {
          slide.addText(slideData.title, {
            x: '5%', y: 0.4, w: '90%', h: 0.6,
            fontSize: s.headingFontSize, bold: true, color: s.headingColor, fontFace: s.fontFace,
          });
        }
        const chart = slideData.chart || (slideData.charts && slideData.charts[0]);
        if (chart) renderChart(chart, { x: 0.7, y: 1.5, w: 8.6, h: 3.4 });
        addFooter();
        break;
      }

      // ═══════════════════════════════════════════════════════
      // FALLBACK — unknown type: render title + bullets/text so it's never blank
      // ═══════════════════════════════════════════════════════
      default: {
        slide.background = { color: s.bg };
        addTopBar();
        if (slideData.title) {
          slide.addText(slideData.title, {
            x: '5%', y: 0.4, w: '90%', h: 0.6,
            fontSize: s.headingFontSize, bold: true, color: s.headingColor, fontFace: s.fontFace,
          });
        }
        if (slideData.bullets && slideData.bullets.length) {
          slide.addText(
            slideData.bullets.map(b => ({ text: b, options: { bullet: { type: 'bullet' as const, style: '●' }, breakLine: true } })),
            { x: '6%', y: 1.4, w: '88%', h: 3.6, fontSize: s.bodyFontSize, color: s.bodyColor, fontFace: s.fontFace, lineSpacingMultiple: 1.5, autoFit: true },
          );
        } else if (slideData.text) {
          slide.addText(slideData.text, {
            x: '6%', y: 1.4, w: '88%', h: 3.6,
            fontSize: s.bodyFontSize, color: s.bodyColor, fontFace: s.fontFace, lineSpacingMultiple: 1.5,
          });
        }
        addFooter();
        break;
      }
    }
  }

  await pptx.writeFile({ fileName: outputPath });
  console.log(`PPTX generated: ${outputPath}`);
}

// CLI entry point
const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  console.error('Usage: generate-pptx.ts <input.json> <output.pptx>');
  process.exit(1);
}
generatePptx(inputPath, outputPath).catch(err => {
  console.error('Failed to generate PPTX:', err);
  process.exit(1);
});
