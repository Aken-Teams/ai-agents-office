import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { dbGet, dbAll, dbRun } from '../db.js';
import { config } from '../config.js';
import { scanSandboxFiles, validateFilePath } from './sandbox.js';
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
  existingFilePaths: Set<string>
): Promise<GeneratedFile[]> {
  const scannedFiles = scanSandboxFiles(sandboxPath);
  const newFiles: GeneratedFile[] = [];

  for (const file of scannedFiles) {
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

    // Brand new file — version 1
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
