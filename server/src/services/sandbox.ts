import path from 'path';
import fs from 'fs';
import { config } from '../config.js';

const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Validate that an ID only contains safe characters (prevent path traversal)
 */
export function validateId(id: string): boolean {
  return SAFE_ID_PATTERN.test(id) && id.length > 0 && id.length <= 128;
}

/**
 * Get the sandboxed directory for a user's conversation.
 * Creates the directory if it doesn't exist.
 */
export function getSandboxPath(userId: string, conversationId: string): string {
  if (!validateId(userId) || !validateId(conversationId)) {
    throw new Error('Invalid userId or conversationId: contains unsafe characters');
  }

  const sandboxDir = path.join(config.workspaceRoot, userId, conversationId);

  // Verify the resolved path is still within workspace root (defense in depth)
  const resolved = path.resolve(sandboxDir);
  if (!resolved.startsWith(path.resolve(config.workspaceRoot))) {
    throw new Error('Path traversal detected');
  }

  fs.mkdirSync(sandboxDir, { recursive: true });
  return sandboxDir;
}

/**
 * Get the user's root workspace directory.
 */
export function getUserWorkspacePath(userId: string): string {
  if (!validateId(userId)) {
    throw new Error('Invalid userId');
  }
  return path.join(config.workspaceRoot, userId);
}

/**
 * Validate that a file path is within the user's workspace.
 */
export function validateFilePath(userId: string, filePath: string): boolean {
  const userRoot = path.resolve(config.workspaceRoot, userId);
  const resolved = path.resolve(filePath);
  return resolved.startsWith(userRoot);
}

/**
 * Sanitize user input to prevent prompt injection.
 * Strips dangerous XML-like tags and validates length.
 */
export function sanitizeUserInput(input: string): string {
  if (input.length > config.maxMessageLength) {
    throw new Error(`Message too long (max ${config.maxMessageLength} characters)`);
  }

  // Strip potentially dangerous XML tags that could override system prompts
  const dangerousTags = /<\/?(?:system|role|admin|prompt|instruction|override|ignore)[^>]*>/gi;
  let sanitized = input.replace(dangerousTags, '');

  // Reject messages with path traversal patterns
  if (/\.\.[\\/]/.test(sanitized)) {
    throw new Error('Path traversal patterns are not allowed');
  }

  // Reject messages referencing system directories
  const systemPaths = /(?:C:\\Windows|\/etc\/|\/usr\/|\/root\/|%SYSTEMROOT%|%WINDIR%)/i;
  if (systemPaths.test(sanitized)) {
    throw new Error('System directory references are not allowed');
  }

  return sanitized;
}

/**
 * Scan sandbox directory for newly generated files.
 * Returns list of files found.
 */
export function scanSandboxFiles(sandboxPath: string): Array<{
  filename: string;
  filePath: string;
  fileType: string;
  fileSize: number;
}> {
  const resolved = path.resolve(sandboxPath);
  if (!resolved.startsWith(path.resolve(config.workspaceRoot))) {
    throw new Error('Invalid sandbox path');
  }

  if (!fs.existsSync(sandboxPath)) {
    return [];
  }

  const files: Array<{
    filename: string;
    filePath: string;
    fileType: string;
    fileSize: number;
  }> = [];

  function walkDir(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else if (entry.isFile()) {
        // Skip internal/intermediate files
        if (entry.name === 'CLAUDE.md') continue;
        const ext = path.extname(entry.name).toLowerCase();
        // Skip versioned backup files (e.g., report.v1.docx, chart.v2.html)
        const baseName = entry.name.slice(0, -ext.length);
        if (/\.v\d+$/.test(baseName)) continue;
        // Only register actual document output files, not intermediate scripts/data
        const DOCUMENT_EXTENSIONS = new Set([
          '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt',
          '.pdf', '.csv', '.txt', '.rtf', '.odt', '.ods', '.odp',
          '.html', '.htm', '.md', '.png', '.jpg', '.jpeg', '.gif', '.svg',
        ]);
        if (!DOCUMENT_EXTENSIONS.has(ext)) continue;

        const fileType = ext.replace('.', '');
        const stat = fs.statSync(fullPath);
        files.push({
          filename: entry.name,
          filePath: path.relative(config.workspaceRoot, fullPath),
          fileType,
          fileSize: stat.size,
        });
      }
    }
  }

  walkDir(sandboxPath);
  return files;
}
