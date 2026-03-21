#!/usr/bin/env node
/**
 * PDF Generator Script
 * Usage: node --import tsx generate-pdf.ts <input.json> <output.pdf>
 */

import PDFDocument from 'pdfkit';
import fs from 'fs';

interface Section {
  heading?: string;
  paragraphs?: string[];
  bullets?: string[];
}

interface PdfInput {
  title: string;
  author?: string;
  pageSize?: string;
  sections: Section[];
}

async function generatePdf(inputPath: string, outputPath: string) {
  const input: PdfInput = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));

  return new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({
      size: (input.pageSize || 'A4') as PDFKit.PDFDocumentOptions['size'],
      margins: { top: 72, bottom: 72, left: 72, right: 72 },
      info: {
        Title: input.title,
        Author: input.author || 'AI Agents Office',
      },
    });

    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    // Title
    doc.fontSize(28).font('Helvetica-Bold').text(input.title, {
      align: 'center',
    });
    doc.moveDown(2);

    // Sections
    for (const section of input.sections) {
      if (section.heading) {
        doc.fontSize(18).font('Helvetica-Bold').text(section.heading);
        doc.moveDown(0.5);
      }

      if (section.paragraphs) {
        doc.fontSize(12).font('Helvetica');
        for (const para of section.paragraphs) {
          doc.text(para, { align: 'justify' });
          doc.moveDown(0.5);
        }
      }

      if (section.bullets) {
        doc.fontSize(12).font('Helvetica');
        for (const bullet of section.bullets) {
          doc.text(`  \u2022  ${bullet}`, { indent: 20 });
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
