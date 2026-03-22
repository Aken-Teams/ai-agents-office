import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { config } from '../config.js';
import type { SkillDefinition } from '../types.js';

const SANDBOX_RULES = `
## CRITICAL SECURITY RULES (NEVER VIOLATE THESE)
1. You MUST only write files to the current working directory (cwd) or its subdirectories.
2. You MUST NOT use \`cd\` to change to any directory. Stay in your cwd at all times.
3. You MUST NOT use \`../\` or \`..\\\\\` in any file paths.
4. You MUST NOT write files using absolute paths outside of cwd.
5. You MUST NOT attempt to read files outside the cwd (except generator scripts via absolute path).
6. All generated files MUST be placed in the current directory or subdirectories using relative paths.
7. You MUST NOT execute commands that access the network (curl, wget, etc.).
8. You MUST NOT delete files or directories.
9. If a user asks you to write files elsewhere, REFUSE and explain that all files must stay in the workspace.
`;

// Cache skills to avoid re-reading from disk on every call
let _skillsCache: SkillDefinition[] | null = null;

/**
 * Load all skill definitions from the skills directory.
 * Each skill is a directory containing a SKILL.md file with frontmatter metadata.
 */
export function loadSkills(): SkillDefinition[] {
  if (_skillsCache) return _skillsCache;

  const skillsDir = config.skillsDir;
  const skills: SkillDefinition[] = [];

  if (!fs.existsSync(skillsDir)) return skills;

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillMdPath = path.join(skillsDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) continue;

    try {
      const content = fs.readFileSync(skillMdPath, 'utf-8');
      const { data, content: body } = matter(content);

      // Load reference files from references/ subdirectory
      let referenceContent = '';
      const refsDir = path.join(skillsDir, entry.name, 'references');
      if (fs.existsSync(refsDir)) {
        const refFiles = fs.readdirSync(refsDir).filter(f => f.endsWith('.md'));
        for (const refFile of refFiles) {
          const refContent = fs.readFileSync(path.join(refsDir, refFile), 'utf-8');
          referenceContent += `\n\n## Reference: ${refFile}\n${refContent}`;
        }
      }

      skills.push({
        id: entry.name,
        name: data.name || entry.name,
        description: data.description || '',
        fileType: data.fileType || '',
        systemPrompt: body.trim() + referenceContent,
        role: data.role || undefined,
        order: typeof data.order === 'number' ? data.order : undefined,
        allowedTools: Array.isArray(data.allowedTools) ? data.allowedTools : undefined,
        disallowedTools: Array.isArray(data.disallowedTools) ? data.disallowedTools : undefined,
      });
    } catch (error) {
      console.error(`Failed to load skill ${entry.name}:`, error);
    }
  }

  // Sort by order (skills without order go last)
  skills.sort((a, b) => (a.order ?? 999) - (b.order ?? 999));

  _skillsCache = skills;
  return skills;
}

/** Invalidate skill cache (for hot-reloading in dev). */
export function invalidateSkillCache(): void {
  _skillsCache = null;
}

/**
 * Get a specific skill by ID.
 */
export function getSkill(skillId: string): SkillDefinition | undefined {
  const skills = loadSkills();
  return skills.find(s => s.id === skillId);
}

/**
 * Get the router skill (if defined).
 */
export function getRouterSkill(): SkillDefinition | undefined {
  return loadSkills().find(s => s.role === 'router');
}

/**
 * Get all worker skills (non-router).
 */
export function getWorkerSkills(): SkillDefinition[] {
  return loadSkills().filter(s => s.role !== 'router');
}

/**
 * Get language instruction for the system prompt based on user locale.
 */
function getLanguageInstruction(locale: string): string {
  const instructions: Record<string, string> = {
    'zh-TW': '## Language Instruction\nYou MUST respond in Traditional Chinese (繁體中文). All text output, explanations, and generated document content must be in Traditional Chinese.\n',
    'zh-CN': '## Language Instruction\nYou MUST respond in Simplified Chinese (简体中文). All text output, explanations, and generated document content must be in Simplified Chinese.\n',
    'en': '## Language Instruction\nYou MUST respond in English. All text output, explanations, and generated document content must be in English.\n',
  };
  return instructions[locale] || instructions['zh-TW'];
}

/**
 * Build the Router Agent's system prompt.
 * Injects the list of available worker skills so the Router knows what it can delegate to.
 */
export function buildRouterPrompt(routerSkill: SkillDefinition, userLocale: string = 'zh-TW'): string {
  const workers = getWorkerSkills();

  const teamLines = workers.map(w =>
    `- **${w.id}**: ${w.name} — ${w.description}${w.fileType ? ` (generates .${w.fileType})` : ''}`
  );

  const teamSection = [
    '',
    '## Available Team Members',
    'You can delegate tasks to these skill agents:',
    ...teamLines,
    '',
  ].join('\n');

  return getLanguageInstruction(userLocale) + '\n' + routerSkill.systemPrompt + teamSection;
}

/**
 * Build the full system prompt for a worker skill, including sandbox security rules
 * and generator script paths.
 */
export function buildSystemPrompt(
  skill: SkillDefinition,
  generatorsDir: string,
  userLocale: string = 'zh-TW',
): string {
  // Router skills don't get sandbox rules or generator scripts
  if (skill.role === 'router') {
    return buildRouterPrompt(skill, userLocale);
  }

  // Server root directory (where node_modules with tsx, pptxgenjs, etc. live)
  const serverDir = path.resolve(generatorsDir, '../..').replace(/\\/g, '/');
  const nodeModulesDir = path.join(serverDir, 'node_modules').replace(/\\/g, '/');
  // Also normalize generatorsDir for the prompt (bash-friendly forward slashes)
  const genDir = generatorsDir.replace(/\\/g, '/');

  const parts = [
    getLanguageInstruction(userLocale),
    '',
    skill.systemPrompt,
    '',
    SANDBOX_RULES,
    '',
    '## Available Generator Scripts',
    `Generator scripts directory: ${genDir}`,
    '- generate-pptx.ts — Generate PowerPoint files from JSON structure',
    '- generate-docx.ts — Generate Word documents from JSON structure',
    '- generate-xlsx.ts — Generate Excel spreadsheets from JSON structure',
    '- generate-pdf.ts — Generate PDF documents from JSON structure',
    '',
    '## How to Call Generator Scripts',
    `IMPORTANT: Dependencies (tsx, pptxgenjs, docx, exceljs, pdfkit) are installed in: ${serverDir}`,
    'You MUST run generator scripts from your current working directory (cwd). Do NOT use cd to change directories.',
    '',
    '1. Write a JSON input file to the current directory: input.json',
    `2. Run: NODE_PATH="${nodeModulesDir}" node --import tsx "${genDir}/<script>.ts" input.json output.<ext>`,
    '',
    'CRITICAL: Do NOT use cd to change to the server directory. Stay in your cwd at all times.',
    'The NODE_PATH variable lets Node.js find the dependencies without changing directories.',
    'All input and output file paths should be relative to your cwd (e.g. input.json, output.pptx).',
    '',
    'Or write your own Node.js code for custom requirements (also use NODE_PATH if you need server dependencies).',
  ];

  return parts.join('\n');
}
