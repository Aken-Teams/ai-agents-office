import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { v4 as uuidv4 } from 'uuid';
import { dbGet, dbRun } from '../db.js';
import { config } from '../config.js';
import { registerNewFiles, getExistingFilePaths, snapshotExistingFiles } from './fileManager.js';
import type { DocumentBlocksRecord, DocumentBlock, GeneratedFile } from '../types.js';

const execFileAsync = promisify(execFile);

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
    [arrayKey]: blocks.sort((a, b) => a.order - b.order).map(b => b.data),
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

  // Snapshot existing files before regeneration
  await snapshotExistingFiles(userId, conversation_id);
  const existingPaths = await getExistingFilePaths(conversation_id);

  // Run generator
  const scriptPath = path.join(config.generatorsDir, generatorScript);
  const nodeModulesDir = path.join(config.rootDir, 'node_modules');

  try {
    await execFileAsync('node', ['--import', 'tsx', scriptPath, 'input.json', outputFilename], {
      cwd: sandboxPath,
      env: { ...process.env, NODE_PATH: nodeModulesDir },
      timeout: 120_000, // 2 minutes should be plenty for rebuild
    });
  } catch (err: any) {
    console.error(`[FileRebuilder] Generator failed:`, err.stderr || err.message);
    // Clean up input.json
    try { fs.unlinkSync(inputJsonPath); } catch {}
    return null;
  }

  // Clean up input.json
  try { fs.unlinkSync(inputJsonPath); } catch {}

  // Register new file version
  const newFiles = await registerNewFiles(userId, conversation_id, sandboxPath, existingPaths);
  const rebuilt = newFiles.find(f => f.filename === outputFilename) || newFiles[0];

  if (rebuilt) {
    // Update block record to point to new file version
    await dbRun(
      `UPDATE document_blocks SET file_id = ?, version = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      rebuilt.id, rebuilt.version, blockRecord.id
    );
    console.log(`[FileRebuilder] Rebuilt ${outputFilename} → v${rebuilt.version}`);
  }

  return rebuilt || null;
}
