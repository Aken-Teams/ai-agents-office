/**
 * Infographic rendering — bridges the `infographic-gen` skill to Gemini.
 *
 * The skill's Claude agent gathers/structures the request and emits a single
 * fenced directive block:
 *
 *   ```gemini-infographic
 *   { "mode": "html" | "image", "filename": "...", "prompt": "...",
 *     "data": "...", "style": "..." }
 *   ```
 *
 * We parse that, call Gemini, and write the resulting file into the sandbox so
 * the normal file-registration pipeline delivers it (HTML infographic → .html,
 * raster illustration → .png). Returns usage so the caller can track Gemini cost
 * separately from Claude.
 */

import fs from 'fs';
import path from 'path';
import { generateInfographicHtml, generateImage, isGeminiEnabled, type GeminiUsage } from './geminiApi.js';

export interface InfographicDirective {
  mode: 'html' | 'image';
  filename?: string;
  prompt: string;
  data?: string;
  style?: string;
}

export interface RenderedInfographic { filePath: string; fileType: 'html' | 'png'; usage: GeminiUsage }

const DIRECTIVE_RE = /```gemini-infographic\s*([\s\S]*?)```/i;

/** Extract the first gemini-infographic directive from an agent's output. */
export function parseInfographicDirective(text: string): InfographicDirective | null {
  const m = text.match(DIRECTIVE_RE);
  if (!m) return null;
  let obj: any;
  try {
    obj = JSON.parse(m[1].trim());
  } catch {
    return null;
  }
  if (!obj || typeof obj.prompt !== 'string' || !obj.prompt.trim()) return null;
  // Default to image: the skill produces a real Gemini-drawn PNG unless the
  // user explicitly asked for an editable HTML version.
  const mode = obj.mode === 'html' ? 'html' : 'image';
  return {
    mode,
    filename: typeof obj.filename === 'string' ? obj.filename : undefined,
    prompt: obj.prompt,
    data: typeof obj.data === 'string' ? obj.data : undefined,
    style: typeof obj.style === 'string' ? obj.style : undefined,
  };
}

/** Sanitize a model-suggested filename to a safe base (no path, no extension). */
function safeBase(name: string | undefined, fallback: string): string {
  const base = (name || fallback)
    .replace(/\.[a-z0-9]+$/i, '')        // strip extension
    .replace(/[\\/:*?"<>|]+/g, '')        // strip path/illegal chars
    .replace(/\s+/g, '_')
    .slice(0, 80)
    .trim();
  return base || fallback;
}

/**
 * Render an infographic directive into `outDir`. Throws if Gemini is disabled or
 * the API call fails (caller surfaces the error to the user).
 */
export async function renderInfographic(directive: InfographicDirective, outDir: string): Promise<RenderedInfographic> {
  if (!isGeminiEnabled()) throw new Error('資訊圖表功能尚未設定（缺少 GEMINI_API_KEY）');
  fs.mkdirSync(outDir, { recursive: true });

  if (directive.mode === 'image') {
    const { base64, usage } = await generateImage({ prompt: directive.prompt });
    const file = path.join(outDir, `${safeBase(directive.filename, 'infographic')}.png`);
    fs.writeFileSync(file, Buffer.from(base64, 'base64'));
    return { filePath: file, fileType: 'png', usage };
  }

  const { html, usage } = await generateInfographicHtml({ prompt: directive.prompt, data: directive.data, style: directive.style });
  const file = path.join(outDir, `${safeBase(directive.filename, 'infographic')}.html`);
  fs.writeFileSync(file, html, 'utf-8');
  return { filePath: file, fileType: 'html', usage };
}
