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
  titleColor: string;
  subtitleColor: string;
  headingColor: string;
  bodyColor: string;
  accentColor: string;
  titleFontSize: number;
  headingFontSize: number;
  bodyFontSize: number;
  fontFace?: string;
  accentBar?: boolean; // decorative bar on content slides
}

const STYLES: Record<string, StylePreset> = {
  'minimal-pro': {
    bg: 'FFFFFF',
    titleColor: '2D2D2D',
    subtitleColor: '999999',
    headingColor: '333333',
    bodyColor: '555555',
    accentColor: 'BBBBBB',
    titleFontSize: 36,
    headingFontSize: 26,
    bodyFontSize: 17,
  },
  'tech-dark': {
    bg: '0F0F23',
    titleColor: '00F0FF',
    subtitleColor: '8888AA',
    headingColor: 'E0E0FF',
    bodyColor: 'AAAACC',
    accentColor: '00F0FF',
    titleFontSize: 38,
    headingFontSize: 28,
    bodyFontSize: 17,
    fontFace: 'Consolas',
    accentBar: true,
  },
  'corporate': {
    bg: 'FFFFFF',
    titleColor: '1B3A5C',
    subtitleColor: '5A7FA0',
    headingColor: '1B3A5C',
    bodyColor: '3D3D3D',
    accentColor: '2B6CB0',
    titleFontSize: 36,
    headingFontSize: 26,
    bodyFontSize: 17,
    accentBar: true,
  },
  'creative': {
    bg: 'FFF8F0',
    titleColor: 'E84855',
    subtitleColor: '7B68EE',
    headingColor: '2D2B55',
    bodyColor: '444444',
    accentColor: 'FF6B35',
    titleFontSize: 40,
    headingFontSize: 28,
    bodyFontSize: 17,
    accentBar: true,
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

async function generatePptx(inputPath: string, outputPath: string) {
  const input: PptxInput = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
  const s = STYLES[input.style || ''] || DEFAULT_STYLE;
  const pptx = new PptxGenJS();

  pptx.title = input.title;
  if (input.author) pptx.author = input.author;

  for (const slideData of input.slides) {
    const slide = pptx.addSlide();
    slide.background = { color: s.bg };

    switch (slideData.type) {
      case 'title':
        slide.addText(slideData.title || '', {
          x: '10%', y: '28%', w: '80%', h: '22%',
          fontSize: s.titleFontSize, bold: true, align: 'center',
          color: s.titleColor, fontFace: s.fontFace,
        });
        if (slideData.subtitle) {
          slide.addText(slideData.subtitle, {
            x: '10%', y: '54%', w: '80%', h: '10%',
            fontSize: 20, align: 'center', color: s.subtitleColor,
            fontFace: s.fontFace,
          });
        }
        // Accent line under title
        slide.addShape(pptx.ShapeType.rect, {
          x: '35%', y: '52%', w: '30%', h: '0.04',
          fill: { color: s.accentColor },
        });
        break;

      case 'section':
        slide.addText(slideData.title || '', {
          x: '10%', y: '35%', w: '80%', h: '30%',
          fontSize: s.headingFontSize + 4, bold: true, align: 'center',
          color: s.titleColor, fontFace: s.fontFace,
        });
        slide.addShape(pptx.ShapeType.rect, {
          x: '40%', y: '63%', w: '20%', h: '0.04',
          fill: { color: s.accentColor },
        });
        break;

      case 'content':
        // Accent bar
        if (s.accentBar) {
          slide.addShape(pptx.ShapeType.rect, {
            x: '5%', y: '5%', w: '0.06', h: '12%',
            fill: { color: s.accentColor },
          });
        }
        if (slideData.title) {
          slide.addText(slideData.title, {
            x: s.accentBar ? '7%' : '5%', y: '5%', w: '88%', h: '12%',
            fontSize: s.headingFontSize, bold: true, color: s.headingColor,
            fontFace: s.fontFace,
          });
        }
        if (slideData.bullets) {
          slide.addText(
            slideData.bullets.map(b => ({ text: b, options: { bullet: true, breakLine: true } })),
            {
              x: '5%', y: '22%', w: '90%', h: '68%',
              fontSize: s.bodyFontSize, color: s.bodyColor,
              fontFace: s.fontFace, lineSpacingMultiple: 1.3,
            }
          );
        }
        if (slideData.text) {
          slide.addText(slideData.text, {
            x: '5%', y: '22%', w: '90%', h: '68%',
            fontSize: s.bodyFontSize, color: s.bodyColor,
            fontFace: s.fontFace,
          });
        }
        break;

      case 'two-column':
        if (s.accentBar) {
          slide.addShape(pptx.ShapeType.rect, {
            x: '5%', y: '5%', w: '0.06', h: '12%',
            fill: { color: s.accentColor },
          });
        }
        if (slideData.title) {
          slide.addText(slideData.title, {
            x: s.accentBar ? '7%' : '5%', y: '5%', w: '88%', h: '12%',
            fontSize: s.headingFontSize, bold: true, color: s.headingColor,
            fontFace: s.fontFace,
          });
        }
        if (slideData.left) {
          slide.addText(slideData.left.heading, {
            x: '5%', y: '20%', w: '42%', h: '10%',
            fontSize: 20, bold: true, color: s.headingColor,
            fontFace: s.fontFace,
          });
          slide.addText(
            slideData.left.bullets.map(b => ({ text: b, options: { bullet: true, breakLine: true } })),
            {
              x: '5%', y: '32%', w: '42%', h: '58%',
              fontSize: s.bodyFontSize, color: s.bodyColor,
              fontFace: s.fontFace, lineSpacingMultiple: 1.3,
            }
          );
        }
        if (slideData.right) {
          slide.addText(slideData.right.heading, {
            x: '53%', y: '20%', w: '42%', h: '10%',
            fontSize: 20, bold: true, color: s.headingColor,
            fontFace: s.fontFace,
          });
          slide.addText(
            slideData.right.bullets.map(b => ({ text: b, options: { bullet: true, breakLine: true } })),
            {
              x: '53%', y: '32%', w: '42%', h: '58%',
              fontSize: s.bodyFontSize, color: s.bodyColor,
              fontFace: s.fontFace, lineSpacingMultiple: 1.3,
            }
          );
        }
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
