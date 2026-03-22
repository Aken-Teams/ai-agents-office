#!/usr/bin/env node
/**
 * XLSX Generator Script
 * Usage: node --import tsx generate-xlsx.ts <input.json> <output.xlsx>
 *
 * Supports "style" field: "dashboard" | "clean" | "financial" | "colorful"
 */

import ExcelJS from 'exceljs';
import fs from 'fs';

// ── Style Presets ──────────────────────────────────────────────
interface StylePreset {
  headerBg: string;
  headerFont: string;
  headerFontSize: number;
  bodyFontSize: number;
  borderStyle: 'thin' | 'medium' | 'hair' | 'none';
  alternateRowBg?: string;
  font: string;
  headerFontColor: string;
}

const STYLES: Record<string, StylePreset> = {
  'dashboard': {
    headerBg: 'FF2B6CB0', headerFont: 'Calibri', headerFontSize: 12,
    bodyFontSize: 11, borderStyle: 'thin', font: 'Calibri',
    headerFontColor: 'FFFFFFFF', alternateRowBg: 'FFF0F4F8',
  },
  'clean': {
    headerBg: 'FFF5F5F5', headerFont: 'Calibri', headerFontSize: 11,
    bodyFontSize: 11, borderStyle: 'hair', font: 'Calibri',
    headerFontColor: 'FF333333',
  },
  'financial': {
    headerBg: 'FF1B3A5C', headerFont: 'Arial', headerFontSize: 11,
    bodyFontSize: 10, borderStyle: 'thin', font: 'Arial',
    headerFontColor: 'FFFFFFFF',
  },
  'colorful': {
    headerBg: 'FF6C5CE7', headerFont: 'Calibri', headerFontSize: 12,
    bodyFontSize: 11, borderStyle: 'thin', font: 'Calibri',
    headerFontColor: 'FFFFFFFF', alternateRowBg: 'FFF8F7FF',
  },
};

const DEFAULT_STYLE = STYLES['clean'];

// ── Types ──────────────────────────────────────────────────────
interface SheetData {
  name: string;
  headers: string[];
  rows: (string | number | boolean | null)[][];
}

interface XlsxInput {
  title: string;
  style?: string;
  sheets: SheetData[];
}

async function generateXlsx(inputPath: string, outputPath: string) {
  const input: XlsxInput = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
  const s = STYLES[input.style || ''] || DEFAULT_STYLE;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'AI Agents Office';
  workbook.created = new Date();

  for (const sheetData of input.sheets) {
    const sheet = workbook.addWorksheet(sheetData.name);

    // Headers
    if (sheetData.headers) {
      const headerRow = sheet.addRow(sheetData.headers);
      headerRow.font = { bold: true, size: s.headerFontSize, name: s.headerFont, color: { argb: s.headerFontColor } };
      headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: s.headerBg } };
      headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
      headerRow.height = 28;

      // Auto-width columns
      sheetData.headers.forEach((header, i) => {
        const col = sheet.getColumn(i + 1);
        col.width = Math.max(header.length * 1.5 + 4, 14);
      });
    }

    // Data rows
    if (sheetData.rows) {
      sheetData.rows.forEach((row, idx) => {
        const excelRow = sheet.addRow(row);
        excelRow.font = { size: s.bodyFontSize, name: s.font };

        // Alternate row shading
        if (s.alternateRowBg && idx % 2 === 1) {
          excelRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: s.alternateRowBg } };
        }
      });
    }

    // Borders
    if (s.borderStyle !== 'none') {
      sheet.eachRow((row) => {
        row.eachCell((cell) => {
          cell.border = {
            top: { style: s.borderStyle },
            left: { style: s.borderStyle },
            bottom: { style: s.borderStyle },
            right: { style: s.borderStyle },
          };
        });
      });
    }

    // Freeze header row
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
  }

  await workbook.xlsx.writeFile(outputPath);
  console.log(`XLSX generated: ${outputPath}`);
}

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  console.error('Usage: generate-xlsx.ts <input.json> <output.xlsx>');
  process.exit(1);
}
generateXlsx(inputPath, outputPath).catch(err => {
  console.error('Failed to generate XLSX:', err);
  process.exit(1);
});
