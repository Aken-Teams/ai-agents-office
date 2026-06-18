/**
 * Google Gemini client — two capabilities for the infographic feature:
 *
 *  1. generateInfographicHtml() — Gemini text model authors a complete,
 *     data-accurate HTML/CSS infographic (text & numbers are exact). Rendered
 *     in-app as a `visual` iframe block.
 *  2. generateImage() — Gemini image model (Nano Banana) produces a raster PNG
 *     for illustrations / cover art, which can be downloaded or embedded into
 *     generated documents (PPT/PDF/Word).
 *
 * Plain REST via fetch (no SDK), mirroring the DeepSeek integration. Cost is
 * reported back to the caller so it can be tracked under provider 'gemini'
 * separately from Claude usage.
 */

import { config } from '../config.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// Defaults — overridable via env so we can bump models without code changes.
const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash';
// gemini-3-pro-image renders CJK text accurately (2.5-flash-image garbles
// Chinese). Override via GEMINI_IMAGE_MODEL for a cheaper/faster model.
const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-3-pro-image';

// Gemini 2.5 Flash pricing (USD per 1M tokens). Used only for our own cost
// reporting; kept here so it's one obvious place to update.
const TEXT_IN_RATE = 0.30;
const TEXT_OUT_RATE = 2.50;
// Image generation is billed per image, not per text token. Flat raw cost per
// generated image (before our display markup); override via env when the model
// or Google's pricing changes. Default ≈ gemini-3-pro-image list price.
const IMAGE_COST_USD = parseFloat(process.env.GEMINI_IMAGE_COST_USD || '0.134');

export interface GeminiUsage { inputTokens: number; outputTokens: number; model: string; costUsd: number }

export interface InfographicResult { html: string; usage: GeminiUsage }
export interface ImageResult { base64: string; mimeType: string; usage: GeminiUsage }

export function isGeminiEnabled(): boolean {
  return !!config.geminiApiKey;
}

interface GeminiPart { text?: string; inlineData?: { mimeType: string; data: string } }
interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { message?: string };
  promptFeedback?: { blockReason?: string };
}

async function callGemini(model: string, body: unknown, timeoutMs = 60_000): Promise<GeminiResponse> {
  if (!config.geminiApiKey) throw new Error('GEMINI_API_KEY 未設定');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}/${model}:generateContent?key=${config.geminiApiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = (await res.json()) as GeminiResponse;
    if (!res.ok) {
      const msg = json?.error?.message || res.statusText;
      // Image generation requires a paid (billing-enabled) Gemini key — the free
      // tier returns 429 with a 0 limit. Give an actionable message.
      if (res.status === 429 && /free_tier|quota|limit: 0/i.test(msg)) {
        throw new Error('Gemini 圖片生成需要「已啟用付費」的 API 金鑰（免費方案不支援圖片生成）。請到 Google AI Studio / Google Cloud 開啟該專案的帳單後再試。');
      }
      throw new Error(`Gemini API ${res.status}: ${msg}`);
    }
    if (json.promptFeedback?.blockReason) throw new Error(`Gemini 拒絕生成（${json.promptFeedback.blockReason}）`);
    return json;
  } finally {
    clearTimeout(timer);
  }
}

function usageOf(model: string, json: GeminiResponse): GeminiUsage {
  const inputTokens = json.usageMetadata?.promptTokenCount ?? 0;
  const outputTokens = json.usageMetadata?.candidatesTokenCount ?? 0;
  const costUsd = (inputTokens / 1_000_000) * TEXT_IN_RATE + (outputTokens / 1_000_000) * TEXT_OUT_RATE;
  return { inputTokens, outputTokens, model, costUsd };
}

/** Strip ```html / ``` fences a model may wrap the document in. */
function unfence(text: string): string {
  return text.replace(/^\s*```(?:html)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
}

const INFOGRAPHIC_SYSTEM = `你是一位資深的資訊圖表（infographic）設計師兼前端工程師。請依使用者的主題與資料，產出「一個完整、可獨立開啟的 HTML 文件」當作資訊圖表。

嚴格要求：
- 只輸出 HTML（從 <!DOCTYPE html> 到 </html>），不要任何說明文字、不要 markdown 圍欄。
- 所有樣式用 inline <style>，不可引用外部 CSS/JS/圖片網址（離線可開）。可用純 CSS 畫圖（長條、圓餅、流程、數字卡、時間軸等）。
- **資料忠實**：只能使用使用者提供的數字與文字，一字不改、不可捏造或補充任何沒給的數據或名稱；缺的就不要硬放。
- 版面：固定寬度約 1080px、自上而下單欄、適合截圖；明確標題、分區、重點數字放大、配色協調專業。
- 繁體中文內容；字型用系統字（font-family: -apple-system, "Noto Sans TC", sans-serif）。`;

/**
 * Generate a complete, data-accurate HTML infographic. The numbers/labels are
 * exact (text model, not diffusion), making this the default for real data.
 */
export async function generateInfographicHtml(opts: { prompt: string; data?: string; style?: string }): Promise<InfographicResult> {
  const dataBlock = opts.data?.trim() ? `\n\n【必須使用的資料（忠實呈現，不可改動）】\n${opts.data.trim()}` : '';
  const styleBlock = opts.style?.trim() ? `\n\n【風格偏好】${opts.style.trim()}` : '';
  const userPrompt = `${opts.prompt.trim()}${dataBlock}${styleBlock}`;

  const json = await callGemini(TEXT_MODEL, {
    systemInstruction: { parts: [{ text: INFOGRAPHIC_SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 8192 },
  });

  const parts = json.candidates?.[0]?.content?.parts || [];
  const html = unfence(parts.map(p => p.text || '').join(''));
  if (!html.toLowerCase().includes('<html')) throw new Error('Gemini 未回傳有效的 HTML 資訊圖表');
  return { html, usage: usageOf(TEXT_MODEL, json) };
}

/**
 * Generate a raster image via the Gemini image model. When `image` is supplied,
 * the model EDITS that image per the prompt (image-to-image) instead of drawing
 * from scratch — used to tweak an existing infographic while keeping its look.
 */
export async function generateImage(opts: { prompt: string; image?: { base64: string; mimeType: string } }): Promise<ImageResult> {
  const reqParts: GeminiPart[] = [];
  if (opts.image) reqParts.push({ inlineData: { mimeType: opts.image.mimeType, data: opts.image.base64 } });
  reqParts.push({ text: opts.prompt.trim() });
  const json = await callGemini(IMAGE_MODEL, {
    contents: [{ role: 'user', parts: reqParts }],
    generationConfig: { responseModalities: ['IMAGE'] },
  }, 90_000);

  const parts = json.candidates?.[0]?.content?.parts || [];
  const img = parts.find(p => p.inlineData?.data);
  if (!img?.inlineData) throw new Error('Gemini 未回傳圖片資料');
  // Image is billed per image — use the flat image price, not text-token rates.
  const usage = usageOf(IMAGE_MODEL, json);
  usage.costUsd = IMAGE_COST_USD;
  return {
    base64: img.inlineData.data,
    mimeType: img.inlineData.mimeType || 'image/png',
    usage,
  };
}
