import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { dbGet, dbAll, dbRun } from '../db.js';
import { config } from '../config.js';
import { scanSandboxFiles, validateFilePath } from './sandbox.js';
import type { GeneratedFile } from '../types.js';

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
