#!/usr/bin/env node
/**
 * XLSX Generator Script
 * Usage: node --import tsx generate-xlsx.ts <input.json> <output.xlsx>
 */

import ExcelJS from 'exceljs';
import fs from 'fs';

interface SheetData {
  name: string;
  headers: string[];
  rows: (string | number | boolean | null)[][];
}

interface XlsxInput {
  title: string;
  sheets: SheetData[];
}

async function generateXlsx(inputPath: string, outputPath: string) {
  const input: XlsxInput = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'AI Agents Office';
  workbook.created = new Date();

  for (const sheetData of input.sheets) {
    const sheet = workbook.addWorksheet(sheetData.name);

    // Headers
    if (sheetData.headers) {
      const headerRow = sheet.addRow(sheetData.headers);
      headerRow.font = { bold: true, size: 12 };
      headerRow.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE0E0E0' },
      };

      // Auto-width columns
      sheetData.headers.forEach((header, i) => {
        const col = sheet.getColumn(i + 1);
        col.width = Math.max(header.length + 4, 12);
      });
    }

    // Data rows
    if (sheetData.rows) {
      for (const row of sheetData.rows) {
        sheet.addRow(row);
      }
    }

    // Add table borders
    sheet.eachRow((row) => {
      row.eachCell((cell) => {
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' },
        };
      });
    });
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
