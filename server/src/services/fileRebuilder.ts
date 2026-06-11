import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import JSZip from 'jszip';
import PptxGenJSModule from 'pptxgenjs';
import { dbGet, dbRun } from '../db.js';

// pptxgenjs may double-wrap the default export (ESM/CJS interop)
const PptxGenJS = (PptxGenJSModule as unknown as { default?: typeof PptxGenJSModule }).default || PptxGenJSModule;
import { config } from '../config.js';
import type { DocumentBlocksRecord, DocumentBlock, GeneratedFile } from '../types.js';

const execAsync = promisify(exec);

/** Map doc_type → generator script name */
const GENERATOR_SCRIPTS: Record<string, string> = {
  pptx: 'generate-pptx.ts',
  docx: 'generate-docx.ts',
  xlsx: 'generate-xlsx.ts',
  pdf: 'generate-pdf.ts',
  slides: 'generate-slides.ts',
};

/** Map doc_type → output file extension */
const DOC_TYPE_EXT: Record<string, string> = {
  pptx: 'pptx',
  docx: 'docx',
  xlsx: 'xlsx',
  pdf: 'pdf',
  slides: 'html',
};

/** Map doc_type → the key name used in the native JSON (slides[], sections[], sheets[]) */
const DOC_TYPE_ARRAY_KEY: Record<string, string> = {
  pptx: 'slides',
  docx: 'sections',
  xlsx: 'sheets',
  pdf: 'sections',
  slides: 'slides',
};

/**
 * Rebuild a generated file from its document_blocks data.
 *
 * 1. Read blocks from DB
 * 2. Reconstruct native JSON (e.g. { title, style, slides: [...] })
 * 3. Write input.json to sandbox
 * 4. Run the generator script
 * 5. Register new file version
 */
