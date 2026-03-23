import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import db from '../db.js';
import { config } from '../config.js';
import { scanSandboxFiles, validateFilePath } from './sandbox.js';
import type { GeneratedFile } from '../types.js';

/**
 * Scan sandbox directory for new or updated files and register them in the database.
 * Supports versioning: if a file with the same path exists and file size changed,
 * a new version record is created.
 */
export function registerNewFiles(
  userId: string,
  conversationId: string,
  sandboxPath: string,
  existingFilePaths: Set<string>
): GeneratedFile[] {
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
      const existing = db.prepare(
        'SELECT * FROM generated_files WHERE conversation_id = ? AND file_path = ? ORDER BY version DESC LIMIT 1'
      ).get(conversationId, file.filePath) as GeneratedFile | undefined;

      if (!existing || existing.file_size === file.fileSize) continue;

      // File was overwritten with different content — create new version
      const newVersion = (existing.version || 1) + 1;
      const id = uuidv4();

      db.prepare(`
        INSERT INTO generated_files (id, user_id, conversation_id, filename, file_path, file_type, file_size, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, userId, conversationId, file.filename, file.filePath, file.fileType, file.fileSize, newVersion);

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
    db.prepare(`
      INSERT INTO generated_files (id, user_id, conversation_id, filename, file_path, file_type, file_size, version)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `).run(id, userId, conversationId, file.filename, file.filePath, file.fileType, file.fileSize);

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
export function getExistingFilePaths(conversationId: string): Set<string> {
  const files = db.prepare(
    'SELECT file_path FROM generated_files WHERE conversation_id = ?'
  ).all(conversationId) as Array<{ file_path: string }>;

  return new Set(files.map(f => f.file_path));
}

/**
 * Get the absolute path for downloading a file, with security validation.
 */
export function getFileDownloadPath(userId: string, fileId: string): string | null {
  const file = db.prepare(
    'SELECT * FROM generated_files WHERE id = ? AND user_id = ?'
  ).get(fileId, userId) as GeneratedFile | undefined;

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
export function getFileVersions(userId: string, fileId: string): GeneratedFile[] {
  const file = db.prepare(
    'SELECT * FROM generated_files WHERE id = ? AND user_id = ?'
  ).get(fileId, userId) as GeneratedFile | undefined;

  if (!file || !file.conversation_id) return [];

  return db.prepare(
    `SELECT * FROM generated_files
     WHERE user_id = ? AND conversation_id = ? AND filename = ?
     ORDER BY version DESC`
  ).all(userId, file.conversation_id, file.filename) as GeneratedFile[];
}

/**
 * Delete a file from disk and database.
 */
export function deleteFile(userId: string, fileId: string): boolean {
  const file = db.prepare(
    'SELECT * FROM generated_files WHERE id = ? AND user_id = ?'
  ).get(fileId, userId) as GeneratedFile | undefined;

  if (!file) return false;

  const fullPath = path.join(config.workspaceRoot, file.file_path);
  if (validateFilePath(userId, fullPath) && fs.existsSync(fullPath)) {
    // Only delete from disk if no other version uses this path
    const otherVersions = db.prepare(
      'SELECT COUNT(*) as cnt FROM generated_files WHERE file_path = ? AND id != ?'
    ).get(file.file_path, fileId) as { cnt: number };
    if (otherVersions.cnt === 0) {
      fs.unlinkSync(fullPath);
    }
  }

  db.prepare('DELETE FROM generated_files WHERE id = ?').run(fileId);
  return true;
}
