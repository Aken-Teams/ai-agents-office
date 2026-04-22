/**
 * Upload Context — Generates system prompt snippet listing user's uploaded files.
 *
 * This allows Claude skills (especially data-analyst) to know what files
 * the user has uploaded and where to find them.
 */

import { dbAll } from '../db.js';
import path from 'path';
import { config } from '../config.js';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.tiff', '.tif']);

function isImageFile(filename: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

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
export async function getUserUploadsForPrompt(
  userId: string,
  sandboxPath: string,
  options?: { uploadIds?: string[]; conversationId?: string },
): Promise<string> {
  const { uploadIds, conversationId } = options || {};

  let uploads: UploadRow[];

  if (uploadIds && uploadIds.length > 0) {
    // Message-level: only include specific files
    const placeholders = uploadIds.map(() => '?').join(',');
    uploads = await dbAll<UploadRow>(
      `SELECT id, filename, original_name, file_type, file_size, storage_path FROM user_uploads WHERE user_id = ? AND id IN (${placeholders}) AND scan_status IN ('clean', 'suspicious') ORDER BY created_at DESC`,
      userId, ...uploadIds
    );
  } else if (conversationId) {
    // Conversation-level fallback
    uploads = await dbAll<UploadRow>(
      "SELECT id, filename, original_name, file_type, file_size, storage_path FROM user_uploads WHERE user_id = ? AND conversation_id = ? AND scan_status IN ('clean', 'suspicious') ORDER BY created_at DESC",
      userId, conversationId
    );
  } else {
    uploads = [];
  }

  if (uploads.length === 0) return '';

  const uploadDir = path.join(config.workspaceRoot, userId, '_uploads').replace(/\\/g, '/');
  // Calculate relative path from sandbox to uploads dir
  const relUploadDir = path.relative(sandboxPath, path.join(config.workspaceRoot, userId, '_uploads')).replace(/\\/g, '/');

  const dataFiles = uploads.filter(u => !isImageFile(u.original_name));
  const imageFiles = uploads.filter(u => isImageFile(u.original_name));

  const lines = [
    '',
    '## User Uploaded Files',
    `The user has uploaded ${uploads.length} file(s) for analysis. These files are READ-ONLY.`,
    `Upload directory (absolute): ${uploadDir}`,
    `Upload directory (relative from your cwd): ${relUploadDir}`,
  ];

  if (dataFiles.length > 0) {
    lines.push(
      '',
      '### Data Files',
      '| Original Name | Type | Size | Relative Path |',
      '|---|---|---|---|',
    );
    for (const u of dataFiles) {
      const relPath = path.relative(sandboxPath, path.join(config.workspaceRoot, u.storage_path)).replace(/\\/g, '/');
      const size = formatSize(u.file_size);
      lines.push(`| ${u.original_name} | ${u.file_type.toUpperCase()} | ${size} | ${relPath} |`);
    }
    lines.push('', 'To read data files: `cat "' + relUploadDir + '/filename"` or use appropriate parsing code.');
  }

  if (imageFiles.length > 0) {
    lines.push(
      '',
      '### Image Files',
      '| Original Name | Type | Size | Relative Path |',
      '|---|---|---|---|',
    );
    for (const u of imageFiles) {
      const relPath = path.relative(sandboxPath, path.join(config.workspaceRoot, u.storage_path)).replace(/\\/g, '/');
      const size = formatSize(u.file_size);
      lines.push(`| ${u.original_name} | ${u.file_type.toUpperCase()} | ${size} | ${relPath} |`);
    }
    lines.push(
      '',
      'To view image files: Use the **Read** tool with the absolute file path. The Read tool supports multimodal vision and can see image contents directly.',
      `Example: Read the file "${uploadDir}/${imageFiles[0].original_name}" to view the image.`,
      'Do NOT use \`cat\` for image files — it will output binary garbage.',
    );
  }

  lines.push('', 'IMPORTANT: These files are READ-ONLY. Do NOT modify or delete uploaded files.');

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

/**
 * Build a comprehensive system prompt listing ALL files in a conversation:
 * 1. User uploads (entire conversation, not message-scoped)
 * 2. Generated files (produced by agents)
 *
 * Used by rag-analyst skill for cross-referencing.
 */
export async function getConversationFilesForPrompt(
  userId: string,
  sandboxPath: string,
  conversationId: string,
): Promise<string> {
  // 1. All uploads in this conversation
  const uploads = await dbAll<UploadRow>(
    "SELECT id, filename, original_name, file_type, file_size, storage_path FROM user_uploads WHERE user_id = ? AND conversation_id = ? AND scan_status IN ('clean', 'suspicious') ORDER BY created_at DESC",
    userId, conversationId
  );

  // 2. All generated files in this conversation
  const generated = await dbAll<GeneratedFileRow>(
    "SELECT id, filename, file_path, file_type, file_size FROM generated_files WHERE user_id = ? AND conversation_id = ? ORDER BY created_at DESC",
    userId, conversationId
  );

  if (uploads.length === 0 && generated.length === 0) return '';

  const lines: string[] = [''];

  // Upload section
  if (uploads.length > 0) {
    const uploadDir = path.join(config.workspaceRoot, userId, '_uploads').replace(/\\/g, '/');
    const relUploadDir = path.relative(sandboxPath, path.join(config.workspaceRoot, userId, '_uploads')).replace(/\\/g, '/');

    const dataUploads = uploads.filter(u => !isImageFile(u.original_name));
    const imageUploads = uploads.filter(u => isImageFile(u.original_name));

    lines.push(
      '## User Uploaded Files (Entire Conversation)',
      `${uploads.length} file(s) uploaded throughout this conversation. These are READ-ONLY.`,
      `Upload directory (relative from your cwd): ${relUploadDir}`,
    );

    if (dataUploads.length > 0) {
      lines.push(
        '',
        '### Data Files',
        '| Original Name | Type | Size | Relative Path |',
        '|---|---|---|---|',
      );
      for (const u of dataUploads) {
        const relPath = path.relative(sandboxPath, path.join(config.workspaceRoot, u.storage_path)).replace(/\\/g, '/');
        lines.push(`| ${u.original_name} | ${u.file_type.toUpperCase()} | ${formatSize(u.file_size)} | ${relPath} |`);
      }
      lines.push('', `To read data files: \`cat "${relUploadDir}/filename"\` or use appropriate parsing code.`);
    }

    if (imageUploads.length > 0) {
      lines.push(
        '',
        '### Image Files',
        '| Original Name | Type | Size | Relative Path |',
        '|---|---|---|---|',
      );
      for (const u of imageUploads) {
        const relPath = path.relative(sandboxPath, path.join(config.workspaceRoot, u.storage_path)).replace(/\\/g, '/');
        lines.push(`| ${u.original_name} | ${u.file_type.toUpperCase()} | ${formatSize(u.file_size)} | ${relPath} |`);
      }
      lines.push(
        '',
        'To view image files: Use the **Read** tool with the absolute file path. The Read tool supports multimodal vision and can see image contents directly.',
        `Example: Read the file "${uploadDir}/${imageUploads[0].original_name}" to view the image.`,
        'Do NOT use `cat` for image files — it will output binary garbage.',
      );
    }
  }

  // Generated files section
  if (generated.length > 0) {
    const dataGenerated = generated.filter(g => !isImageFile(g.filename));
    const imageGenerated = generated.filter(g => isImageFile(g.filename));

    lines.push(
      '',
      '## Generated Files in This Conversation',
      `${generated.length} file(s) generated by AI agents. These are READ-ONLY.`,
    );

    if (dataGenerated.length > 0) {
      lines.push(
        '',
        '| Filename | Type | Size | Relative Path |',
        '|---|---|---|---|',
      );
      for (const g of dataGenerated) {
        const relPath = path.relative(sandboxPath, path.join(config.workspaceRoot, g.file_path)).replace(/\\/g, '/');
        lines.push(`| ${g.filename} | ${g.file_type.toUpperCase()} | ${formatSize(g.file_size)} | ${relPath} |`);
      }
    }

    if (imageGenerated.length > 0) {
      lines.push(
        '',
        '### Generated Image Files',
        '| Filename | Type | Size | Relative Path |',
        '|---|---|---|---|',
      );
      for (const g of imageGenerated) {
        const relPath = path.relative(sandboxPath, path.join(config.workspaceRoot, g.file_path)).replace(/\\/g, '/');
        lines.push(`| ${g.filename} | ${g.file_type.toUpperCase()} | ${formatSize(g.file_size)} | ${relPath} |`);
      }
      lines.push('', 'To view generated image files: Use the **Read** tool with the absolute file path.');
    }
  }

  lines.push('', 'IMPORTANT: ALL files listed above are READ-ONLY. Do NOT modify or delete any files.');

  return lines.join('\n');
}
