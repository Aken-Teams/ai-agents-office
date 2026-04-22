#!/usr/bin/env node
/**
 * DOCX Generator Script
 * Usage: node --import tsx generate-docx.ts <input.json> <output.docx>
 *
 * Supports "style" field: "formal" | "modern" | "academic" | "compact"
 */

import { Document, Packer, Paragraph, HeadingLevel, TextRun, AlignmentType, BorderStyle, ShadingType } from 'docx';
import fs from 'fs';

// ── Style Presets ──────────────────────────────────────────────
interface StylePreset {
  titleSize: number;
  headingSize: number;
  bodySize: number;
  font: string;
  titleColor: string;
  headingColor: string;
  bodyColor: string;
  accentColor: string;
  lineSpacing: number;       // spacing in twips (1/20 pt)
  paragraphAfter: number;
  sectionBefore: number;
  titleAlign: (typeof AlignmentType)[keyof typeof AlignmentType];
  bulletIndent: number;
  accentBorder?: boolean;    // colored left border on headings
}

const STYLES: Record<string, StylePreset> = {
  'formal': {
    titleSize: 52, headingSize: 28, bodySize: 24,
    font: 'Times New Roman',
    titleColor: '000000', headingColor: '1B3A5C', bodyColor: '333333', accentColor: '1B3A5C',
    lineSpacing: 360, paragraphAfter: 240, sectionBefore: 400,
    titleAlign: AlignmentType.CENTER, bulletIndent: 720,
    accentBorder: false,
  },
  'modern': {
    titleSize: 48, headingSize: 28, bodySize: 22,
    font: 'Calibri',
    titleColor: '2D2D2D', headingColor: '2B6CB0', bodyColor: '444444', accentColor: '2B6CB0',
    lineSpacing: 300, paragraphAfter: 200, sectionBefore: 360,
    titleAlign: AlignmentType.LEFT, bulletIndent: 600,
    accentBorder: true,
  },
  'academic': {
    titleSize: 48, headingSize: 26, bodySize: 24,
    font: 'Times New Roman',
    titleColor: '000000', headingColor: '000000', bodyColor: '000000', accentColor: '333333',
    lineSpacing: 480, paragraphAfter: 240, sectionBefore: 480,
    titleAlign: AlignmentType.CENTER, bulletIndent: 720,
    accentBorder: false,
  },
  'compact': {
    titleSize: 40, headingSize: 24, bodySize: 20,
    font: 'Arial',
    titleColor: '1A1A1A', headingColor: '333333', bodyColor: '444444', accentColor: '666666',
    lineSpacing: 240, paragraphAfter: 100, sectionBefore: 200,
    titleAlign: AlignmentType.LEFT, bulletIndent: 400,
    accentBorder: false,
  },
};

const DEFAULT_STYLE = STYLES['modern'];

// ── Types ──────────────────────────────────────────────────────
interface Section {
  heading?: string;
  level?: number;
  paragraphs?: string[];
  bullets?: string[];
}

interface DocxInput {
  title: string;
  author?: string;
  style?: string;
  sections: Section[];
}

async function generateDocx(inputPath: string, outputPath: string) {
  const input: DocxInput = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
  const s = STYLES[input.style || ''] || DEFAULT_STYLE;

  const children: Paragraph[] = [];

  // Title
  children.push(new Paragraph({
    children: [new TextRun({ text: input.title, bold: true, size: s.titleSize, font: s.font, color: s.titleColor })],
    heading: HeadingLevel.TITLE,
    alignment: s.titleAlign,
    spacing: { after: s.paragraphAfter * 2 },
  }));

  // Sections
  for (const section of input.sections) {
    if (section.heading) {
      const headingLevel = section.level === 2 ? HeadingLevel.HEADING_2 :
                           section.level === 3 ? HeadingLevel.HEADING_3 :
                           HeadingLevel.HEADING_1;
      const headingParagraph: ConstructorParameters<typeof Paragraph>[0] = {
        children: [new TextRun({ text: section.heading, bold: true, size: s.headingSize, font: s.font, color: s.headingColor })],
        heading: headingLevel,
        spacing: { before: s.sectionBefore, after: s.paragraphAfter },
      };
      // Accent left border for modern style
      if (s.accentBorder) {
        (headingParagraph as any).border = {
          left: { style: BorderStyle.SINGLE, size: 12, color: s.accentColor, space: 8 },
        };
        (headingParagraph as any).shading = { type: ShadingType.CLEAR, fill: 'F0F4F8' };
        (headingParagraph as any).indent = { left: 120 };
      }
      children.push(new Paragraph(headingParagraph));
    }

    if (section.paragraphs) {
      for (const para of section.paragraphs) {
        children.push(new Paragraph({
          children: [new TextRun({ text: para, size: s.bodySize, font: s.font, color: s.bodyColor })],
          spacing: { after: s.paragraphAfter, line: s.lineSpacing },
        }));
      }
    }

    if (section.bullets) {
      for (const bullet of section.bullets) {
        children.push(new Paragraph({
          children: [new TextRun({ text: bullet, size: s.bodySize, font: s.font, color: s.bodyColor })],
          bullet: { level: 0 },
          spacing: { after: s.paragraphAfter / 2, line: s.lineSpacing },
          indent: { left: s.bulletIndent },
        }));
      }
    }
  }

  const doc = new Document({
    creator: input.author || 'AI Agents Office',
    title: input.title,
    sections: [{ children }],
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);
  console.log(`DOCX generated: ${outputPath}`);
}

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  console.error('Usage: generate-docx.ts <input.json> <output.docx>');
  process.exit(1);
}
generateDocx(inputPath, outputPath).catch(err => {
  console.error('Failed to generate DOCX:', err);
  process.exit(1);
});
