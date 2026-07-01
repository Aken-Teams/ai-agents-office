import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { dbGet, dbAll, dbRun } from '../db.js';
import { config } from '../config.js';
import { scanSandboxFiles, validateFilePath } from './sandbox.js';
import { sanitizePptxFile } from './pptxSanitizer.js';
import type { GeneratedFile, DocType, DocumentBlock } from '../types.js';

/**
 * Scan sandbox directory for new or updated files and register them in the database.
 * Supports versioning: if a file with the same path exists and file size changed,
 * a new version record is created.
 */
export async function registerNewFiles(
  userId: string,
  conversationId: string,
  sandboxPath: string,
  existingFilePaths: Set<string>,
  // Whitelist of deliverable file types the user actually requested (the output
  // types of the generator skills that ran this turn). When provided, ONLY files
  // of these types are registered — so scratch of any other type (analysis .md,
  // .json, extracted .png, an unwanted .pdf…) is dropped regardless of its name.
  expectedTypes?: Set<string>,
): Promise<GeneratedFile[]> {
  const scannedFiles = scanSandboxFiles(sandboxPath);
  const newFiles: GeneratedFile[] = [];
  const useWhitelist = !!expectedTypes && expectedTypes.size > 0;

  for (const file of scannedFiles) {
    // Only keep deliverables of the requested type(s). Type-based, not name-based,
    // so however the agent names its scratch files it won't slip through.
    if (useWhitelist && !expectedTypes!.has(file.fileType)) continue;

    const fullPath = path.join(config.workspaceRoot, file.filePath);

    // Security: verify file is within user's workspace
    if (!validateFilePath(userId, fullPath)) {
      console.error(`[SECURITY] File outside sandbox detected: ${fullPath}`);
      continue;
    }

    if (existingFilePaths.has(file.filePath)) {
      // File path already registered — check if content changed (by size)
      const existing = await dbGet<GeneratedFile>(
        'SELECT * FROM generated_files WHERE conversation_id = ? AND file_path = ? ORDER BY version DESC LIMIT 1',
        conversationId, file.filePath
      );

      if (!existing || existing.file_size === file.fileSize) continue;

      // Repair OOXML packaging defects before registering/serving (pptxgenjs
      // 4.0.1 emits orphan slideMaster Overrides in [Content_Types].xml that
      // strict Office builds — 2019/2024/LTSC — reject with a "repair" prompt).
      // Idempotent; re-stat size if the file was actually rewritten.
      if (await sanitizePptxFile(fullPath)) {
        try { file.fileSize = fs.statSync(fullPath).size; } catch { /* keep scanned size */ }
      }

      // File was overwritten with different content — create new version
      // Point old DB record to the versioned backup (created by snapshotExistingFiles)
      const ext = path.extname(existing.file_path);
      const base = existing.file_path.slice(0, -ext.length);
      const versionedPath = `${base}.v${existing.version}${ext}`;
      const versionedFullPath = path.join(config.workspaceRoot, versionedPath);

      if (fs.existsSync(versionedFullPath)) {
        // Snapshot backup exists — just update DB to point to it
        await dbRun(
          'UPDATE generated_files SET file_path = ? WHERE id = ?',
          versionedPath, existing.id
        );
      } else {
        // Fallback: try to copy (backup wasn't pre-created)
        const oldFullPath = path.join(config.workspaceRoot, existing.file_path);
        if (fs.existsSync(oldFullPath)) {
          try {
            fs.copyFileSync(oldFullPath, versionedFullPath);
            await dbRun(
              'UPDATE generated_files SET file_path = ? WHERE id = ?',
              versionedPath, existing.id
            );
          } catch (err) {
            console.error(`[FileManager] Failed to backup version ${existing.version}:`, err);
          }
        }
      }

      const newVersion = (existing.version || 1) + 1;
      const id = uuidv4();

      await dbRun(
        `INSERT INTO generated_files (id, user_id, conversation_id, filename, file_path, file_type, file_size, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id, userId, conversationId, file.filename, file.filePath, file.fileType, file.fileSize, newVersion
      );

      newFiles.push({
        id,
        user_id: userId,
        conversation_id: conversationId,
        filename: file.filename,
        file_path: file.filePath,
        file_type: file.fileType,
        file_size: file.fileSize,
        version: newVersion,
        created_at: new Date().toISOString(),
      });

      continue;
    }

    // Brand new file — version 1.
    // Repair OOXML packaging defects first (see note above). Idempotent.
    if (await sanitizePptxFile(fullPath)) {
      try { file.fileSize = fs.statSync(fullPath).size; } catch { /* keep scanned size */ }
    }
    const id = uuidv4();
    await dbRun(
      `INSERT INTO generated_files (id, user_id, conversation_id, filename, file_path, file_type, file_size, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      id, userId, conversationId, file.filename, file.filePath, file.fileType, file.fileSize
    );

    newFiles.push({
      id,
      user_id: userId,
      conversation_id: conversationId,
      filename: file.filename,
      file_path: file.filePath,
      file_type: file.fileType,
      file_size: file.fileSize,
      version: 1,
      created_at: new Date().toISOString(),
    });
  }

  return newFiles;
}

/**
 * Pre-snapshot existing files before an agent runs, so old versions are preserved
 * even if the agent overwrites files with the same name.
 * Must be called BEFORE the agent executes.
 */
export async function snapshotExistingFiles(
  userId: string,
  conversationId: string,
): Promise<void> {
  // Get latest version of each filename in this conversation
  const files = await dbAll<GeneratedFile>(
    `SELECT gf.* FROM generated_files gf
     WHERE gf.conversation_id = ? AND gf.version = (
       SELECT MAX(gf2.version) FROM generated_files gf2
       WHERE gf2.conversation_id = gf.conversation_id AND gf2.filename = gf.filename
     )`,
    conversationId
  );

  for (const file of files) {
    const fullPath = path.join(config.workspaceRoot, file.file_path);
    if (!fs.existsSync(fullPath)) continue;

    // Skip if already at a versioned path (e.g., file.v1.html)
    const ext = path.extname(file.file_path);
    const base = file.file_path.slice(0, -ext.length);
    if (/\.v\d+$/.test(base)) continue;

    const versionedPath = `${base}.v${file.version}${ext}`;
    const versionedFullPath = path.join(config.workspaceRoot, versionedPath);

    try {
      fs.copyFileSync(fullPath, versionedFullPath);
    } catch (err) {
      console.error(`[FileManager] Failed to snapshot ${file.filename} v${file.version}:`, err);
    }
  }
}

/**
 * Get the set of already-registered file paths for a conversation.
 */
export async function getExistingFilePaths(conversationId: string): Promise<Set<string>> {
  const files = await dbAll<{ file_path: string }>(
    'SELECT file_path FROM generated_files WHERE conversation_id = ?',
    conversationId
  );

  return new Set(files.map(f => f.file_path));
}

/**
 * Get the absolute path for downloading a file, with security validation.
 */
export async function getFileDownloadPath(userId: string, fileId: string): Promise<string | null> {
  const file = await dbGet<GeneratedFile>(
    'SELECT * FROM generated_files WHERE id = ? AND user_id = ?',
    fileId, userId
  );

  if (!file) return null;

  const fullPath = path.join(config.workspaceRoot, file.file_path);

  // Security check
  if (!validateFilePath(userId, fullPath)) return null;
  if (!fs.existsSync(fullPath)) return null;

  return fullPath;
}

/**
 * Get all versions of a file (same filename + conversation).
 */
export async function getFileVersions(userId: string, fileId: string): Promise<GeneratedFile[]> {
  const file = await dbGet<GeneratedFile>(
    'SELECT * FROM generated_files WHERE id = ? AND user_id = ?',
    fileId, userId
  );

  if (!file || !file.conversation_id) return [];

  return await dbAll<GeneratedFile>(
    `SELECT * FROM generated_files
     WHERE user_id = ? AND conversation_id = ? AND filename = ?
     ORDER BY version DESC`,
    userId, file.conversation_id, file.filename
  );
}

/**
 * Delete a file from disk and database.
 */
export async function deleteFile(userId: string, fileId: string): Promise<boolean> {
  const file = await dbGet<GeneratedFile>(
    'SELECT * FROM generated_files WHERE id = ? AND user_id = ?',
    fileId, userId
  );

  if (!file) return false;

  const fullPath = path.join(config.workspaceRoot, file.file_path);
  if (validateFilePath(userId, fullPath) && fs.existsSync(fullPath)) {
    // Only delete from disk if no other version uses this path
    const otherVersions = await dbGet<{ cnt: number }>(
      'SELECT COUNT(*) as cnt FROM generated_files WHERE file_path = ? AND id != ?',
      file.file_path, fileId
    );
    if (!otherVersions || otherVersions.cnt === 0) {
      fs.unlinkSync(fullPath);
    }
  }

  await dbRun('DELETE FROM generated_files WHERE id = ?', fileId);
  return true;
}

// ---------------------------------------------------------------------------
// Block capture — intercept input.json written by agents
// ---------------------------------------------------------------------------

/** Map file extension → doc type for block capture */
const EXT_TO_DOC_TYPE: Record<string, DocType> = {
  pptx: 'pptx', docx: 'docx', xlsx: 'xlsx', pdf: 'pdf',
};

/** Agent skill ids that use generator scripts with input.json */
const GENERATOR_SKILLS = ['pptx-gen', 'docx-gen', 'xlsx-gen', 'pdf-gen', 'slides-gen'];

/**
 * After a file is registered, scan agent directories for input.json
 * and store the structured block data in document_blocks table.
 */
export async function captureBlocksForFile(
  fileRecord: GeneratedFile,
  userId: string,
  conversationId: string,
  sandboxPath: string,
): Promise<DocumentBlock[] | null> {
  // Determine doc type from file extension
  const ext = fileRecord.file_type.replace('.', '').toLowerCase();
  let docType: DocType | undefined = EXT_TO_DOC_TYPE[ext];

  // For HTML files, determine if it's slides or webapp based on which agent produced it
  const isHtml = ext === 'html' || ext === 'htm';

  // Collect all directories to search: agent dirs + sandbox root
  const searchDirs: { dir: string; skillId?: string }[] = [];
  for (const skillId of GENERATOR_SKILLS) {
    const agentDir = path.join(sandboxPath, '_agents', skillId);
    if (fs.existsSync(agentDir)) {
      searchDirs.push({ dir: agentDir, skillId });
    }
  }
  // Also search sandbox root (some agents write JSON alongside the output file)
  searchDirs.push({ dir: sandboxPath });

  for (const { dir, skillId } of searchDirs) {
    // Find input JSON: try well-known names first, then any *.json with slides/sections/sheets
    let inputJsonPath: string | null = null;

    const wellKnownNames = ['input.json', 'slides.json', 'sections.json', 'sheets.json'];
    for (const name of wellKnownNames) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) { inputJsonPath = p; break; }
    }

    if (!inputJsonPath) {
      // Search for any JSON file with slides/sections/sheets arrays
      try {
        const jsonFiles = fs.readdirSync(dir).filter(
          f => f.endsWith('.json') && f !== 'package.json' && f !== 'tsconfig.json'
        );
        const found = jsonFiles.find(f => {
          try {
            const content = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
            return content.slides || content.sections || content.sheets;
          } catch { return false; }
        });
        if (!found) continue;
        inputJsonPath = path.join(dir, found);
      } catch { continue; }
    }

    // Verify skill matches file type (only when searching agent dirs)
    if (skillId) {
      if (!docType && isHtml && skillId === 'slides-gen') docType = 'slides';
      if (!docType && isHtml) continue;
      if (docType) {
        const skillExt = skillId.replace('-gen', '');
        if (skillExt !== ext && !(isHtml && skillId === 'slides-gen')) continue;
      }
    }

    try {
      const raw = JSON.parse(fs.readFileSync(inputJsonPath, 'utf-8'));

      // Identify the block array key
      const blockArrayKey = raw.slides ? 'slides'
        : raw.sections ? 'sections'
        : raw.sheets ? 'sheets'
        : null;
      if (!blockArrayKey) continue;

      const blockArray = raw[blockArrayKey];
      if (!Array.isArray(blockArray) || blockArray.length === 0) continue;

      // For xlsx: skip JSON files where sheets have headers but no rows (e.g. sheets.json metadata)
      if (blockArrayKey === 'sheets' && blockArray.every((s: any) => !s.rows || s.rows.length === 0)) {
        console.log(`[FileManager] Skipping ${inputJsonPath} — sheets have no rows data (metadata-only)`);
        continue;
      }

      // Wrap each native block with id + order
      const blocks: DocumentBlock[] = blockArray.map((block: any, i: number) => ({
        id: uuidv4(),
        type: block.type || (blockArrayKey === 'sheets' ? 'sheet' : 'section'),
        order: i,
        data: block,
      }));

      // Extract doc-level metadata (everything except the block array)
      const meta = { ...raw };
      delete meta[blockArrayKey];

      const finalDocType = docType || (isHtml ? 'slides' : ext) as DocType;

      await dbRun(
        `INSERT INTO document_blocks (id, file_id, user_id, conversation_id, doc_type, doc_meta, blocks, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        uuidv4(), fileRecord.id, userId, conversationId,
        finalDocType, JSON.stringify(meta), JSON.stringify(blocks), fileRecord.version
      );

      console.log(`[FileManager] Captured ${blocks.length} blocks for ${fileRecord.filename} (${finalDocType}) from ${inputJsonPath}`);
      return blocks;
    } catch (err) {
      console.error(`[FileManager] Failed to capture blocks from ${inputJsonPath}:`, err);
    }
  }

  // Fallback: extract blocks directly from the generated file
  // file_path is relative to workspaceRoot (e.g. "{userId}/{convId}/file.pptx")
  const filePath = path.join(config.workspaceRoot, fileRecord.file_path);
  if (fs.existsSync(filePath)) {
    try {
      const blocks = await extractBlocksFromFile(filePath, ext);
      if (blocks && blocks.length > 0) {
        const finalDocType = docType || (isHtml ? 'slides' : ext) as DocType;
        await dbRun(
          `INSERT INTO document_blocks (id, file_id, user_id, conversation_id, doc_type, doc_meta, blocks, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          uuidv4(), fileRecord.id, userId, conversationId,
          finalDocType, JSON.stringify({}), JSON.stringify(blocks), fileRecord.version
        );
        console.log(`[FileManager] Captured ${blocks.length} blocks from file ${fileRecord.filename} (${finalDocType}) [fallback]`);
        return blocks;
      }
    } catch (err) {
      console.error(`[FileManager] Fallback block extraction failed for ${fileRecord.filename}:`, err);
    }
  }

  console.warn(`[FileManager] No block structure found for ${fileRecord.filename} (searched ${searchDirs.length} dirs)`);
  return null;
}

