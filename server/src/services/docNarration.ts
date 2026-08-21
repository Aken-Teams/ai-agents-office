/**
 * Document narration (pro-out only) — turn a document's per-page block content
 * into natural spoken-broadcast script lines, one per page/section, so the
 * frontend can read them aloud (browser TTS) while following along page-by-page.
 *
 * Uses the aux LLM (on-prem first) in a single call for the whole document. Returns one
 * narration string per block, aligned to block order. Null on failure → caller
 * surfaces a friendly error.
 */
import { config } from '../config.js';
import type { DocumentBlock } from '../types.js';
import { auxChat, auxLlmAvailable, parseJsonLoose } from './auxLlm.js';

/** Pull readable text out of a block's data (titles, bullets, quotes, etc.). */
function blockToText(block: DocumentBlock): string {
  const parts: string[] = [];
  const visit = (v: unknown, depth = 0) => {
    if (depth > 4 || parts.join(' ').length > 600) return;
    if (typeof v === 'string') { const s = v.trim(); if (s) parts.push(s); }
    else if (Array.isArray(v)) v.forEach(x => visit(x, depth + 1));
    else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(x => visit(x, depth + 1));
  };
  visit(block.data);
  return parts.join('｜').slice(0, 600);
}

const DOC_TYPE_LABEL: Record<string, string> = { pptx: '簡報', pdf: 'PDF 文件', docx: 'Word 文件' };

/**
 * Generate one broadcast narration line per block. Returns an array the same
 * length as `blocks`, or null if narration could not be produced.
 */
/**
 * Pages per model call, and how many calls run at once.
 *
 * One call for a whole 40-page deck was the real problem: ~2.4k tokens of output
 * from a single request, which the on-prem model needs about a minute for. It
 * would spend its entire ceiling and fail, THEN the fallback started from zero —
 * a minute and a quarter before the user saw anything, if the frontend had not
 * given up first. Split it and each call is small enough to finish comfortably,
 * several run at once, and one bad batch costs eight lines instead of the whole
 * narration. This mirrors what the email briefing already does with mail.
 */
const PAGES_PER_CALL = 8;
const NARRATION_CONCURRENCY = 3;
/** Per batch, not per document — a small call that cannot finish in this is stuck. */
const BATCH_TIMEOUT_MS = 60_000;

/** Narrate one slice of the document. Returns null if this batch failed. */
async function narrateBatch(
  batch: DocumentBlock[], firstPage: number, totalPages: number, docLabel: string, userId?: string,
): Promise<string[] | null> {
  const pages = batch.map((b, i) => `第${firstPage + i}頁：${blockToText(b) || '（無文字內容）'}`).join('\n');
  const prompt = `你是專業的簡報主播，要把一份${docLabel}做成語音導覽。這份文件共 ${totalPages} 頁，以下是其中第 ${firstPage} 到 ${firstPage + batch.length - 1} 頁，請為「每一頁」產生一段自然、口語、適合朗讀的繁體中文旁白：
- 每頁 1～3 句，像主播在介紹這一頁的重點，流暢、不生硬。
- 不要念出條列符號（•、-）、也不要說「標題」「副標題」「第N頁」等結構字眼，直接講內容。
- 數字、公司名、重點照著內容講，**不要新增內容裡沒有的資訊**。
- 只輸出一個 JSON 字串陣列，長度必須剛好是 ${batch.length}、順序對應上面的頁次，不要任何說明或 markdown。

每頁內容：
${pages}`;

  const aux = await auxChat(prompt, {
    temperature: 0.4,
    // ~3 sentences x 8 pages, plus room for the JSON scaffolding.
    maxTokens: 1200,
    timeoutMs: BATCH_TIMEOUT_MS,
    feature: 'doc-narration',
    ...(userId ? { billTo: { userId } } : {}),
  });
  if (!aux) return null;
  const arr = parseJsonLoose<string[]>(aux.text);
  return Array.isArray(arr) ? arr.map(s => String(s ?? '').trim()) : null;
}

/**
 * Generate one broadcast narration line per block. Returns an array the same
 * length as `blocks`, or null if narration could not be produced at all.
 *
 * A batch that fails does NOT sink the whole narration — those pages fall back
 * to their own text, which is still readable aloud. Losing the audio tour of the
 * entire document because page 30 misbehaved would be a poor trade.
 */
export async function generateNarration(blocks: DocumentBlock[], docType: string, userId?: string): Promise<string[] | null> {
  if (!auxLlmAvailable()) return null;
  if (!blocks.length) return null;

  const docLabel = DOC_TYPE_LABEL[docType] || '文件';
  const batches: { start: number; blocks: DocumentBlock[] }[] = [];
  for (let i = 0; i < blocks.length; i += PAGES_PER_CALL) {
    batches.push({ start: i, blocks: blocks.slice(i, i + PAGES_PER_CALL) });
  }

  const results: (string[] | null)[] = new Array(batches.length).fill(null);
  let next = 0;
  async function worker() {
    for (let my = next++; my < batches.length; my = next++) {
      const b = batches[my];
      try {
        results[my] = await narrateBatch(b.blocks, b.start + 1, blocks.length, docLabel, userId);
      } catch (e) {
        console.error(`[docNarration] batch ${my + 1}/${batches.length} failed:`, e);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(NARRATION_CONCURRENCY, batches.length) }, worker));

  const ok = results.filter(Boolean).length;
  if (!ok) return null;                       // nothing worked — let the caller report failure
  if (ok < batches.length) {
    console.warn(`[docNarration] ${batches.length - ok}/${batches.length} batches failed — those pages fall back to their own text`);
  }

  return blocks.map((b, i) => {
    const line = results[Math.floor(i / PAGES_PER_CALL)]?.[i % PAGES_PER_CALL] || '';
    return line || blockToText(b).slice(0, 120) || `第 ${i + 1} 頁`;
  });
}
