import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
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
  const outputPath = path.join(sandboxPath, outputFilename);

  // Write input.json
  fs.mkdirSync(sandboxPath, { recursive: true });
  fs.writeFileSync(inputJsonPath, JSON.stringify(nativeJson, null, 2), 'utf-8');

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

  // Invalidate preview cache (delete cached PDF so next preview re-converts)
  const cacheDir = path.join(sandboxPath, '.preview-cache');
  const basename = path.basename(outputFilename, path.extname(outputFilename));
  const cachedPdf = path.join(cacheDir, `${basename}.pdf`);
  try { if (fs.existsSync(cachedPdf)) fs.unlinkSync(cachedPdf); } catch {}

  // Update existing file record in-place (keep same ID so frontend doesn't need to track)
  const newSize = fs.statSync(outputPath).size;
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
