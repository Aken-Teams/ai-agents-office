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
 *
 * @param uploadIds - Specific upload IDs to include (message-level binding).
 *                    If provided, only these files are included.
 *                    If empty/undefined, falls back to conversation-level scope.
 * @param conversationId - Fallback: include all uploads in this conversation.
 */
export function getUserUploadsForPrompt(
  userId: string,
  sandboxPath: string,
  options?: { uploadIds?: string[]; conversationId?: string },
): string {
  const { uploadIds, conversationId } = options || {};

  let uploads: UploadRow[];

  if (uploadIds && uploadIds.length > 0) {
    // Message-level: only include specific files
    const placeholders = uploadIds.map(() => '?').join(',');
    uploads = db.prepare(
      `SELECT id, filename, original_name, file_type, file_size, storage_path FROM user_uploads WHERE user_id = ? AND id IN (${placeholders}) AND scan_status IN ('clean', 'suspicious') ORDER BY created_at DESC`
    ).all(userId, ...uploadIds) as UploadRow[];
  } else if (conversationId) {
    // Conversation-level fallback
    uploads = db.prepare(
      "SELECT id, filename, original_name, file_type, file_size, storage_path FROM user_uploads WHERE user_id = ? AND conversation_id = ? AND scan_status IN ('clean', 'suspicious') ORDER BY created_at DESC"
    ).all(userId, conversationId) as UploadRow[];
  } else {
    uploads = [];
  }

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

// ── RAG: Conversation-wide file context ──────────────────────

interface GeneratedFileRow {
  id: string;
  filename: string;
  file_path: string;
  file_type: string;
  file_size: number;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Build a comprehensive system prompt listing ALL files in a conversation:
 * 1. User uploads (entire conversation, not message-scoped)
 * 2. Generated files (produced by agents)
 *
 * Used by rag-analyst skill for cross-referencing.
 */
export function getConversationFilesForPrompt(
  userId: string,
  sandboxPath: string,
  conversationId: string,
): string {
  // 1. All uploads in this conversation
  const uploads = db.prepare(
    "SELECT id, filename, original_name, file_type, file_size, storage_path FROM user_uploads WHERE user_id = ? AND conversation_id = ? AND scan_status IN ('clean', 'suspicious') ORDER BY created_at DESC"
  ).all(userId, conversationId) as UploadRow[];

  // 2. All generated files in this conversation
  const generated = db.prepare(
    "SELECT id, filename, file_path, file_type, file_size FROM generated_files WHERE user_id = ? AND conversation_id = ? ORDER BY created_at DESC"
  ).all(userId, conversationId) as GeneratedFileRow[];

  if (uploads.length === 0 && generated.length === 0) return '';

  const lines: string[] = [''];

  // Upload section
  if (uploads.length > 0) {
    const uploadDir = path.join(config.workspaceRoot, userId, '_uploads').replace(/\\/g, '/');
    const relUploadDir = path.relative(sandboxPath, path.join(config.workspaceRoot, userId, '_uploads')).replace(/\\/g, '/');

    lines.push(
      '## User Uploaded Files (Entire Conversation)',
      `${uploads.length} file(s) uploaded throughout this conversation. These are READ-ONLY.`,
      `Upload directory (relative from your cwd): ${relUploadDir}`,
      '',
      '| Original Name | Type | Size | Relative Path |',
      '|---|---|---|---|',
    );
    for (const u of uploads) {
      const relPath = path.relative(sandboxPath, path.join(config.workspaceRoot, u.storage_path)).replace(/\\/g, '/');
      lines.push(`| ${u.original_name} | ${u.file_type.toUpperCase()} | ${formatSize(u.file_size)} | ${relPath} |`);
    }
    lines.push('', `To read: \`cat "${relUploadDir}/filename"\` or use appropriate parsing code.`);
  }

  // Generated files section
  if (generated.length > 0) {
    lines.push(
      '',
      '## Generated Files in This Conversation',
      `${generated.length} file(s) generated by AI agents. These are READ-ONLY.`,
      '',
      '| Filename | Type | Size | Relative Path |',
      '|---|---|---|---|',
    );
    for (const g of generated) {
      const relPath = path.relative(sandboxPath, path.join(config.workspaceRoot, g.file_path)).replace(/\\/g, '/');
      lines.push(`| ${g.filename} | ${g.file_type.toUpperCase()} | ${formatSize(g.file_size)} | ${relPath} |`);
    }
  }

  lines.push('', 'IMPORTANT: ALL files listed above are READ-ONLY. Do NOT modify or delete any files.');

  return lines.join('\n');
}