export async function rebuildFile(fileId: string, userId: string): Promise<GeneratedFile | null> {
  // Load block record
  const blockRecord = await dbGet<DocumentBlocksRecord>(
    'SELECT * FROM document_blocks WHERE file_id = ? AND user_id = ?',
    fileId, userId
  );
  if (!blockRecord) {
    console.error(`[FileRebuilder] No block record found for file ${fileId}`);
    return null;
  }

  const { doc_type, conversation_id } = blockRecord;
  const generatorScript = GENERATOR_SCRIPTS[doc_type];
  if (!generatorScript) {
    console.error(`[FileRebuilder] No generator script for doc_type: ${doc_type}`);
    return null;
  }

  // Load original file record to get output filename
  const originalFile = await dbGet<GeneratedFile>(
    'SELECT * FROM generated_files WHERE id = ? AND user_id = ?',
    fileId, userId
  );
  if (!originalFile) return null;

  // Reconstruct native JSON
  const blocks: DocumentBlock[] = JSON.parse(blockRecord.blocks);
  const meta = blockRecord.doc_meta ? JSON.parse(blockRecord.doc_meta) : {};
  const arrayKey = DOC_TYPE_ARRAY_KEY[doc_type];

  const nativeJson = {
    ...meta,
    [arrayKey]: blocks.sort((a, b) => a.order - b.order).map(b => ({
      type: b.type,  // generator needs slide type to render correctly
      ...b.data,
    })),
  };

  // Determine sandbox and output paths
  const sandboxPath = path.join(config.workspaceRoot, userId, conversation_id);
  const inputJsonPath = path.join(sandboxPath, 'input.json');
  const ext = DOC_TYPE_EXT[doc_type];
  const outputFilename = originalFile.filename.replace(/\.[^.]+$/, `.${ext}`);
  // Generator writes to sandbox root; we'll copy to the original file_path afterwards
  const outputPath = path.join(sandboxPath, outputFilename);
  // The DB file_path may point to a subdirectory (e.g. _agents/pptx-gen/)
  const originalFilePath = path.join(config.workspaceRoot, originalFile.file_path);

  // Write input.json
  fs.mkdirSync(sandboxPath, { recursive: true });
  fs.writeFileSync(inputJsonPath, JSON.stringify(nativeJson, null, 2), 'utf-8');

  // Debug: log first slide title to confirm data was updated
  const firstSlide = (nativeJson as any)[arrayKey]?.[0];
  console.log(`[FileRebuilder] Rebuilding ${outputFilename}: ${blocks.length} blocks, style=${meta.style || 'default'}, first slide: "${firstSlide?.title || '?'}" (type=${firstSlide?.type || '?'})`);

  // Run generator
  const scriptPath = path.join(config.generatorsDir, generatorScript);
  const nodeModulesDir = path.join(config.rootDir, 'server', 'node_modules');

  try {
    // Use tsx binary with absolute path to avoid module resolution issues in sandbox cwd
    // Use exec (not execFile) so the .CMD shim works on Windows
    const tsxBin = path.join(config.rootDir, 'server', 'node_modules', '.bin', 'tsx');
    const cmd = `"${tsxBin}" "${scriptPath}" "input.json" "${outputFilename}"`;
    await execAsync(cmd, {
      cwd: sandboxPath,
      env: { ...process.env, NODE_PATH: nodeModulesDir },
      timeout: 120_000,
    });
  } catch (err: any) {
    console.error(`[FileRebuilder] Generator failed:`, err.stderr || err.message);
    // Clean up input.json
    try { fs.unlinkSync(inputJsonPath); } catch {}
    return null;
  }

  // Clean up input.json
  try { fs.unlinkSync(inputJsonPath); } catch {}

  // Verify output file was generated
  if (!fs.existsSync(outputPath)) {
    console.error(`[FileRebuilder] Output file not found: ${outputPath}`);
    return null;
  }

  // Copy rebuilt file to original location if they differ
  // (original may be in _agents/pptx-gen/ subdirectory)
  if (path.resolve(outputPath) !== path.resolve(originalFilePath)) {
    fs.mkdirSync(path.dirname(originalFilePath), { recursive: true });
    fs.copyFileSync(outputPath, originalFilePath);
    console.log(`[FileRebuilder] Copied rebuilt file to original path: ${originalFile.file_path}`);
  }

  // Invalidate preview cache in BOTH the sandbox root and the original file's directory
  const originalDir = path.dirname(originalFilePath);
  const basename = path.basename(outputFilename, path.extname(outputFilename));
  for (const dir of new Set([sandboxPath, originalDir])) {
    const cacheDir = path.join(dir, '.preview-cache');
    const cachedPdf = path.join(cacheDir, `${basename}.pdf`);
    if (fs.existsSync(cachedPdf)) {
      try {
        fs.unlinkSync(cachedPdf);
        console.log(`[FileRebuilder] Cleared preview cache: ${cachedPdf}`);
      } catch (err) {
        console.warn(`[FileRebuilder] Could not delete cached PDF:`, err);
      }
    }
  }

  // Update existing file record in-place (keep same ID so frontend doesn't need to track)
  const newSize = fs.statSync(originalFilePath).size;
  await dbRun(
    `UPDATE generated_files SET file_size = ?, created_at = CURRENT_TIMESTAMP WHERE id = ?`,
    newSize, fileId
  );

  // Update block record timestamp
  await dbRun(
    `UPDATE document_blocks SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    blockRecord.id
  );

  console.log(`[FileRebuilder] Rebuilt ${outputFilename} (${newSize} bytes), cache cleared`);

  // Return the updated file record
  const updatedFile = await dbGet<GeneratedFile>(
    'SELECT * FROM generated_files WHERE id = ?', fileId
  );
  return updatedFile || null;
}

// ---------------------------------------------------------------------------
// Single-slide rebuild — regenerate ONE slide and splice it into the PPTX
// Used by blockRegenerator for non-patchable changes (colors, charts, etc.)
// Only modifies the target slide; all other slides stay untouched.
// ---------------------------------------------------------------------------

/**
 * Rebuild a single slide by generating a 1-slide PPTX with the shared generator
 * (which applies resolveSlideStyle for per-slide color overrides), then splicing
 * the generated slide XML into the original PPTX.
 *
 * Returns true if successful, false if not supported.
 */
export async function rebuildSingleSlide(
  fileId: string,
  userId: string,
  slideIndex: number,
  slideData: Record<string, unknown>,
  docMeta: Record<string, unknown>,
): Promise<GeneratedFile | null> {
  const fileRecord = await dbGet<GeneratedFile>(
    'SELECT * FROM generated_files WHERE id = ? AND user_id = ?',
    fileId, userId,
  );
  if (!fileRecord) return null;

  const blockRecord = await dbGet<DocumentBlocksRecord>(
    'SELECT * FROM document_blocks WHERE file_id = ? AND user_id = ?',
    fileId, userId,
  );
  if (!blockRecord) return null;

  const originalFilePath = path.join(config.workspaceRoot, fileRecord.file_path);
  if (!fs.existsSync(originalFilePath)) return null;

  // 1. Create temporary input.json with just the target slide
  const sandboxPath = path.join(config.workspaceRoot, userId, blockRecord.conversation_id);
  const tmpDir = path.join(sandboxPath, '_tmp_slide_rebuild');
  fs.mkdirSync(tmpDir, { recursive: true });

  const tmpInputPath = path.join(tmpDir, 'input.json');
  const tmpOutputPath = path.join(tmpDir, 'output.pptx');

  const tmpInput = {
    ...docMeta,
    slides: [{ type: slideData.type, ...slideData }],
  };
  fs.writeFileSync(tmpInputPath, JSON.stringify(tmpInput, null, 2), 'utf-8');

  // 2. Run the shared generator to produce a 1-slide PPTX
  const scriptPath = path.join(config.generatorsDir, 'generate-pptx.ts');
  const nodeModulesDir = path.join(config.rootDir, 'server', 'node_modules');
  const tsxBin = path.join(config.rootDir, 'server', 'node_modules', '.bin', 'tsx');

  try {
    const cmd = `"${tsxBin}" "${scriptPath}" "input.json" "output.pptx"`;
    await execAsync(cmd, {
      cwd: tmpDir,
      env: { ...process.env, NODE_PATH: nodeModulesDir },
      timeout: 30_000,
    });
  } catch (err: any) {
    console.error('[FileRebuilder] Single-slide generator failed:', err.stderr || err.message);
    cleanup(tmpDir);
    return null;
  }

  if (!fs.existsSync(tmpOutputPath)) {
    console.error('[FileRebuilder] Single-slide output not found');
    cleanup(tmpDir);
    return null;
  }

  // 3. Extract slide1.xml from the 1-slide PPTX
  try {
    const tmpData = fs.readFileSync(tmpOutputPath);
    const tmpZip = await JSZip.loadAsync(tmpData);
    const newSlideXml = await tmpZip.file('ppt/slides/slide1.xml')?.async('text');
    if (!newSlideXml) throw new Error('No slide1.xml in generated PPTX');

    // Also extract slide1 rels if present
    const newSlideRels = await tmpZip.file('ppt/slides/_rels/slide1.xml.rels')?.async('text') || null;

    // 4. Splice into original PPTX
    const origData = fs.readFileSync(originalFilePath);
    const origZip = await JSZip.loadAsync(origData);

    // Find slide files and sort by number
    const slideFiles: string[] = [];
    origZip.forEach((p) => {
      if (/^ppt\/slides\/slide\d+\.xml$/.test(p)) slideFiles.push(p);
    });
    slideFiles.sort((a, b) => {
      const na = parseInt(a.match(/slide(\d+)/)?.[1] || '0');
      const nb = parseInt(b.match(/slide(\d+)/)?.[1] || '0');
      return na - nb;
    });

    if (slideIndex >= slideFiles.length) {
      console.error(`[FileRebuilder] Slide index ${slideIndex} out of range (${slideFiles.length} slides)`);
      cleanup(tmpDir);
      return null;
    }

    const targetSlideFile = slideFiles[slideIndex];
    const targetSlideNum = targetSlideFile.match(/slide(\d+)/)?.[1] || '1';

    // Replace the slide XML
    origZip.file(targetSlideFile, newSlideXml);
    console.log(`[FileRebuilder] Replaced ${targetSlideFile} with regenerated slide`);

    // Replace rels if the new slide has them
    if (newSlideRels) {
      const targetRelsFile = `ppt/slides/_rels/slide${targetSlideNum}.xml.rels`;
      origZip.file(targetRelsFile, newSlideRels);
    }

    // Write updated PPTX
    const output = await origZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    fs.writeFileSync(originalFilePath, output);

    // Update file size
    const newSize = fs.statSync(originalFilePath).size;
    await dbRun(
      'UPDATE generated_files SET file_size = ?, created_at = CURRENT_TIMESTAMP WHERE id = ?',
      newSize, fileId,
    );

    // Invalidate preview cache
    const dir = path.dirname(originalFilePath);
    const basename = path.basename(fileRecord.filename, path.extname(fileRecord.filename));
    for (const cacheDir of new Set([dir, sandboxPath])) {
      const cachedPdf = path.join(cacheDir, '.preview-cache', `${basename}.pdf`);
      if (fs.existsSync(cachedPdf)) {
        try { fs.unlinkSync(cachedPdf); } catch {}
      }
    }

    console.log(`[FileRebuilder] Single-slide rebuild complete: slide ${slideIndex + 1} updated (${newSize} bytes)`);
    cleanup(tmpDir);

    return await dbGet<GeneratedFile>('SELECT * FROM generated_files WHERE id = ?', fileId) || null;
  } catch (err: any) {
    console.error('[FileRebuilder] Single-slide splice failed:', err);
    cleanup(tmpDir);
    return null;
  }
}

function cleanup(dir: string) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ---------------------------------------------------------------------------
// In-place block patching — patch all changed fields for a single block
// Used by blockRegenerator for fast single-block updates.
// ---------------------------------------------------------------------------

/** Fields that can be patched in-place via XML manipulation (text only).
 *  Charts and color fields are handled specially (see patchBlockInPlace):
 *  chart DATA + single-element colors patch in place; a chart TYPE change or a
 *  whole-slide redesign still falls back to a full rebuild. */
const PATCHABLE_FIELDS = new Set([
  'title', 'subtitle', 'quote', 'attribution', 'description', 'content',
  'bullets', 'points',
  'heading', // DOCX section heading
  // Colors — patched in place by swapping the old hex for the new one in the
  // slide XML (preserves the bespoke design; no full rebuild needed).
  'backgroundColor', 'textColor', 'titleColor', 'subtitleColor', 'accentColor', 'accentColor2',
]);

const COLOR_FIELDS = new Set([
  'backgroundColor', 'textColor', 'titleColor', 'subtitleColor', 'accentColor', 'accentColor2',
]);

/** Normalize chart-kind spellings so comparisons are stable. */
function normKind(k: string): string {
  const x = String(k || '').toLowerCase();
  if (x === 'donut' || x === 'doughnut') return 'doughnut';
  if (x === 'column') return 'bar';
  return x;
}

/**
 * Render ONE chart with pptxgenjs and return its `<c:plotArea>` + `<c:legend>`
 * XML. Used to re-render a chart in place on a type/colour/legend change: we drop
 * the fresh plot area + legend into the existing chart part, leaving the chart's
 * title/frame/embedding untouched. Pie/doughnut get a legend + % labels by
 * default so the slices are readable.
 */
async function genChart(
  kind: string, labels: string[], values: number[], colors: string[], showLegend?: boolean,
): Promise<{ plotArea: string; legend: string } | null> {
  const map: Record<string, string> = {
    bar: 'bar', column: 'bar', line: 'line', area: 'area', pie: 'pie', donut: 'doughnut', doughnut: 'doughnut',
  };
  const k = map[String(kind).toLowerCase()] || 'bar';
  const circular = k === 'pie' || k === 'doughnut';
  const legendOn = showLegend === undefined ? circular : showLegend;
  const pptx = new PptxGenJS();
  const ctype = (pptx as any).ChartType[k] || (pptx as any).ChartType.bar;
  const slide = pptx.addSlide();
  slide.addChart(ctype, [{ name: 'Series', labels, values }], {
    x: 1, y: 1, w: 6, h: 4,
    chartColors: colors.length ? colors : ['2B6CB0', 'E84855', '38A169', 'D69E2E', '805AD5', 'DD6B20'],
    barDir: 'col',
    holeSize: k === 'doughnut' ? 55 : undefined,
    showLegend: legendOn,
    legendPos: 'r',
    legendFontSize: 9,
    showPercent: circular,           // % labels on pie/doughnut slices
    dataLabelColor: circular ? 'FFFFFF' : undefined,
    dataLabelFontSize: 9,
  } as any);
  const buf = await (pptx as any).write({ outputType: 'nodebuffer' }) as Buffer;
  const z = await JSZip.loadAsync(buf);
  const cf = Object.keys(z.files).filter(p => /ppt\/charts\/chart\d+\.xml$/.test(p)).sort()[0];
  if (!cf) return null;
  const cx = await z.file(cf)!.async('text');
  const pa = cx.match(/<c:plotArea>[\s\S]*<\/c:plotArea>/);
  if (!pa) return null;
  const lg = cx.match(/<c:legend>[\s\S]*?<\/c:legend>/);
  return { plotArea: pa[0], legend: lg ? lg[0] : '' };
}

/** Pull the series/slice colors out of a chart part so a type swap keeps them.
 *  Skips near-white fills (plot/label backgrounds) that aren't real data colors. */
function extractChartColors(chartXml: string): string[] {
  const plot = (chartXml.match(/<c:plotArea>[\s\S]*<\/c:plotArea>/) || [''])[0];
  const seen = new Set<string>();
  for (const m of plot.matchAll(/<a:srgbClr val="([0-9A-Fa-f]{6})"/g)) {
    const c = m[1].toUpperCase();
    const r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
    if (r > 235 && g > 235 && b > 235) continue; // near-white background, not a data colour
    seen.add(c);
  }
  return [...seen];
}

/** A column/pane object minus its chart (for comparing the non-chart parts). */
function stripChart(o: unknown): unknown {
  if (!o || typeof o !== 'object') return o;
  const { chart, ...rest } = o as Record<string, unknown>;
  void chart;
  return rest;
}

/** True if the ONLY difference between old/new is a nested chart (so we can
 *  patch it in place instead of rebuilding the whole slide). Handles a single
 *  pane (left/right) or a columns[] array. */
function isChartOnlyChange(oldVal: unknown, newVal: unknown): boolean {
  if (Array.isArray(oldVal) && Array.isArray(newVal)) {
    if (oldVal.length !== newVal.length) return false;
    let chartDiff = false;
    for (let i = 0; i < oldVal.length; i++) {
      if (JSON.stringify(stripChart(oldVal[i])) !== JSON.stringify(stripChart(newVal[i]))) return false;
      if (JSON.stringify((oldVal[i] as any)?.chart) !== JSON.stringify((newVal[i] as any)?.chart)) chartDiff = true;
    }
    return chartDiff;
  }
  if (oldVal && newVal && typeof oldVal === 'object' && typeof newVal === 'object') {
    return JSON.stringify(stripChart(oldVal)) === JSON.stringify(stripChart(newVal))
      && JSON.stringify((oldVal as any).chart) !== JSON.stringify((newVal as any).chart);
  }
  return false;
}

/** All charts on a slide in PowerPoint's graphic-frame order: top-level `charts`,
 *  else panes (left→right) / columns, else a single `chart`. */
function collectSlideCharts(d: any): unknown[] {
  if (Array.isArray(d?.charts)) return d.charts;
  const out: unknown[] = [];
  if (d?.left?.chart) out.push(d.left.chart);
  if (d?.right?.chart) out.push(d.right.chart);
  if (Array.isArray(d?.columns)) for (const c of d.columns) if (c?.chart) out.push(c.chart);
  if (!out.length && d?.chart) out.push(d.chart);
  return out;
}

/**
 * Patch a single block's changed fields directly in the PPTX/DOCX file.
 * Compares oldData vs newData and patches each changed field.
 * Returns true if patching was attempted (even if some fields couldn't match).
 * Returns false if patching is not supported for this doc type (caller should rebuild).
 */
export async function patchBlockInPlace(
  fileId: string,
  userId: string,
  slideIndex: number,
  oldData: Record<string, unknown>,
  newData: Record<string, unknown>,
  docType: string,
): Promise<boolean> {
  if (docType !== 'pptx' && docType !== 'docx') {
    return false; // Not supported — caller should use rebuildFile()
  }

  // Load file record to get path
  const fileRecord = await dbGet<GeneratedFile>(
    'SELECT * FROM generated_files WHERE id = ? AND user_id = ?',
    fileId, userId,
  );
  if (!fileRecord) return false;

  const filePath = path.join(config.workspaceRoot, fileRecord.file_path);
  if (!fs.existsSync(filePath)) return false;

  // Find changed patchable fields
  const changedFields: { key: string; oldVal: unknown; newVal: unknown }[] = [];
  const nonPatchableChanges: string[] = [];
  let chartChanged = false;
  for (const key of Object.keys(newData)) {
    const oldVal = oldData[key];
    const newVal = newData[key];
    if (JSON.stringify(oldVal) === JSON.stringify(newVal)) continue;
    if (key === 'charts' || key === 'chart') {
      // Chart DATA and TYPE both patch in place (data → cache rewrite; type →
      // re-render just that chart's plot area).
      if (docType === 'pptx') chartChanged = true;
      else nonPatchableChanges.push(key);
    } else if (key === 'left' || key === 'right' || key === 'columns') {
      // A column/pane changed: patch in place ONLY if the sole difference is a
      // nested chart (data/type). Any text/structure change there → rebuild.
      if (docType === 'pptx' && isChartOnlyChange(oldVal, newVal)) chartChanged = true;
      else nonPatchableChanges.push(key);
    } else if (PATCHABLE_FIELDS.has(key)) {
      changedFields.push({ key, oldVal, newVal });
    } else {
      nonPatchableChanges.push(key);
    }
  }
  // One chart patch for the whole slide, in graphic-frame order (covers top-level
  // charts and charts nested in columns/panes). Index alignment is guaranteed by
  // collecting them in the same order PowerPoint lays them out.
  if (chartChanged) {
    changedFields.push({ key: 'charts', oldVal: null, newVal: collectSlideCharts(newData) });
  }

  // If ANY non-patchable fields changed (colors, charts, layout), force full rebuild.
  // The rebuild also handles text changes, so we don't lose patchable field updates.
  if (nonPatchableChanges.length > 0) {
    console.log(`[FileRebuilder] patchBlockInPlace: non-patchable fields changed: [${nonPatchableChanges.join(', ')}] → fallback to rebuild`);
    return false;
  }

  if (changedFields.length === 0) {
    console.log(`[FileRebuilder] patchBlockInPlace: no field changes detected at all`);
    return true; // Genuinely nothing changed
  }

  // Apply patches
  let anyPatched = false;
  if (docType === 'pptx') {
    for (const { key, oldVal, newVal } of changedFields) {
      const ok = await patchPptxField(filePath, slideIndex, key, oldVal, newVal);
      if (ok) anyPatched = true;
    }
  } else if (docType === 'docx') {
    for (const { key, oldVal, newVal } of changedFields) {
      const ok = await patchDocxField(filePath, slideIndex, key, oldVal, newVal);
      if (ok) anyPatched = true;
    }
  }

  if (!anyPatched) return true; // Fields were attempted but no XML match

  // Invalidate preview cache
  const blockRecord = await dbGet<DocumentBlocksRecord>(
    'SELECT * FROM document_blocks WHERE file_id = ? AND user_id = ?',
    fileId, userId,
  );
  const dir = path.dirname(filePath);
  const basename = path.basename(fileRecord.filename, path.extname(fileRecord.filename));
  const cachedPdf = path.join(dir, '.preview-cache', `${basename}.pdf`);
  if (fs.existsSync(cachedPdf)) {
    try { fs.unlinkSync(cachedPdf); } catch {}
  }
  if (blockRecord) {
    const sandboxPath = path.join(config.workspaceRoot, userId, blockRecord.conversation_id);
    const rootCachedPdf = path.join(sandboxPath, '.preview-cache', `${basename}.pdf`);
    if (rootCachedPdf !== cachedPdf && fs.existsSync(rootCachedPdf)) {
      try { fs.unlinkSync(rootCachedPdf); } catch {}
    }
  }

  // Update file size
  const newSize = fs.statSync(filePath).size;
  await dbRun(
    'UPDATE generated_files SET file_size = ?, created_at = CURRENT_TIMESTAMP WHERE id = ?',
    newSize, fileId,
  );

  console.log(`[FileRebuilder] patchBlockInPlace: patched ${changedFields.length} fields for slide ${slideIndex + 1}`);
  return true;
}

// ---------------------------------------------------------------------------
// In-place field patching — modify text directly inside PPTX/DOCX XML
// This preserves all formatting, charts, and visual elements.
// ---------------------------------------------------------------------------

/**
 * Patch a single text field inside a generated file without regenerating it.
 * For PPTX: modifies slide XML directly to replace text.
 * Returns the updated file record, or null on failure.
 */
export async function patchFileField(
  fileId: string,
  userId: string,
  blockId: string,
  fieldKey: string,
  newValue: unknown,
): Promise<GeneratedFile | null> {
  // Load block record
  const blockRecord = await dbGet<DocumentBlocksRecord>(
    'SELECT * FROM document_blocks WHERE file_id = ? AND user_id = ?',
    fileId, userId,
  );
  if (!blockRecord) return null;

  const { doc_type } = blockRecord;
  const blocks: DocumentBlock[] = JSON.parse(blockRecord.blocks);
  const block = blocks.find(b => b.id === blockId);
  if (!block) return null;

  // Get original value before we update it
  const oldValue = block.data[fieldKey];

  // Update block data in DB
  block.data[fieldKey] = newValue;
  await dbRun(
    'UPDATE document_blocks SET blocks = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    JSON.stringify(blocks), blockRecord.id,
  );

  // Load file record to get path
  const fileRecord = await dbGet<GeneratedFile>(
    'SELECT * FROM generated_files WHERE id = ? AND user_id = ?',
    fileId, userId,
  );
  if (!fileRecord) return null;

  const filePath = path.join(config.workspaceRoot, fileRecord.file_path);
  if (!fs.existsSync(filePath)) return null;

  let patched = false;

  if (doc_type === 'pptx') {
    patched = await patchPptxField(filePath, block.order, fieldKey, oldValue, newValue);
  } else if (doc_type === 'docx') {
    patched = await patchDocxField(filePath, block.order, fieldKey, oldValue, newValue);
  }

  if (!patched) {
    console.warn(`[FileRebuilder] Patch not supported for ${doc_type}, field ${fieldKey}`);
    return fileRecord;
  }

  // Invalidate preview cache
  const dir = path.dirname(filePath);
  const basename = path.basename(fileRecord.filename, path.extname(fileRecord.filename));
  const cachedPdf = path.join(dir, '.preview-cache', `${basename}.pdf`);
  if (fs.existsSync(cachedPdf)) {
    try { fs.unlinkSync(cachedPdf); } catch {}
  }
  // Also clear sandbox root cache if different
  const sandboxPath = path.join(config.workspaceRoot, userId, blockRecord.conversation_id);
  const rootCachedPdf = path.join(sandboxPath, '.preview-cache', `${basename}.pdf`);
  if (rootCachedPdf !== cachedPdf && fs.existsSync(rootCachedPdf)) {
    try { fs.unlinkSync(rootCachedPdf); } catch {}
  }

  // Update file size
  const newSize = fs.statSync(filePath).size;
  await dbRun(
    'UPDATE generated_files SET file_size = ?, created_at = CURRENT_TIMESTAMP WHERE id = ?',
    newSize, fileId,
  );

  console.log(`[FileRebuilder] Patched slide ${block.order + 1} field "${fieldKey}" in ${fileRecord.filename}`);

  return await dbGet<GeneratedFile>('SELECT * FROM generated_files WHERE id = ?', fileId) || null;
}

/**
 * Replace text inside a PPTX slide XML.
 * Handles title, subtitle, bullet points, and other text fields.
 */
async function patchPptxField(
  filePath: string,
  slideIndex: number,
  fieldKey: string,
  oldValue: unknown,
  newValue: unknown,
): Promise<boolean> {
  const data = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(data);

  // Find the target slide file
  const slideFiles: string[] = [];
  zip.forEach((p) => {
    if (/^ppt\/slides\/slide\d+\.xml$/.test(p)) slideFiles.push(p);
  });
  slideFiles.sort((a, b) => {
    const na = parseInt(a.match(/slide(\d+)/)?.[1] || '0');
    const nb = parseInt(b.match(/slide(\d+)/)?.[1] || '0');
    return na - nb;
  });

  if (slideIndex >= slideFiles.length) return false;

  const slideFile = slideFiles[slideIndex];
  let xml = await zip.file(slideFile)!.async('text');
  let modified = false;

  if (fieldKey === 'title' || fieldKey === 'subtitle' || fieldKey === 'quote' ||
      fieldKey === 'attribution' || fieldKey === 'description' || fieldKey === 'content') {
    const oldText = String(oldValue || '');
    const newText = String(newValue || '');
    console.log(`[FileRebuilder] patchPptxField: slide=${slideIndex}, field=${fieldKey}, old="${oldText.slice(0, 50)}", new="${newText.slice(0, 50)}"`);
    if (oldText && oldText !== newText) {
      // Try 1: direct match (oldText might already be XML-escaped from capture)
      if (xml.includes(oldText)) {
        xml = xml.replace(oldText, escapeXml(newText));
        modified = true;
        console.log(`[FileRebuilder] → direct match (raw oldText)`);
      }
      // Try 2: escaped match
      else if (xml.includes(escapeXml(oldText))) {
        xml = xml.replace(escapeXml(oldText), escapeXml(newText));
        modified = true;
        console.log(`[FileRebuilder] → direct match (escaped oldText)`);
      }
      // Try 3: paragraph-level concatenation match
      else {
        const result = replaceTextAcrossRuns(xml, oldText, newText);
        xml = result.xml;
        modified = result.found;
        if (!result.found) {
          console.warn(`[FileRebuilder] → ALL match strategies failed for field "${fieldKey}"`);
        }
      }
    }
  } else if (fieldKey === 'bullets' || fieldKey === 'points') {
    // Bullet list: replace each bullet text individually
    const oldBullets = (Array.isArray(oldValue) ? oldValue : []) as string[];
    const newBullets = (Array.isArray(newValue) ? newValue : []) as string[];
    for (let i = 0; i < Math.min(oldBullets.length, newBullets.length); i++) {
      const oldB = typeof oldBullets[i] === 'string' ? oldBullets[i] : '';
      const newB = typeof newBullets[i] === 'string' ? newBullets[i] : '';
      if (oldB && oldB !== newB) {
        const escaped = escapeXml(oldB);
        const escapedNew = escapeXml(newB);
        if (xml.includes(escaped)) {
          xml = xml.replace(escaped, escapedNew);
          modified = true;
        } else {
          // Bullet text split across runs
          const result = replaceTextAcrossRuns(xml, oldB, newB);
          xml = result.xml;
          if (result.found) modified = true;
        }
      }
    }
  } else if (COLOR_FIELDS.has(fieldKey)) {
    // Swap the old hex for the new one throughout this slide's XML. Targeted:
    // only that exact colour changes; the rest of the bespoke design is kept.
    const oldHex = String(oldValue || '').replace('#', '').toUpperCase();
    const newHex = String(newValue || '').replace('#', '').toUpperCase();
    if (/^[0-9A-F]{6}$/.test(oldHex) && /^[0-9A-F]{6}$/.test(newHex) && oldHex !== newHex && new RegExp(oldHex, 'i').test(xml)) {
      xml = xml.replace(new RegExp(oldHex, 'gi'), newHex);
      modified = true;
      console.log(`[FileRebuilder] patchPptxField: color ${fieldKey} ${oldHex}→${newHex}`);
    }
  } else if (fieldKey === 'charts' || fieldKey === 'chart') {
    // Chart DATA edit (labels/values) — patch the chart parts' cached data so
    // the existing chart object updates without touching the rest of the slide.
    const newCharts = fieldKey === 'chart'
      ? (newValue ? [newValue] : [])
      : (Array.isArray(newValue) ? newValue : []);
    const ok = await patchSlideChartData(zip, slideFile, slideIndex, newCharts as ChartCacheData[]);
    if (ok) modified = true;
  }

  if (modified) {
    zip.file(slideFile, xml);
    const output = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    fs.writeFileSync(filePath, output);
  }

  return true; // DB was updated even if XML patch didn't match
}

// ── Chart data in-place patching ──────────────────────────────────────────
interface ChartCacheData {
  kind?: string; type?: string;
  labels?: string[]; values?: number[];
  slices?: { label: string; value: number }[];
  bars?: { label: string; value: number }[];
  colors?: string[];
  showLegend?: boolean;
}

const xmlEsc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Rewrite the first numeric cache (`<c:numCache>`) with new values. */
function setNumCache(xml: string, values: number[]): string {
  return xml.replace(/<c:numCache>([\s\S]*?)<\/c:numCache>/, (_m, inner) => {
    const fmt = (inner.match(/<c:formatCode>[\s\S]*?<\/c:formatCode>/) || [''])[0];
    const pts = values.map((v, i) => `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`).join('');
    return `<c:numCache>${fmt}<c:ptCount val="${values.length}"/>${pts}</c:numCache>`;
  });
}

/** Rewrite the category cache (str or multi-level) with new labels. */
function setCatCache(xml: string, labels: string[]): string {
  const pts = labels.map((l, i) => `<c:pt idx="${i}"><c:v>${xmlEsc(l)}</c:v></c:pt>`).join('');
  if (/<c:multiLvlStrCache>/.test(xml)) {
    return xml.replace(/<c:multiLvlStrCache>[\s\S]*?<\/c:multiLvlStrCache>/,
      `<c:multiLvlStrCache><c:ptCount val="${labels.length}"/><c:lvl>${pts}</c:lvl></c:multiLvlStrCache>`);
  }
  if (/<c:strCache>/.test(xml)) {
    return xml.replace(/<c:strCache>[\s\S]*?<\/c:strCache>/,
      `<c:strCache><c:ptCount val="${labels.length}"/>${pts}</c:strCache>`);
  }
  return xml;
}

/** Patch each chart on a slide (matched in document order) with new labels/values. */
async function patchSlideChartData(zip: JSZip, slideFile: string, _slideIndex: number, newCharts: ChartCacheData[]): Promise<boolean> {
  if (!newCharts.length) return false;
  const slideXml = await zip.file(slideFile)?.async('text') || '';
  const rIds = [...slideXml.matchAll(/<c:chart[^>]*r:id="(rId\d+)"/g)].map(m => m[1]);
  if (!rIds.length) return false;
  const relsPath = `ppt/slides/_rels/${path.basename(slideFile)}.rels`;
  const relsXml = await zip.file(relsPath)?.async('text') || '';
  let patched = false;
  for (let i = 0; i < rIds.length && i < newCharts.length; i++) {
    const nc = newCharts[i];
    if (!nc) continue;
    const tgt = (relsXml.match(new RegExp(`Id="${rIds[i]}"[^>]*Target="([^"]+)"`)) || [])[1];
    if (!tgt) continue;
    // Target may be absolute ("/ppt/charts/chartN.xml") or relative ("../charts/chartN.xml").
    const partPath = tgt.startsWith('/') ? tgt.slice(1) : 'ppt/' + tgt.replace(/^\.\.\//, '');
    const cf = zip.file(partPath);
    if (!cf) continue;
    let cx = await cf.async('text');
    const items = nc.slices || nc.bars;
    const values = nc.values || items?.map(x => x.value) || [];
    const labels = nc.labels || items?.map(x => x.label) || [];

    // Detect the chart's CURRENT type + colors from its XML and compare to the request.
    const curType = (cx.match(/<c:(barChart|lineChart|pieChart|doughnutChart|areaChart)/) || [])[1];
    const curKind = curType ? normKind(curType.replace('Chart', '')) : '';
    const newKind = normKind(String(nc.kind || nc.type || ''));
    const curColors = extractChartColors(cx);
    const newColors = (nc.colors || []).map(c => String(c).replace('#', '').toUpperCase()).filter(c => /^[0-9A-F]{6}$/.test(c));
    const kindChanged = !!newKind && !!curKind && newKind !== curKind;
    const colorsChanged = newColors.length > 0 && JSON.stringify(newColors) !== JSON.stringify(curColors);
    const targetKind = kindChanged ? newKind : curKind;
    const circular = targetKind === 'pie' || targetKind === 'doughnut';
    const curHasLegend = /<c:legend>/.test(cx);
    // Pie/doughnut need a legend (slices = categories); bar/line put categories
    // on the axis, so a single-series legend is just a useless "Series" box —
    // default it OFF for those (unless the user explicitly asked for one).
    const wantLegend = nc.showLegend !== undefined ? !!nc.showLegend : circular;
    const legendChanged = wantLegend !== curHasLegend;

    if ((kindChanged || colorsChanged || legendChanged) && labels.length && values.length) {
      // TYPE / COLOUR / LEGEND change — re-render this chart's plot area (+ legend),
      // keeping the title/frame/embedding intact.
      const colors = newColors.length ? newColors : curColors;
      const gen = await genChart(targetKind, labels, values, colors, wantLegend);
      if (gen) {
        cx = cx.replace(/<c:plotArea>[\s\S]*<\/c:plotArea>/, gen.plotArea);
        if (curHasLegend) {
          cx = gen.legend
            ? cx.replace(/<c:legend>[\s\S]*?<\/c:legend>/, gen.legend)
            : cx.replace(/<c:legend>[\s\S]*?<\/c:legend>/, '');
        } else if (gen.legend) {
          cx = cx.replace('</c:plotArea>', `</c:plotArea>${gen.legend}`);
        }
        zip.file(partPath, cx);
        patched = true;
        continue;
      }
      // If generation failed, fall through to a data-only patch.
    }

    // DATA-ONLY — rewrite the cached labels/values, keep the original styling.
    if (values.length) cx = setNumCache(cx, values);
    if (labels.length) cx = setCatCache(cx, labels);
    zip.file(partPath, cx);
    patched = true;
  }
  return patched;
}

