import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { config } from '../config.js';
import type { SkillDefinition } from '../types.js';

const SANDBOX_RULES = `
## CRITICAL SECURITY RULES (NEVER VIOLATE THESE)
1. You MUST only write files to the current working directory (cwd) or its subdirectories.
2. You MUST NOT use \`cd\` to change to any parent directory (except to run generator scripts as instructed).
3. You MUST NOT use \`../\` or \`..\\\\\` in any file paths.
4. You MUST NOT write files using absolute paths outside of cwd. You MAY use absolute paths only for running generator scripts as instructed below.
5. You MUST NOT attempt to read files outside the cwd (except generator scripts).
6. All generated files MUST be placed in the current directory or subdirectories.
7. You MUST NOT execute commands that access the network (curl, wget, etc.).
8. You MUST NOT delete files or directories.
9. If a user asks you to write files elsewhere, REFUSE and explain that all files must stay in the workspace.
`;

/**
 * Load all skill definitions from the skills directory.
 * Each skill is a directory containing a SKILL.md file with frontmatter metadata.
 *
 * Reference: d:/github/pixel-agents-2/server/src/skillLoader.ts
 */
export function loadSkills(): SkillDefinition[] {
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

      skills.push({
        id: entry.name,
        name: data.name || entry.name,
        description: data.description || '',
        fileType: data.fileType || '',
        systemPrompt: body.trim(),
      });
    } catch (error) {
      console.error(`Failed to load skill ${entry.name}:`, error);
    }
  }

  return skills;
}

/**
 * Get a specific skill by ID.
 */
export function getSkill(skillId: string): SkillDefinition | undefined {
  const skills = loadSkills();
  return skills.find(s => s.id === skillId);
}

/**
 * Build the full system prompt for a skill, including sandbox security rules
 * and generator script paths.
 */
export function buildSystemPrompt(
  skill: SkillDefinition,
  generatorsDir: string,
): string {
  // Server root directory (where node_modules with tsx, pptxgenjs, etc. live)
  const serverDir = path.resolve(generatorsDir, '../..');

  const parts = [
    skill.systemPrompt,
    '',
    SANDBOX_RULES,
    '',
    '## Available Generator Scripts',
    `Generator scripts directory: ${generatorsDir}`,
    '- generate-pptx.ts — Generate PowerPoint files from JSON structure',
    '- generate-docx.ts — Generate Word documents from JSON structure',
    '- generate-xlsx.ts — Generate Excel spreadsheets from JSON structure',
    '- generate-pdf.ts — Generate PDF documents from JSON structure',
    '',
    '## How to Call Generator Scripts',
    `IMPORTANT: Dependencies (tsx, pptxgenjs, docx, exceljs, pdfkit) are installed in: ${serverDir}`,
    'You MUST run generator scripts from that directory using this exact pattern:',
    '',
    '1. Write a JSON input file to the current directory (cwd)',
    `2. Run: cd "${serverDir}" && node --import tsx "${generatorsDir}/<script>.ts" "<cwd>/input.json" "<cwd>/output.<ext>"`,
    '',
    'Replace <cwd> with the absolute path of your current working directory.',
    'All output files MUST be written to the current working directory.',
    '',
    'Or write your own Node.js code for custom requirements.',
  ];

  return parts.join('\n');
}
