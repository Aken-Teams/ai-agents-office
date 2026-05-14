/**
 * Shared utility to resolve Claude CLI path for direct node invocation.
 * On Windows, npm global installs create .cmd wrappers that break under
 * concurrently/tsx process groups. We find the actual .js entry point
 * and invoke it with node directly (no shell needed).
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export function resolveClaudeCliPath(cliPath: string): { bin: string; prefix: string[] } {
  if (cliPath.endsWith('.js')) {
    return { bin: process.execPath, prefix: [cliPath] };
  }

  const cliNames = ['cli.js', 'cli-wrapper.cjs'];
  try {
    const npmPrefix = execSync('npm prefix -g', { encoding: 'utf-8' }).trim();
    for (const name of cliNames) {
      const cliScript = path.join(npmPrefix, 'node_modules', '@anthropic-ai', 'claude-code', name);
      if (fs.existsSync(cliScript)) {
        return { bin: process.execPath, prefix: [cliScript] };
      }
    }
  } catch { /* fall through */ }

  // Fallback: try common Windows npm global paths
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const candidates = cliNames.flatMap(name => [
    path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', name),
    path.join(home, '.npm-global', 'lib', 'node_modules', '@anthropic-ai', 'claude-code', name),
  ]);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { bin: process.execPath, prefix: [candidate] };
    }
  }

  console.warn('[Claude CLI] Could not resolve CLI script, falling back to shell invocation');
  return { bin: cliPath, prefix: [] };
}
