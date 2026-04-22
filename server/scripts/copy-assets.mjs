/**
 * Copy non-TS assets (SKILL.md, etc.) from src/ to dist/
 * so production build can find them at runtime.
 */
import { cpSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(__dirname, '../src');
const distDir = resolve(__dirname, '../dist');

// Ensure dist exists
if (!existsSync(distDir)) {
  mkdirSync(distDir, { recursive: true });
}

// Copy skills directory (preserves SKILL.md files)
const skillsSrc = resolve(srcDir, 'skills');
const skillsDist = resolve(distDir, 'skills');
if (existsSync(skillsSrc)) {
  cpSync(skillsSrc, skillsDist, {
    recursive: true,
    filter: (src) => {
      // Copy directories and non-ts files (md, json, yaml, txt)
      if (src.endsWith('.ts')) return false;
      return true;
    },
  });
  console.log('Copied skills assets to dist/skills/');
}

console.log('Asset copy complete.');