/**
 * Fallback: extract block structure directly from the output file.
 * Supports PPTX (slide extraction via XML) and DOCX (section extraction via mammoth).
 */
async function extractBlocksFromFile(filePath: string, ext: string): Promise<DocumentBlock[] | null> {
  if (ext === 'pptx' || ext === 'ppt') {
    return extractBlocksFromPptx(filePath);
  }
  if (ext === 'docx' || ext === 'doc') {
    return extractBlocksFromDocx(filePath);
  }
  if (ext === 'xlsx' || ext === 'xls') {
    return extractBlocksFromXlsx(filePath);
  }
  return null;
}

async function extractBlocksFromPptx(filePath: string): Promise<DocumentBlock[] | null> {
  const JSZip = (await import('jszip')).default;
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

  if (slideFiles.length === 0) return null;

  const blocks: DocumentBlock[] = [];
  for (let i = 0; i < slideFiles.length; i++) {
    const xml = await zip.file(slideFiles[i])!.async('text');
    const texts = extractTextsFromXml(xml);
    const title = texts[0] || `Slide ${i + 1}`;
    const bullets = texts.slice(1);

    blocks.push({
      id: uuidv4(),
      type: i === 0 ? 'title' : 'content',
      order: i,
      data: { title, bullets, slideIndex: i },
    });
  }
  return blocks;
}

