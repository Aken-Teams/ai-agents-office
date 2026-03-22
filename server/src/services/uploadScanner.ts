/**
 * Upload Scanner — Security scanner for user-uploaded files.
 *
 * Validates file type, checks for malicious content (macros, scripts,
 * prompt injection in text files, CSV formula injection), and returns
 * a scan result before the file is accepted.
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
  '.csv', '.xlsx', '.xls',
  '.pdf',
  '.txt', '.md', '.json',
  '.docx', '.doc',
]);

const MIME_WHITELIST: Record<string, string[]> = {
  '.csv':  ['text/csv', 'text/plain', 'application/vnd.ms-excel'],
  '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  '.xls':  ['application/vnd.ms-excel'],
  '.pdf':  ['application/pdf'],
  '.txt':  ['text/plain'],
  '.md':   ['text/plain', 'text/markdown'],
  '.json': ['application/json', 'text/plain'],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  '.doc':  ['application/msword'],
};

// Magic bytes for file type verification
const MAGIC_BYTES: Record<string, number[]> = {
  '.pdf':  [0x25, 0x50, 0x44, 0x46],           // %PDF
  '.xlsx': [0x50, 0x4B, 0x03, 0x04],            // PK (ZIP)
  '.docx': [0x50, 0x4B, 0x03, 0x04],            // PK (ZIP)
  '.xls':  [0xD0, 0xCF, 0x11, 0xE0],            // OLE2
  '.doc':  [0xD0, 0xCF, 0x11, 0xE0],            // OLE2
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
// Validation: magic bytes
// ---------------------------------------------------------------------------

function validateMagicBytes(ext: string, filePath: string): boolean {
  const expected = MAGIC_BYTES[ext];
  if (!expected) return true; // no magic bytes to check for text files

  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(expected.length);
    fs.readSync(fd, buf, 0, expected.length, 0);
    fs.closeSync(fd);

    for (let i = 0; i < expected.length; i++) {
      if (buf[i] !== expected[i]) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Scan: Office macros (check for vbaProject.bin in ZIP-based Office files)
// ---------------------------------------------------------------------------

function checkOfficeMacros(filePath: string, ext: string): string | null {
  if (!['.xlsx', '.docx'].includes(ext)) return null;

  try {
    // Read ZIP file and search for vbaProject.bin signature
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
    // Check for JavaScript, Launch actions, embedded files
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
// Scan: Text content (prompt injection + CSV formula injection)
// ---------------------------------------------------------------------------

function checkTextContent(filePath: string, ext: string): { flag: string; detail: string } | null {
  const textExts = ['.csv', '.txt', '.md', '.json'];
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

  // 5. Office macro check
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

  // 7. Text content check (prompt injection + CSV formula)
  const textResult = checkTextContent(filePath, ext);
  if (textResult) {
    flags.push(textResult.flag);
    details.push(textResult.detail);
  }

  // Determine result
  if (flags.some(f => ['disallowed_extension', 'office_macro_detected', 'pdf_script_detected', 'csv_formula_injection', 'prompt_injection_in_file'].includes(f))) {
    // Log security event
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
    // Suspicious but not blocking
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
