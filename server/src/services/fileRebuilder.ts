import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import JSZip from 'jszip';
import { dbGet, dbRun } from '../db.js';
import { config } from '../config.js';
import type { DocumentBlocksRecord, DocumentBlock, GeneratedFile } from '../types.js';

const execAsync = promisify(exec);

/** Map doc_type → generator script name */
const GENERATOR_SCRIPTS: Record<string, string> = {
  pptx: 'generate-pptx.ts',
  docx: 'generate-docx.ts',
  xlsx: 'generate-xlsx.ts',
  pdf: 'generate-pdf.ts',
  slides: 'generate-slides.ts',
};

/** Map doc_type → output file extension */
const DOC_TYPE_EXT: Record<string, string> = {
  pptx: 'pptx',
  docx: 'docx',
  xlsx: 'xlsx',
  pdf: 'pdf',
  slides: 'html',
};

/** Map doc_type → the key name used in the native JSON (slides[], sections[], sheets[]) */
const DOC_TYPE_ARRAY_KEY: Record<string, string> = {
  pptx: 'slides',
  docx: 'sections',
  xlsx: 'sheets',
  pdf: 'sections',
  slides: 'slides',
};

/**
 * Rebuild a generated file from its document_blocks data.
 *
 * 1. Read blocks from DB
 * 2. Reconstruct native JSON (e.g. { title, style, slides: [...] })
 * 3. Write input.json to sandbox
 * 4. Run the generator script
 * 5. Register new file version
 */