async function extractBlocksFromDocx(filePath: string): Promise<DocumentBlock[] | null> {
  const mammoth = (await import('mammoth')).default;
  const result = await mammoth.extractRawText({ path: filePath });
  const text = result.value;
  if (!text.trim()) return null;

  // Split by double newlines into sections
  const sections = text.split(/\n{2,}/).filter(s => s.trim());
  if (sections.length === 0) return null;

  return sections.map((section, i) => {
    const lines = section.split('\n').filter(l => l.trim());
    const title = lines[0] || `Section ${i + 1}`;
    const content = lines.slice(1).join('\n');
    return {
      id: uuidv4(),
      type: i === 0 ? 'heading' : 'paragraph',
      order: i,
      data: { title, content },
    };
  });
}

// ── Excel cell value resolution + formula evaluation ────────────

/** Resolve an ExcelJS cell value to a plain scalar (non-formula cells only) */
function resolveCell(v: any): string | number | boolean | null {
  if (v == null) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  // Formula with cached result
  if (typeof v === 'object' && 'formula' in v) {
    const r = v.result;
    if (r != null && typeof r !== 'object') return r;
    if (r instanceof Date) return r.toISOString().slice(0, 10);
    if (r && typeof r === 'object' && r.error) return String(r.error);
    return null; // no cached result — needs formula evaluation
  }
  if (typeof v === 'object' && Array.isArray(v.richText)) {
    return v.richText.map((rt: any) => rt.text || '').join('');
  }
  if (typeof v === 'object' && 'hyperlink' in v) return v.text || v.hyperlink || '';
  try { return JSON.stringify(v); } catch { return String(v); }
}

