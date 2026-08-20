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
export async function generateNarration(blocks: DocumentBlock[], docType: string): Promise<string[] | null> {
  if (!auxLlmAvailable()) return null;
  if (!blocks.length) return null;

  const docLabel = DOC_TYPE_LABEL[docType] || '文件';
  const pages = blocks.map((b, i) => `第${i + 1}頁：${blockToText(b) || '（無文字內容）'}`).join('\n');
  const prompt = `你是專業的簡報主播，要把一份${docLabel}做成語音導覽。以下是每一頁的內容，請為「每一頁」產生一段自然、口語、適合朗讀的繁體中文旁白：
- 每頁 1～3 句，像主播在介紹這一頁的重點，流暢、不生硬。
- 不要念出條列符號（•、-）、也不要說「標題」「副標題」「第N頁」等結構字眼，直接講內容。
- 數字、公司名、重點照著內容講，**不要新增內容裡沒有的資訊**。
- 只輸出一個 JSON 字串陣列，長度必須等於頁數、順序對應每一頁，不要任何說明或 markdown。

每頁內容：
${pages}`;

  try {
    const aux = await auxChat(prompt, { temperature: 0.4, maxTokens: 2400, timeoutMs: 45_000, feature: 'doc-narration' });
    if (!aux) return null;
    const arr = parseJsonLoose<string[]>(aux.text);
    if (!Array.isArray(arr)) return null;
    // Always return exactly one line per block: fall back to raw text if the
    // model returned fewer items than pages.
    return blocks.map((b, i) => {
      const line = String(arr[i] ?? '').trim();
      return line || blockToText(b).slice(0, 120) || `第 ${i + 1} 頁`;
    });
  } catch (e) {
    console.error('[docNarration] failed:', e);
    return null;
  }
}
