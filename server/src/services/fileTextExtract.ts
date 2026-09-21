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
import JSZip from 'jszip';

/** Formats that are already text; read as UTF-8 and hand straight over. */
export const TEXT_EXTS = new Set(['txt', 'csv', 'tsv', 'md', 'log', 'json', 'xml', 'html', 'htm']);

/**
 * Raster formats Claude's vision accepts. These are NOT extracted — they go to
 * the model as image blocks, so there is no text step and no file-read surface.
 */
export const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

/** Formats worth parsing into text. */
export const DOC_EXTS = new Set(['pdf', 'docx', 'xlsx', 'xls', 'pptx']);

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
/** Slide/notes files sort as text, so slide10 lands between slide1 and slide2. */
const slideNumber = (name: string) => Number((name.match(/(\d+)\.xml$/) || [])[1] || 0);

/** `<a:t>…</a:t>` is where every visible run of text in a slide lives. */
function runsFrom(xml: string): string[] {
  return [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
    .map(m => m[1]
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&'))
    .filter(t => t.trim());
}

/**
 * A .pptx as text, slide by slide.
 *
 * ── Why this exists ──
 * .pptx was simply absent from DOC_EXTS, so uploading a deck was refused as an
 * unsupported format — in a product whose third add-in is a PowerPoint add-in.
 * Comparing this quarter's deck against last quarter's, or pulling the numbers
 * out of a deck into a workbook, were both impossible for want of a parser.
 *
 * ── Why by hand rather than a library ──
 * A .pptx is a zip of XML and jszip was already a dependency. The alternative
 * was adding a parser for one function's worth of work. Slide text is entirely
 * inside `<a:t>` runs, which makes the extraction a regex rather than a document
 * model — good enough for reading, and this module only ever produces text.
 *
 * Speaker notes come too, under their own heading. They are often where the
 * argument actually lives, and the notes pane is the one place the JS API cannot
 * reach — so a deck the add-in itself cannot read the notes of can still have
 * them read here, when someone uploads it.
 */
async function extractPptx(buf: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf);

  const slides = Object.keys(zip.files)
    .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => slideNumber(a) - slideNumber(b));
  const notes = Object.keys(zip.files)
    .filter(n => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n))
    .sort((a, b) => slideNumber(a) - slideNumber(b));

  const noteFor = new Map(notes.map(n => [slideNumber(n), n]));
  const out: string[] = [];

  for (const name of slides) {
    const n = slideNumber(name);
    const text = runsFrom(await zip.file(name)!.async('string'));
    out.push(`# 投影片 ${n}`);
    if (text.length) out.push(...text);

    const noteFile = noteFor.get(n);
    if (noteFile) {
      const noteText = runsFrom(await zip.file(noteFile)!.async('string'))
        // PowerPoint puts the slide number itself in the notes XML as a
        // placeholder run; it is not something anybody wrote.
        .filter(t => t.trim() !== String(n));
      if (noteText.length) out.push(`## 備忘稿`, ...noteText);
    }
  }

  return out.join('\n');
}

/**
 * One spreadsheet cell as text.
 *
 * Exists for the date case. exceljs parses a date cell into a JS Date, and its
 * own `.text` then renders that with Date#toString — so a cell showing 2024/1/1
 * came out as 「Mon Jan 01 2024 08:00:00 GMT+0800 (台北標準時間)」. That is wrong
 * for every reader of this text: the model sees a wall of timezone noise instead
 * of a date, and excel_compare_source, which diffs this against what Excel hands
 * back for the same cell (the serial 45292), reported EVERY dated row as a
 * difference. ISO instead — unambiguous, sorts correctly, and both sides of a
 * comparison can recognise it.
 *
 * The time is kept only when there is one. A pure date carrying 00:00:00 reads
 * as false precision, and it would not match the same date written plainly.
 */
function cellToText(cell: { text?: string; value?: unknown }): string {
  const v = cell.value;
  if (v instanceof Date) {
    const iso = v.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' ');
  }
  return String(cell.text ?? '');
}

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
        row.eachCell({ includeEmpty: false }, cell => cells.push(cellToText(cell)));
        if (cells.length) lines.push(cells.join('\t'));
      });
    });
    return lines.join('\n');
  }
  if (e === 'pptx') return extractPptx(buf);
  if (TEXT_EXTS.has(e)) {
    return buf.toString('utf8');
  }
  throw new Error('unsupported');
}