/** Parse "A1" → { col: 0, row: 0 } (0-indexed) */
function parseCellRef(ref: string): { col: number; row: number } | null {
  const m = ref.match(/^\$?([A-Z]+)\$?(\d+)$/);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: parseInt(m[2]) - 1 };
}

/** Expand "A1:C3" into flat list of { col, row } */
function expandRange(rangeStr: string): { col: number; row: number }[] {
  const parts = rangeStr.split(':');
  const start = parseCellRef(parts[0]);
  const end = parts[1] ? parseCellRef(parts[1]) : start;
  if (!start || !end) return [];
  const cells: { col: number; row: number }[] = [];
  for (let r = start.row; r <= end.row; r++)
    for (let c = start.col; c <= end.col; c++)
      cells.push({ col: c, row: r });
  return cells;
}

/** Safe arithmetic evaluator (recursive descent — no eval/Function) */
function evalArithmetic(tokens: string[]): number | null {
  let pos = 0;
  function parseExpr(): number {
    let result = parseTerm();
    while (pos < tokens.length && (tokens[pos] === '+' || tokens[pos] === '-')) {
      const op = tokens[pos++];
      result = op === '+' ? result + parseTerm() : result - parseTerm();
    }
    return result;
  }
  function parseTerm(): number {
    let result = parseFactor();
    while (pos < tokens.length && (tokens[pos] === '*' || tokens[pos] === '/')) {
      const op = tokens[pos++];
      const right = parseFactor();
      result = op === '*' ? result * right : (right !== 0 ? result / right : 0);
    }
    return result;
  }
  function parseFactor(): number {
    if (tokens[pos] === '-') { pos++; return -parseFactor(); }
    if (tokens[pos] === '+') { pos++; return parseFactor(); }
    if (tokens[pos] === '(') { pos++; const r = parseExpr(); if (tokens[pos] === ')') pos++; return r; }
    const n = parseFloat(tokens[pos++]);
    return isNaN(n) ? 0 : n;
  }
  try {
    const value = parseExpr();
    return (isNaN(value) || !isFinite(value)) ? null : value;
  } catch { return null; }
}