export async function rebuildFile(fileId: string, userId: string): Promise<GeneratedFile | null> {
  // Load block record
  const blockRecord = await dbGet<DocumentBlocksRecord>(
    'SELECT * FROM document_blocks WHERE file_id = ? AND user_id = ?',
    fileId, userId
  );
  if (!blockRecord) {
    console.error(`[FileRebuilder] No block record found for file ${fileId}`);
    return null;
  }

  const { doc_type, conversation_id } = blockRecord;
  const generatorScript = GENERATOR_SCRIPTS[doc_type];
  if (!generatorScript) {
    console.error(`[FileRebuilder] No generator script for doc_type: ${doc_type}`);
    return null;
  }

  // Load original file record to get output filename
  const originalFile = await dbGet<GeneratedFile>(
    'SELECT * FROM generated_files WHERE id = ? AND user_id = ?',
    fileId, userId
  );
  if (!originalFile) return null;

  // Reconstruct native JSON
  const blocks: DocumentBlock[] = JSON.parse(blockRecord.blocks);
  const meta = blockRecord.doc_meta ? JSON.parse(blockRecord.doc_meta) : {};
  const arrayKey = DOC_TYPE_ARRAY_KEY[doc_type];

  const nativeJson = {
    ...meta,
    [arrayKey]: blocks.sort((a, b) => a.order - b.order).map(b => ({
      type: b.type,  // generator needs slide type to render correctly
      ...b.data,
    })),
  };

  // Determine sandbox and output paths
  const sandboxPath = path.join(config.workspaceRoot, userId, conversation_id);
  const inputJsonPath = path.join(sandboxPath, 'input.json');
  const ext = DOC_TYPE_EXT[doc_type];
  const outputFilename = originalFile.filename.replace(/\.[^.]+$/, `.${ext}`);
  // Generator writes to sandbox root; we'll copy to the original file_path afterwards
  const outputPath = path.join(sandboxPath, outputFilename);
  // The DB file_path may point to a subdirectory (e.g. _agents/pptx-gen/)
  const originalFilePath = path.join(config.workspaceRoot, originalFile.file_path);

  // Write input.json
  fs.mkdirSync(sandboxPath, { recursive: true });
  fs.writeFileSync(inputJsonPath, JSON.stringify(nativeJson, null, 2), 'utf-8');

  // Debug: log first slide title to confirm data was updated
  const firstSlide = (nativeJson as any)[arrayKey]?.[0];
  console.log(`[FileRebuilder] Rebuilding ${outputFilename}: ${blocks.length} blocks, style=${meta.style || 'default'}, first slide: "${firstSlide?.title || '?'}" (type=${firstSlide?.type || '?'})`);

  // Run generator
  const scriptPath = path.join(config.generatorsDir, generatorScript);
  const nodeModulesDir = path.join(config.rootDir, 'server', 'node_modules');

  try {
    // Use tsx binary with absolute path to avoid module resolution issues in sandbox cwd
    // Use exec (not execFile) so the .CMD shim works on Windows
    const tsxBin = path.join(config.rootDir, 'server', 'node_modules', '.bin', 'tsx');
    const cmd = `"${tsxBin}" "${scriptPath}" "input.json" "${outputFilename}"`;
    await execAsync(cmd, {
      cwd: sandboxPath,
      env: { ...process.env, NODE_PATH: nodeModulesDir },
      timeout: 120_000,
    });
  } catch (err: any) {
    console.error(`[FileRebuilder] Generator failed:`, err.stderr || err.message);
    // Clean up input.json
    try { fs.unlinkSync(inputJsonPath); } catch {}
    return null;
  }

  // Clean up input.json
  try { fs.unlinkSync(inputJsonPath); } catch {}

  // Verify output file was generated
  if (!fs.existsSync(outputPath)) {
    console.error(`[FileRebuilder] Output file not found: ${outputPath}`);
    return null;
  }

  // Copy rebuilt file to original location if they differ
  // (original may be in _agents/pptx-gen/ subdirectory)
  if (path.resolve(outputPath) !== path.resolve(originalFilePath)) {
    fs.mkdirSync(path.dirname(originalFilePath), { recursive: true });
    fs.copyFileSync(outputPath, originalFilePath);
    console.log(`[FileRebuilder] Copied rebuilt file to original path: ${originalFile.file_path}`);
  }

  // Invalidate preview cache in BOTH the sandbox root and the original file's directory
  const originalDir = path.dirname(originalFilePath);
  const basename = path.basename(outputFilename, path.extname(outputFilename));
  for (const dir of new Set([sandboxPath, originalDir])) {
    const cacheDir = path.join(dir, '.preview-cache');
    const cachedPdf = path.join(cacheDir, `${basename}.pdf`);
    if (fs.existsSync(cachedPdf)) {
      try {
        fs.unlinkSync(cachedPdf);
        console.log(`[FileRebuilder] Cleared preview cache: ${cachedPdf}`);
      } catch (err) {
        console.warn(`[FileRebuilder] Could not delete cached PDF:`, err);
      }
    }
  }

  // Update existing file record in-place (keep same ID so frontend doesn't need to track)
  const newSize = fs.statSync(originalFilePath).size;
  await dbRun(
    `UPDATE generated_files SET file_size = ?, created_at = CURRENT_TIMESTAMP WHERE id = ?`,
    newSize, fileId
  );

  // Update block record timestamp
  await dbRun(
    `UPDATE document_blocks SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    blockRecord.id
  );

  console.log(`[FileRebuilder] Rebuilt ${outputFilename} (${newSize} bytes), cache cleared`);

  // Return the updated file record
  const updatedFile = await dbGet<GeneratedFile>(
    'SELECT * FROM generated_files WHERE id = ?', fileId
  );
  return updatedFile || null;
}

// ---------------------------------------------------------------------------
// In-place field patching — modify text directly inside PPTX/DOCX XML
// This preserves all formatting, charts, and visual elements.
// ---------------------------------------------------------------------------

/**
 * Patch a single text field inside a generated file without regenerating it.
 * For PPTX: modifies slide XML directly to replace text.
 * Returns the updated file record, or null on failure.
 */
export async function patchFileField(
  fileId: string,
  userId: string,
  blockId: string,
  fieldKey: string,
  newValue: unknown,
): Promise<GeneratedFile | null> {
  // Load block record
  const blockRecord = await dbGet<DocumentBlocksRecord>(
    'SELECT * FROM document_blocks WHERE file_id = ? AND user_id = ?',
    fileId, userId,
  );
  if (!blockRecord) return null;

  const { doc_type } = blockRecord;
  const blocks: DocumentBlock[] = JSON.parse(blockRecord.blocks);
  const block = blocks.find(b => b.id === blockId);
  if (!block) return null;

  // Get original value before we update it
  const oldValue = block.data[fieldKey];

  // Update block data in DB
  block.data[fieldKey] = newValue;
  await dbRun(
    'UPDATE document_blocks SET blocks = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    JSON.stringify(blocks), blockRecord.id,
  );

  // Load file record to get path
  const fileRecord = await dbGet<GeneratedFile>(
    'SELECT * FROM generated_files WHERE id = ? AND user_id = ?',
    fileId, userId,
  );
  if (!fileRecord) return null;

  const filePath = path.join(config.workspaceRoot, fileRecord.file_path);
  if (!fs.existsSync(filePath)) return null;

  let patched = false;

  if (doc_type === 'pptx') {
    patched = await patchPptxField(filePath, block.order, fieldKey, oldValue, newValue);
  } else if (doc_type === 'docx') {
    patched = await patchDocxField(filePath, block.order, fieldKey, oldValue, newValue);
  }

  if (!patched) {
    console.warn(`[FileRebuilder] Patch not supported for ${doc_type}, field ${fieldKey}`);
    return fileRecord;
  }

  // Invalidate preview cache
  const dir = path.dirname(filePath);
  const basename = path.basename(fileRecord.filename, path.extname(fileRecord.filename));
  const cachedPdf = path.join(dir, '.preview-cache', `${basename}.pdf`);
  if (fs.existsSync(cachedPdf)) {
    try { fs.unlinkSync(cachedPdf); } catch {}
  }
  // Also clear sandbox root cache if different
  const sandboxPath = path.join(config.workspaceRoot, userId, blockRecord.conversation_id);
  const rootCachedPdf = path.join(sandboxPath, '.preview-cache', `${basename}.pdf`);
  if (rootCachedPdf !== cachedPdf && fs.existsSync(rootCachedPdf)) {
    try { fs.unlinkSync(rootCachedPdf); } catch {}
  }

  // Update file size
  const newSize = fs.statSync(filePath).size;
  await dbRun(
    'UPDATE generated_files SET file_size = ?, created_at = CURRENT_TIMESTAMP WHERE id = ?',
    newSize, fileId,
  );

  console.log(`[FileRebuilder] Patched slide ${block.order + 1} field "${fieldKey}" in ${fileRecord.filename}`);

  return await dbGet<GeneratedFile>('SELECT * FROM generated_files WHERE id = ?', fileId) || null;
}

/**
 * Replace text inside a PPTX slide XML.
 * Handles title, subtitle, bullet points, and other text fields.
 */
async function patchPptxField(
  filePath: string,
  slideIndex: number,
  fieldKey: string,
  oldValue: unknown,
  newValue: unknown,
): Promise<boolean> {
  const data = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(data);

  // Find the target slide file
  const slideFiles: string[] = [];
  zip.forEach((p) => {
    if (/^ppt\/slides\/slide\d+\.xml$/.test(p)) slideFiles.push(p);
  });
  slideFiles.sort((a, b) => {
    const na = parseInt(a.match(/slide(\d+)/)?.[1] || '0');
    const nb = parseInt(b.match(/slide(\d+)/)?.[1] || '0');
    return na - nb;
  });

  if (slideIndex >= slideFiles.length) return false;

  const slideFile = slideFiles[slideIndex];
  let xml = await zip.file(slideFile)!.async('text');
  let modified = false;

  if (fieldKey === 'title' || fieldKey === 'subtitle' || fieldKey === 'quote' ||
      fieldKey === 'attribution' || fieldKey === 'description' || fieldKey === 'content') {
    // Simple text replacement: find old text and replace with new
    const oldText = String(oldValue || '');
    const newText = String(newValue || '');
    if (oldText && oldText !== newText) {
      // PPTX text can be split across multiple <a:r> runs within a <a:p>.
      // Try exact match first (text in a single <a:t> element)
      const escapedOld = escapeXml(oldText);
      const escapedNew = escapeXml(newText);
      if (xml.includes(escapedOld)) {
        xml = xml.replace(escapedOld, escapedNew);
        modified = true;
      } else {
        // Text might be split across runs — try to find and replace across <a:t> elements
        modified = false; // Can't handle split runs reliably; will still update DB
      }
    }
  } else if (fieldKey === 'bullets' || fieldKey === 'points') {
    // Bullet list: replace each bullet text individually
    const oldBullets = (Array.isArray(oldValue) ? oldValue : []) as string[];
    const newBullets = (Array.isArray(newValue) ? newValue : []) as string[];
    for (let i = 0; i < Math.min(oldBullets.length, newBullets.length); i++) {
      const oldB = typeof oldBullets[i] === 'string' ? oldBullets[i] : '';
      const newB = typeof newBullets[i] === 'string' ? newBullets[i] : '';
      if (oldB && oldB !== newB) {
        const escaped = escapeXml(oldB);
        const escapedNew = escapeXml(newB);
        if (xml.includes(escaped)) {
          xml = xml.replace(escaped, escapedNew);
          modified = true;
        }
      }
    }
  }

  if (modified) {
    zip.file(slideFile, xml);
    const output = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    fs.writeFileSync(filePath, output);
  }

  return true; // DB was updated even if XML patch didn't match
}

/**
 * Patch text inside a DOCX file.
 */
async function patchDocxField(
  filePath: string,
  _sectionIndex: number,
  fieldKey: string,
  oldValue: unknown,
  newValue: unknown,
): Promise<boolean> {
  if (fieldKey !== 'title' && fieldKey !== 'content') return false;

  const data = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(data);
  const docFile = zip.file('word/document.xml');
  if (!docFile) return false;

  let xml = await docFile.async('text');
  const oldText = String(oldValue || '');
  const newText = String(newValue || '');

  if (oldText && oldText !== newText) {
    const escaped = escapeXml(oldText);
    const escapedNew = escapeXml(newText);
    if (xml.includes(escaped)) {
      xml = xml.replace(escaped, escapedNew);
      zip.file('word/document.xml', xml);
      const output = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      fs.writeFileSync(filePath, output);
    }
  }

  return true;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
