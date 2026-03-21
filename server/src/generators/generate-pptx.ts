#!/usr/bin/env node
/**
 * PPTX Generator Script
 * Usage: node --import tsx generate-pptx.ts <input.json> <output.pptx>
 *
 * Input JSON format:
 * {
 *   "title": "Presentation Title",
 *   "author": "Author Name",
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
  slides: SlideData[];
}

async function generatePptx(inputPath: string, outputPath: string) {
  const input: PptxInput = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
  const pptx = new PptxGenJS();

  pptx.title = input.title;
  if (input.author) pptx.author = input.author;

  for (const slideData of input.slides) {
    const slide = pptx.addSlide();

    switch (slideData.type) {
      case 'title':
        slide.addText(slideData.title || '', {
          x: '10%', y: '30%', w: '80%', h: '20%',
          fontSize: 36, bold: true, align: 'center', color: '333333',
        });
        if (slideData.subtitle) {
          slide.addText(slideData.subtitle, {
            x: '10%', y: '55%', w: '80%', h: '10%',
            fontSize: 20, align: 'center', color: '666666',
          });
        }
        break;

      case 'section':
        slide.addText(slideData.title || '', {
          x: '10%', y: '35%', w: '80%', h: '30%',
          fontSize: 32, bold: true, align: 'center', color: '333333',
        });
        break;

      case 'content':
        if (slideData.title) {
          slide.addText(slideData.title, {
            x: '5%', y: '5%', w: '90%', h: '15%',
            fontSize: 28, bold: true, color: '333333',
          });
        }
        if (slideData.bullets) {
          slide.addText(
            slideData.bullets.map(b => ({ text: b, options: { bullet: true, breakLine: true } })),
            { x: '5%', y: '25%', w: '90%', h: '65%', fontSize: 18, color: '444444' }
          );
        }
        if (slideData.text) {
          slide.addText(slideData.text, {
            x: '5%', y: '25%', w: '90%', h: '65%', fontSize: 16, color: '444444',
          });
        }
        break;

      case 'two-column':
        if (slideData.title) {
          slide.addText(slideData.title, {
            x: '5%', y: '5%', w: '90%', h: '12%',
            fontSize: 28, bold: true, color: '333333',
          });
        }
        if (slideData.left) {
          slide.addText(slideData.left.heading, {
            x: '5%', y: '20%', w: '42%', h: '10%',
            fontSize: 20, bold: true, color: '333333',
          });
          slide.addText(
            slideData.left.bullets.map(b => ({ text: b, options: { bullet: true, breakLine: true } })),
            { x: '5%', y: '32%', w: '42%', h: '58%', fontSize: 16, color: '444444' }
          );
        }
        if (slideData.right) {
          slide.addText(slideData.right.heading, {
            x: '53%', y: '20%', w: '42%', h: '10%',
            fontSize: 20, bold: true, color: '333333',
          });
          slide.addText(
            slideData.right.bullets.map(b => ({ text: b, options: { bullet: true, breakLine: true } })),
            { x: '53%', y: '32%', w: '42%', h: '58%', fontSize: 16, color: '444444' }
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