/**
 * Evaluate an Excel formula string using grid data.
 * grid is 0-indexed (row 0 = Excel row 1, i.e. header row).
 * Supports: cell refs, arithmetic, SUM/AVERAGE/COUNT/MIN/MAX/ABS/ROUND/INT, simple IF.
 */
function evaluateFormula(
  formula: string,
  grid: (string | number | boolean | null)[][],
): number | string | null {
  let expr = formula.trim();

  const getNum = (col: number, row: number): number | null => {
    const cell = grid[row]?.[col];
    if (cell == null) return null;
    if (typeof cell === 'number') return cell;
    if (typeof cell === 'string') { const n = Number(cell); return isNaN(n) ? null : n; }
    if (typeof cell === 'boolean') return cell ? 1 : 0;
    return null;
  };

  // Resolve functions (up to 10 nesting levels)
  for (let iter = 0; iter < 10; iter++) {
    const fm = expr.match(/(SUM|AVERAGE|COUNT|MIN|MAX|ABS|ROUND|INT)\(([^()]*)\)/i);
    if (!fm) break;
    const func = fm[1].toUpperCase();
    const nums: number[] = [];
    for (const arg of fm[2].split(',')) {
      const t = arg.trim();
      if (t.includes(':')) {
        for (const c of expandRange(t)) { const v = getNum(c.col, c.row); if (v != null) nums.push(v); }
      } else {
        const ref = parseCellRef(t);
        if (ref) { const v = getNum(ref.col, ref.row); if (v != null) nums.push(v); }
        else { const n = parseFloat(t); if (!isNaN(n)) nums.push(n); }
      }
    }
    let r: number;
    switch (func) {
      case 'SUM': r = nums.reduce((a, b) => a + b, 0); break;
      case 'AVERAGE': r = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0; break;
      case 'COUNT': r = nums.length; break;
      case 'MIN': r = nums.length ? Math.min(...nums) : 0; break;
      case 'MAX': r = nums.length ? Math.max(...nums) : 0; break;
      case 'ABS': r = Math.abs(nums[0] || 0); break;
      case 'ROUND': r = nums.length >= 2 ? Number(nums[0].toFixed(nums[1])) : Math.round(nums[0] || 0); break;
      case 'INT': r = Math.floor(nums[0] || 0); break;
      default: r = 0;
    }
    expr = expr.replace(fm[0], String(r));
  }

  // Simple IF(cond, trueVal, falseVal)
  const ifm = expr.match(/IF\(([^,]+),([^,]+),([^)]+)\)/i);
  if (ifm) {
    const cm = ifm[1].trim().match(/^(.+?)\s*(>=|<=|<>|>|<|=)\s*(.+)$/);
    if (cm) {
      const left = evaluateFormula(cm[1], grid);
      const right = evaluateFormula(cm[3], grid);
      if (typeof left === 'number' && typeof right === 'number') {
        let cond = false;
        switch (cm[2]) {
          case '>': cond = left > right; break; case '<': cond = left < right; break;
          case '>=': cond = left >= right; break; case '<=': cond = left <= right; break;
          case '=': cond = left === right; break; case '<>': cond = left !== right; break;
        }
        const branch = (cond ? ifm[2] : ifm[3]).trim();
        const strM = branch.match(/^"(.*)"$/);
        if (strM) return strM[1];
        return evaluateFormula(branch, grid);
      }
    }
  }

  // Replace cell references with values
  expr = expr.replace(/\$?[A-Z]+\$?\d+/g, (match) => {
    const ref = parseCellRef(match);
    if (!ref) return '0';
    const v = getNum(ref.col, ref.row);
    return v != null ? String(v) : '0';
  });

  // Tokenize & evaluate arithmetic
  const tokens = expr.match(/(\d+\.?\d*(?:[eE][+-]?\d+)?|[+\-*/()])/g);
  if (!tokens) return null;
  return evalArithmetic(tokens);
}

