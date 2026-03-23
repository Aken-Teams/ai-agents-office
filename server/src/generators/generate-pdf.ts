#!/usr/bin/env node
/**
 * PDF Generator Script
 * Usage: node --import tsx generate-pdf.ts <input.json> <output.pdf>
 *
 * Supports "style" field: "formal" | "modern" | "magazine" | "technical"
 */

// @ts-ignore -- pdfkit lacks type declarations
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
  accentColor2: string;       // secondary / lighter accent
  lineGap: number;
  paragraphGap: number;
  titleAlign: 'center' | 'left' | 'right';
  margins: { top: number; bottom: number; left: number; right: number };
  accentLine: boolean;        // decorative line under title
  headerRule: boolean;        // horizontal rule under headings
  titlePageBanner: boolean;   // colored banner bar on title page
  headingAccentBar: boolean;  // colored sidebar bar next to headings
  pageNumbers: boolean;       // footer page numbers
}

const STYLES: Record<string, StylePreset> = {
  'formal': {
    titleSize: 30, headingSize: 18, bodySize: 12,
    titleFont: 'Times-Bold', headingFont: 'Times-Bold', bodyFont: 'Times-Roman',
    titleColor: '#1B3A5C', headingColor: '#1B3A5C', bodyColor: '#333333',
    accentColor: '#1B3A5C', accentColor2: '#E8EDF5',
    lineGap: 6, paragraphGap: 10,
    titleAlign: 'center',
    margins: { top: 72, bottom: 72, left: 72, right: 72 },
    accentLine: true, headerRule: false,
    titlePageBanner: true, headingAccentBar: false, pageNumbers: true,
  },
  'modern': {
    titleSize: 32, headingSize: 20, bodySize: 11,
    titleFont: 'Helvetica-Bold', headingFont: 'Helvetica-Bold', bodyFont: 'Helvetica',
    titleColor: '#1B2A4A', headingColor: '#1B2A4A', bodyColor: '#3D3D3D',
    accentColor: '#2B6CB0', accentColor2: '#EDF2F7',
    lineGap: 5, paragraphGap: 8,
    titleAlign: 'left',
    margins: { top: 60, bottom: 60, left: 64, right: 64 },
    accentLine: true, headerRule: true,
    titlePageBanner: true, headingAccentBar: true, pageNumbers: true,
  },
  'magazine': {
    titleSize: 36, headingSize: 22, bodySize: 11,
    titleFont: 'Helvetica-Bold', headingFont: 'Helvetica-Bold', bodyFont: 'Helvetica',
    titleColor: '#E84855', headingColor: '#2D2B55', bodyColor: '#333333',
    accentColor: '#E84855', accentColor2: '#FFF0F0',
    lineGap: 5, paragraphGap: 10,
    titleAlign: 'center',
    margins: { top: 56, bottom: 56, left: 56, right: 56 },
    accentLine: true, headerRule: false,
    titlePageBanner: true, headingAccentBar: false, pageNumbers: true,
  },
  'technical': {
    titleSize: 26, headingSize: 16, bodySize: 10,
    titleFont: 'Courier-Bold', headingFont: 'Courier-Bold', bodyFont: 'Courier',
    titleColor: '#000000', headingColor: '#333333', bodyColor: '#222222',
    accentColor: '#666666', accentColor2: '#F0F0F0',
    lineGap: 4, paragraphGap: 6,
    titleAlign: 'left',
    margins: { top: 54, bottom: 54, left: 54, right: 54 },
    accentLine: false, headerRule: true,
    titlePageBanner: false, headingAccentBar: false, pageNumbers: true,
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
      size: (input.pageSize || 'A4') as any,
      margins: s.margins,
      info: {
        Title: input.title,
        Author: input.author || 'AI Agents Office',
      },
    });

    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    const pageWidth = doc.page.width - s.margins.left - s.margins.right;

    // ── Title page banner (colored bar at top of first page) ──
    if (s.titlePageBanner) {
      doc.save();
      doc.rect(0, 0, doc.page.width, 8).fill(s.accentColor);
      doc.restore();
    }

    // Title
    if (s.titlePageBanner) doc.moveDown(1);
    doc.fontSize(s.titleSize).font(s.titleFont).fillColor(s.titleColor)
      .text(input.title, { align: s.titleAlign });

    // Accent line under title
    if (s.accentLine) {
      doc.moveDown(0.5);
      const lineY = doc.y;
      const lineWidth = s.titleAlign === 'center' ? pageWidth * 0.4 : pageWidth * 0.3;
      const lineX = s.titleAlign === 'center'
        ? s.margins.left + (pageWidth - lineWidth) / 2
        : s.margins.left;
      doc.save();
      doc.moveTo(lineX, lineY)
        .lineTo(lineX + lineWidth, lineY)
        .strokeColor(s.accentColor)
        .lineWidth(2.5)
        .stroke();
      doc.restore();
    }

    // Author line
    if (input.author) {
      doc.moveDown(0.8);
      doc.fontSize(s.bodySize + 1).font(s.bodyFont).fillColor(s.accentColor)
        .text(input.author, { align: s.titleAlign });
    }

    doc.moveDown(2);

    // ── Sections ──
    for (const section of input.sections) {
      if (section.heading) {
        // Accent bar next to heading
        if (s.headingAccentBar) {
          const headingY = doc.y;
          doc.save();
          doc.rect(s.margins.left - 8, headingY, 3, s.headingSize + 4).fill(s.accentColor);
          doc.restore();
        }

        doc.fontSize(s.headingSize).font(s.headingFont).fillColor(s.headingColor)
          .text(section.heading);

        // Header rule
        if (s.headerRule) {
          const ruleY = doc.y + 2;
          doc.save();
          doc.moveTo(s.margins.left, ruleY)
            .lineTo(s.margins.left + pageWidth, ruleY)
            .strokeColor(s.accentColor)
            .lineWidth(0.5)
            .opacity(0.4)
            .stroke();
          doc.restore();
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
          // Colored bullet dot
          const bulletY = doc.y + s.bodySize * 0.35;
          doc.save();
          doc.circle(s.margins.left + 12, bulletY, 2.5).fill(s.accentColor);
          doc.restore();
          doc.fillColor(s.bodyColor);
          doc.text(bullet, s.margins.left + 22, doc.y, {
            width: pageWidth - 22,
            lineGap: s.lineGap,
          });
          doc.moveDown(0.3);
        }
      }

      doc.moveDown(1);
    }

    // ── Page numbers ──
    if (s.pageNumbers) {
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        doc.save();
        // Bottom accent line
        doc.moveTo(s.margins.left, doc.page.height - s.margins.bottom + 10)
          .lineTo(s.margins.left + pageWidth, doc.page.height - s.margins.bottom + 10)
          .strokeColor(s.accentColor)
          .lineWidth(0.5)
          .opacity(0.3)
          .stroke();
        // Page number
        doc.fontSize(8).font(s.bodyFont).fillColor(s.accentColor)
          .text(
            `${i + 1}`,
            s.margins.left,
            doc.page.height - s.margins.bottom + 16,
            { width: pageWidth, align: 'right' }
          );
        doc.restore();
      }
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