/**
 * Patch text inside a DOCX file.
 */
async function patchDocxField(
  filePath: string,
  _sectionIndex: number,
  fieldKey: string,
  oldValue: unknown,
  newValue: unknown,
): Promise<boolean> {
  if (fieldKey !== 'title' && fieldKey !== 'content' && fieldKey !== 'heading') return false;

  const data = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(data);
  const docFile = zip.file('word/document.xml');
  if (!docFile) return false;

  let xml = await docFile.async('text');
  const oldText = String(oldValue || '');
  const newText = String(newValue || '');

  if (oldText && oldText !== newText) {
    const escaped = escapeXml(oldText);
    const escapedNew = escapeXml(newText);
    if (xml.includes(escaped)) {
      xml = xml.replace(escaped, escapedNew);
      zip.file('word/document.xml', xml);
      const output = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      fs.writeFileSync(filePath, output);
    }
  }

  return true;
}

/**
 * Replace text in a slide's <a:p> paragraphs.
 *
 * Strategies (in order):
 * 1. Exact paragraph match (concatenated runs === oldText)
 * 2. Fuzzy match: find the paragraph whose text best overlaps with oldText
 *    (handles cases where the generator transforms the title, e.g. strips year)
 *
 * Returns { xml, found } so caller knows if replacement actually happened.
 */
