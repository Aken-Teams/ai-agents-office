import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import db from '../db.js';
import { config } from '../config.js';
import { scanSandboxFiles, validateFilePath } from './sandbox.js';
import type { GeneratedFile } from '../types.js';

/**
 * Scan sandbox directory for new files and register them in the database.
 * Returns newly registered files.
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
    // Skip files already registered
    if (existingFilePaths.has(file.filePath)) continue;

    // Security: verify file is within user's workspace
    const fullPath = path.join(config.workspaceRoot, file.filePath);
    if (!validateFilePath(userId, fullPath)) {
      console.error(`[SECURITY] File outside sandbox detected: ${fullPath}`);
      continue;
    }

    const id = uuidv4();
    db.prepare(`
      INSERT INTO generated_files (id, user_id, conversation_id, filename, file_path, file_type, file_size)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, userId, conversationId, file.filename, file.filePath, file.fileType, file.fileSize);

    newFiles.push({
      id,
      user_id: userId,
      conversation_id: conversationId,
      filename: file.filename,
      file_path: file.filePath,
      file_type: file.fileType,
      file_size: file.fileSize,
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
 * Delete a file from disk and database.
 */
export function deleteFile(userId: string, fileId: string): boolean {
  const file = db.prepare(
    'SELECT * FROM generated_files WHERE id = ? AND user_id = ?'
  ).get(fileId, userId) as GeneratedFile | undefined;

  if (!file) return false;

  const fullPath = path.join(config.workspaceRoot, file.file_path);
  if (validateFilePath(userId, fullPath) && fs.existsSync(fullPath)) {
    fs.unlinkSync(fullPath);
  }

  db.prepare('DELETE FROM generated_files WHERE id = ?').run(fileId);
  return true;
}