export async function extractBlocksFromXlsx(filePath: string): Promise<DocumentBlock[] | null> {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  if (workbook.worksheets.length === 0) return null;

  const blocks: DocumentBlock[] = [];
  workbook.eachSheet((sheet, sheetIdx) => {
    const colCount = sheet.columnCount;
    const rowCount = sheet.rowCount;
    if (colCount === 0 || rowCount === 0) {
      blocks.push({ id: uuidv4(), type: 'sheet', order: sheetIdx - 1, data: { name: sheet.name, headers: [], rows: [] } });
      return;
    }

    // Pass 1: Read all raw values, collect unresolved formulas
    const grid: (string | number | boolean | null)[][] = []; // 0-indexed, row 0 = Excel row 1
    const formulas: { row: number; col: number; formula: string }[] = [];

    sheet.eachRow((row, rowNum) => {
      // Pad sparse rows
      while (grid.length < rowNum - 1) grid.push(new Array(colCount).fill(null));
      const rowData: (string | number | boolean | null)[] = [];
      for (let c = 1; c <= colCount; c++) {
        const v = row.getCell(c).value;
        if (v && typeof v === 'object' && 'formula' in v) {
          const resolved = resolveCell(v);
          rowData.push(resolved);
          if (resolved == null) {
            formulas.push({ row: rowNum - 1, col: c - 1, formula: (v as any).formula || '' });
          }
        } else {
          rowData.push(resolveCell(v));
        }
      }
      grid[rowNum - 1] = rowData;
    });

    // Pass 2: Evaluate unresolved formulas (up to 3 iterations for chained dependencies)
    if (formulas.length > 0) {
      for (let pass = 0; pass < 3; pass++) {
        let progress = 0;
        for (const f of formulas) {
          if (grid[f.row]?.[f.col] != null) continue;
          const result = evaluateFormula(f.formula, grid);
          if (result != null) {
            grid[f.row][f.col] = result;
            progress++;
          }
        }
        if (progress === 0) break;
      }
    }

    const headers = (grid[0] || []).map(v => v != null ? String(v) : '');
    const rows = grid.slice(1);

    blocks.push({
      id: uuidv4(),
      type: 'sheet',
      order: sheetIdx - 1,
      data: { name: sheet.name, headers, rows },
    });
  });

  return blocks.length > 0 ? blocks : null;
}

