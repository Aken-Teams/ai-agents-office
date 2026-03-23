/**
 * Upload Scanner — Security scanner for user-uploaded files.
 *
 * Validates file type, checks for malicious content (macros, scripts,
 * prompt injection in text files, CSV formula injection, SVG/HTML scripts,
 * image polyglot detection), and returns a scan result before the file is accepted.
 *
 * Supported categories:
 * - Documents: PDF, DOCX, DOC, TXT, MD
 * - Data: CSV, XLSX, XLS, JSON, XML, YAML/YML
 * - Presentations: PPTX, PPT
 * - Images: PNG, JPG/JPEG, GIF, WEBP, BMP, SVG, TIFF/TIF, ICO
 * - Web: HTML/HTM
 */

import fs from 'fs';
import path from 'path';
import { analyzeFileContent, logSecurityEvent } from './inputGuard.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScanResult {
  status: 'clean' | 'suspicious' | 'rejected';
  detail: string;
  flags: string[];
}

// ---------------------------------------------------------------------------
// Allowed file types
// ---------------------------------------------------------------------------

const ALLOWED_EXTENSIONS = new Set([
  // Data
  '.csv', '.xlsx', '.xls', '.json', '.xml', '.yaml', '.yml',
  // Documents
  '.pdf', '.txt', '.md', '.docx', '.doc',
  // Presentations
  '.pptx', '.ppt',
  // Images
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.tiff', '.tif', '.ico',
  // Web
  '.html', '.htm',
]);

const MIME_WHITELIST: Record<string, string[]> = {
  // Data
  '.csv':  ['text/csv', 'text/plain', 'application/vnd.ms-excel'],
  '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  '.xls':  ['application/vnd.ms-excel'],
  '.json': ['application/json', 'text/plain'],
  '.xml':  ['text/xml', 'application/xml', 'text/plain'],
  '.yaml': ['text/yaml', 'text/x-yaml', 'application/x-yaml', 'text/plain'],
  '.yml':  ['text/yaml', 'text/x-yaml', 'application/x-yaml', 'text/plain'],
  // Documents
  '.pdf':  ['application/pdf'],
  '.txt':  ['text/plain'],
  '.md':   ['text/plain', 'text/markdown'],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  '.doc':  ['application/msword'],
  // Presentations
  '.pptx': ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  '.ppt':  ['application/vnd.ms-powerpoint'],
  // Images
  '.png':  ['image/png'],
  '.jpg':  ['image/jpeg'],
  '.jpeg': ['image/jpeg'],
  '.gif':  ['image/gif'],
  '.webp': ['image/webp'],
  '.bmp':  ['image/bmp', 'image/x-ms-bmp'],
  '.svg':  ['image/svg+xml', 'text/xml', 'application/xml'],
  '.tiff': ['image/tiff'],
  '.tif':  ['image/tiff'],
  '.ico':  ['image/x-icon', 'image/vnd.microsoft.icon'],
  // Web
  '.html': ['text/html'],
  '.htm':  ['text/html'],
};

// Magic bytes for file type verification (binary files only)
const MAGIC_BYTES: Record<string, number[][]> = {
  // Documents
  '.pdf':  [[0x25, 0x50, 0x44, 0x46]],                        // %PDF
  '.docx': [[0x50, 0x4B, 0x03, 0x04]],                        // PK (ZIP)
  '.doc':  [[0xD0, 0xCF, 0x11, 0xE0]],                        // OLE2
  // Data
  '.xlsx': [[0x50, 0x4B, 0x03, 0x04]],                        // PK (ZIP)
  '.xls':  [[0xD0, 0xCF, 0x11, 0xE0]],                        // OLE2
  // Presentations
  '.pptx': [[0x50, 0x4B, 0x03, 0x04]],                        // PK (ZIP)
  '.ppt':  [[0xD0, 0xCF, 0x11, 0xE0]],                        // OLE2
  // Images
  '.png':  [[0x89, 0x50, 0x4E, 0x47]],                        // .PNG
  '.jpg':  [[0xFF, 0xD8, 0xFF]],                               // JFIF/EXIF
  '.jpeg': [[0xFF, 0xD8, 0xFF]],                               // JFIF/EXIF
  '.gif':  [[0x47, 0x49, 0x46, 0x38]],                        // GIF8
  '.webp': [[0x52, 0x49, 0x46, 0x46]],                        // RIFF
  '.bmp':  [[0x42, 0x4D]],                                     // BM
  '.tiff': [[0x49, 0x49, 0x2A, 0x00], [0x4D, 0x4D, 0x00, 0x2A]], // II or MM
  '.tif':  [[0x49, 0x49, 0x2A, 0x00], [0x4D, 0x4D, 0x00, 0x2A]],
  '.ico':  [[0x00, 0x00, 0x01, 0x00]],                        // ICO
};

