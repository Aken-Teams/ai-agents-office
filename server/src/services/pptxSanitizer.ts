/**
 * pptxSanitizer — repair OOXML packaging defects in generated .pptx files.
 *
 * pptxgenjs 4.0.1 has a packaging bug: it writes one `<Override>` entry per
 * slide for `/ppt/slideMasters/slideMasterN.xml` into `[Content_Types].xml`,
 * but only ever emits a single `slideMaster1.xml` part. The result is a package
 * that declares content-type Overrides for parts that do not exist (orphan
 * overrides). LibreOffice and Office 365 silently tolerate this, but strict
 * builds (Office 2019 / 2024 / LTSC) reject the file — PowerPoint shows
 * "found a problem with content … repair", and stricter builds cannot open it
 * at all.
 *
 * This module strips any `<Override>` whose target part is missing from the
 * archive, producing a clean, spec-compliant package. It is idempotent: files
 * without orphan overrides are left untouched (no rewrite).
 */
import fs from 'fs';
import JSZip from 'jszip';

const CONTENT_TYPES = '[Content_Types].xml';

/**
 * Remove orphan `<Override PartName="…">` entries (parts declared in
 * [Content_Types].xml that do not exist in the package). Operates on a raw
 * .pptx/.docx/.xlsx buffer. Returns the (possibly) cleaned buffer plus whether
 * anything changed.
 */
export async function sanitizeOoxmlBuffer(buf: Buffer): Promise<{ buffer: Buffer; changed: boolean }> {
  const zip = await JSZip.loadAsync(buf);
  const ctFile = zip.file(CONTENT_TYPES);
  if (!ctFile) return { buffer: buf, changed: false };

  const xml = await ctFile.async('string');
  // Set of part paths that actually exist in the archive (leading '/').
  const present = new Set<string>();
  zip.forEach((relativePath) => { present.add('/' + relativePath.replace(/^\/+/, '')); });

  let removed = 0;
  const cleaned = xml.replace(/<Override\b[^>]*?PartName="([^"]+)"[^>]*\/>/g, (match, partName: string) => {
    // Keep the entry only if the referenced part is present in the package.
    if (present.has(partName)) return match;
    removed++;
    return '';
  });

  if (removed === 0) return { buffer: buf, changed: false };

  zip.file(CONTENT_TYPES, cleaned);
  const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { buffer: out, changed: true };
}

/**
 * Sanitize a .pptx (or other OOXML) file in place. Cheap and idempotent — if the
 * package has no orphan overrides it does not rewrite the file. Never throws:
 * on any failure it leaves the original file untouched and returns false.
 *
 * @returns true if the file was rewritten (had defects), false otherwise.
 */
export async function sanitizePptxFile(filePath: string): Promise<boolean> {
  try {
    if (!/\.(pptx|docx|xlsx)$/i.test(filePath)) return false;
    if (!fs.existsSync(filePath)) return false;
    const buf = await fs.promises.readFile(filePath);
    const { buffer, changed } = await sanitizeOoxmlBuffer(buf);
    if (!changed) return false;
    await fs.promises.writeFile(filePath, buffer);
    return true;
  } catch {
    // Best-effort: a repair failure must never block generation or download.
    return false;
  }
}
