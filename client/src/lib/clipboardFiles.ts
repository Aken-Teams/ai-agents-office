/**
 * Clipboard → file helpers.
 *
 * Lets users Ctrl+V a screenshot (or a file copied from the file manager)
 * straight into a chat composer instead of going through the upload button.
 *
 * Two clipboard shapes matter:
 *  - A screenshot / copied image lands as an `image/*` item whose File has no
 *    usable name ("image.png" in Chrome, "" in some browsers). The upload API
 *    validates by extension, so we re-wrap it with a timestamped name.
 *  - A file copied in Explorer/Finder lands in `clipboardData.files` already
 *    named — keep it as-is.
 */

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/tiff': 'tif',
  'image/x-icon': 'ico',
};

/** `2026-08-30T11:04:07.123Z` → `20260830-110407` */
function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Give a clipboard image a real filename so the server's extension check passes. */
function nameClipboardImage(file: File, index: number): File {
  const ext = MIME_EXT[file.type.toLowerCase()] || 'png';
  const hasRealName = file.name && /\.[a-z0-9]+$/i.test(file.name) && !/^image\.[a-z]+$/i.test(file.name);
  if (hasRealName) return file;
  const suffix = index > 0 ? `-${index + 1}` : '';
  return new File([file], `貼上圖片-${stamp()}${suffix}.${ext}`, {
    type: file.type || 'image/png',
    lastModified: file.lastModified,
  });
}

/**
 * Pull attachable files out of a paste event.
 *
 * Returns `[]` when the clipboard also carries plain text (copying a cell from
 * Excel puts both a text and an image flavour on the clipboard — the user means
 * the text) or when the paste is text-only, so the caller can just let the
 * browser paste normally.
 */
export function extractPastedFiles(data: DataTransfer | null): File[] {
  if (!data) return [];

  const items = data.items ? Array.from(data.items) : [];
  if (items.some(i => i.kind === 'string' && i.type === 'text/plain')) return [];

  const out: File[] = [];

  // Prefer items: this is where screenshots show up, and it carries the MIME type.
  for (const item of items) {
    if (item.kind !== 'file') continue;
    const f = item.getAsFile();
    if (!f || f.size === 0) continue;
    out.push(f.type.startsWith('image/') ? nameClipboardImage(f, out.length) : f);
  }

  // Fallback for browsers that don't populate `items` (older Safari).
  if (out.length === 0 && data.files && data.files.length > 0) {
    Array.from(data.files).forEach((f, i) => {
      if (f.size === 0) return;
      out.push(f.type.startsWith('image/') ? nameClipboardImage(f, i) : f);
    });
  }

  return out;
}
