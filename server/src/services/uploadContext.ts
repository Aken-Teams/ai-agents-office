/**
 * Upload Context — Generates system prompt snippet listing user's uploaded files.
 *
 * This allows Claude skills (especially data-analyst) to know what files
 * the user has uploaded and where to find them.
 */

import db from '../db.js';
import path from 'path';
import { config } from '../config.js';

interface UploadRow {
  id: string;
  filename: string;
  original_name: string;
  file_type: string;
  file_size: number;
  storage_path: string;
  scan_status: string;
}

/**
 * Build a system prompt snippet describing user's uploaded files.
 * Only includes files that passed security scanning (clean or suspicious-but-allowed).
 */
export function getUserUploadsForPrompt(userId: string, sandboxPath: string): string {
  const uploads = db.prepare(
    "SELECT id, filename, original_name, file_type, file_size, storage_path FROM user_uploads WHERE user_id = ? AND scan_status IN ('clean', 'suspicious') ORDER BY created_at DESC"
  ).all(userId) as UploadRow[];

  if (uploads.length === 0) return '';

  const uploadDir = path.join(config.workspaceRoot, userId, '_uploads').replace(/\\/g, '/');
  // Calculate relative path from sandbox to uploads dir
  const relUploadDir = path.relative(sandboxPath, path.join(config.workspaceRoot, userId, '_uploads')).replace(/\\/g, '/');

  const lines = [
    '',
    '## User Uploaded Files',
    `The user has uploaded ${uploads.length} file(s) for analysis. These files are READ-ONLY.`,
    `Upload directory (absolute): ${uploadDir}`,
    `Upload directory (relative from your cwd): ${relUploadDir}`,
    '',
    '| Original Name | Type | Size | Relative Path |',
    '|---|---|---|---|',
  ];

  for (const u of uploads) {
    const relPath = path.relative(sandboxPath, path.join(config.workspaceRoot, u.storage_path)).replace(/\\/g, '/');
    const size = u.file_size < 1024 ? `${u.file_size} B`
      : u.file_size < 1024 * 1024 ? `${(u.file_size / 1024).toFixed(1)} KB`
      : `${(u.file_size / (1024 * 1024)).toFixed(1)} MB`;
    lines.push(`| ${u.original_name} | ${u.file_type.toUpperCase()} | ${size} | ${relPath} |`);
  }

  lines.push('');
  lines.push('To read a file: `cat "' + relUploadDir + '/filename"` or use appropriate parsing code.');
  lines.push('IMPORTANT: These files are READ-ONLY. Do NOT modify or delete uploaded files.');

  return lines.join('\n');
}
