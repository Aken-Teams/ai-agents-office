/**
 * Server-side Excel (.xlsx) export helper (exceljs). Used by admin exports so
 * they get a real, styled workbook — with no client bundle and no row cap.
 */
import ExcelJS from 'exceljs';
import type { Response } from 'express';

export interface XlsxSheet {
  name: string;
  headers: string[];
  rows: (string | number | null | undefined)[][];
}

export async function sendXlsx(res: Response, filename: string, sheets: XlsxSheet[]): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'AI Agents Office';
  wb.created = new Date();

  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name.slice(0, 31) || 'Sheet');
    ws.addRow(s.headers);
    const head = ws.getRow(1);
    head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1B2A4A' } };
    head.alignment = { vertical: 'middle' };
    head.height = 20;
    for (const r of s.rows) ws.addRow(r.map(v => (v == null ? '' : v)));
    // Reasonable auto column widths (capped) based on header + content length.
    ws.columns.forEach((col, i) => {
      let max = (s.headers[i] || '').length;
      for (const r of s.rows) { const len = r[i] == null ? 0 : String(r[i]).length; if (len > max) max = len; }
      col.width = Math.min(60, Math.max(10, max + 2));
    });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }

  const buf = await wb.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
  res.end(Buffer.from(buf));
}
