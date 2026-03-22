#!/usr/bin/env node
/**
 * PDF Generator Script
 * Usage: node --import tsx generate-pdf.ts <input.json> <output.pdf>
 *
 * Supports "style" field: "formal" | "modern" | "magazine" | "technical"
 */

import PDFDocument from 'pdfkit';
import fs from 'fs';

// ── Style Presets ──────────────────────────────────────────────
interface StylePreset {
  titleSize: number;
  headingSize: number;
  bodySize: number;
  titleFont: string;
  headingFont: string;
  bodyFont: string;
  titleColor: string;
  headingColor: string;
  bodyColor: string;
  accentColor: string;
  lineGap: number;
  paragraphGap: number;
  titleAlign: 'center' | 'left' | 'right';
  margins: { top: number; bottom: number; left: number; right: number };
  accentLine?: boolean;    // decorative line under title
  headerRule?: boolean;    // horizontal rule under headings
}

const STYLES: Record<string, StylePreset> = {
  'formal': {
    titleSize: 30, headingSize: 18, bodySize: 12,
    titleFont: 'Times-Bold', headingFont: 'Times-Bold', bodyFont: 'Times-Roman',
    titleColor: '#1B3A5C', headingColor: '#1B3A5C', bodyColor: '#333333', accentColor: '#1B3A5C',
    lineGap: 6, paragraphGap: 10,
    titleAlign: 'center',
    margins: { top: 72, bottom: 72, left: 72, right: 72 },
    accentLine: true, headerRule: false,
  },
  'modern': {
    titleSize: 32, headingSize: 20, bodySize: 11,
    titleFont: 'Helvetica-Bold', headingFont: 'Helvetica-Bold', bodyFont: 'Helvetica',
    titleColor: '#2B6CB0', headingColor: '#2B6CB0', bodyColor: '#444444', accentColor: '#2B6CB0',
    lineGap: 5, paragraphGap: 8,
    titleAlign: 'left',
    margins: { top: 60, bottom: 60, left: 64, right: 64 },
    accentLine: true, headerRule: true,
  },
  'magazine': {
    titleSize: 36, headingSize: 22, bodySize: 11,
    titleFont: 'Helvetica-Bold', headingFont: 'Helvetica-Bold', bodyFont: 'Helvetica',
    titleColor: '#E84855', headingColor: '#2D2B55', bodyColor: '#333333', accentColor: '#E84855',
    lineGap: 5, paragraphGap: 10,
    titleAlign: 'center',
    margins: { top: 56, bottom: 56, left: 56, right: 56 },
    accentLine: true, headerRule: false,
  },
  'technical': {
    titleSize: 26, headingSize: 16, bodySize: 10,
    titleFont: 'Courier-Bold', headingFont: 'Courier-Bold', bodyFont: 'Courier',
    titleColor: '#000000', headingColor: '#333333', bodyColor: '#222222', accentColor: '#666666',
    lineGap: 4, paragraphGap: 6,
    titleAlign: 'left',
    margins: { top: 54, bottom: 54, left: 54, right: 54 },
    accentLine: false, headerRule: true,
  },
};

const DEFAULT_STYLE = STYLES['modern'];

// ── Types ──────────────────────────────────────────────────────
interface Section {
  heading?: string;
  paragraphs?: string[];
  bullets?: string[];
}

interface PdfInput {
  title: string;
  author?: string;
  style?: string;
  pageSize?: string;
  sections: Section[];
}

async function generatePdf(inputPath: string, outputPath: string) {
  const input: PdfInput = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
  const s = STYLES[input.style || ''] || DEFAULT_STYLE;

  return new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({
      size: (input.pageSize || 'A4') as PDFKit.PDFDocumentOptions['size'],
      margins: s.margins,
      info: {
        Title: input.title,
        Author: input.author || 'AI Agents Office',
      },
    });

    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    // Title
    doc.fontSize(s.titleSize).font(s.titleFont).fillColor(s.titleColor)
      .text(input.title, { align: s.titleAlign });

    // Accent line under title
    if (s.accentLine) {
      doc.moveDown(0.5);
      const lineY = doc.y;
      const pageWidth = doc.page.width - s.margins.left - s.margins.right;
      const lineWidth = s.titleAlign === 'center' ? pageWidth * 0.4 : pageWidth * 0.3;
      const lineX = s.titleAlign === 'center'
        ? s.margins.left + (pageWidth - lineWidth) / 2
        : s.margins.left;
      doc.moveTo(lineX, lineY)
        .lineTo(lineX + lineWidth, lineY)
        .strokeColor(s.accentColor)
        .lineWidth(2)
        .stroke();
    }

    doc.moveDown(2);

    // Sections
    for (const section of input.sections) {
      if (section.heading) {
        doc.fontSize(s.headingSize).font(s.headingFont).fillColor(s.headingColor)
          .text(section.heading);

        // Header rule
        if (s.headerRule) {
          const ruleY = doc.y + 2;
          const pageWidth = doc.page.width - s.margins.left - s.margins.right;
          doc.moveTo(s.margins.left, ruleY)
            .lineTo(s.margins.left + pageWidth, ruleY)
            .strokeColor(s.accentColor)
            .lineWidth(0.5)
            .stroke();
          doc.moveDown(0.3);
        }

        doc.moveDown(0.5);
      }

      if (section.paragraphs) {
        doc.fontSize(s.bodySize).font(s.bodyFont).fillColor(s.bodyColor);
        for (const para of section.paragraphs) {
          doc.text(para, { align: 'justify', lineGap: s.lineGap });
          doc.moveDown(s.paragraphGap / 10);
        }
      }

      if (section.bullets) {
        doc.fontSize(s.bodySize).font(s.bodyFont).fillColor(s.bodyColor);
        for (const bullet of section.bullets) {
          doc.text(`  \u2022  ${bullet}`, { indent: 20, lineGap: s.lineGap });
          doc.moveDown(0.3);
        }
      }

      doc.moveDown(1);
    }

    doc.end();

    stream.on('finish', () => {
      console.log(`PDF generated: ${outputPath}`);
      resolve();
    });
    stream.on('error', reject);
  });
}

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  console.error('Usage: generate-pdf.ts <input.json> <output.pdf>');
  process.exit(1);
}
generatePdf(inputPath, outputPath).catch(err => {
  console.error('Failed to generate PDF:', err);
  process.exit(1);
});
