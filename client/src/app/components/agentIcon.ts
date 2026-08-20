/**
 * Display-time defence for agent / team icons.
 *
 * Material Symbols renders an UNKNOWN ligature as plain text at the icon's font
 * size, so a bad name does not show a blank box — it splashes the raw string
 * across the card ("REVIEWER", "DATA-ANALYST"). Teams designed by the AI before
 * the icon list was enforced still carry names like that in the database, and no
 * amount of fixing the writer repairs rows already written.
 *
 * So every icon that came from data (not a literal in our JSX) goes through
 * here. Anything we do not recognise becomes the caller's fallback.
 *
 * Keep in step with server/src/data/agentIcons.ts, which is what the team
 * designer is now restricted to.
 */
const AGENT_ICONS = new Set([
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
  // used by our own JSX around agent/team cards
  'person', 'chat', 'bolt',
]);

/** The icon name if it will actually render, otherwise `fallback`. */
export function agentIcon(name: string | null | undefined, fallback = 'smart_toy'): string {
  const n = (name || '').trim().toLowerCase();
  return AGENT_ICONS.has(n) ? n : fallback;
}
