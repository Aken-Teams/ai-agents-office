/**
 * The icons an agent or team may carry.
 *
 * Material Symbols renders an unknown ligature as PLAIN TEXT, at whatever size
 * the icon was meant to be — so one bad name does not degrade to a blank box, it
 * splashes the raw string across the card. That is exactly what happened when the
 * team designer returned its own role names ("reviewer", "data-analyst") in the
 * icon field: the AI was asked for "a Material Symbols name" and answered with
 * something plausible-looking that does not exist in the font.
 *
 * A model cannot be trusted to know which of the thousands of icon names are
 * real, so it does not get to choose freely: it picks from this list, and
 * anything else is replaced. The list is the union of what the app already uses
 * (the assistant icon picker + every team template) plus a few obvious roles, so
 * nothing that used to render stops rendering.
 *
 * The client keeps its own copy for display-time defence — legacy rows written
 * before this existed still hold bad names. Keep the two in step.
 */
export const AGENT_ICONS: string[] = [
  // assistant icon picker
  'smart_toy', 'psychology', 'description', 'slideshow', 'table_chart',
  'analytics', 'code', 'science', 'school', 'translate',
  'brush', 'auto_fix_high', 'support_agent', 'travel_explore', 'calculate',
  // team templates
  'account_balance', 'account_tree', 'badge', 'balance', 'business_center',
  'campaign', 'celebration', 'checklist', 'co_present', 'compare',
  'compare_arrows', 'design_services', 'diversity_3', 'draw', 'edit_note',
  'engineering', 'event', 'fact_check', 'functions', 'gavel', 'grading',
  'groups', 'hub', 'insights', 'lightbulb', 'menu_book', 'monitoring',
  'payments', 'person_search', 'public', 'query_stats', 'quiz',
  'record_voice_over', 'route', 'shield', 'spellcheck', 'trending_up',
  'verified_user', 'warning', 'widgets',
  // common analytical roles the designer reaches for
  'search', 'rate_review', 'summarize', 'target', 'timeline', 'flag',
  'health_and_safety', 'pets', 'restaurant', 'fitness_center', 'savings',
  'handshake', 'inventory_2', 'factory', 'science_off', 'biotech',
];

const ICON_SET = new Set(AGENT_ICONS);

/** A safe icon name: the given one if we know it renders, else `fallback`. */
export function safeAgentIcon(name: unknown, fallback = 'smart_toy'): string {
  const n = typeof name === 'string' ? name.trim().toLowerCase() : '';
  return ICON_SET.has(n) ? n : fallback;
}
