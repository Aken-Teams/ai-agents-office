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
import sharp from 'sharp';
import { generateInfographicHtml, generateImage, isGeminiEnabled, type GeminiUsage } from './geminiApi.js';

export interface InfographicDirective {
  mode: 'html' | 'image';
  filename?: string;
  prompt: string;
  data?: string;
  style?: string;
  edit?: boolean;   // image mode: edit the existing infographic instead of redrawing
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
    edit: obj.edit === true,
  };
}

/** Find the existing infographic PNG to edit: prefer the named file, else newest .png. */
function findExistingPng(outDir: string, filename?: string): string | null {
  try {
    const named = filename ? path.join(outDir, `${safeBase(filename, 'infographic')}.png`) : null;
    if (named && fs.existsSync(named)) return named;
    const pngs = fs.readdirSync(outDir)
      .filter(f => f.toLowerCase().endsWith('.png'))
      .map(f => ({ f, t: fs.statSync(path.join(outDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    return pngs.length ? path.join(outDir, pngs[0].f) : null;
  } catch {
    return null;
  }
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
    // Edit mode: feed the existing infographic back in so Gemini tweaks it
    // in place (keeps the look) instead of redrawing from scratch.
    let baseImage: { base64: string; mimeType: string } | undefined;
    if (directive.edit) {
      const existing = findExistingPng(outDir, directive.filename);
      if (existing) baseImage = { base64: fs.readFileSync(existing).toString('base64'), mimeType: 'image/png' };
    }
    const { base64, usage } = await generateImage({ prompt: directive.prompt, image: baseImage });
    const file = path.join(outDir, `${safeBase(directive.filename, 'infographic')}.png`);
    fs.writeFileSync(file, Buffer.from(base64, 'base64'));
    return { filePath: file, fileType: 'png', usage };
  }

  const { html, usage } = await generateInfographicHtml({ prompt: directive.prompt, data: directive.data, style: directive.style });
  const file = path.join(outDir, `${safeBase(directive.filename, 'infographic')}.html`);
  fs.writeFileSync(file, html, 'utf-8');
  return { filePath: file, fileType: 'html', usage };
}

const REGION_EDIT_RULE = '\n\n（最重要）我已用半透明的筆刷在圖上塗抹標記出要修改的區域。只修改這些被筆刷塗到的區域，標記範圍以外的所有內容——文字、圖示、配色、版面——都必須完全保持原樣、一個像素都不要動。完成後請把那些半透明筆刷標記本身全部移除乾淨，不要殘留在圖上。';

/** Composite a brush mask (base64 PNG, may have a data: prefix) onto an image, returning the marked PNG buffer. */
export async function compositeRegionMask(originalAbsPath: string, maskBase64: string): Promise<Buffer> {
  const original = fs.readFileSync(originalAbsPath);
  const meta = await sharp(original).metadata();
  const maskBuf = Buffer.from(maskBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
  const maskResized = await sharp(maskBuf).resize(meta.width, meta.height, { fit: 'fill' }).png().toBuffer();
  return sharp(original).composite([{ input: maskResized, top: 0, left: 0 }]).png().toBuffer();
}

/** Edit only the brush-marked region of `markedImage` per `instruction`; writes the result to `outAbsPath`. */
export async function regionEditToFile(markedImage: Buffer, instruction: string, outAbsPath: string): Promise<{ usage: GeminiUsage }> {
  if (!isGeminiEnabled()) throw new Error('圖片編輯功能尚未設定（缺少 GEMINI_API_KEY）');
  const { base64, usage } = await generateImage({
    image: { base64: markedImage.toString('base64'), mimeType: 'image/png' },
    prompt: `${instruction.trim()}${REGION_EDIT_RULE}`,
  });
  fs.writeFileSync(outAbsPath, Buffer.from(base64, 'base64'));
  return { usage };
}
