/**
 * Shared billing markup for displayed token counts and dollar costs.
 *
 * Raw Claude Sonnet pricing is $3/M input, $15/M output. The app shows marked-up
 * figures: ×10 for internal/default deployments, ×2 for the external `pro-out`
 * deployment. Keep all cost/token display math routed through here so the markup
 * stays consistent and is changed in one place.
 */

export const PRICING_MARKUP =
  (process.env.NEXT_PUBLIC_DEPLOY_MODE || 'pro-panjit') === 'pro-out' ? 2 : 10;

const IN_RATE = 3;   // USD per 1M input tokens (raw)
const OUT_RATE = 15; // USD per 1M output tokens (raw)

/** Display/billing cost in USD for a token usage, with markup applied. */
export function calcCostUsd(inputTokens: number, outputTokens: number): number {
  return ((inputTokens / 1_000_000) * IN_RATE + (outputTokens / 1_000_000) * OUT_RATE) * PRICING_MARKUP;
}

/** Displayed token count (raw × markup), matching the billing markup. */
export function displayTokens(n: number): number {
  return n * PRICING_MARKUP;
}
