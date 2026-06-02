/**
 * Extract plain text from common document types so they can be indexed
 * into the personal-RAG vector store.
 *
 * Supported:
 *   - PDF (pdf-parse)
 *   - DOCX (mammoth)
 *   - XLSX / XLS (xlsx → sheet→CSV per worksheet)
 *   - TXT / MD / CSV / JSON / YAML — read raw
 *
 * Out-of-scope for v1: image OCR, audio transcripts, scanned PDFs without
 * a text layer. Image-only PDFs return a short note describing the issue
 * so the user gets a meaningful failure reason instead of an empty index.
 */

import fs from 'fs';
import path from 'path';

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'yaml', 'yml',
  'html', 'htm', 'xml',
]);

export interface ExtractResult {
  text: string;
  /** Approximate character count of useful content. */
  chars: number;
  /** Inferred file type label (pdf / docx / xlsx / txt / unknown). */
  fileType: string;
  /** Non-fatal note (e.g. "PDF has no text layer — only metadata extracted"). */
  warning?: string;
}

/**
 * Read a file from disk and produce a text snapshot. Throws on hard parse
 * errors so the caller (embeddingWorker) can mark the user_documents row
 * as failed.
 */
export async function extractText(filePath: string): Promise<ExtractResult> {
  const ext = path.extname(filePath).slice(1).toLowerCase();

  if (TEXT_EXTENSIONS.has(ext)) {
    const text = await fs.promises.readFile(filePath, 'utf-8');
    return { text, chars: text.length, fileType: ext };
  }

  switch (ext) {
    case 'pdf':  return await extractPdf(filePath);
    case 'docx': return await extractDocx(filePath);
    case 'xlsx':
    case 'xls':  return await extractXlsx(filePath, ext);
    default:
      throw new Error(`Unsupported file type: .${ext}`);
  }
}

async function extractPdf(filePath: string): Promise<ExtractResult> {
  // pdf-parse 2.x exposes a PDFParse class instead of the old default function.
  const { PDFParse } = await import('pdf-parse');
  const buffer = await fs.promises.readFile(filePath);
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    const text = (result.text ?? '').trim();
    if (text.length < 20) {
      return {
        text,
        chars: text.length,
        fileType: 'pdf',
        warning: 'PDF 內無文字層（掃描檔），請改傳原始檔或先 OCR',
      };
    }
    return { text, chars: text.length, fileType: 'pdf' };
  } finally {
    await parser.destroy().catch(() => {});
  }
}

async function extractDocx(filePath: string): Promise<ExtractResult> {
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ path: filePath });
  const text = (result.value ?? '').trim();
  return { text, chars: text.length, fileType: 'docx' };
}

async function extractXlsx(filePath: string, ext: 'xls' | 'xlsx'): Promise<ExtractResult> {
  const XLSX = await import('xlsx');
  const workbook = XLSX.readFile(filePath, { cellDates: true });
  const blocks: string[] = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const tsv = XLSX.utils.sheet_to_csv(sheet, { FS: '\t' }).trim();
    if (!tsv) continue;
    blocks.push(`# Sheet: ${sheetName}\n\n${tsv}`);
  }
  const text = blocks.join('\n\n---\n\n');
  return { text, chars: text.length, fileType: ext };
}
