/**
 * Shared billing markup for displayed dollar costs.
 *
 * Raw Claude Sonnet pricing is $3/M input, $15/M output. The app shows marked-up
 * cost. This is the CURRENT (ongoing) rate: ×2 for the external `pro-out`
 * deployment, and ×5 for pro-panjit (強茂) — which dropped from ×10 to ×5 at a
 * precise instant. Historical records bill at the rate in effect then — use
 * markupForDate() for any per-record cost so pre-switch usage stays ×10.
 */

export const PRICING_MARKUP =
  (process.env.NEXT_PUBLIC_DEPLOY_MODE || 'pro-panjit') === 'pro-out' ? 2 : 5;

const IN_RATE = 3;   // USD per 1M input tokens (raw)
const OUT_RATE = 15; // USD per 1M output tokens (raw)

// 強茂 three-tier billing (Taipei time), mirrors the server's PRICING_* constants:
//   before 2026-07-01 00:00 → ×10 ; 2026-07-01..2026-07-03 16:00 → ×0 (free) ; after → ×5.
const PRICING_FREE_START_MS = Date.parse('2026-07-01T00:00:00+08:00');
const PRICING_X5_START_MS   = Date.parse('2026-07-03T16:00:00+08:00');

/**
 * Billing markup for a record's timestamp. pro-out is always ×2; pro-panjit is
 * ×10 before July, ×0 (free) for 7/1–7/3 16:00, and ×5 after.
 */
export function markupForDate(ts: string | number | Date): number {
  if ((process.env.NEXT_PUBLIC_DEPLOY_MODE || 'pro-panjit') === 'pro-out') return 2;
  const ms = ts instanceof Date ? ts.getTime() : (typeof ts === 'number' ? ts : Date.parse(ts));
  if (ms < PRICING_FREE_START_MS) return 10;
  if (ms < PRICING_X5_START_MS) return 0;
  return 5;
}

/** Display/billing cost in USD for a token usage, with the current markup applied. */
export function calcCostUsd(inputTokens: number, outputTokens: number): number {
  return ((inputTokens / 1_000_000) * IN_RATE + (outputTokens / 1_000_000) * OUT_RATE) * PRICING_MARKUP;
}

/** Cost in USD for a token usage billed at the rate in effect at `ts`. */
export function calcCostUsdForDate(inputTokens: number, outputTokens: number, ts: string | number | Date): number {
  return ((inputTokens / 1_000_000) * IN_RATE + (outputTokens / 1_000_000) * OUT_RATE) * markupForDate(ts);
}
