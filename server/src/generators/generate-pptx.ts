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
  heading: string;
  bullets: string[];
}

interface SlideData {
  type: 'title' | 'content' | 'two-column' | 'three-column' | 'section' | 'stats' | 'quote' | 'image';
  title?: string;
  subtitle?: string;
  bullets?: string[];
  text?: string;
  left?: { heading: string; bullets: string[] };
  right?: { heading: string; bullets: string[] };
  columns?: ColumnItem[];
  stats?: StatItem[];
  quote?: string;
  author?: string;
  role?: string;
  imagePath?: string;
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
  if (s.left && s.left.bullets.length > LIMITS.bulletsCompact) {
    s.left = { ...s.left, bullets: s.left.bullets.slice(0, LIMITS.bulletsCompact) };
  }
  if (s.right && s.right.bullets.length > LIMITS.bulletsCompact) {
    s.right = { ...s.right, bullets: s.right.bullets.slice(0, LIMITS.bulletsCompact) };
  }
  if (s.stats && s.stats.length > LIMITS.stats) {
    s.stats = s.stats.slice(0, LIMITS.stats);
  }
  if (s.columns && s.columns.length > LIMITS.columns) {
    s.columns = s.columns.slice(0, LIMITS.columns);
  }
  return s;
}

async function generatePptx(inputPath: string, outputPath: string) {
  const input: PptxInput = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
  const s = STYLES[input.style || ''] || DEFAULT_STYLE;
  const pptx = new PptxGenJS();

  pptx.title = input.title;
  if (input.author) pptx.author = input.author;

  const totalSlides = input.slides.length;
  const presTitle = input.title;

  for (let slideIdx = 0; slideIdx < totalSlides; slideIdx++) {
    const slideData = sanitizeSlide(input.slides[slideIdx]);
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

    switch (slideData.type) {
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

        // Stat cards
        const stats = slideData.stats || [];
        const cardCount = stats.length || 1;
        const cardGap = 0.2;
        const totalCardWidth = 8.6; // inches usable
        const cardW = (totalCardWidth - cardGap * (cardCount - 1)) / cardCount;
        const cardY = 1.5;
        const cardH = 1.7;

        for (let ci = 0; ci < stats.length; ci++) {
          const stat = stats[ci];
          const cardX = 0.7 + ci * (cardW + cardGap);
          const color = stat.color?.replace('#', '') || STAT_COLORS[ci % STAT_COLORS.length];

          // Card background (white)
          slide.addShape(pptx.ShapeType.rect, {
            x: cardX, y: cardY, w: cardW, h: cardH,
            fill: { color: 'FFFFFF' },
            shadow: { type: 'outer', blur: 6, offset: 2, color: '000000', opacity: 0.1 },
            rectRadius: 0.05,
          });
          // Colored top border
          slide.addShape(pptx.ShapeType.rect, {
            x: cardX, y: cardY, w: cardW, h: 0.06,
            fill: { color },
            rectRadius: 0.05,
          });
          // Value (big number)
          slide.addText(stat.value, {
            x: cardX, y: cardY + 0.2, w: cardW, h: 0.65,
            fontSize: 36, bold: true, align: 'center',
            color, fontFace: s.fontFace,
          });
          // Unit (small text under number)
          if (stat.unit) {
            slide.addText(stat.unit, {
              x: cardX, y: cardY + 0.8, w: cardW, h: 0.3,
              fontSize: 12, align: 'center',
              color: '999999', fontFace: s.fontFace,
            });
          }
          // Label
          slide.addText(stat.label, {
            x: cardX, y: cardY + (stat.unit ? 1.1 : 0.9), w: cardW, h: 0.4,
            fontSize: 13, bold: true, align: 'center',
            color: s.bodyColor, fontFace: s.fontFace,
          });
        }

        // Optional bullet summary below stats
        if (slideData.bullets && slideData.bullets.length > 0) {
          const bulletY = cardY + cardH + 0.35;
          // Summary card background
          slide.addShape(pptx.ShapeType.rect, {
            x: 0.7, y: bulletY, w: totalCardWidth, h: 2.6,
            fill: { color: 'FFFFFF' },
            shadow: { type: 'outer', blur: 4, offset: 1, color: '000000', opacity: 0.08 },
            rectRadius: 0.05,
          });
          // Bullets
          slide.addText(
            slideData.bullets.map(b => ({
              text: b,
              options: {
                bullet: { type: 'bullet' as const, style: '●' },
                breakLine: true,
                color: s.bodyColor,
              },
            })),
            {
              x: 0.9, y: bulletY + 0.15, w: totalCardWidth - 0.4, h: 2.3,
              fontSize: 14, color: s.bodyColor,
              fontFace: s.fontFace, lineSpacingMultiple: 1.6,
              autoFit: true,
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
        // Left column panel
        if (slideData.left) {
          slide.addShape(pptx.ShapeType.rect, {
            x: '4%', y: '18%', w: '44%', h: '67%',
            fill: { color: s.accentColor2 },
            rectRadius: 0.08,
          });
          slide.addText(slideData.left.heading, {
            x: '6%', y: '20%', w: '40%', h: '7%',
            fontSize: 20, bold: true, color: s.headingColor,
            fontFace: s.fontFace,
          });
          slide.addText(
            slideData.left.bullets.map(b => ({ text: b, options: { bullet: true, breakLine: true } })),
            {
              x: '6%', y: '28%', w: '40%', h: '55%',
              fontSize: s.bodyFontSize, color: s.bodyColor,
              fontFace: s.fontFace, lineSpacingMultiple: 1.4,
              autoFit: true,
            }
          );
        }
        // Right column panel
        if (slideData.right) {
          slide.addShape(pptx.ShapeType.rect, {
            x: '52%', y: '18%', w: '44%', h: '67%',
            fill: { color: s.accentColor2 },
            rectRadius: 0.08,
          });
          slide.addText(slideData.right.heading, {
            x: '54%', y: '20%', w: '40%', h: '7%',
            fontSize: 20, bold: true, color: s.headingColor,
            fontFace: s.fontFace,
          });
          slide.addText(
            slideData.right.bullets.map(b => ({ text: b, options: { bullet: true, breakLine: true } })),
            {
              x: '54%', y: '28%', w: '40%', h: '55%',
              fontSize: s.bodyFontSize, color: s.bodyColor,
              fontFace: s.fontFace, lineSpacingMultiple: 1.4,
              autoFit: true,
            }
          );
        }
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
          slide.addText(col.heading, {
            x: colX + 0.2, y: 1.65, w: colW - 0.4, h: 0.4,
            fontSize: 17, bold: true, color: s.headingColor,
            fontFace: s.fontFace,
          });
          // Column bullets
          slide.addText(
            col.bullets.slice(0, 5).map(b => ({ text: b, options: { bullet: true, breakLine: true } })),
            {
              x: colX + 0.2, y: 2.2, w: colW - 0.4, h: 3.3,
              fontSize: 14, color: s.bodyColor,
              fontFace: s.fontFace, lineSpacingMultiple: 1.4,
              autoFit: true,
            }
          );
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
