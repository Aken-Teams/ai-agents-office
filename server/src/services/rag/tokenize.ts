/**
 * Lightweight CJK-aware tokenizer for BM25 keyword search.
 *
 * Strategy:
 *   1. Use `Intl.Segmenter('zh', { granularity: 'word' })` if available
 *      (Node 22+; ICU full-data builds). It produces word-level segments
 *      that handle CJK boundaries well without a 100MB dictionary.
 *   2. Fallback: char-bigram for CJK + whitespace split for ASCII. This
 *      always works on any V8/Node and is good enough for proper-noun /
 *      model-number style queries which is the LEANN port's pain point.
 *
 * Both strategies emit lowercase tokens, drop punctuation, and discard
 * single ASCII characters (which would otherwise blow up IDF on every doc).
 *
 * The tokenizer is pure — no LRU here, since callers cache token arrays
 * alongside their HNSW handles.
 */

let segmenter: Intl.Segmenter | null = null;
let segmenterTried = false;

function trySegmenter(): Intl.Segmenter | null {
  if (segmenterTried) return segmenter;
  segmenterTried = true;
  try {
    // `Intl.Segmenter` is in ES2022; runtime may still lack it.
    if (typeof (Intl as unknown as { Segmenter?: unknown }).Segmenter === 'function') {
      segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
    }
  } catch {
    segmenter = null;
  }
  return segmenter;
}

const PUNCT = /[\s\p{P}\p{S}]+/u;
const CJK = /[㐀-鿿豈-﫿぀-ヿ]/;

function isMeaningful(token: string): boolean {
  if (!token) return false;
  if (PUNCT.test(token) && token.length === 1) return false;
  // Drop single ASCII chars; keep CJK singletons (they often carry meaning).
  if (token.length === 1 && !CJK.test(token)) return false;
  return true;
}

/**
 * Char-bigram tokenizer fallback. For CJK runs we emit overlapping
 * 2-character grams (so `差勤政策` → `差勤`, `勤政`, `政策`), which gives
 * BM25 decent term coverage without a dictionary. ASCII words are split on
 * whitespace and lower-cased. Numbers and Latin tokens pass through whole.
 */
function bigramFallback(text: string): string[] {
  const out: string[] = [];
  // Replace punctuation/whitespace with a single space, then walk runs.
  const cleaned = text.replace(/[\s\p{P}\p{S}]+/gu, ' ');
  let i = 0;
  while (i < cleaned.length) {
    const ch = cleaned[i];
    if (ch === ' ') { i++; continue; }
    if (CJK.test(ch)) {
      // Walk the CJK run.
      let j = i;
      while (j < cleaned.length && CJK.test(cleaned[j])) j++;
      const run = cleaned.slice(i, j);
      // Single char run → emit as-is. Otherwise overlapping bigrams.
      if (run.length === 1) {
        out.push(run);
      } else {
        for (let p = 0; p < run.length - 1; p++) out.push(run.slice(p, p + 2));
      }
      i = j;
    } else {
      // ASCII / digits / latin — split on next space.
      let j = i;
      while (j < cleaned.length && cleaned[j] !== ' ' && !CJK.test(cleaned[j])) j++;
      const token = cleaned.slice(i, j).toLowerCase();
      if (isMeaningful(token)) out.push(token);
      i = j;
    }
  }
  return out;
}

/**
 * Public tokenize entry. Uses Intl.Segmenter when available; falls back to
 * char-bigram + ASCII split. Always returns lowercased meaningful tokens.
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const seg = trySegmenter();
  if (seg) {
    const out: string[] = [];
    for (const item of seg.segment(text)) {
      const token = item.segment.toLowerCase().trim();
      if (isMeaningful(token)) out.push(token);
    }
    if (out.length > 0) return out;
    // Some ICU builds segment everything as one chunk for short zh strings.
    // Fall through to bigram.
  }
  return bigramFallback(text);
}
