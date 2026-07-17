/**
 * Shared email-content helpers used by BOTH the email MCP subprocess
 * (server/src/mcp/emailMcp.ts) and the in-process email assistant
 * (emailAttachmentReader / emailAgent / emailAgentPoller).
 *
 * Design rule: this module must stay CHEAP to import — the MCP subprocess loads
 * it at startup and has to answer the MCP handshake within a short window. So
 * there are NO heavy top-level imports; `sharp` is imported lazily inside
 * downscaleImageForVision().
 *
 * Principle behind these helpers: 資料準確性 > token 省用. We feed the AI the
 * FULL attachment/image, but for the body we deliberately feed only THIS email
 * (dropping the quoted reply history Outlook embeds) — more chars there would be
 * old-thread noise, not signal.
 */

/**
 * HTML email body → readable plain text, PRESERVING line breaks so the quoted-
 * reply boundaries survive for extractCurrentMessage(). (The old one-liner
 * `.replace(/\s+/g,' ')` flattened everything into a single line, which destroyed
 * those boundaries and made current-vs-history impossible to tell apart.)
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Markers Outlook / Gmail / zh-TW clients put between the current message and the
// quoted reply/forward history. First match (earliest position) wins.
const REPLY_BOUNDARIES: RegExp[] = [
  /-{3,}\s*(original message|原始郵件|原始信件|forwarded message|轉寄的郵件|轉寄郵件)\s*-{3,}/i,
  /_{10,}/,                                                   // Outlook horizontal rule before history
  /\bon\b.{4,80}?\bwrote:/i,                                  // "On <date> X wrote:"
  /在[\s\S]{2,80}?(寫道|撰寫)\s*[:：]/,                        // "在 <date> X 寫道："
  /(^|\n)\s*(from|寄件者|發件人)\s*[:：][^\n]{1,120}\n\s*(sent|寄件日期|發送時間|日期|to|收件者)\s*[:：]/i,
];

/**
 * Return only the CURRENT message, dropping the quoted reply/forward history that
 * Outlook embeds inline in a reply's body. Feeding just this email (not the whole
 * flattened thread) keeps the AI accurate AND saves tokens — the compromise the
 * user chose over "look at the entire thread".
 *
 * Guard against forwards: if the text ABOVE the first boundary is trivially short
 * (a bare "FYI / 請參考下面" intro), the real content is BELOW the boundary — so we
 * keep the whole body rather than throwing the content away.
 */
export function extractCurrentMessage(
  text: string,
  minHeadChars = 80,
): { current: string; trimmedHistory: boolean } {
  let idx = -1;
  for (const p of REPLY_BOUNDARIES) {
    const m = text.match(p);
    if (m && m.index !== undefined && (idx === -1 || m.index < idx)) idx = m.index;
  }
  if (idx <= 0) return { current: text, trimmedHistory: false };
  const head = text.slice(0, idx).trim();
  if (head.length < minHeadChars) return { current: text, trimmedHistory: false };
  return { current: head, trimmedHistory: true };
}

export interface DownscaledImage {
  base64: string;
  mediaType: string;
}

const VISION_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const VISION_MAX_BYTES = 5 * 1024 * 1024; // Claude vision hard limit: 5MB per image
const VISION_LONG_EDGE = 1568;            // ~optimal long edge for Claude vision

/**
 * Prepare an image buffer for Claude vision: small supported images pass through
 * untouched; large or unsupported ones (>5MB, bmp/tiff, etc.) are downscaled/
 * converted to a JPEG within the 5MB limit so they are STILL analysed rather than
 * skipped ("請它看就真的看"). Returns null only if it truly can't be made to fit.
 * sharp is imported lazily to keep this module cheap to load.
 */
export async function downscaleImageForVision(
  buf: Buffer,
  mime: string,
): Promise<DownscaledImage | null> {
  const m = (mime || '').toLowerCase();
  if (buf.length <= VISION_MAX_BYTES && VISION_MIMES.has(m)) {
    return { base64: buf.toString('base64'), mediaType: m };
  }
  try {
    const sharp = (await import('sharp')).default;
    const shrink = (edge: number, quality: number) =>
      sharp(buf, { failOn: 'none' })
        .rotate()
        .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality })
        .toBuffer();
    let out = await shrink(VISION_LONG_EDGE, 80);
    if (out.length > VISION_MAX_BYTES) out = await shrink(1024, 60);
    if (out.length > VISION_MAX_BYTES) return null;
    return { base64: out.toString('base64'), mediaType: 'image/jpeg' };
  } catch {
    return null;
  }
}
