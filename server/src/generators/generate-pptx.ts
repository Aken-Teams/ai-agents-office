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
 *     { "type": "content", "title": "...", "bullets": ["..."] },
 *     { "type": "two-column", "title": "...", "left": {...}, "right": {...} },
 *     { "type": "section", "title": "..." },
 *     { "type": "image", "title": "...", "imagePath": "..." }
 *   ]
 * }
 */

import PptxGenJSModule from 'pptxgenjs';
import fs from 'fs';

// Handle ESM/CJS interop - pptxgenjs may double-wrap the default export
const PptxGenJS = (PptxGenJSModule as unknown as { default?: typeof PptxGenJSModule }).default || PptxGenJSModule;

// ── Style Presets ──────────────────────────────────────────────
interface StylePreset {
  bg: string;
  titleSlideBg: string;        // distinct background for title & section slides
  sectionSlideBg: string;      // section divider background
  titleColor: string;
  titleSlideTextColor: string;  // text on title slide (over dark bg)
  subtitleColor: string;
  headingColor: string;
  bodyColor: string;
  accentColor: string;
  accentColor2: string;        // secondary accent
  titleFontSize: number;
  headingFontSize: number;
  bodyFontSize: number;
  fontFace?: string;
  sidebarWidth: number;        // left accent sidebar width (inches)
  showFooter: boolean;         // slide number footer
  showSidebar: boolean;        // left accent sidebar on content slides
}

const STYLES: Record<string, StylePreset> = {
  'minimal-pro': {
    bg: 'FFFFFF', titleSlideBg: 'FFFFFF', sectionSlideBg: 'F5F5F5',
    titleColor: '2D2D2D', titleSlideTextColor: '2D2D2D',
    subtitleColor: '999999', headingColor: '333333',
    bodyColor: '555555', accentColor: 'BBBBBB', accentColor2: 'E0E0E0',
    titleFontSize: 36, headingFontSize: 26, bodyFontSize: 17,
    sidebarWidth: 0, showFooter: false, showSidebar: false,
  },
  'tech-dark': {
    bg: '0F0F23', titleSlideBg: '080818', sectionSlideBg: '0A0A1E',
    titleColor: '00F0FF', titleSlideTextColor: '00F0FF',
    subtitleColor: '8888AA', headingColor: 'E0E0FF',
    bodyColor: 'AAAACC', accentColor: '00F0FF', accentColor2: '7B68EE',
    titleFontSize: 38, headingFontSize: 28, bodyFontSize: 17,
    fontFace: 'Consolas',
    sidebarWidth: 0.12, showFooter: true, showSidebar: true,
  },
  'corporate': {
    bg: 'F8F9FC', titleSlideBg: '1B2A4A', sectionSlideBg: '1B2A4A',
    titleColor: '1B2A4A', titleSlideTextColor: 'FFFFFF',
    subtitleColor: 'A0B4D0', headingColor: '1B2A4A',
    bodyColor: '3D3D3D', accentColor: '2B6CB0', accentColor2: 'E8EDF5',
    titleFontSize: 36, headingFontSize: 26, bodyFontSize: 17,
    sidebarWidth: 0.15, showFooter: true, showSidebar: true,
  },
  'creative': {
    bg: 'FFF8F0', titleSlideBg: '2D2B55', sectionSlideBg: '2D2B55',
    titleColor: 'E84855', titleSlideTextColor: 'FFFFFF',
    subtitleColor: 'C8B0FF', headingColor: '2D2B55',
    bodyColor: '444444', accentColor: 'FF6B35', accentColor2: 'FFE8D6',
    titleFontSize: 40, headingFontSize: 28, bodyFontSize: 17,
    sidebarWidth: 0.12, showFooter: true, showSidebar: true,
  },
};

const DEFAULT_STYLE = STYLES['corporate'];

// ── Types ──────────────────────────────────────────────────────
interface SlideData {
  type: 'title' | 'content' | 'two-column' | 'section' | 'image';
  title?: string;
  subtitle?: string;
  bullets?: string[];
  text?: string;
  left?: { heading: string; bullets: string[] };
  right?: { heading: string; bullets: string[] };
  imagePath?: string;
}

interface PptxInput {
  title: string;
  author?: string;
  style?: string;
  slides: SlideData[];
}

// ── Content Limits (prevent overflow in .pptx) ────────────────
const LIMITS = { bullets: 6, bulletsCompact: 4 };

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
  return s;
}