/** Shape bounding box extracted from PPTX slide XML */
export interface PptxShape {
  id: string;
  name: string;
  type: 'text' | 'picture' | 'chart' | 'table' | 'group' | 'shape';
  /** Position/size as percentage of slide dimensions (0–100) */
  x: number;
  y: number;
  width: number;
  height: number;
  /** First ~80 chars of text content */
  text?: string;
}

export interface PptxSlideShapes {
  slideIndex: number;
  shapes: PptxShape[];
}

/**
 * Extract shape bounding boxes from a PPTX file for overlay rendering.
 * Returns shape positions as percentages of slide dimensions.
 */
export async function extractPptxShapes(filePath: string): Promise<PptxSlideShapes[]> {
  const JSZip = (await import('jszip')).default;
  const data = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(data);

  // Get slide dimensions from presentation.xml
  let slideW = 12192000; // default widescreen EMU
  let slideH = 6858000;
  const presXml = await zip.file('ppt/presentation.xml')?.async('text');
  if (presXml) {
    const szMatch = presXml.match(/<p:sldSz\s+cx="(\d+)"\s+cy="(\d+)"/);
    if (szMatch) {
      slideW = parseInt(szMatch[1]);
      slideH = parseInt(szMatch[2]);
    }
  }

  // Find and sort slide files
  const slideFiles: string[] = [];
  zip.forEach((p) => {
    if (/^ppt\/slides\/slide\d+\.xml$/.test(p)) slideFiles.push(p);
  });
  slideFiles.sort((a, b) => {
    const na = parseInt(a.match(/slide(\d+)/)?.[1] || '0');
    const nb = parseInt(b.match(/slide(\d+)/)?.[1] || '0');
    return na - nb;
  });

  const result: PptxSlideShapes[] = [];

  for (let i = 0; i < slideFiles.length; i++) {
    const xml = await zip.file(slideFiles[i])!.async('text');
    const shapes: PptxShape[] = [];

    // Extract <p:sp> shapes (text boxes, titles, etc.)
    const spRegex = /<p:sp\b[^>]*>([\s\S]*?)<\/p:sp>/g;
    let spMatch;
    while ((spMatch = spRegex.exec(xml)) !== null) {
      const shape = parseShapeXml(spMatch[1], 'text', slideW, slideH);
      if (shape) shapes.push(shape);
    }

    // Extract <p:pic> picture shapes
    const picRegex = /<p:pic\b[^>]*>([\s\S]*?)<\/p:pic>/g;
    let picMatch;
    while ((picMatch = picRegex.exec(xml)) !== null) {
      const shape = parseShapeXml(picMatch[1], 'picture', slideW, slideH);
      if (shape) shapes.push(shape);
    }

    // Extract <p:graphicFrame> (charts, tables, etc.)
    const gfRegex = /<p:graphicFrame\b[^>]*>([\s\S]*?)<\/p:graphicFrame>/g;
    let gfMatch;
    while ((gfMatch = gfRegex.exec(xml)) !== null) {
      const inner = gfMatch[1];
      const isChart = /chart/.test(inner);
      const isTable = /<a:tbl\b/.test(inner);
      const shape = parseShapeXml(inner, isChart ? 'chart' : isTable ? 'table' : 'shape', slideW, slideH);
      if (shape) shapes.push(shape);
    }

    result.push({ slideIndex: i, shapes });
  }

  return result;
}

