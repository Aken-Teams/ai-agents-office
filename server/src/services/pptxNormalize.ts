/**
 * PPTX Normalization — pre-delivery schema repair via LibreOffice round-trip.
 *
 * ── Why this exists ──
 * pptxgenjs (our chart/deck generator) emits chart OOXML that is NOT strictly
 * schema-compliant. Microsoft PowerPoint enforces the schema and shows a
 * "needs repair" prompt on open; LibreOffice and python-pptx are lenient and
 * open the same file fine — so the break is invisible until a customer opens it
 * in real PowerPoint (on Office 2019/2024 that can't even run repair).
 *
 * Confirmed defect classes (all in charts, verified against a real broken deck
 * and PowerPoint's own repaired copy):
 *   1. `<c:multiLvlStrRef>` used for a single-level category axis (must be ≥2
 *      levels; PowerPoint rewrites it to `<c:strRef>`).
 *   2. a bar chart referencing an axId with no matching axis definition.
 *   3. two `<p:graphicFrame>` (chart + table) sharing one `<p:cNvPr id>`.
 *   4. a malformed embedded-workbook table ref (`ref="A1:B11'"`).
 * Hand-patching each is whack-a-mole (fixing all four STILL left a repair
 * prompt — there were more). Instead we let LibreOffice re-serialize the deck
 * from its clean internal model: one round-trip rewrites the WHOLE package as
 * valid OOXML, fixing all known AND unknown pptxgenjs schema issues at once,
 * WITHOUT dropping content (PowerPoint's own repair deletes what it can't fix;
 * LibreOffice keeps everything). Verified: the round-tripped deck opens in
 * PowerPoint with no repair prompt and identical layout.
 *
 * This reuses the exact mechanism the preview feature already runs on the
 * production box (filePreview.ts → `soffice --headless --convert-to pdf`); here
 * we convert pptx → pptx instead. No new dependency — LibreOffice is already
 * installed for previews.
 *
 * Non-fatal: if LibreOffice is missing or the conversion fails, the original
 * file is left untouched (no worse than today).
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import JSZip from 'jszip';
import { findLibreOffice } from './filePreview.js';

const execFileAsync = promisify(execFile);

const CONVERT_TIMEOUT = 60_000;

/** True if the .pptx contains at least one chart part — the marker for the
 *  pptxgenjs schema bugs. Pure-text decks have none of these issues, so we skip
 *  them (saves the LibreOffice round-trip and avoids re-rendering when it isn't
 *  needed). */
async function hasCharts(filePath: string): Promise<boolean> {
  try {
    const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
    return Object.keys(zip.files).some(n => /^ppt\/charts\/chart\d+\.xml$/.test(n));
  } catch {
    return false;
  }
}

/**
 * Round-trip a .pptx through LibreOffice to normalize it into valid OOXML,
 * overwriting the file in place. Returns whether the file was rewritten and its
 * new size.
 *
 * Only decks that contain charts are processed (unless `force` is set). Safe to
 * call on any path; a non-pptx / chart-less / unconvertible file is left as-is.
 */
export async function normalizePptx(
  filePath: string,
  opts: { force?: boolean } = {},
): Promise<{ normalized: boolean; newSize?: number }> {
  try {
    if (!filePath.toLowerCase().endsWith('.pptx') || !fs.existsSync(filePath)) {
      return { normalized: false };
    }
    if (!opts.force && !(await hasCharts(filePath))) return { normalized: false };

    const soffice = await findLibreOffice();
    if (!soffice) {
      console.warn('[PptxNormalize] LibreOffice not found — skipping normalization.');
      return { normalized: false };
    }

    // Convert into an isolated temp dir. Input is already .pptx, so LibreOffice
    // would write a same-named file — converting into a separate dir avoids
    // clobbering the source mid-write, then we copy the clean result back.
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pptxnorm-'));
    // A per-run UserInstallation profile lets this run concurrently with the
    // preview converter (a shared LibreOffice profile is single-instance).
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-profile-'));

    try {
      await execFileAsync(soffice, [
        '-env:UserInstallation=file:///' + profileDir.replace(/\\/g, '/'),
        '--headless',
        '--convert-to', 'pptx',
        '--outdir', outDir,
        filePath,
      ], { timeout: CONVERT_TIMEOUT });

      const produced = path.join(outDir, `${path.basename(filePath, path.extname(filePath))}.pptx`);
      if (!fs.existsSync(produced)) {
        console.warn(`[PptxNormalize] LibreOffice produced no output for ${path.basename(filePath)}.`);
        return { normalized: false };
      }
      // Sanity: never replace a good file with an empty/broken one.
      const size = fs.statSync(produced).size;
      if (size < 1024) {
        console.warn(`[PptxNormalize] normalized output suspiciously small (${size}B) — keeping original.`);
        return { normalized: false };
      }

      fs.copyFileSync(produced, filePath);
      console.log(`[PptxNormalize] normalized ${path.basename(filePath)} via LibreOffice (${size} bytes).`);
      return { normalized: true, newSize: size };
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  } catch (e) {
    console.warn(`[PptxNormalize] failed for ${path.basename(filePath)} (non-fatal):`, (e as Error).message);
    return { normalized: false };
  }
}
