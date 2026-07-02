/**
 * Shared billing markup for displayed token counts and dollar costs.
 *
 * Raw Claude Sonnet pricing is $3/M input, $15/M output. The app shows marked-up
 * figures. This is the CURRENT (ongoing) rate: ×2 for the external `pro-out`
 * deployment, and ×5 for pro-panjit (強茂) — which dropped from ×10 to ×5 starting
 * 2026-07. Historical months bill at their own rate — use markupForMonth() for any
 * per-month / invoice / per-record cost so June-2026 and earlier stay ×10.
 */

export const PRICING_MARKUP =
  (process.env.NEXT_PUBLIC_DEPLOY_MODE || 'pro-panjit') === 'pro-out' ? 2 : 5;

const IN_RATE = 3;   // USD per 1M input tokens (raw)
const OUT_RATE = 15; // USD per 1M output tokens (raw)

/**
 * Billing markup for a specific month ('YYYY-MM'). Mirrors the server's
 * pricingMarkupForMonth: pro-out is always ×2; pro-panjit was ×10 through 2026-06
 * and ×5 from 2026-07 onward.
 */
export function markupForMonth(month: string): number {
  if ((process.env.NEXT_PUBLIC_DEPLOY_MODE || 'pro-panjit') === 'pro-out') return 2;
  return month && month < '2026-07' ? 10 : 5;
}

/** Display/billing cost in USD for a token usage, with the current markup applied. */
export function calcCostUsd(inputTokens: number, outputTokens: number): number {
  return ((inputTokens / 1_000_000) * IN_RATE + (outputTokens / 1_000_000) * OUT_RATE) * PRICING_MARKUP;
}

/** Cost in USD billed at a specific month's historical rate ('YYYY-MM'). */
export function calcCostUsdForMonth(inputTokens: number, outputTokens: number, month: string): number {
  return ((inputTokens / 1_000_000) * IN_RATE + (outputTokens / 1_000_000) * OUT_RATE) * markupForMonth(month);
}

/** Displayed token count (raw × current markup), matching the billing markup. */
export function displayTokens(n: number): number {
  return n * PRICING_MARKUP;
}