// Max file size: 50MB
const MAX_FILE_SIZE = 50 * 1024 * 1024;

// Max upload quota per user: 500MB
export const UPLOAD_QUOTA_BYTES = 500 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Validation: file extension
// ---------------------------------------------------------------------------

export function isAllowedExtension(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return ALLOWED_EXTENSIONS.has(ext);
}

// ---------------------------------------------------------------------------
// Validation: file size
// ---------------------------------------------------------------------------

export function isAllowedSize(size: number): boolean {
  return size > 0 && size <= MAX_FILE_SIZE;
}

// ---------------------------------------------------------------------------
// Validation: MIME type
// ---------------------------------------------------------------------------

function validateMimeType(ext: string, declaredMime: string | undefined): boolean {
  if (!declaredMime) return true; // if no mime declared, skip (rely on magic bytes)
  const allowed = MIME_WHITELIST[ext];
  if (!allowed) return false;
  return allowed.includes(declaredMime);
}

// ---------------------------------------------------------------------------
// Validation: magic bytes (supports multiple valid signatures per extension)
// ---------------------------------------------------------------------------

function validateMagicBytes(ext: string, filePath: string): boolean {
  const expected = MAGIC_BYTES[ext];
  if (!expected) return true; // no magic bytes to check for text files

  try {
    const maxLen = Math.max(...expected.map(sig => sig.length));
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(maxLen);
    fs.readSync(fd, buf, 0, maxLen, 0);
    fs.closeSync(fd);

    // Match ANY of the valid signatures
    return expected.some(sig => {
      for (let i = 0; i < sig.length; i++) {
        if (buf[i] !== sig[i]) return false;
      }
      return true;
    });
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Scan: Office macros (check for vbaProject.bin in ZIP-based Office files)
// ---------------------------------------------------------------------------

function checkOfficeMacros(filePath: string, ext: string): string | null {
  if (!['.xlsx', '.docx', '.pptx'].includes(ext)) return null;

  try {
    const content = fs.readFileSync(filePath);
    const vbaSignature = Buffer.from('vbaProject.bin');
    if (content.includes(vbaSignature)) {
      return 'office_macro_detected';
    }
  } catch {
    // If we can't read the file, skip this check
  }
  return null;
}

// ---------------------------------------------------------------------------
// Scan: PDF JavaScript
// ---------------------------------------------------------------------------

function checkPdfScripts(filePath: string, ext: string): string | null {
  if (ext !== '.pdf') return null;

  try {
    const content = fs.readFileSync(filePath, 'latin1');
    const suspicious = [
      /\/JavaScript\s/i,
      /\/JS\s*\(/i,
      /\/Launch\s/i,
      /\/EmbeddedFile\s/i,
      /\/AA\s*<</i,     // Auto-action
      /\/OpenAction\s/i,
    ];

    for (const p of suspicious) {
      if (p.test(content)) {
        return 'pdf_script_detected';
      }
    }
  } catch {
    // skip
  }
  return null;
}

// ---------------------------------------------------------------------------
// Scan: SVG scripts (SVG can embed JavaScript, event handlers, external refs)
// ---------------------------------------------------------------------------

function checkSvgScripts(filePath: string, ext: string): string | null {
  if (ext !== '.svg') return null;

  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(200 * 1024); // check first 200KB
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);

    const content = buf.toString('utf8', 0, bytesRead).toLowerCase();

    // Check for embedded scripts and dangerous patterns
    const dangerous = [
      /<script[\s>]/,                  // <script> tags
      /javascript\s*:/,                // javascript: URIs
      /on\w+\s*=/,                     // event handlers (onclick, onload, onerror, etc.)
      /xlink:href\s*=\s*["']data:/,    // data: URI in xlink
      /<foreignobject[\s>]/,           // foreignObject can embed HTML
      /<iframe[\s>]/,                  // embedded iframes
      /<embed[\s>]/,                   // embedded objects
      /set\s*=\s*["'].*<!\[cdata\[/,   // CDATA injection
    ];

    for (const p of dangerous) {
      if (p.test(content)) {
        return 'svg_script_detected';
      }
    }
  } catch {
    // skip
  }
  return null;
}

// ---------------------------------------------------------------------------
// Scan: HTML scripts
// ---------------------------------------------------------------------------

function checkHtmlScripts(filePath: string, ext: string): string | null {
  if (!['.html', '.htm'].includes(ext)) return null;

  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(200 * 1024);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);

    const content = buf.toString('utf8', 0, bytesRead).toLowerCase();

    // Trusted CDN patterns — allow <script src="https://cdn.jsdelivr.net/..."> etc.
    const trustedCdns = [
      'cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'unpkg.com',
      'fonts.googleapis.com', 'fonts.gstatic.com',
    ];

    // Check for inline scripts with dangerous content (not just any <script> tag)
    // Extract all inline script blocks (not external <script src="...">)
    const scriptBlocks = content.match(/<script(?:\s[^>]*)?>[\s\S]*?<\/script>/gi) || [];
    for (const block of scriptBlocks) {
      // Skip external CDN scripts
      const srcMatch = block.match(/src\s*=\s*["']([^"']+)["']/i);
      if (srcMatch) {
        const src = srcMatch[1];
        if (trustedCdns.some(cdn => src.includes(cdn))) continue;
        // External script from unknown source — suspicious but not necessarily dangerous
        continue; // Let other checks catch truly dangerous patterns
      }

      // Inline script — check for dangerous API calls
      const dangerousInline = [
        /document\.cookie/,
        /document\.write\s*\(/,
        /\.innerHTML\s*=/,
        /eval\s*\(/,
        /new\s+function\s*\(/i,
        /window\.location\s*=/,
        /fetch\s*\(\s*["']http/,
        /xmlhttprequest/i,
        /navigator\.sendbeacon/i,
      ];
      for (const p of dangerousInline) {
        if (p.test(block)) {
          return 'html_script_detected';
        }
      }
    }

    // Check non-script dangerous patterns
    const dangerous = [
      /javascript\s*:/,                // javascript: URIs
      /on\w+\s*=\s*["'][^"']*(?:eval|alert|document\.|window\.|fetch|xmlhttp)/,  // dangerous event handlers
      /<iframe[^>]+src\s*=\s*["'](?!about:blank)/,  // iframes loading external content
      /<object[\s>]/,                  // embedded objects
      /<embed[\s>]/,                   // embedded content
      /<applet[\s>]/,                  // Java applets
      /<form[^>]+action\s*=\s*["']http/,  // forms posting to external URLs
    ];

    for (const p of dangerous) {
      if (p.test(content)) {
        return 'html_script_detected';
      }
    }
  } catch {
    // skip
  }
  return null;
}

// ---------------------------------------------------------------------------
// Scan: Image polyglot detection (image with embedded scripts/executables)
// ---------------------------------------------------------------------------

function checkImagePolyglot(filePath: string, ext: string): string | null {
  const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.ico'];
  if (!imageExts.includes(ext)) return null;

  try {
    // Read first 64KB to check for embedded dangerous content
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);

    const content = buf.toString('latin1', 0, bytesRead);

    // Check for polyglot patterns (scripts hidden in image data)
    const polyglotPatterns = [
      /<script[\s>]/i,                 // HTML script tag
      /<%.*%>/,                        // Server-side code (ASP/JSP)
      /<\?php/i,                       // PHP code
      /\x00\x00\x00\x00MZ/,           // PE executable after null bytes
    ];

    for (const p of polyglotPatterns) {
      if (p.test(content)) {
        return 'image_polyglot_detected';
      }
    }
  } catch {
    // skip
  }
  return null;
}

// ---------------------------------------------------------------------------
// Scan: Text content (prompt injection + CSV formula injection)
// ---------------------------------------------------------------------------

function checkTextContent(filePath: string, ext: string): { flag: string; detail: string } | null {
  const textExts = ['.csv', '.txt', '.md', '.json', '.xml', '.yaml', '.yml'];
  if (!textExts.includes(ext)) return null;

  try {
    // Read first 100KB for scanning
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(100 * 1024);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);

    const content = buf.toString('utf8', 0, bytesRead);

    // CSV formula injection
    if (ext === '.csv') {
      const lines = content.split('\n');
      for (const line of lines.slice(0, 100)) {
        const cells = line.split(',');
        for (const cell of cells) {
          const trimmed = cell.trim().replace(/^["']|["']$/g, '');
          if (/^[=+\-@]/.test(trimmed)) {
            const dangerousFormula = /^[=+\-@]\s*(?:CMD|EXEC|SYSTEM|SHELL|HYPERLINK|IMPORTXML|IMPORTDATA|IMPORTRANGE|IMPORTFEED)\s*\(/i;
            if (dangerousFormula.test(trimmed)) {
              return { flag: 'csv_formula_injection', detail: `Dangerous formula detected: ${trimmed.slice(0, 50)}` };
            }
          }
        }
      }
    }

    // XML external entity (XXE) detection
    if (ext === '.xml') {
      const xxePatterns = [
        /<!ENTITY\s+\w+\s+SYSTEM/i,       // External entity
        /<!ENTITY\s+%\s+\w+\s+SYSTEM/i,   // Parameter external entity
        /<!DOCTYPE[^>]*\[\s*<!ENTITY/i,    // DOCTYPE with entity declaration
      ];
      for (const p of xxePatterns) {
        if (p.test(content)) {
          return { flag: 'xml_xxe_detected', detail: 'XML External Entity (XXE) pattern detected' };
        }
      }
    }

    // Prompt injection in text content
    const guard = analyzeFileContent(content, path.basename(filePath));
    if (guard.blocked) {
      return { flag: 'prompt_injection_in_file', detail: `Flags: ${guard.flags.join(', ')} (score: ${guard.score})` };
    }
    if (!guard.safe) {
      return { flag: 'suspicious_content', detail: `Warning flags: ${guard.flags.join(', ')} (score: ${guard.score})` };
    }
  } catch {
    // skip unreadable
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main scan function
// ---------------------------------------------------------------------------

// Flags that trigger immediate rejection
const REJECT_FLAGS = new Set([
  'disallowed_extension',
  'office_macro_detected',
  'pdf_script_detected',
  'svg_script_detected',
  'html_script_detected',
  'image_polyglot_detected',
  'xml_xxe_detected',
  'csv_formula_injection',
  'prompt_injection_in_file',
]);

export function scanUploadedFile(
  filePath: string,
  originalName: string,
  declaredMime?: string,
  userId?: string,
): ScanResult {
  const ext = path.extname(originalName).toLowerCase();
  const flags: string[] = [];
  const details: string[] = [];

  // 1. Extension check
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return { status: 'rejected', detail: `不允許的檔案類型: ${ext}`, flags: ['disallowed_extension'] };
  }

  // 2. Size check
  try {
    const stat = fs.statSync(filePath);
    if (!isAllowedSize(stat.size)) {
      return { status: 'rejected', detail: `檔案大小超出限制 (最大 ${MAX_FILE_SIZE / 1024 / 1024}MB)`, flags: ['file_too_large'] };
    }
  } catch {
    return { status: 'rejected', detail: '無法讀取檔案', flags: ['unreadable'] };
  }

  // 3. MIME type check
  if (declaredMime && !validateMimeType(ext, declaredMime)) {
    flags.push('mime_mismatch');
    details.push(`MIME 類型不符: expected ${MIME_WHITELIST[ext]?.join('|')}, got ${declaredMime}`);
  }

  // 4. Magic bytes check
  if (!validateMagicBytes(ext, filePath)) {
    flags.push('magic_bytes_mismatch');
    details.push('檔案標頭與副檔名不符');
  }

  // 5. Office macro check (XLSX, DOCX, PPTX)
  const macroResult = checkOfficeMacros(filePath, ext);
  if (macroResult) {
    flags.push(macroResult);
    details.push('偵測到 Office 巨集 (macro)');
  }

  // 6. PDF script check
  const pdfResult = checkPdfScripts(filePath, ext);
  if (pdfResult) {
    flags.push(pdfResult);
    details.push('偵測到 PDF 內嵌腳本');
  }

  // 7. SVG script check
  const svgResult = checkSvgScripts(filePath, ext);
  if (svgResult) {
    flags.push(svgResult);
    details.push('偵測到 SVG 內嵌腳本或事件處理器');
  }

  // 8. HTML script check
  const htmlResult = checkHtmlScripts(filePath, ext);
  if (htmlResult) {
    flags.push(htmlResult);
    details.push('偵測到 HTML 內嵌腳本或危險元素');
  }

  // 9. Image polyglot check
  const polyglotResult = checkImagePolyglot(filePath, ext);
  if (polyglotResult) {
    flags.push(polyglotResult);
    details.push('偵測到圖片檔案中嵌入可疑程式碼');
  }

  // 10. Text content check (prompt injection + CSV formula + XXE)
  const textResult = checkTextContent(filePath, ext);
  if (textResult) {
    flags.push(textResult.flag);
    details.push(textResult.detail);
  }

  // Determine result
  if (flags.some(f => REJECT_FLAGS.has(f))) {
    if (userId) {
      logSecurityEvent(userId, 'suspicious_upload', 'high',
        `Rejected upload: ${originalName} — ${details.join('; ')}`,
        originalName);
    }
    return {
      status: 'rejected',
      detail: details.join('; '),
      flags,
    };
  }

  if (flags.length > 0) {
    if (userId) {
      logSecurityEvent(userId, 'suspicious_upload', 'medium',
        `Suspicious upload: ${originalName} — ${details.join('; ')}`,
        originalName);
    }
    return {
      status: 'suspicious',
      detail: details.join('; '),
      flags,
    };
  }

  return { status: 'clean', detail: '通過所有安全檢查', flags: [] };
}
