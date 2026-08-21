/**
 * fileTextExtract — turn an uploaded file into plain text.
 *
 * Lifted out of emailAttachmentReader so the Excel add-in's file uploads and a
 * mail attachment go through exactly the same parsers. They are the same
 * problem: somebody has a PDF or a spreadsheet, and the model needs its contents
 * as text. Two copies of "how do we read a docx" is two copies that drift, and
 * the one that drifts is always the one nobody is testing.
 *
 * No I/O and no auth in here — a Buffer in, a string out — so it can be called
 * from a route, from a queue, or from a test without dragging Outlook or Express
 * along with it.
 */
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import { extractText, getDocumentProxy } from 'unpdf';

/** Formats that are already text; read as UTF-8 and hand straight over. */
export const TEXT_EXTS = new Set(['txt', 'csv', 'tsv', 'md', 'log', 'json', 'xml', 'html', 'htm']);

/**
 * Raster formats Claude's vision accepts. These are NOT extracted — they go to
 * the model as image blocks, so there is no text step and no file-read surface.
 */
export const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

/** Formats worth parsing into text. */
export const DOC_EXTS = new Set(['pdf', 'docx', 'xlsx', 'xls']);

export function fileExt(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Everything this module can turn into text or show to the model. */
export function isReadableFile(name: string): boolean {
  const e = fileExt(name);
  return TEXT_EXTS.has(e) || IMAGE_EXTS.has(e) || DOC_EXTS.has(e);
}

/**
 * Extract text. Throws `unsupported` for anything not in the sets above —
 * callers decide whether that is an error or a file to skip.
 *
 * Spreadsheets come out tab-separated with a `# 工作表名` line per sheet rather
 * than as prose: the model is going to rebuild a table from this, and a layout
 * that already looks like a table is one it does not have to reverse-engineer.
 */
export async function extractTextFromBuffer(buf: Buffer, e: string): Promise<string> {
  if (e === 'pdf') {
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await extractText(pdf, { mergePages: true });
    return Array.isArray(text) ? text.join('\n') : text;
  }
  if (e === 'docx') {
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return value;
  }
  if (e === 'xlsx' || e === 'xls') {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const lines: string[] = [];
    wb.eachSheet(sheet => {
      lines.push(`# ${sheet.name}`);
      sheet.eachRow(row => {
        const cells: string[] = [];
        row.eachCell({ includeEmpty: false }, cell => cells.push(String(cell.text ?? '')));
        if (cells.length) lines.push(cells.join('\t'));
      });
    });
    return lines.join('\n');
  }
  if (TEXT_EXTS.has(e)) {
    return buf.toString('utf8');
  }
  throw new Error('unsupported');
}