function replaceTextAcrossRuns(xml: string, oldText: string, newText: string): { xml: string; found: boolean } {
  const escapedNew = escapeXml(newText);
  const oldTrimmed = oldText.trim();
  const oldEscaped = escapeXml(oldText).trim();

  // Parse all paragraphs with their text
  const pRegex = /<a:p\b[^>]*>[\s\S]*?<\/a:p>/g;
  const paragraphs: { raw: string; text: string; tMatches: { full: string; text: string }[] }[] = [];
  let match: RegExpExecArray | null;

  while ((match = pRegex.exec(xml)) !== null) {
    const raw = match[0];
    const tRegex = /<a:t\b[^>]*>([^<]*)<\/a:t>/g;
    const tMatches: { full: string; text: string }[] = [];
    let tMatch: RegExpExecArray | null;
    while ((tMatch = tRegex.exec(raw)) !== null) {
      tMatches.push({ full: tMatch[0], text: tMatch[1] });
    }
    if (tMatches.length === 0) continue;
    const text = tMatches.map(t => t.text).join('').trim();
    if (text) paragraphs.push({ raw, text, tMatches });
  }

  // Strategy 1: exact match
  let target = paragraphs.find(p =>
    p.text === oldTrimmed || p.text === oldEscaped
  );

  // Strategy 2: containment match (also normalizing whitespace)
  // Pick the longest matching paragraph (most specific) with minimum 4 chars overlap
  if (!target) {
    const MIN_OVERLAP = 4;
    const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
    const oldNorm = normalize(oldTrimmed);
    const oldEscNorm = normalize(oldEscaped);
    let bestScore = 0;
    for (const p of paragraphs) {
      if (p.text.length < MIN_OVERLAP) continue;
      const pNorm = normalize(p.text);
      // Exact match with normalized whitespace
      if (pNorm === oldNorm || pNorm === oldEscNorm) {
        target = p;
        break;
      }
      // Containment: oldText contains paragraph text or vice versa
      if (oldNorm.includes(pNorm) || oldEscNorm.includes(pNorm)) {
        if (pNorm.length > bestScore) {
          bestScore = pNorm.length;
          target = p;
        }
      } else if (pNorm.includes(oldNorm) || pNorm.includes(oldEscNorm)) {
        if (pNorm.length > bestScore) {
          bestScore = pNorm.length;
          target = p;
        }
      }
    }
    if (target) {
      console.log(`[FileRebuilder] Fuzzy matched paragraph: "${target.text.slice(0, 40)}" for old: "${oldTrimmed.slice(0, 40)}"`);
    }
  }

  if (target) {
    let newParagraph = target.raw;
    for (let i = 0; i < target.tMatches.length; i++) {
      if (i === 0) {
        const attrMatch = target.tMatches[i].full.match(/^<a:t([^>]*)>/);
        const attrs = attrMatch ? attrMatch[1] : '';
        newParagraph = newParagraph.replace(target.tMatches[i].full, `<a:t${attrs}>${escapedNew}</a:t>`);
      } else {
        newParagraph = newParagraph.replace(target.tMatches[i].full, target.tMatches[i].full.replace(/>[^<]*</, '><'));
      }
    }
    const result = xml.replace(target.raw, newParagraph);
    console.log(`[FileRebuilder] Patched text: "${target.text.slice(0, 40)}" → "${newText.slice(0, 40)}"`);
    return { xml: result, found: true };
  }

  console.warn(`[FileRebuilder] replaceTextAcrossRuns FAILED for: "${oldTrimmed.slice(0, 60)}"`);
  console.warn(`[FileRebuilder] Available paragraphs:`, paragraphs.map(p => `"${p.text.slice(0, 50)}"`));
  return { xml, found: false };
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
