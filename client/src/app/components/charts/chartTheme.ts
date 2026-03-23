// Read theme colors from CSS custom properties at render time

const PALETTE_VARS = [
  '--primary',
  '--tertiary',
  '--success',
  '--warning',
  '--error',
  '--secondary',
];

const FALLBACK_COLORS = ['#006970', '#6750a4', '#0d9668', '#b77400', '#ba1a1a', '#3e495d', '#00898f', '#845ec2'];

export function getChartColors(): string[] {
  if (typeof window === 'undefined') return FALLBACK_COLORS;
  const style = getComputedStyle(document.documentElement);
  const colors = PALETTE_VARS.map(v => style.getPropertyValue(v).trim()).filter(Boolean);
  return colors.length >= 4 ? colors : FALLBACK_COLORS;
}

export function getThemeVars() {
  if (typeof window === 'undefined') {
    return { text: '#44474d', subtext: '#747680', grid: '#c4c7d0', bg: '#f8fafb' };
  }
  const style = getComputedStyle(document.documentElement);
  const get = (v: string, fallback: string) => style.getPropertyValue(v).trim() || fallback;
  return {
    text: get('--md-heading', '#1a1c2e'),
    subtext: get('--md-text', '#44474d'),
    grid: get('--md-table-border', '#c4c7d0'),
    bg: get('--md-pre-bg', '#f3f5f8'),
  };
}
