#!/usr/bin/env node
/**
 * DOCX Generator Script
 * Usage: node --import tsx generate-docx.ts <input.json> <output.docx>
 *
 * Supports "style" field: "formal" | "modern" | "academic" | "compact"
 */

import { Document, Packer, Paragraph, HeadingLevel, TextRun, AlignmentType, BorderStyle, ShadingType, Table, TableRow, TableCell, WidthType, Header, Footer, PageNumber } from 'docx';
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
// Accepts BOTH the editor's block schema (type/title/content/items/headers/rows)
// and the older {heading, paragraphs, bullets} shape.
interface Section {
  type?: string;
  heading?: string;
  title?: string;
  level?: number;
  content?: string;
  paragraphs?: string[];
  bullets?: string[];
  items?: string[];
  points?: string[];
  headers?: string[];
  rows?: string[][];
}

/** Infer heading level from a numbered title: "1." → 1, "1.2" → 2, "1.2.3" → 3. */
function levelFromTitle(title: string, fallback = 1): number {
  const m = (title || '').match(/^\s*(\d+(?:\.\d+)*)/);
  if (m) return Math.min(m[1].split('.').filter(Boolean).length, 3);
  return fallback;
}

export interface DocxInput {
  title: string;
  author?: string;
  style?: string;
  sections: Section[];
}

/** Build a .docx as an in-memory Buffer (no filesystem). Reused by server routes. */
export async function buildDocxBuffer(input: DocxInput): Promise<Buffer> {
  const s = STYLES[input.style || ''] || DEFAULT_STYLE;

  const children: (Paragraph | Table)[] = [];

  // Title
  children.push(new Paragraph({
    children: [new TextRun({ text: input.title, bold: true, size: s.titleSize, font: s.font, color: s.titleColor })],
    heading: HeadingLevel.TITLE,
    alignment: s.titleAlign,
    spacing: { after: s.paragraphAfter * 2 },
  }));

  const addHeading = (text: string, level: number, pageBreakBefore = false) => {
    const headingLevel = level >= 3 ? HeadingLevel.HEADING_3 : level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_1;
    const p: ConstructorParameters<typeof Paragraph>[0] = {
      children: [new TextRun({ text, bold: true, size: s.headingSize, font: s.font, color: s.headingColor })],
      heading: headingLevel,
      spacing: { before: s.sectionBefore, after: s.paragraphAfter },
      ...(pageBreakBefore ? { pageBreakBefore: true } : {}),
    };
    if (s.accentBorder) {
      (p as any).border = { left: { style: BorderStyle.SINGLE, size: 12, color: s.accentColor, space: 8 } };
      (p as any).shading = { type: ShadingType.CLEAR, fill: 'F0F4F8' };
      (p as any).indent = { left: 120 };
    }
    children.push(new Paragraph(p));
  };
  const addParas = (text: string) => {
    for (const para of String(text).split(/\n+/).map(t => t.trim()).filter(Boolean)) {
      children.push(new Paragraph({
        children: [new TextRun({ text: para, size: s.bodySize, font: s.font, color: s.bodyColor })],
        spacing: { after: s.paragraphAfter, line: s.lineSpacing },
      }));
    }
  };
  const addBullets = (arr: string[]) => {
    for (const b of arr) {
      const text = typeof b === 'string' ? b : String((b as any)?.text ?? '');
      if (!text) continue;
      children.push(new Paragraph({
        children: [new TextRun({ text, size: s.bodySize, font: s.font, color: s.bodyColor })],
        bullet: { level: 0 },
        spacing: { after: s.paragraphAfter / 2, line: s.lineSpacing },
        indent: { left: s.bulletIndent },
      }));
    }
  };
  const addTable = (headers: string[], rows: string[][]) => {
    const cell = (txt: string, header: boolean) => new TableCell({
      shading: header ? { type: ShadingType.CLEAR, fill: s.accentColor } : undefined,
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
      children: [new Paragraph({ children: [new TextRun({ text: String(txt ?? ''), bold: header, size: s.bodySize, font: s.font, color: header ? 'FFFFFF' : s.bodyColor })] })],
    });
    const tableRows: TableRow[] = [];
    if (headers?.length) tableRows.push(new TableRow({ tableHeader: true, children: headers.map(h => cell(h, true)) }));
    for (const r of rows || []) tableRows.push(new TableRow({ children: (Array.isArray(r) ? r : [r]).map(c => cell(c as string, false)) }));
    if (tableRows.length) {
      children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: tableRows }));
      children.push(new Paragraph({ children: [], spacing: { after: s.paragraphAfter } }));
    }
  };

  // Sections — support BOTH the editor block schema and the legacy shape.
  // The first block is treated as the cover; real content starts on a new page.
  const coverIsTable = String(input.sections[0]?.type || '').toLowerCase() === 'table';
  let coverBreakDone = !coverIsTable; // only force a break when there's a cover block
  for (let i = 0; i < input.sections.length; i++) {
    const sec = input.sections[i];
    const headingText = sec.heading || sec.title || '';
    const kind = String(sec.type || '').toLowerCase();
    // First real section after the cover → start it on a fresh page.
    const breakBefore = !coverBreakDone && i > 0;
    if (breakBefore) coverBreakDone = true;

    if (kind === 'table' || (sec.headers && sec.rows)) {
      if (headingText) addHeading(headingText, levelFromTitle(headingText, 2), breakBefore);
      addTable(sec.headers || [], sec.rows || []);
      continue;
    }
    if (headingText) addHeading(headingText, sec.level || levelFromTitle(headingText, kind === 'paragraph' ? 2 : 1), breakBefore);
    if (sec.content) addParas(sec.content);
    if (sec.paragraphs) for (const p of sec.paragraphs) addParas(p);
    const listItems = sec.items || sec.bullets || sec.points;
    if (listItems?.length) addBullets(listItems);
  }

  // Header: document title (right-aligned, muted). Footer: 第 X 頁 / 共 Y 頁.
  const header = new Header({
    children: [new Paragraph({
      alignment: AlignmentType.RIGHT,
      border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC', space: 2 } },
      children: [new TextRun({ text: input.title, size: 16, color: '888888', font: s.font })],
    })],
  });
  const footer = new Footer({
    children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({ text: '第 ', size: 16, color: '888888', font: s.font }),
        new TextRun({ children: [PageNumber.CURRENT], size: 16, color: '888888', font: s.font }),
        new TextRun({ text: ' 頁 / 共 ', size: 16, color: '888888', font: s.font }),
        new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: '888888', font: s.font }),
        new TextRun({ text: ' 頁', size: 16, color: '888888', font: s.font }),
      ],
    })],
  });

  const doc = new Document({
    creator: input.author || 'AI Agents Office',
    title: input.title,
    sections: [{
      properties: { page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
      headers: { default: header },
      footers: { default: footer },
      children,
    }],
  });

  return await Packer.toBuffer(doc);
}

async function generateDocx(inputPath: string, outputPath: string) {
  const input: DocxInput = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
  const buffer = await buildDocxBuffer(input);
  fs.writeFileSync(outputPath, buffer);
  console.log(`DOCX generated: ${outputPath}`);
}

// CLI entry — only run when invoked directly, not when imported as a module.
const invokedDirectly = process.argv[1] && /generate-docx\.[tj]s$/.test(process.argv[1]);
if (invokedDirectly) {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath) {
    console.error('Usage: generate-docx.ts <input.json> <output.docx>');
    process.exit(1);
  }
  generateDocx(inputPath, outputPath).catch(err => {
    console.error('Failed to generate DOCX:', err);
    process.exit(1);
  });
}
