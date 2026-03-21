import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';

const execFileAsync = promisify(execFile);

const OFFICE_EXTENSIONS = new Set(['docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt']);

/* ============================================================
   LibreOffice Detection (cross-platform)
   ============================================================ */
let libreOfficePath: string | null | undefined = undefined; // undefined = not checked yet

const SOFFICE_PATHS: Record<string, string[]> = {
  win32: [
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
  ],
  darwin: [
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  ],
  linux: [
    '/usr/bin/libreoffice',
    '/usr/bin/soffice',
    '/snap/bin/libreoffice',
  ],
};

async function findLibreOffice(): Promise<string | null> {
  if (libreOfficePath !== undefined) return libreOfficePath;

  const platform = process.platform as string;
  const candidates = SOFFICE_PATHS[platform] || SOFFICE_PATHS.linux;

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      libreOfficePath = p;
      console.log(`[FilePreview] LibreOffice found: ${p}`);
      return p;
    }
  }

  // Try PATH lookup
  try {
    const cmd = platform === 'win32' ? 'where' : 'which';
    const name = platform === 'win32' ? 'soffice.exe' : 'libreoffice';
    const { stdout } = await execFileAsync(cmd, [name]);
    const found = stdout.trim().split('\n')[0];
    if (found && fs.existsSync(found)) {
      libreOfficePath = found;
      console.log(`[FilePreview] LibreOffice found in PATH: ${found}`);
      return found;
    }
  } catch { /* not in PATH */ }

  libreOfficePath = null;
  console.log('[FilePreview] LibreOffice not found, using JS fallback');
  return null;
}

/* ============================================================
   Main Entry: Convert Office file to preview content
   ============================================================ */
