#!/usr/bin/env node
/**
 * DOCX Generator Script
 * Usage: node --import tsx generate-docx.ts <input.json> <output.docx>
 */

import { Document, Packer, Paragraph, HeadingLevel, TextRun, AlignmentType } from 'docx';
import fs from 'fs';

interface Section {
  heading?: string;
  level?: number;
  paragraphs?: string[];
  bullets?: string[];
}

interface DocxInput {
  title: string;
  author?: string;
  sections: Section[];
}

async function generateDocx(inputPath: string, outputPath: string) {
  const input: DocxInput = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));

  const children: Paragraph[] = [];

  // Title
  children.push(new Paragraph({
    children: [new TextRun({ text: input.title, bold: true, size: 48 })],
    heading: HeadingLevel.TITLE,
    alignment: AlignmentType.CENTER,
    spacing: { after: 400 },
  }));

  // Sections
  for (const section of input.sections) {
    if (section.heading) {
      const headingLevel = section.level === 2 ? HeadingLevel.HEADING_2 :
                           section.level === 3 ? HeadingLevel.HEADING_3 :
                           HeadingLevel.HEADING_1;
      children.push(new Paragraph({
        text: section.heading,
        heading: headingLevel,
        spacing: { before: 300, after: 200 },
      }));
    }

    if (section.paragraphs) {
      for (const para of section.paragraphs) {
        children.push(new Paragraph({
          children: [new TextRun({ text: para, size: 24 })],
          spacing: { after: 200 },
        }));
      }
    }

    if (section.bullets) {
      for (const bullet of section.bullets) {
        children.push(new Paragraph({
          children: [new TextRun({ text: bullet, size: 24 })],
          bullet: { level: 0 },
          spacing: { after: 100 },
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
