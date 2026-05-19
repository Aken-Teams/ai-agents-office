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

  // Try to resolve the actual CLI entry point via `which` or `where`
  try {
    const cmd = process.platform === 'win32' ? 'where claude' : 'which claude';
    const claudePath = execSync(cmd, { encoding: 'utf-8' }).trim().split('\n')[0];
    const realPath = fs.realpathSync(claudePath);
    if (realPath.endsWith('.js') && fs.existsSync(realPath)) {
      return { bin: process.execPath, prefix: [realPath] };
    }
  } catch { /* fall through */ }

  // Try to find the actual CLI script from the npm global prefix
  try {
    const npmPrefix = execSync('npm prefix -g', { encoding: 'utf-8' }).trim();
    for (const sub of ['node_modules', 'lib/node_modules']) {
      for (const name of cliNames) {
        const cliScript = path.join(npmPrefix, sub, '@anthropic-ai', 'claude-code', name);
        if (fs.existsSync(cliScript)) {
          return { bin: process.execPath, prefix: [cliScript] };
        }
      }
    }
  } catch { /* fall through */ }

  // Fallback: try common paths
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