export async function convertOfficeFile(
  filePath: string,
  ext: string,
): Promise<{ content: Buffer | string; mime: string }> {
  if (!OFFICE_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported file type: ${ext}`);
  }

  // Try LibreOffice PDF conversion first (best quality)
  const soffice = await findLibreOffice();
  if (soffice) {
    try {
      const pdfBuffer = await convertWithLibreOffice(soffice, filePath);
      return { content: pdfBuffer, mime: 'application/pdf' };
    } catch (err) {
      console.warn('[FilePreview] LibreOffice conversion failed, using JS fallback:', err);
    }
  }

  // JS fallback
  if (ext === 'docx' || ext === 'doc') {
    const html = await convertDocxToHtml(filePath);
    return { content: html, mime: 'text/html' };
  }
  if (ext === 'xlsx' || ext === 'xls') {
    const html = await convertXlsxToHtml(filePath);
    return { content: html, mime: 'text/html' };
  }
  if (ext === 'pptx' || ext === 'ppt') {
    const html = await convertPptxToHtml(filePath);
    return { content: html, mime: 'text/html' };
  }

  throw new Error(`No converter available for: ${ext}`);
}

/* ============================================================
   LibreOffice PDF Conversion
   ============================================================ */
async function convertWithLibreOffice(soffice: string, filePath: string): Promise<Buffer> {
  const tmpDir = path.join(path.dirname(filePath), '.preview-cache');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const basename = path.basename(filePath, path.extname(filePath));
  const pdfPath = path.join(tmpDir, `${basename}.pdf`);

  // Use cached PDF if it's newer than source
  if (fs.existsSync(pdfPath)) {
    const srcStat = fs.statSync(filePath);
    const pdfStat = fs.statSync(pdfPath);
    if (pdfStat.mtimeMs > srcStat.mtimeMs) {
      return fs.readFileSync(pdfPath);
    }
  }

  await execFileAsync(soffice, [
    '--headless',
    '--convert-to', 'pdf',
    '--outdir', tmpDir,
    filePath,
  ], { timeout: 30000 });

  if (!fs.existsSync(pdfPath)) {
    throw new Error('LibreOffice conversion did not produce PDF');
  }

  return fs.readFileSync(pdfPath);
}

/* ============================================================
   JS Fallback Converters
   ============================================================ */

async function convertDocxToHtml(filePath: string): Promise<string> {
  const result = await mammoth.convertToHtml({ path: filePath });
  return wrapHtml('Word 文件預覽', result.value);
}

async function convertXlsxToHtml(filePath: string): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  let html = '';
  workbook.eachSheet((sheet) => {
    html += `<h2 style="margin:16px 0 8px;font-size:16px;font-weight:700;color:#dae2fd;">${esc(sheet.name)}</h2>`;
    html += '<table style="border-collapse:collapse;width:100%;margin-bottom:24px;">';

    let isFirst = true;
    sheet.eachRow((row, rowNum) => {
      const tag = isFirst ? 'th' : 'td';
      html += '<tr>';
      row.eachCell({ includeEmpty: true }, (cell) => {
        const bg = isFirst ? 'background:#222a3d;' : '';
        html += `<${tag} style="border:1px solid #44474d;padding:6px 10px;text-align:left;font-size:13px;${bg}">${esc(cell.text || '')}</${tag}>`;
      });
      html += '</tr>';
      if (rowNum === 1) isFirst = false;
    });
    html += '</table>';
  });

  return wrapHtml('Excel 試算表預覽', html);
}

async function convertPptxToHtml(filePath: string): Promise<string> {
  const data = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(data);

  const slideFiles: string[] = [];
  zip.forEach((p) => {
    if (/^ppt\/slides\/slide\d+\.xml$/.test(p)) slideFiles.push(p);
  });
  slideFiles.sort((a, b) => {
    const na = parseInt(a.match(/slide(\d+)/)?.[1] || '0');
    const nb = parseInt(b.match(/slide(\d+)/)?.[1] || '0');
    return na - nb;
  });

  let html = '';
  for (let i = 0; i < slideFiles.length; i++) {
    const xml = await zip.file(slideFiles[i])!.async('text');
    const texts = extractSlideTexts(xml);

    html += `<div style="background:#171f33;border:1px solid #44474d;padding:32px;margin-bottom:16px;position:relative;">`;
    html += `<div style="position:absolute;top:12px;right:16px;font-size:10px;color:#8f9097;font-family:monospace;">SLIDE ${String(i + 1).padStart(2, '0')}</div>`;

    if (texts.length > 0) {
      html += `<h3 style="font-size:18px;font-weight:700;color:#dae2fd;margin:0 0 12px;font-family:'Space Grotesk',sans-serif;">${esc(texts[0])}</h3>`;
      for (let j = 1; j < texts.length; j++) {
        html += `<p style="font-size:14px;color:#c5c6cd;margin:4px 0;line-height:1.6;">${esc(texts[j])}</p>`;
      }
    } else {
      html += `<p style="font-size:13px;color:#8f9097;font-style:italic;">（此投影片無文字內容）</p>`;
    }
    html += '</div>';
  }

  if (slideFiles.length === 0) {
    html = '<p style="color:#8f9097;">無法解析投影片內容。</p>';
  }

  return wrapHtml(`簡報預覽 — ${slideFiles.length} 張投影片`, html);
}

function extractSlideTexts(xml: string): string[] {
  const paragraphs: string[] = [];
  const pRegex = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g;
  let pMatch;
  while ((pMatch = pRegex.exec(xml)) !== null) {
    const parts: string[] = [];
    const tRegex = /<a:t>([\s\S]*?)<\/a:t>/g;
    let tMatch;
    while ((tMatch = tRegex.exec(pMatch[1])) !== null) {
      parts.push(tMatch[1]);
    }
    const text = parts.join('').trim();
    if (text) paragraphs.push(text);
  }
  return paragraphs;
}

/* ============================================================
   Helpers
   ============================================================ */
function esc(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function wrapHtml(title: string, body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',-apple-system,sans-serif;background:#0b1326;color:#c5c6cd;padding:24px;line-height:1.6}
h1{font-family:'Space Grotesk',sans-serif;font-size:14px;color:#00dbe9;margin-bottom:16px;text-transform:uppercase;letter-spacing:0.2em;font-weight:700}
img{max-width:100%;height:auto}
</style></head><body>
<h1>${esc(title)}</h1>
${body}
</body></html>`;
}