async function generatePptx(inputPath: string, outputPath: string) {
  const input: PptxInput = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
  const s = STYLES[input.style || ''] || DEFAULT_STYLE;
  const pptx = new PptxGenJS();

  pptx.title = input.title;
  if (input.author) pptx.author = input.author;

  const totalSlides = input.slides.length;

  for (let slideIdx = 0; slideIdx < totalSlides; slideIdx++) {
    const slideData = sanitizeSlide(input.slides[slideIdx]);
    const slide = pptx.addSlide();

    // ── Helper: add footer bar with slide number ──
    const addFooter = () => {
      if (!s.showFooter) return;
      // Bottom accent bar
      slide.addShape(pptx.ShapeType.rect, {
        x: 0, y: '94%', w: '100%', h: '6%',
        fill: { color: s.titleSlideBg },
      });
      // Slide number
      slide.addText(`${slideIdx + 1} / ${totalSlides}`, {
        x: '85%', y: '94.5%', w: '12%', h: '5%',
        fontSize: 9, color: 'FFFFFF', align: 'right',
        fontFace: s.fontFace,
      });
    };

    // ── Helper: add left sidebar accent ──
    const addSidebar = () => {
      if (!s.showSidebar) return;
      slide.addShape(pptx.ShapeType.rect, {
        x: 0, y: 0, w: s.sidebarWidth, h: '100%',
        fill: { color: s.accentColor },
      });
    };

    // Content x-offset when sidebar present
    const contentX = s.showSidebar ? '5%' : '5%';
    const headingX = s.showSidebar ? '5%' : '5%';

    switch (slideData.type) {
      case 'title':
        // Dark full-bleed background for title slide
        slide.background = { color: s.titleSlideBg };
        // Decorative accent shape — top-right corner triangle
        slide.addShape(pptx.ShapeType.rect, {
          x: '75%', y: 0, w: '25%', h: 0.08,
          fill: { color: s.accentColor },
        });
        slide.addShape(pptx.ShapeType.rect, {
          x: 0, y: '92%', w: '40%', h: 0.08,
          fill: { color: s.accentColor },
        });
        // Title text (white on dark)
        slide.addText(slideData.title || '', {
          x: '10%', y: '25%', w: '80%', h: '25%',
          fontSize: s.titleFontSize, bold: true, align: 'center',
          color: s.titleSlideTextColor, fontFace: s.fontFace,
        });
        // Accent line
        slide.addShape(pptx.ShapeType.rect, {
          x: '30%', y: '53%', w: '40%', h: 0.06,
          fill: { color: s.accentColor },
        });
        if (slideData.subtitle) {
          slide.addText(slideData.subtitle, {
            x: '10%', y: '57%', w: '80%', h: '12%',
            fontSize: 20, align: 'center', color: s.subtitleColor,
            fontFace: s.fontFace,
          });
        }
        break;

      case 'section':
        // Dark full-bleed background for section dividers
        slide.background = { color: s.sectionSlideBg };
        // Decorative accents
        slide.addShape(pptx.ShapeType.rect, {
          x: 0, y: '45%', w: '8%', h: 0.06,
          fill: { color: s.accentColor },
        });
        slide.addShape(pptx.ShapeType.rect, {
          x: '92%', y: '55%', w: '8%', h: 0.06,
          fill: { color: s.accentColor },
        });
        slide.addText(slideData.title || '', {
          x: '10%', y: '32%', w: '80%', h: '36%',
          fontSize: s.headingFontSize + 6, bold: true, align: 'center',
          color: s.titleSlideTextColor, fontFace: s.fontFace,
        });
        break;

      case 'content':
        slide.background = { color: s.bg };
        addSidebar();
        // Heading area with accent underline
        if (slideData.title) {
          slide.addText(slideData.title, {
            x: headingX, y: '5%', w: '88%', h: '12%',
            fontSize: s.headingFontSize, bold: true, color: s.headingColor,
            fontFace: s.fontFace,
          });
          // Accent underline for heading
          slide.addShape(pptx.ShapeType.rect, {
            x: headingX, y: '17%', w: '20%', h: 0.04,
            fill: { color: s.accentColor },
          });
        }
        if (slideData.bullets) {
          slide.addText(
            slideData.bullets.map(b => ({ text: b, options: { bullet: true, breakLine: true } })),
            {
              x: contentX, y: '22%', w: '88%', h: '64%',
              fontSize: s.bodyFontSize, color: s.bodyColor,
              fontFace: s.fontFace, lineSpacingMultiple: 1.4,
              autoFit: true,
            }
          );
        }
        if (slideData.text) {
          slide.addText(slideData.text, {
            x: contentX, y: '22%', w: '88%', h: '64%',
            fontSize: s.bodyFontSize, color: s.bodyColor,
            fontFace: s.fontFace, autoFit: true,
          });
        }
        addFooter();
        break;

      case 'two-column':
        slide.background = { color: s.bg };
        addSidebar();
        if (slideData.title) {
          slide.addText(slideData.title, {
            x: headingX, y: '5%', w: '88%', h: '12%',
            fontSize: s.headingFontSize, bold: true, color: s.headingColor,
            fontFace: s.fontFace,
          });
          slide.addShape(pptx.ShapeType.rect, {
            x: headingX, y: '17%', w: '20%', h: 0.04,
            fill: { color: s.accentColor },
          });
        }
        // Left column with subtle background panel
        if (slideData.left) {
          slide.addShape(pptx.ShapeType.rect, {
            x: '4%', y: '20%', w: '44%', h: '68%',
            fill: { color: s.accentColor2 },
            rectRadius: 0.1,
          });
          slide.addText(slideData.left.heading, {
            x: '6%', y: '22%', w: '40%', h: '8%',
            fontSize: 20, bold: true, color: s.headingColor,
            fontFace: s.fontFace,
          });
          slide.addText(
            slideData.left.bullets.map(b => ({ text: b, options: { bullet: true, breakLine: true } })),
            {
              x: '6%', y: '32%', w: '40%', h: '54%',
              fontSize: s.bodyFontSize, color: s.bodyColor,
              fontFace: s.fontFace, lineSpacingMultiple: 1.4,
              autoFit: true,
            }
          );
        }
        // Right column with subtle background panel
        if (slideData.right) {
          slide.addShape(pptx.ShapeType.rect, {
            x: '52%', y: '20%', w: '44%', h: '68%',
            fill: { color: s.accentColor2 },
            rectRadius: 0.1,
          });
          slide.addText(slideData.right.heading, {
            x: '54%', y: '22%', w: '40%', h: '8%',
            fontSize: 20, bold: true, color: s.headingColor,
            fontFace: s.fontFace,
          });
          slide.addText(
            slideData.right.bullets.map(b => ({ text: b, options: { bullet: true, breakLine: true } })),
            {
              x: '54%', y: '32%', w: '40%', h: '54%',
              fontSize: s.bodyFontSize, color: s.bodyColor,
              fontFace: s.fontFace, lineSpacingMultiple: 1.4,
              autoFit: true,
            }
          );
        }
        addFooter();
        break;
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
