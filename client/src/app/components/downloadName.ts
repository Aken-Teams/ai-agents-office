/**
 * The filename the server asked us to save as.
 *
 * Downloads go through fetch → blob → <a download>, and whatever we put in
 * `a.download` wins — so a caller that passes the plain filename silently
 * discards the server's choice. That matters because only the server knows the
 * file's version, and a folder full of identically-named "report.html" copies
 * is exactly what the version suffix exists to prevent.
 *
 * Reads RFC 5987 `filename*=UTF-8''…` first (the only form that carries Chinese
 * names correctly), then falls back to the plain quoted `filename=`.
 */
export function filenameFromResponse(res: Response): string | null {
  const cd = res.headers.get('content-disposition');
  if (!cd) return null;

  const star = cd.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (star) {
    try { return decodeURIComponent(star[1].trim()); } catch { /* fall through */ }
  }

  const plain = cd.match(/filename\s*=\s*"([^"]+)"/i) || cd.match(/filename\s*=\s*([^;]+)/i);
  if (!plain) return null;
  const raw = plain[1].trim();
  // Older responses percent-encoded the name into the plain parameter; decoding
  // is safe either way because a real name never contains a stray '%'.
  try { return /%[0-9a-f]{2}/i.test(raw) ? decodeURIComponent(raw) : raw; } catch { return raw; }
}