function parseShapeXml(
  xml: string,
  defaultType: PptxShape['type'],
  slideW: number,
  slideH: number,
): PptxShape | null {
  // Get name from cNvPr
  const nameMatch = xml.match(/<p:cNvPr\s[^>]*name="([^"]*)"/) || xml.match(/<p:cNvPr\s[^>]*id="(\d+)"/);
  const name = nameMatch?.[1] || '';

  // Get id
  const idMatch = xml.match(/<p:cNvPr\s[^>]*id="([^"]*)"/);
  const id = idMatch?.[1] || Math.random().toString(36).slice(2, 8);

  // Get transform: <a:off x="" y=""/> and <a:ext cx="" cy=""/>
  const offMatch = xml.match(/<a:off\s+x="(-?\d+)"\s+y="(-?\d+)"/);
  const extMatch = xml.match(/<a:ext\s+cx="(\d+)"\s+cy="(\d+)"/);
  if (!offMatch || !extMatch) return null;

  const x = parseInt(offMatch[1]);
  const y = parseInt(offMatch[2]);
  const cx = parseInt(extMatch[1]);
  const cy = parseInt(extMatch[2]);

  // Skip tiny or zero-size shapes
  if (cx < slideW * 0.02 && cy < slideH * 0.02) return null;

  // Extract text content preview
  const texts = extractTextsFromXml(xml);
  const text = texts.join(' ').slice(0, 80) || undefined;

  return {
    id,
    name,
    type: defaultType,
    x: (x / slideW) * 100,
    y: (y / slideH) * 100,
    width: (cx / slideW) * 100,
    height: (cy / slideH) * 100,
    text,
  };
}

/** Extract text paragraphs from PowerPoint slide XML */
function extractTextsFromXml(xml: string): string[] {
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
