#!/usr/bin/env node
/**
 * Scroll-Snap Web Presentation Generator v3
 * Usage: node --import tsx generate-slides.ts <input.json> <output.html>
 *
 * 8 styles: minimal | dark | gradient | neon | corporate | creative | elegant | tech
 * 21 slide types: title | section | content | two-column | code | image |
 *                 hero | stats | icon-grid | timeline | quote | chart | image-text |
 *                 profile | process | gallery | team | table | dashboard | diagram | mindmap
 *
 * Charts: Apache ECharts (bar, line, pie, donut, radar, funnel, gauge, treemap, waterfall, scatter)
 * Diagrams: Mermaid.js (flowchart, gantt, sequence, ER, state)
 * Mindmaps: Markmap (markdown → interactive mindmap)
 *
 * Architecture: CSS scroll-snap sections (each section = one page, min-height: 100vh).
 * No external presentation framework — pure HTML + CSS + minimal JS.
 * Generates a self-contained HTML with Google Fonts, Material Symbols from CDN.
 */

import fs from 'fs';

// ── Style Presets ──────────────────────────────────────────────

interface StylePreset {
  bg: string;
  titleColor: string;
  subtitleColor: string;
  headingColor: string;
  bodyColor: string;
  accentColor: string;
  accentColor2: string;
  codeBg: string;
  codeColor: string;
  fontFamily: string;
  headingFontFamily: string;
  transition: string;
  googleFontsUrl: string;
  cardBg: string;
  cardBorder: string;
  decorations: boolean;
  decorationColors: string[];
  isDark: boolean;
  chartColors: string[];
  iconColor: string;
  timelineColor: string;
  statsCardBg: string;
  quoteMarkColor: string;
  sectionBgColors: string[];
  extra?: string;
}

const STYLES: Record<string, StylePreset> = {
  'minimal': {
    bg: '#ffffff',
    titleColor: '#2d2d2d',
    subtitleColor: '#888888',
    headingColor: '#333333',
    bodyColor: '#555555',
    accentColor: '#667eea',
    accentColor2: '#764ba2',
    codeBg: '#f5f5f5',
    codeColor: '#333333',
    fontFamily: '"Inter", "Segoe UI", "Helvetica Neue", sans-serif',
    headingFontFamily: '"Inter", "Segoe UI", "Helvetica Neue", sans-serif',
    transition: 'slide',
    googleFontsUrl: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap',
    cardBg: '#f8f9fa',
    cardBorder: '#e9ecef',
    decorations: false,
    decorationColors: [],
    isDark: false,
    chartColors: ['#667eea', '#764ba2', '#f093fb', '#4facfe', '#43e97b'],
    iconColor: '#667eea',
    timelineColor: '#667eea',
    statsCardBg: '#f8f9fa',
    quoteMarkColor: 'rgba(102,126,234,0.15)',
    sectionBgColors: ['#f0f0f5', '#e8f4f8', '#f5f0eb', '#eef5e8', '#f3e8f5', '#fdf6e3'],
  },
  'dark': {
    bg: '#1a1a2e',
    titleColor: '#00f0ff',
    subtitleColor: '#8888aa',
    headingColor: '#e0e0ff',
    bodyColor: '#aaaacc',
    accentColor: '#00f0ff',
    accentColor2: '#ff6b9d',
    codeBg: '#0f0f23',
    codeColor: '#00f0ff',
    fontFamily: '"Space Grotesk", "Segoe UI", sans-serif',
    headingFontFamily: '"Space Grotesk", "Segoe UI", sans-serif',
    transition: 'convex',
    googleFontsUrl: 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700&family=JetBrains+Mono:wght@400;700&display=swap',
    cardBg: 'rgba(255,255,255,0.05)',
    cardBorder: 'rgba(255,255,255,0.1)',
    decorations: true,
    decorationColors: ['#00f0ff', '#1a1a4e'],
    isDark: true,
    chartColors: ['#00f0ff', '#ff6b9d', '#50fa7b', '#f1fa8c', '#bd93f9'],
    iconColor: '#00f0ff',
    timelineColor: '#00f0ff',
    statsCardBg: 'rgba(0,240,255,0.06)',
    quoteMarkColor: 'rgba(0,240,255,0.15)',
    sectionBgColors: ['#16162a', '#1a1a32', '#14142e', '#1c1c36', '#181830', '#1a1a2e'],
  },
  'gradient': {
    bg: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    titleColor: '#ffffff',
    subtitleColor: 'rgba(255,255,255,0.7)',
    headingColor: '#ffffff',
    bodyColor: 'rgba(255,255,255,0.9)',
    accentColor: '#ffd700',
    accentColor2: '#ff6b6b',
    codeBg: 'rgba(0,0,0,0.3)',
    codeColor: '#ffd700',
    fontFamily: '"Poppins", "Segoe UI", sans-serif',
    headingFontFamily: '"Poppins", "Segoe UI", sans-serif',
    transition: 'fade',
    googleFontsUrl: 'https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap',
    cardBg: 'rgba(255,255,255,0.12)',
    cardBorder: 'rgba(255,255,255,0.25)',
    decorations: true,
    decorationColors: ['rgba(255,255,255,0.15)', 'rgba(255,215,0,0.1)'],
    isDark: true,
    chartColors: ['#ffd700', '#ffffff', '#ff6b6b', '#a0d0ff', '#50fa7b'],
    iconColor: '#ffd700',
    timelineColor: 'rgba(255,255,255,0.4)',
    statsCardBg: 'rgba(255,255,255,0.12)',
    quoteMarkColor: 'rgba(255,215,0,0.25)',
    sectionBgColors: ['#2a1b5e', '#1e3a6e', '#2d1a4e', '#1a2d5e', '#331e5e', '#1e2a4e'],
  },
  'neon': {
    bg: '#000000',
    titleColor: '#ff00ff',
    subtitleColor: '#00ffcc',
    headingColor: '#00ffcc',
    bodyColor: '#cccccc',
    accentColor: '#ff00ff',
    accentColor2: '#00ffcc',
    codeBg: '#111111',
    codeColor: '#00ff88',
    fontFamily: '"Fira Code", "Consolas", monospace',
    headingFontFamily: '"Orbitron", "Consolas", monospace',
    transition: 'zoom',
    googleFontsUrl: 'https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700&family=Fira+Code:wght@400;700&display=swap',
    cardBg: 'rgba(255,255,255,0.03)',
    cardBorder: 'rgba(255,0,255,0.2)',
    decorations: true,
    decorationColors: ['#ff00ff', '#00ffcc'],
    isDark: true,
    chartColors: ['#ff00ff', '#00ffcc', '#ff6600', '#00ff88', '#ffff00'],
    iconColor: '#00ffcc',
    timelineColor: '#ff00ff',
    statsCardBg: 'rgba(255,0,255,0.06)',
    quoteMarkColor: 'rgba(255,0,255,0.2)',
    extra: `
      .reveal h1, .reveal h2 { text-shadow: 0 0 20px currentColor, 0 0 40px currentColor; }
      .reveal .accent-line { box-shadow: 0 0 10px currentColor, 0 0 20px currentColor; }
      .glass-card { box-shadow: 0 0 20px rgba(255,0,255,0.1), inset 0 0 20px rgba(0,255,204,0.03); }
    `,
    sectionBgColors: ['#0a0a14', '#0d0a18', '#0a0d14', '#100a1a', '#0a0a10', '#0d0d18'],
  },
  'corporate': {
    bg: '#ffffff',
    titleColor: '#1B365D',
    subtitleColor: '#718096',
    headingColor: '#2D3748',
    bodyColor: '#4A5568',
    accentColor: '#2B6CB0',
    accentColor2: '#38B2AC',
    codeBg: '#EDF2F7',
    codeColor: '#2B6CB0',
    fontFamily: '"Inter", "Roboto", "Segoe UI", sans-serif',
    headingFontFamily: '"Inter", "Roboto", "Segoe UI", sans-serif',
    transition: 'slide',
    googleFontsUrl: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Roboto:wght@400;500&display=swap',
    cardBg: '#F7FAFC',
    cardBorder: '#E2E8F0',
    decorations: false,
    decorationColors: [],
    isDark: false,
    chartColors: ['#2B6CB0', '#38B2AC', '#ED8936', '#9F7AEA', '#48BB78'],
    iconColor: '#2B6CB0',
    timelineColor: '#2B6CB0',
    statsCardBg: '#EBF8FF',
    quoteMarkColor: 'rgba(43,108,176,0.1)',
    sectionBgColors: ['#f5f7fa', '#eef3f9', '#f7f5f0', '#f0f7f5', '#f5f0f7', '#faf7f0'],
  },
  'creative': {
    bg: '#FFFBF5',
    titleColor: '#2D3748',
    subtitleColor: '#718096',
    headingColor: '#2D3748',
    bodyColor: '#4A5568',
    accentColor: '#FF6B6B',
    accentColor2: '#4ECDC4',
    codeBg: '#FFF5F5',
    codeColor: '#E53E3E',
    fontFamily: '"Poppins", "Segoe UI", sans-serif',
    headingFontFamily: '"Poppins", "Segoe UI", sans-serif',
    transition: 'slide',
    googleFontsUrl: 'https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap',
    cardBg: '#ffffff',
    cardBorder: '#FED7D7',
    decorations: true,
    decorationColors: ['#FFE66D', '#FF6B6B', '#4ECDC4'],
    isDark: false,
    chartColors: ['#FF6B6B', '#4ECDC4', '#FFE66D', '#845EC2', '#FF9671'],
    iconColor: '#FF6B6B',
    timelineColor: '#4ECDC4',
    statsCardBg: '#FFF5F5',
    quoteMarkColor: 'rgba(255,107,107,0.15)',
    extra: `.glass-card, .stats-card, .icon-card { border-radius: 20px !important; }`,
    sectionBgColors: ['#fef6ee', '#f0ece4', '#fef0f0', '#eef6f0', '#f5f0fe', '#fdf6e3'],
  },
  'elegant': {
    bg: '#FAF8F5',
    titleColor: '#2C2C2C',
    subtitleColor: '#8B8178',
    headingColor: '#3D3D3D',
    bodyColor: '#555555',
    accentColor: '#C9A96E',
    accentColor2: '#8B7355',
    codeBg: '#F5F0EB',
    codeColor: '#8B7355',
    fontFamily: '"Source Serif 4", "Georgia", serif',
    headingFontFamily: '"Playfair Display", "Georgia", serif',
    transition: 'fade',
    googleFontsUrl: 'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&family=Source+Serif+4:wght@400;600&display=swap',
    cardBg: '#ffffff',
    cardBorder: '#E8E0D8',
    decorations: false,
    decorationColors: [],
    isDark: false,
    chartColors: ['#C9A96E', '#8B7355', '#6B8E6B', '#B07C6E', '#7B8DAA'],
    iconColor: '#C9A96E',
    timelineColor: '#C9A96E',
    statsCardBg: '#FBF8F4',
    quoteMarkColor: 'rgba(201,169,110,0.2)',
    extra: `.accent-line { background: linear-gradient(90deg, transparent, var(--accent), transparent) !important; }`,
    sectionBgColors: ['#f8f5f0', '#f0ece6', '#f5f0ea', '#ede8e2', '#f3ede7', '#f7f2ec'],
  },
  'tech': {
    bg: '#0D1117',
    titleColor: '#58A6FF',
    subtitleColor: '#8B949E',
    headingColor: '#C9D1D9',
    bodyColor: '#8B949E',
    accentColor: '#3FB950',
    accentColor2: '#F78166',
    codeBg: '#161B22',
    codeColor: '#79C0FF',
    fontFamily: '"Inter", "Segoe UI", sans-serif',
    headingFontFamily: '"JetBrains Mono", "Consolas", monospace',
    transition: 'fade',
    googleFontsUrl: 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Inter:wght@400;600;700&display=swap',
    cardBg: '#161B22',
    cardBorder: '#30363D',
    decorations: true,
    decorationColors: ['#58A6FF', '#3FB950'],
    isDark: true,
    chartColors: ['#58A6FF', '#3FB950', '#F78166', '#D2A8FF', '#79C0FF'],
    iconColor: '#3FB950',
    timelineColor: '#58A6FF',
    statsCardBg: 'rgba(88,166,255,0.06)',
    quoteMarkColor: 'rgba(88,166,255,0.15)',
    sectionBgColors: ['#1a1e24', '#1e2228', '#16191f', '#1c2026', '#181c22', '#1a1e24'],
  },
};

const DEFAULT_STYLE = STYLES['minimal'];

// ── Types ──────────────────────────────────────────────────────

interface ChartBarItem { label: string; value: number; color?: string; }
interface ChartPieSlice { label: string; value: number; color?: string; }
interface ChartLinePoint { label: string; value: number; }
interface ChartLineSeries { name: string; points: ChartLinePoint[]; color?: string; }
interface TreemapNode { name: string; value: number; children?: TreemapNode[]; }

interface ChartData {
  type: 'bar' | 'pie' | 'donut' | 'line' | 'radar' | 'funnel' | 'gauge' | 'treemap' | 'waterfall' | 'scatter' | 'map';
  bars?: ChartBarItem[];
  maxValue?: number;
  slices?: ChartPieSlice[];
  series?: ChartLineSeries[];
  labels?: string[];
  // Radar
  indicators?: { name: string; max: number }[];
  radarData?: { name: string; values: number[] }[];
  // Funnel
  funnelData?: { name: string; value: number }[];
  // Gauge
  gaugeValue?: number;
  gaugeMax?: number;
  gaugeLabel?: string;
  // Treemap
  treemapData?: TreemapNode[];
  // Waterfall
  waterfallData?: { label: string; value: number; type?: 'increase' | 'decrease' | 'total' }[];
  // Scatter
  scatterSeries?: { name: string; data: [number, number][] }[];
  // Map
  mapType?: 'world' | 'china';
  mapRegions?: { name: string; value: number }[];
  mapLabel?: string;  // legend label e.g. "Revenue ($M)"
}

interface StatItem { value: string; label: string; icon?: string; trend?: 'up' | 'down' | 'neutral'; }
interface IconGridItem { icon: string; title: string; description?: string; imageSrc?: string; }
interface TimelineMilestone { date?: string; title: string; description?: string; icon?: string; }

interface SlideData {
  type: 'title' | 'content' | 'two-column' | 'section' | 'code' | 'image'
    | 'hero' | 'stats' | 'icon-grid' | 'timeline' | 'quote' | 'chart' | 'image-text'
    | 'profile' | 'process' | 'gallery' | 'team' | 'table' | 'dashboard' | 'diagram' | 'mindmap';
  title?: string;
  subtitle?: string;
  bullets?: string[];
  text?: string;
  left?: { heading: string; bullets: string[] };
  right?: { heading: string; bullets: string[] };
  code?: string;
  language?: string;
  imageSrc?: string;
  imageAlt?: string;
  fragments?: boolean;
  tagline?: string;
  quote?: string;
  attribution?: string;
  stats?: StatItem[];
  items?: IconGridItem[];
  columns?: number;
  milestones?: TimelineMilestone[];
  chart?: ChartData;
  imagePosition?: 'left' | 'right';
  autoAnimate?: boolean;
  background?: string;
  notes?: string;
  // Profile
  avatar?: string;
  name?: string;
  role?: string;
  bio?: string;
  socialLinks?: { icon: string; label: string }[];
  // Process
  steps?: { icon?: string; title: string; description?: string }[];
  // Gallery
  images?: { src: string; caption?: string; alt?: string }[];
  galleryLayout?: '2x2' | '3-col' | '1-hero-2-small';
  // Team
  members?: { photo?: string; name: string; role: string; description?: string }[];
  // Table
  headers?: string[];
  rows?: string[][];
  highlightHeader?: boolean;
  // Dashboard
  kpis?: StatItem[];
  dashboardChart?: ChartData;
  // Diagram (Mermaid)
  diagramType?: 'mermaid';
  // Compound layout
  layout?: 'full' | 'split-left' | 'split-right' | 'top-bottom';
  description?: string;
  highlights?: string[];
  sideImage?: string;
  // Card-style bullets
  cardStyle?: boolean;
  bulletIcons?: string[];
}

interface SlidesInput {
  title: string;
  author?: string;
  date?: string;
  style?: string;
  slides: SlideData[];
}

// ── Utilities ──────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function animAttr(slide: SlideData, index: number): string {
  return slide.fragments ? ` class="animate-on-scroll" data-delay="${index}"` : '';
}

function wrapSlide(type: string, innerHtml: string, slide: SlideData, idx: number): string {
  const bgStyle = slide.background
    ? (slide.background.startsWith('http')
        ? ` style="background-image:url('${escapeHtml(slide.background)}');background-size:cover;background-position:center;"`
        : ` style="background-color:${escapeHtml(slide.background)};"`)
    : '';
  return `<section class="slide slide--${type}" id="slide-${idx}"${bgStyle}>
  <div class="slide-inner">
    ${innerHtml}
  </div>
</section>`;
}

function renderIcon(name: string, extraClass = ''): string {
  return `<span class="material-symbols-outlined${extraClass ? ' ' + extraClass : ''}">${escapeHtml(name)}</span>`;
}

// ── Decorative SVG ─────────────────────────────────────────────

function renderDecoBlob(colors: string[], idx: number): string {
  const [c1, c2 = c1] = colors;
  const gid = `blob-${idx}`;
  return `<svg class="deco-svg deco-blob" width="320" height="320" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="${gid}" x1="0%" y1="0%" x2="100%" y2="100%">
    <stop offset="0%" stop-color="${c1}" stop-opacity="0.4"/><stop offset="100%" stop-color="${c2}" stop-opacity="0.1"/>
  </linearGradient></defs>
  <path d="M44.7,-76.4C58.8,-69.2,71.8,-59.1,79.6,-45.8C87.3,-32.4,89.9,-16.2,88.5,-0.8C87.1,14.6,81.7,29.2,73.4,42.1C65.1,55,53.9,66.2,40.6,73.6C27.3,81,13.7,84.7,-0.8,86.1C-15.3,87.4,-30.5,86.5,-43.2,79.7C-55.9,72.9,-66,60.2,-73.4,46.1C-80.8,32,-85.5,16,-85.8,-0.2C-86.1,-16.3,-82,-32.7,-73.6,-46C-65.2,-59.3,-52.5,-69.6,-38.6,-76.9C-24.7,-84.3,-12.3,-88.6,1.5,-91.2C15.4,-93.8,30.7,-83.7,44.7,-76.4Z" transform="translate(100 100)" fill="url(#${gid})"/>
</svg>`;
}

function renderDecoCircles(colors: string[], idx: number): string {
  const [c1, c2 = c1] = colors;
  return `<svg class="deco-svg deco-circles" width="260" height="260" viewBox="0 0 260 260" xmlns="http://www.w3.org/2000/svg">
  <circle cx="130" cy="130" r="120" fill="none" stroke="${c1}" stroke-opacity="0.12" stroke-width="1"/>
  <circle cx="130" cy="130" r="80" fill="none" stroke="${c2}" stroke-opacity="0.08" stroke-width="1"/>
  <circle cx="130" cy="130" r="40" fill="${c1}" fill-opacity="0.05"/>
</svg>`;
}

function renderDecoWave(color: string): string {
  return `<svg class="deco-svg deco-wave" viewBox="0 0 1440 120" xmlns="http://www.w3.org/2000/svg">
  <path d="M0,64L60,69.3C120,75,240,85,360,80C480,75,600,53,720,48C840,43,960,53,1080,58.7C1200,64,1320,64,1380,64L1440,64L1440,120L0,120Z" fill="${color}" fill-opacity="0.1"/>
</svg>`;
}

// ── Compound Layout Helper ────────────────────────────────────

/**
 * Wraps a visual element in a compound layout with narrative text.
 * Returns the inner HTML (title + layout grid) when layout is set, or null to use legacy rendering.
 * Caller wraps with wrapSlide().
 */
function renderCompoundLayout(
  slide: SlideData,
  s: StylePreset,
  visualHtml: string,
): string | null {
  const layout = slide.layout;
  if (!layout || layout === 'full') return null;

  const hasText = slide.description || (slide.highlights && slide.highlights.length > 0);
  if (!hasText) return null;

  // Build text block
  let textHtml = '';
  if (slide.description) {
    textHtml += `<p class="compound-description">${escapeHtml(slide.description)}</p>`;
  }
  if (slide.highlights && slide.highlights.length > 0) {
    textHtml += `<ul class="compound-highlights">${slide.highlights.map(h =>
      `<li>${renderIcon('check_circle', 'highlight-icon')}<span>${escapeHtml(h)}</span></li>`
    ).join('')}</ul>`;
  }
  if (slide.sideImage) {
    textHtml += `<img src="${escapeHtml(slide.sideImage)}" class="compound-side-image" loading="lazy" alt="" />`;
  }

  const textBlock = `<div class="layout-text">${textHtml}</div>`;
  const visualBlock = `<div class="layout-visual">${visualHtml}</div>`;

  let gridHtml: string;
  if (layout === 'split-left') {
    gridHtml = `${visualBlock}${textBlock}`;
  } else if (layout === 'split-right') {
    gridHtml = `${textBlock}${visualBlock}`;
  } else {
    // top-bottom
    gridHtml = `${visualBlock}${textBlock}`;
  }

  return `${slide.title ? `<h2 class="slide-title">${escapeHtml(slide.title)}</h2>` : ''}
  <div class="slide-layout ${layout}">${gridHtml}</div>`;
}

// ── Side Image Wrapper (1/3 image + 2/3 content) ──────────────

function wrapWithSideImage(contentHtml: string, slide: SlideData): string {
  if (!slide.sideImage || slide.layout) return contentHtml;
  const imgPos = slide.imagePosition || 'right';
  const imgBlock = `<div class="side-image-panel"><img src="${escapeHtml(slide.sideImage)}" loading="lazy" alt="" /></div>`;
  const contentBlock = `<div class="side-content-panel">${contentHtml}</div>`;
  if (imgPos === 'left') {
    return `<div class="side-image-layout img-left">${imgBlock}${contentBlock}</div>`;
  }
  return `<div class="side-image-layout">${contentBlock}${imgBlock}</div>`;
}

// ── ECharts Option Builder ─────────────────────────────────────

function buildEChartsOption(chart: ChartData, s: StylePreset): object {
  const colors = s.chartColors;
  const textColor = s.bodyColor;
  const isDark = s.isDark;
  const splitLineColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
  const tooltipBg = isDark ? 'rgba(30,30,50,0.92)' : 'rgba(255,255,255,0.96)';
  const tooltipBorder = isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)';

  const baseTooltip = { backgroundColor: tooltipBg, borderColor: tooltipBorder, textStyle: { color: isDark ? '#e0e0ff' : '#333', fontSize: 13 } };

  switch (chart.type) {
    case 'bar': {
      const bars = chart.bars || [];
      return {
        color: colors,
        tooltip: { ...baseTooltip, trigger: 'axis' },
        grid: { left: '8%', right: '6%', bottom: '12%', top: '8%', containLabel: true },
        xAxis: { type: 'category', data: bars.map(b => b.label), axisLabel: { color: textColor, fontSize: 12 }, axisLine: { lineStyle: { color: splitLineColor } } },
        yAxis: { type: 'value', axisLabel: { color: textColor, fontSize: 12 }, splitLine: { lineStyle: { color: splitLineColor } } },
        series: [{ type: 'bar', data: bars.map((b, i) => ({ value: b.value, itemStyle: b.color ? { color: b.color } : undefined })), barWidth: '45%', itemStyle: { borderRadius: [6, 6, 0, 0] } }],
        animationDuration: 1200, animationEasing: 'cubicOut',
      };
    }
    case 'pie': case 'donut': {
      const slices = chart.slices || [];
      return {
        color: colors,
        tooltip: { ...baseTooltip, trigger: 'item', formatter: '{b}: {c} ({d}%)' },
        legend: { orient: 'vertical', right: '2%', top: 'center', textStyle: { color: textColor, fontSize: 12 }, formatter: function (name: string) { return name.length > 10 ? name.slice(0, 10) + '…' : name; } },
        series: [{
          type: 'pie', radius: chart.type === 'donut' ? ['40%', '70%'] : ['0%', '70%'],
          center: ['35%', '50%'], padAngle: 2, itemStyle: { borderRadius: 6 },
          data: slices.map(sl => ({ value: sl.value, name: sl.label })),
          label: { show: false },
          labelLine: { show: false },
          emphasis: { label: { show: true, fontSize: 14, fontWeight: 'bold', color: textColor }, itemStyle: { shadowBlur: 20, shadowColor: 'rgba(0,0,0,0.3)' } },
          animationType: 'scale', animationEasing: 'elasticOut',
        }],
      };
    }
    case 'line': {
      const series = chart.series || [];
      const labels = chart.labels || series[0]?.points.map(p => p.label) || [];
      return {
        color: colors,
        tooltip: { ...baseTooltip, trigger: 'axis' },
        legend: series.length > 1 ? { data: series.map(sr => sr.name), textStyle: { color: textColor, fontSize: 12 }, bottom: 0 } : undefined,
        grid: { left: '8%', right: '6%', bottom: series.length > 1 ? '15%' : '10%', top: '8%', containLabel: true },
        xAxis: { type: 'category', data: labels, axisLabel: { color: textColor, fontSize: 12 }, axisLine: { lineStyle: { color: splitLineColor } }, boundaryGap: false },
        yAxis: { type: 'value', axisLabel: { color: textColor, fontSize: 12 }, splitLine: { lineStyle: { color: splitLineColor } } },
        series: series.map((sr, i) => ({
          name: sr.name, type: 'line', smooth: true,
          data: sr.points.map(p => p.value),
          lineStyle: { width: 3 },
          areaStyle: { opacity: 0.08 },
          symbolSize: 6,
          ...(sr.color ? { itemStyle: { color: sr.color } } : {}),
        })),
        animationDuration: 1500,
      };
    }
    case 'radar': {
      const indicators = chart.indicators || [];
      const radarData = chart.radarData || [];
      return {
        color: colors,
        tooltip: { ...baseTooltip },
        legend: radarData.length > 1 ? { data: radarData.map(d => d.name), textStyle: { color: textColor }, bottom: 0 } : undefined,
        radar: {
          indicator: indicators.map(ind => ({ name: ind.name, max: ind.max })),
          shape: 'polygon',
          axisName: { color: textColor, fontSize: 12 },
          splitArea: { areaStyle: { color: isDark ? ['rgba(255,255,255,0.02)', 'rgba(255,255,255,0.04)'] : ['rgba(0,0,0,0.01)', 'rgba(0,0,0,0.03)'] } },
          splitLine: { lineStyle: { color: splitLineColor } },
          axisLine: { lineStyle: { color: splitLineColor } },
        },
        series: [{ type: 'radar', data: radarData.map((d, i) => ({ value: d.values, name: d.name, areaStyle: { opacity: 0.15 }, lineStyle: { width: 2 } })) }],
        animationDuration: 1200,
      };
    }
    case 'funnel': {
      const funnelData = chart.funnelData || [];
      return {
        color: colors,
        tooltip: { ...baseTooltip, trigger: 'item', formatter: '{b}: {c}' },
        series: [{
          type: 'funnel', left: '10%', top: '5%', bottom: '5%', width: '80%',
          sort: 'descending', gap: 4,
          label: { show: true, position: 'inside', color: '#fff', fontSize: 14, fontWeight: 600 },
          labelLine: { show: false },
          itemStyle: { borderWidth: 0, borderRadius: 4 },
          emphasis: { label: { fontSize: 16 } },
          data: funnelData.map(d => ({ value: d.value, name: d.name })),
          animationDuration: 1200, animationEasing: 'cubicOut',
        }],
      };
    }
    case 'gauge': {
      const val = chart.gaugeValue ?? 0;
      const max = chart.gaugeMax ?? 100;
      return {
        series: [{
          type: 'gauge', min: 0, max,
          progress: { show: true, width: 18, itemStyle: { color: s.accentColor } },
          axisLine: { lineStyle: { width: 18, color: [[1, splitLineColor]] } },
          axisTick: { show: false },
          splitLine: { length: 12, lineStyle: { width: 2, color: textColor } },
          axisLabel: { distance: 25, color: textColor, fontSize: 12 },
          pointer: { width: 5, length: '60%', itemStyle: { color: s.accentColor } },
          anchor: { show: true, size: 16, itemStyle: { borderWidth: 2, borderColor: s.accentColor, color: isDark ? '#1a1a2e' : '#fff' } },
          title: { show: true, offsetCenter: [0, '70%'], fontSize: 16, color: textColor },
          detail: { valueAnimation: true, fontSize: 36, fontWeight: 700, color: s.titleColor, offsetCenter: [0, '45%'], formatter: '{value}' },
          data: [{ value: val, name: chart.gaugeLabel || '' }],
          animationDuration: 2000,
        }],
      };
    }
    case 'treemap': {
      const data = chart.treemapData || [];
      return {
        color: colors,
        tooltip: { ...baseTooltip, formatter: '{b}: {c}' },
        series: [{
          type: 'treemap', data, roam: false,
          breadcrumb: { show: false },
          label: { show: true, fontSize: 13, color: '#fff', fontWeight: 600 },
          itemStyle: { borderColor: isDark ? '#1a1a2e' : '#fff', borderWidth: 3, borderRadius: 4 },
          levels: [{ itemStyle: { borderWidth: 0 }, upperLabel: { show: false } }],
          animationDuration: 1000,
        }],
      };
    }
    case 'waterfall': {
      const items = chart.waterfallData || [];
      const total: number[] = [];
      let cumulative = 0;
      const values: (number | string)[] = [];
      items.forEach(item => {
        if (item.type === 'total') { total.push(0); values.push(cumulative); }
        else { total.push(cumulative); values.push(item.value); cumulative += item.value; }
      });
      return {
        color: colors,
        tooltip: { ...baseTooltip, trigger: 'axis', axisPointer: { type: 'shadow' } },
        grid: { left: '8%', right: '6%', bottom: '12%', top: '8%', containLabel: true },
        xAxis: { type: 'category', data: items.map(i => i.label), axisLabel: { color: textColor, fontSize: 12 } },
        yAxis: { type: 'value', axisLabel: { color: textColor, fontSize: 12 }, splitLine: { lineStyle: { color: splitLineColor } } },
        series: [
          { type: 'bar', stack: 'wf', silent: true, itemStyle: { borderColor: 'transparent', color: 'transparent' }, data: total },
          {
            type: 'bar', stack: 'wf', barWidth: '40%',
            data: items.map((item, i) => ({
              value: values[i],
              itemStyle: {
                color: item.type === 'total' ? s.accentColor : (item.value >= 0 ? '#48BB78' : '#FC8181'),
                borderRadius: [4, 4, 0, 0],
              },
            })),
            label: { show: true, position: 'top', color: textColor, fontSize: 12, formatter: (p: any) => p.value },
          },
        ],
        animationDuration: 1200,
      };
    }
    case 'scatter': {
      const scatterSeries = chart.scatterSeries || [];
      return {
        color: colors,
        tooltip: { ...baseTooltip, trigger: 'item' },
        legend: scatterSeries.length > 1 ? { data: scatterSeries.map(s => s.name), textStyle: { color: textColor }, bottom: 0 } : undefined,
        grid: { left: '8%', right: '6%', bottom: scatterSeries.length > 1 ? '15%' : '10%', top: '8%', containLabel: true },
        xAxis: { type: 'value', axisLabel: { color: textColor, fontSize: 12 }, splitLine: { lineStyle: { color: splitLineColor } } },
        yAxis: { type: 'value', axisLabel: { color: textColor, fontSize: 12 }, splitLine: { lineStyle: { color: splitLineColor } } },
        series: scatterSeries.map(sr => ({
          name: sr.name, type: 'scatter', data: sr.data, symbolSize: 12,
          emphasis: { focus: 'series', itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0,0,0,0.3)' } },
        })),
        animationDuration: 1200,
      };
    }
    case 'map': {
      const regions = chart.mapRegions || [];
      const mapName = chart.mapType || 'world';
      const maxVal = Math.max(...regions.map(r => r.value), 1);
      return {
        tooltip: { ...baseTooltip, trigger: 'item', formatter: (p: any) => p.name + ': ' + (p.value || 'N/A') },
        visualMap: {
          min: 0, max: maxVal, left: 'left', top: 'bottom',
          text: [chart.mapLabel || 'High', 'Low'],
          textStyle: { color: textColor, fontSize: 12 },
          inRange: { color: [isDark ? '#1a2a4a' : '#e0ecf4', isDark ? '#0af' : colors[0]] },
          calculable: true,
        },
        series: [{
          type: 'map', map: mapName, roam: true,
          label: { show: false },
          emphasis: {
            label: { show: true, color: isDark ? '#fff' : '#333', fontSize: 13, fontWeight: 600 },
            itemStyle: { areaColor: colors[0], shadowColor: 'rgba(0,0,0,0.3)', shadowBlur: 10 },
          },
          itemStyle: {
            areaColor: isDark ? '#2a2a4a' : '#e8edf2',
            borderColor: isDark ? '#444' : '#ccc',
            borderWidth: 0.5,
          },
          data: regions,
          animationDurationUpdate: 1000,
        }],
      };
    }
    default:
      return {};
  }
}

// ── Content Limits (prevent overflow) ───────────────────────────
const LIMITS = {
  bullets: 6,
  bulletsCompact: 4,
  stats: 4,
  iconGridItems: 6,
  timelineMilestones: 4,
  codeLines: 12,
  chartBars: 6,
  chartSlices: 6,
  chartLinePoints: 8,
  profileSocialLinks: 4,
  processSteps: 5,
  galleryImages: 6,
  teamMembers: 4,
  tableRows: 6,
  tableColumns: 6,
  dashboardKpis: 4,
  radarIndicators: 6,
  funnelItems: 8,
  waterfallItems: 10,
  highlights: 4,
  descriptionChars: 300,
};

function sanitizeSlide(slide: SlideData): SlideData {
  const s = { ...slide };
  if (s.bullets && s.bullets.length > LIMITS.bullets) s.bullets = s.bullets.slice(0, LIMITS.bullets);
  if (s.left && s.left.bullets.length > LIMITS.bulletsCompact) s.left = { ...s.left, bullets: s.left.bullets.slice(0, LIMITS.bulletsCompact) };
  if (s.right && s.right.bullets.length > LIMITS.bulletsCompact) s.right = { ...s.right, bullets: s.right.bullets.slice(0, LIMITS.bulletsCompact) };
  if (s.stats && s.stats.length > LIMITS.stats) s.stats = s.stats.slice(0, LIMITS.stats);
  if (s.items && s.items.length > LIMITS.iconGridItems) s.items = s.items.slice(0, LIMITS.iconGridItems);
  if (s.items && s.type === 'icon-grid') {
    const count = s.items.length;
    if (!s.columns || s.columns < count) {
      if (count <= 4) s.columns = count;
      else if (count <= 6) s.columns = 3;
    }
  }
  if (s.milestones && s.milestones.length > LIMITS.timelineMilestones) s.milestones = s.milestones.slice(0, LIMITS.timelineMilestones);
  if (s.code && s.type !== 'diagram' && s.type !== 'mindmap') {
    const lines = s.code.split('\n');
    if (lines.length > LIMITS.codeLines) s.code = lines.slice(0, LIMITS.codeLines).join('\n') + '\n// ...';
  }
  if (s.chart) {
    const c = { ...s.chart };
    if (c.bars && c.bars.length > LIMITS.chartBars) c.bars = c.bars.slice(0, LIMITS.chartBars);
    if (c.slices && c.slices.length > LIMITS.chartSlices) c.slices = c.slices.slice(0, LIMITS.chartSlices);
    if (c.series) c.series = c.series.map(sr => ({ ...sr, points: sr.points.length > LIMITS.chartLinePoints ? sr.points.slice(0, LIMITS.chartLinePoints) : sr.points }));
    if (c.indicators && c.indicators.length > LIMITS.radarIndicators) c.indicators = c.indicators.slice(0, LIMITS.radarIndicators);
    if (c.radarData) c.radarData = c.radarData.map(d => ({ ...d, values: d.values.slice(0, LIMITS.radarIndicators) }));
    if (c.funnelData && c.funnelData.length > LIMITS.funnelItems) c.funnelData = c.funnelData.slice(0, LIMITS.funnelItems);
    if (c.waterfallData && c.waterfallData.length > LIMITS.waterfallItems) c.waterfallData = c.waterfallData.slice(0, LIMITS.waterfallItems);
    s.chart = c;
  }
  if (s.dashboardChart) {
    const c = { ...s.dashboardChart };
    if (c.bars && c.bars.length > LIMITS.chartBars) c.bars = c.bars.slice(0, LIMITS.chartBars);
    if (c.slices && c.slices.length > LIMITS.chartSlices) c.slices = c.slices.slice(0, LIMITS.chartSlices);
    s.dashboardChart = c;
  }
  if (s.socialLinks && s.socialLinks.length > LIMITS.profileSocialLinks) s.socialLinks = s.socialLinks.slice(0, LIMITS.profileSocialLinks);
  if (s.steps && s.steps.length > LIMITS.processSteps) s.steps = s.steps.slice(0, LIMITS.processSteps);
  if (s.images && s.images.length > LIMITS.galleryImages) s.images = s.images.slice(0, LIMITS.galleryImages);
  if (s.members && s.members.length > LIMITS.teamMembers) s.members = s.members.slice(0, LIMITS.teamMembers);
  if (s.kpis && s.kpis.length > LIMITS.dashboardKpis) s.kpis = s.kpis.slice(0, LIMITS.dashboardKpis);
  if (s.headers && s.headers.length > LIMITS.tableColumns) s.headers = s.headers.slice(0, LIMITS.tableColumns);
  if (s.rows) {
    if (s.rows.length > LIMITS.tableRows) s.rows = s.rows.slice(0, LIMITS.tableRows);
    if (s.headers) s.rows = s.rows.map(r => r.slice(0, s.headers!.length));
  }
  // Compound layout fields
  if (s.highlights && s.highlights.length > LIMITS.highlights) s.highlights = s.highlights.slice(0, LIMITS.highlights);
  if (s.description && s.description.length > LIMITS.descriptionChars) s.description = s.description.slice(0, LIMITS.descriptionChars) + '...';
  return s;
}

// ── Slide Renderers ────────────────────────────────────────────

// Track CDN needs
let echartsUsed = false;
let mermaidUsed = false;
let markmapUsed = false;
const echartsMapTypes = new Set<string>();  // Track map GeoJSON needs
const echartsConfigs: { id: string; option: object }[] = [];
const mindmapConfigs: { id: string; code: string }[] = [];
const mermaidConfigs: { id: string; code: string }[] = [];

function renderSlide(rawSlide: SlideData, s: StylePreset, idx: number): string {
  const slide = sanitizeSlide(rawSlide);
  const aa = (i: number) => animAttr(slide, i);
  const deco = s.decorations && s.decorationColors.length > 0;

  switch (slide.type) {

    case 'title': {
      let inner: string;
      if (slide.sideImage) {
        inner = `<div class="slide-layout split-right">
    <div class="layout-text title-text-block">
      ${slide.tagline ? `<p class="tagline">${escapeHtml(slide.tagline)}</p>` : ''}
      <h1>${escapeHtml(slide.title || '')}</h1>
      <div class="accent-line"></div>
      ${slide.subtitle ? `<p class="subtitle">${escapeHtml(slide.subtitle)}</p>` : ''}
      ${slide.description ? `<p class="compound-description">${escapeHtml(slide.description)}</p>` : ''}
    </div>
    <div class="layout-visual title-side-image">
      <img src="${escapeHtml(slide.sideImage)}" loading="lazy" alt="" />
    </div>
  </div>`;
      } else {
        inner = `${deco ? renderDecoBlob(s.decorationColors, idx) : ''}
  ${deco ? `<div class="deco-svg deco-circles-pos">${renderDecoCircles(s.decorationColors, idx)}</div>` : ''}
  <h1>${escapeHtml(slide.title || '')}</h1>
  <div class="accent-line"></div>
  ${slide.subtitle ? `<p class="subtitle">${escapeHtml(slide.subtitle)}</p>` : ''}
  ${slide.tagline ? `<p class="tagline">${escapeHtml(slide.tagline)}</p>` : ''}`;
      }
      return wrapSlide('title', inner, slide, idx);
    }

    case 'section':
      return wrapSlide('section', `${deco ? renderDecoWave(s.decorationColors[0] || s.accentColor) : ''}
  <h2 class="section-heading">${escapeHtml(slide.title || '')}</h2>
  <div class="accent-line"></div>
  ${slide.subtitle ? `<p class="subtitle">${escapeHtml(slide.subtitle)}</p>` : ''}`, slide, idx);

    case 'content': {
      let body = '';
      if (slide.bullets && slide.cardStyle) {
        const icons = slide.bulletIcons || [];
        body = `<div class="bullet-cards">${slide.bullets.map((b, i) => {
          const icon = icons[i] || 'arrow_right';
          return `<div class="bullet-card glass-card"${aa(i)}>
  <div class="bullet-card-icon">${renderIcon(icon)}</div>
  <div class="bullet-card-text">${escapeHtml(b)}</div>
</div>`;
        }).join('')}</div>`;
      } else if (slide.bullets) {
        body = `<ul class="bullet-list">${slide.bullets.map((b, i) =>
          `<li${aa(i)}><span class="bullet-icon">${renderIcon('arrow_right', 'bullet-sym')}</span><span>${escapeHtml(b)}</span></li>`
        ).join('')}</ul>`;
      } else if (slide.text) {
        body = `<p class="body-text">${escapeHtml(slide.text)}</p>`;
      }
      const contentInner = `${slide.title ? `<h2 class="slide-title">${escapeHtml(slide.title)}</h2>` : ''}
  ${body}`;
      return wrapSlide('content', wrapWithSideImage(contentInner, slide), slide, idx);
    }

    case 'two-column': {
      const renderCol = (col: { heading: string; bullets: string[] }) =>
        `<div class="slide-col glass-card">
          <h3>${escapeHtml(col.heading)}</h3>
          <ul class="bullet-list compact">${col.bullets.map((b, i) =>
            `<li${aa(i)}><span class="bullet-icon">${renderIcon('chevron_right', 'bullet-sym')}</span><span>${escapeHtml(b)}</span></li>`
          ).join('')}</ul>
        </div>`;
      return wrapSlide('two-column', `${slide.title ? `<h2 class="slide-title">${escapeHtml(slide.title)}</h2>` : ''}
  <div class="slide-columns">${slide.left ? renderCol(slide.left) : ''}${slide.right ? renderCol(slide.right) : ''}</div>`, slide, idx);
    }

    case 'code': {
      const codeInner = `${slide.title ? `<h2 class="slide-title">${escapeHtml(slide.title)}</h2>` : ''}
  <pre class="code-block"><code class="language-${slide.language || 'plaintext'}">${escapeHtml(slide.code || '')}</code></pre>`;
      return wrapSlide('code', wrapWithSideImage(codeInner, slide), slide, idx);
    }

    case 'image':
      return wrapSlide('image', `${slide.title ? `<h2 class="slide-title">${escapeHtml(slide.title)}</h2>` : ''}
  <img src="${escapeHtml(slide.imageSrc || '')}" alt="${escapeHtml(slide.imageAlt || '')}" loading="lazy" class="slide-image">`, slide, idx);

    case 'hero': {
      // Hero uses background image via inline style on the section
      const heroBg = slide.imageSrc ? slide.imageSrc : '';
      const heroSlide: SlideData = { ...slide, background: heroBg || slide.background };
      return wrapSlide('hero', `${slide.imageSrc ? '<div class="hero-overlay"></div>' : ''}
  ${deco && !slide.imageSrc ? renderDecoBlob(s.decorationColors, idx) : ''}
  <div class="hero-content">
    <h1 class="hero-title">${escapeHtml(slide.title || '')}</h1>
    ${slide.subtitle ? `<p class="hero-subtitle">${escapeHtml(slide.subtitle)}</p>` : ''}
    ${slide.tagline ? `<p class="hero-tagline">${escapeHtml(slide.tagline)}</p>` : ''}
  </div>`, heroSlide, idx);
    }

    case 'stats': {
      const statsItems = slide.stats || [];
      const cards = statsItems.map((st, i) => {
        const trendIcon = st.trend === 'up' ? 'trending_up' : st.trend === 'down' ? 'trending_down' : '';
        const trendClass = st.trend === 'up' ? 'trend-up' : st.trend === 'down' ? 'trend-down' : '';
        return `<div class="stats-card glass-card"${aa(i)}>
  ${st.icon ? `<div class="stats-icon">${renderIcon(st.icon)}</div>` : ''}
  <div class="stats-value">${escapeHtml(st.value)}</div>
  <div class="stats-label">${escapeHtml(st.label)}</div>
  ${trendIcon ? `<div class="stats-trend ${trendClass}">${renderIcon(trendIcon, 'trend-icon')}</div>` : ''}
</div>`;
      }).join('');
      const visualHtml = `<div class="stats-grid">${cards}</div>`;
      const compound = renderCompoundLayout(slide, s, visualHtml);
      if (compound) return wrapSlide('stats', compound, slide, idx);
      const statsInner = `${slide.title ? `<h2 class="slide-title">${escapeHtml(slide.title)}</h2>` : ''}
  ${visualHtml}`;
      return wrapSlide('stats', wrapWithSideImage(statsInner, slide), slide, idx);
    }

    case 'icon-grid': {
      const items = slide.items || [];
      const cols = Math.min(slide.columns || 3, 4);
      const cards = items.map((it, i) => {
        const iconHtml = it.imageSrc
          ? `<img src="${escapeHtml(it.imageSrc)}" class="icon-card-img" loading="lazy" alt="${escapeHtml(it.title)}" />`
          : `<div class="icon-card-icon">${renderIcon(it.icon)}</div>`;
        return `<div class="icon-card glass-card"${aa(i)}>
  ${iconHtml}
  <div class="icon-card-title">${escapeHtml(it.title)}</div>
  ${it.description ? `<p class="icon-card-desc">${escapeHtml(it.description)}</p>` : ''}
</div>`;
      }).join('');
      const visualHtml = `<div class="icon-grid cols-${cols}">${cards}</div>`;
      const compound = renderCompoundLayout(slide, s, visualHtml);
      if (compound) return wrapSlide('icon-grid', compound, slide, idx);
      const gridInner = `${slide.title ? `<h2 class="slide-title">${escapeHtml(slide.title)}</h2>` : ''}
  ${visualHtml}`;
      return wrapSlide('icon-grid', wrapWithSideImage(gridInner, slide), slide, idx);
    }

    case 'timeline': {
      const milestones = slide.milestones || [];
      const tlItems = milestones.map((m, i) =>
        `<div class="tl-item"${aa(i)}>
  <div class="tl-dot">${m.icon ? renderIcon(m.icon, 'tl-icon') : `<span class="tl-num">${i + 1}</span>`}</div>
  <div class="tl-content">
    ${m.date ? `<span class="tl-date">${escapeHtml(m.date)}</span>` : ''}
    <div class="tl-title">${escapeHtml(m.title)}</div>
    ${m.description ? `<p class="tl-desc">${escapeHtml(m.description)}</p>` : ''}
  </div>
</div>`
      ).join('');
      const visualHtml = `<div class="timeline"><div class="tl-line"></div><div class="tl-items">${tlItems}</div></div>`;
      const compound = renderCompoundLayout(slide, s, visualHtml);
      if (compound) return wrapSlide('timeline', compound, slide, idx);
      return wrapSlide('timeline', `${slide.title ? `<h2 class="slide-title">${escapeHtml(slide.title)}</h2>` : ''}
  ${visualHtml}`, slide, idx);
    }

    case 'quote': {
      const quoteInner = `<div class="quote-block">
    <div class="quote-mark">\u201C</div>
    <blockquote class="quote-text">${escapeHtml(slide.quote || slide.text || '')}</blockquote>
    ${slide.attribution ? `<cite class="quote-author">\u2014 ${escapeHtml(slide.attribution)}</cite>` : ''}
  </div>`;
      return wrapSlide('quote', wrapWithSideImage(quoteInner, slide), slide, idx);
    }

    case 'chart': {
      echartsUsed = true;
      if (slide.chart?.type === 'map') echartsMapTypes.add(slide.chart.mapType || 'world');
      const chartId = `echart-${idx}`;
      echartsConfigs.push({ id: chartId, option: buildEChartsOption(slide.chart || { type: 'bar' }, s) });
      const visualHtml = `<div id="${chartId}" class="echart-container"></div>`;
      const compound = renderCompoundLayout(slide, s, visualHtml);
      if (compound) return wrapSlide('chart', compound, slide, idx);
      return wrapSlide('chart', `${slide.title ? `<h2 class="slide-title">${escapeHtml(slide.title)}</h2>` : ''}
  ${visualHtml}`, slide, idx);
    }

    case 'image-text': {
      const pos = slide.imagePosition || 'left';
      const imgBlock = `<div class="it-image"><img src="${escapeHtml(slide.imageSrc || '')}" alt="${escapeHtml(slide.imageAlt || '')}" loading="lazy"></div>`;
      let textBlock = `<div class="it-text">`;
      if (slide.title) textBlock += `<h2 class="slide-title">${escapeHtml(slide.title)}</h2>`;
      if (slide.text) textBlock += `<p class="body-text">${escapeHtml(slide.text)}</p>`;
      if (slide.bullets) {
        textBlock += `<ul class="bullet-list compact">${slide.bullets.map((b, i) =>
          `<li${aa(i)}><span class="bullet-icon">${renderIcon('arrow_right', 'bullet-sym')}</span><span>${escapeHtml(b)}</span></li>`
        ).join('')}</ul>`;
      }
      textBlock += `</div>`;
      return wrapSlide('image-text', `<div class="image-text-layout ${pos === 'right' ? 'img-right' : ''}">${pos === 'left' ? imgBlock + textBlock : textBlock + imgBlock}</div>`, slide, idx);
    }

    case 'profile': {
      const links = (slide.socialLinks || []).map(l =>
        `<span class="profile-link">${renderIcon(l.icon, 'profile-link-icon')}<span>${escapeHtml(l.label)}</span></span>`
      ).join('');
      return wrapSlide('profile', `<div class="profile-layout">
    ${slide.avatar ? `<div class="profile-avatar-wrap"><img src="${escapeHtml(slide.avatar)}" class="profile-avatar" loading="lazy" alt="${escapeHtml(slide.name || '')}" /></div>` : ''}
    ${slide.name ? `<h2 class="profile-name">${escapeHtml(slide.name)}</h2>` : ''}
    ${slide.role ? `<p class="profile-role">${escapeHtml(slide.role)}</p>` : ''}
    ${slide.bio ? `<p class="profile-bio">${escapeHtml(slide.bio)}</p>` : ''}
    ${links ? `<div class="profile-social">${links}</div>` : ''}
  </div>`, slide, idx);
    }

    case 'process': {
      const steps = slide.steps || [];
      const stepsHtml = steps.map((st, i) =>
        `<div class="process-step"${aa(i)}>
  <div class="process-step-circle">${st.icon ? renderIcon(st.icon, 'process-icon') : `<span class="process-num">${i + 1}</span>`}</div>
  <div class="process-step-label">${escapeHtml(st.title)}</div>
  ${st.description ? `<div class="process-step-desc">${escapeHtml(st.description)}</div>` : ''}
</div>`
      ).join('');
      const visualHtml = `<div class="process-steps"><div class="process-connector"></div>${stepsHtml}</div>`;
      const compound = renderCompoundLayout(slide, s, visualHtml);
      if (compound) return wrapSlide('process', compound, slide, idx);
      const processInner = `${slide.title ? `<h2 class="slide-title">${escapeHtml(slide.title)}</h2>` : ''}
  ${visualHtml}`;
      return wrapSlide('process', wrapWithSideImage(processInner, slide), slide, idx);
    }

    case 'gallery': {
      const images = slide.images || [];
      const gLayout = slide.galleryLayout || (images.length <= 3 ? '3-col' : '2x2');
      const gItems = images.map(img =>
        `<figure class="gallery-item">
  <img src="${escapeHtml(img.src)}" alt="${escapeHtml(img.alt || img.caption || '')}" loading="lazy" />
  ${img.caption ? `<figcaption>${escapeHtml(img.caption)}</figcaption>` : ''}
</figure>`
      ).join('');
      const visualHtml = `<div class="gallery gallery-${gLayout}">${gItems}</div>`;
      const compound = renderCompoundLayout(slide, s, visualHtml);
      if (compound) return wrapSlide('gallery', compound, slide, idx);
      return wrapSlide('gallery', `${slide.title ? `<h2 class="slide-title">${escapeHtml(slide.title)}</h2>` : ''}
  ${visualHtml}`, slide, idx);
    }

    case 'team': {
      const members = slide.members || [];
      const teamCards = members.map((m, i) =>
        `<div class="team-card glass-card"${aa(i)}>
  ${m.photo ? `<img src="${escapeHtml(m.photo)}" class="team-photo" loading="lazy" alt="${escapeHtml(m.name)}" />` : `<div class="team-photo-placeholder">${renderIcon('person')}</div>`}
  <div class="team-name">${escapeHtml(m.name)}</div>
  <div class="team-role">${escapeHtml(m.role)}</div>
  ${m.description ? `<div class="team-desc">${escapeHtml(m.description)}</div>` : ''}
</div>`
      ).join('');
      const visualHtml = `<div class="team-grid">${teamCards}</div>`;
      const compound = renderCompoundLayout(slide, s, visualHtml);
      if (compound) return wrapSlide('team', compound, slide, idx);
      return wrapSlide('team', `${slide.title ? `<h2 class="slide-title">${escapeHtml(slide.title)}</h2>` : ''}
  ${visualHtml}`, slide, idx);
    }

    case 'table': {
      const tHeaders = slide.headers || [];
      const tRows = slide.rows || [];
      const thClass = slide.highlightHeader ? ' class="table-header-highlighted"' : '';
      const headerRow = tHeaders.length ? `<thead${thClass}><tr>${tHeaders.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>` : '';
      const bodyRows = tRows.map(r => `<tr>${r.map(c => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('');
      const visualHtml = `<div class="table-wrap"><table class="slide-table">${headerRow}<tbody>${bodyRows}</tbody></table></div>`;
      const compound = renderCompoundLayout(slide, s, visualHtml);
      if (compound) return wrapSlide('table', compound, slide, idx);
      return wrapSlide('table', `${slide.title ? `<h2 class="slide-title">${escapeHtml(slide.title)}</h2>` : ''}
  ${visualHtml}`, slide, idx);
    }

    case 'dashboard': {
      const kpis = slide.kpis || [];
      const kpiCards = kpis.map(st => {
        const trendIcon = st.trend === 'up' ? 'trending_up' : st.trend === 'down' ? 'trending_down' : '';
        const trendClass = st.trend === 'up' ? 'trend-up' : st.trend === 'down' ? 'trend-down' : '';
        return `<div class="stats-card glass-card dashboard-kpi-card">
  ${st.icon ? `<div class="stats-icon">${renderIcon(st.icon)}</div>` : ''}
  <div class="stats-value">${escapeHtml(st.value)}</div>
  <div class="stats-label">${escapeHtml(st.label)}</div>
  ${trendIcon ? `<div class="stats-trend ${trendClass}">${renderIcon(trendIcon, 'trend-icon')}</div>` : ''}
</div>`;
      }).join('');

      let chartHtml = '';
      if (slide.dashboardChart) {
        echartsUsed = true;
        if (slide.dashboardChart.type === 'map') echartsMapTypes.add(slide.dashboardChart.mapType || 'world');
        const chartId = `echart-dash-${idx}`;
        echartsConfigs.push({ id: chartId, option: buildEChartsOption(slide.dashboardChart, s) });
        chartHtml = `<div id="${chartId}" class="echart-container echart-compact"></div>`;
      }

      return wrapSlide('dashboard', `${slide.title ? `<h2 class="slide-title">${escapeHtml(slide.title)}</h2>` : ''}
  <div class="dashboard-kpis">${kpiCards}</div>
  ${chartHtml ? `<div class="dashboard-chart">${chartHtml}</div>` : ''}`, slide, idx);
    }

    case 'diagram': {
      mermaidUsed = true;
      const mermaidId = `mermaid-${idx}`;
      mermaidConfigs.push({ id: mermaidId, code: slide.code || '' });
      const visualHtml = `<div class="diagram-container"><pre class="mermaid" id="${mermaidId}"></pre></div>`;
      const compound = renderCompoundLayout(slide, s, visualHtml);
      if (compound) return wrapSlide('diagram', compound, slide, idx);
      return wrapSlide('diagram', `${slide.title ? `<h2 class="slide-title">${escapeHtml(slide.title)}</h2>` : ''}
  ${visualHtml}`, slide, idx);
    }

    case 'mindmap': {
      markmapUsed = true;
      const mmId = `mindmap-${idx}`;
      mindmapConfigs.push({ id: mmId, code: slide.code || '' });
      const visualHtml = `<div class="mindmap-wrapper">
  <div class="mindmap-container"><svg id="${mmId}" class="mindmap-svg"></svg></div>
  <div class="mindmap-toolbar">
    <button onclick="mmExpandAll('${mmId}')" title="Expand All"><span class="material-symbols-outlined">unfold_more</span> Expand All</button>
    <button onclick="mmCollapseAll('${mmId}')" title="Collapse All"><span class="material-symbols-outlined">unfold_less</span> Collapse All</button>
    <button onclick="mmFitView('${mmId}')" title="Fit View"><span class="material-symbols-outlined">fit_screen</span> Fit View</button>
    <span class="mindmap-hint"><span class="material-symbols-outlined">touch_app</span> Click node to expand</span>
  </div>
</div>`;
      const compound = renderCompoundLayout(slide, s, visualHtml);
      if (compound) return wrapSlide('mindmap', compound, slide, idx);
      return wrapSlide('mindmap', `${slide.title ? `<h2 class="slide-title">${escapeHtml(slide.title)}</h2>` : ''}
  ${visualHtml}`, slide, idx);
    }

    default:
      return wrapSlide('default', `<p class="body-text">${escapeHtml(slide.title || 'Untitled Slide')}</p>`, slide, idx);
  }
}

// ── CSS Generator ──────────────────────────────────────────────

function generateCSS(s: StylePreset): string {
  const isGrad = s.bg.startsWith('linear-gradient');
  const bgRule = isGrad ? `background: ${s.bg};` : `background-color: ${s.bg};`;
  const hoverBg = s.isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)';

  return `
/* ── CSS Custom Properties ── */
:root {
  --slide-bg: ${isGrad ? '#667eea' : s.bg};
  --title-color: ${s.titleColor};
  --subtitle-color: ${s.subtitleColor};
  --heading-color: ${s.headingColor};
  --body-color: ${s.bodyColor};
  --accent: ${s.accentColor};
  --accent2: ${s.accentColor2};
  --code-bg: ${s.codeBg};
  --code-color: ${s.codeColor};
  --font-body: ${s.fontFamily};
  --font-heading: ${s.headingFontFamily};
  --card-bg: ${s.cardBg};
  --card-border: ${s.cardBorder};
  --icon-color: ${s.iconColor};
  --timeline-color: ${s.timelineColor};
  --stats-card-bg: ${s.statsCardBg};
  --quote-mark-color: ${s.quoteMarkColor};
  --chart-accent: ${s.chartColors[0] || s.accentColor};
}

/* ── Reset & Base ── */
*, *::before, *::after { box-sizing: border-box; }
html { scroll-behavior: smooth; font-size: 18px; }
body { margin: 0; padding: 0; font-family: var(--font-body); color: var(--body-color); ${bgRule} }
* { scrollbar-width: none; -ms-overflow-style: none; }
*::-webkit-scrollbar { display: none; }

/* ── Scroll-Snap Container ── */
.slides-container {
  height: 100vh; overflow-y: auto;
  scroll-snap-type: y mandatory;
  scroll-behavior: smooth;
}

/* ── Each Section (Slide) ── */
.slide {
  min-height: 100vh;
  scroll-snap-align: start;
  display: flex; align-items: center; justify-content: center;
  position: relative;
  text-align: left;
}
/* Section background cycling */
.slide:nth-child(6n+1) { background-color: ${s.sectionBgColors[0]}; }
.slide:nth-child(6n+2) { background-color: ${s.sectionBgColors[1]}; }
.slide:nth-child(6n+3) { background-color: ${s.sectionBgColors[2]}; }
.slide:nth-child(6n+4) { background-color: ${s.sectionBgColors[3]}; }
.slide:nth-child(6n+5) { background-color: ${s.sectionBgColors[4]}; }
.slide:nth-child(6n+6) { background-color: ${s.sectionBgColors[5]}; }
.slide .deco-svg { position: absolute; pointer-events: none; z-index: 0; }
.slide-inner > *:not(.deco-svg):not(.hero-overlay) { position: relative; z-index: 1; }

/* Content wrapper — floating card on colored background */
.slide-inner {
  width: 100%; max-width: 1100px;
  margin: 60px auto;
  padding: 56px 56px;
  display: flex; flex-direction: column; justify-content: center;
  min-height: min(680px, calc(100vh - 120px));
  background: ${s.isDark ? 'rgba(255,255,255,0.04)' : '#ffffff'};
  border-radius: 24px;
  box-shadow: ${s.isDark
    ? '0 8px 40px rgba(0,0,0,0.3), 0 0 0 1px rgba(255,255,255,0.06)'
    : '0 4px 30px rgba(0,0,0,0.06), 0 0 0 1px rgba(0,0,0,0.03)'};
  overflow: hidden;
  position: relative;
}
/* Hero & section slides — full-bleed, no card */
.slide--hero .slide-inner {
  background: transparent;
  border-radius: 0;
  box-shadow: none;
  margin: 0;
  padding: 80px 64px;
  min-height: 100vh;
  max-width: 100%;
  overflow: hidden;
}
.slide--hero { background-color: transparent !important; }
.slide--section .slide-inner {
  background: transparent;
  box-shadow: none;
}
/* image-text slides — zero card padding, layout fills card */
.slide--image-text .slide-inner {
  padding: 0;
}

/* Floating gradient orbs */
.slide::before {
  content: '';
  position: absolute;
  width: 500px; height: 500px;
  border-radius: 50%;
  background: radial-gradient(circle, ${s.accentColor} 0%, transparent 70%);
  opacity: ${s.isDark ? '0.1' : '0.06'};
  pointer-events: none; z-index: 0;
  filter: blur(60px);
}
.slide:nth-child(odd)::before { top: -220px; right: -180px; }
.slide:nth-child(even)::before { bottom: -220px; left: -180px; }
.slide::after {
  content: '';
  position: absolute;
  width: 350px; height: 350px;
  border-radius: 50%;
  background: radial-gradient(circle, ${s.accentColor2} 0%, transparent 70%);
  opacity: ${s.isDark ? '0.07' : '0.04'};
  pointer-events: none; z-index: 0;
  filter: blur(40px);
}
.slide:nth-child(odd)::after { bottom: -150px; left: -120px; }
.slide:nth-child(even)::after { top: -150px; right: -120px; }

/* ── Navigation Overlay ── */
.slide-nav {
  position: fixed; right: 28px; top: 50%; transform: translateY(-50%);
  z-index: 200; display: flex; flex-direction: column; gap: 10px;
}
.nav-dot {
  width: 10px; height: 10px; border-radius: 50%;
  background: var(--body-color); opacity: 0.25;
  cursor: pointer; transition: all 0.3s ease; border: none;
}
.nav-dot:hover { opacity: 0.6; transform: scale(1.3); }
.nav-dot.active { opacity: 1; background: var(--accent); transform: scale(1.5); box-shadow: 0 0 10px ${s.accentColor}60; }
.nav-progress {
  position: fixed; top: 0; left: 0; right: 0; height: 3px;
  background: linear-gradient(90deg, var(--accent), var(--accent2));
  transform-origin: left; transform: scaleX(0);
  z-index: 200; transition: transform 0.3s ease;
}
.slide-counter {
  position: fixed; bottom: 28px; left: 50%; transform: translateX(-50%);
  z-index: 200; font-size: 13px; color: var(--body-color); opacity: 0.5;
  font-family: var(--font-body); letter-spacing: 0.08em;
  transition: opacity 0.3s;
}
.slide-counter:hover { opacity: 0.9; }
.fullscreen-btn {
  position: fixed; bottom: 24px; right: 24px; z-index: 200;
  width: 44px; height: 44px; border-radius: 12px;
  border: 1px solid var(--card-border); background: var(--card-bg);
  backdrop-filter: blur(12px); cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: transform 0.2s, opacity 0.2s; opacity: 0.5;
  color: var(--body-color);
}
.fullscreen-btn:hover { opacity: 1; transform: scale(1.08); }

/* ── Scroll-Triggered Animations ── */
.animate-on-scroll {
  opacity: 0; transform: translateY(24px);
  transition: opacity 0.6s cubic-bezier(0.22,1,0.36,1), transform 0.6s cubic-bezier(0.22,1,0.36,1);
}
.animate-on-scroll.is-visible { opacity: 1; transform: translateY(0); }
.animate-on-scroll[data-delay="1"] { transition-delay: 0.1s; }
.animate-on-scroll[data-delay="2"] { transition-delay: 0.2s; }
.animate-on-scroll[data-delay="3"] { transition-delay: 0.3s; }
.animate-on-scroll[data-delay="4"] { transition-delay: 0.4s; }
.animate-on-scroll[data-delay="5"] { transition-delay: 0.5s; }

/* ── Typography ── */
h1, h2, h3, h4 {
  font-family: var(--font-heading);
  font-weight: 700;
  color: var(--heading-color);
  word-wrap: break-word;
  margin: 0 0 0.4em;
  line-height: 1.15;
  letter-spacing: -0.02em;
}
h1 { font-size: clamp(2.2em, 4.5vw, 3.2em); color: var(--title-color); }
h2 { font-size: clamp(1.4em, 3vw, 2em); }
h3 { font-size: clamp(1em, 2.2vw, 1.3em); }
h4 { font-size: clamp(0.9em, 1.8vw, 1.1em); font-weight: 600; }
.slide-title {
  text-align: left;
  margin-bottom: 0.8em;
  padding-left: 20px;
  padding-bottom: 0.3em;
  border-left: 4px solid var(--accent);
  border-image: linear-gradient(to bottom, var(--accent), var(--accent2)) 1;
}
.section-heading { font-size: clamp(1.8em, 3.5vw, 2.4em); text-align: center; color: var(--title-color); }
.subtitle { color: var(--subtitle-color); font-size: 1.1em; margin: 0; line-height: 1.5; }
.tagline { color: var(--accent); font-size: 0.78em; letter-spacing: 0.18em; text-transform: uppercase; margin-top: 0.6em; font-weight: 600; }
.body-text { color: var(--body-color); font-size: 1em; line-height: 1.8; }

/* ── Accent Line (gradient) ── */
.accent-line { width: 100px; height: 4px; background: linear-gradient(90deg, var(--accent), var(--accent2)); margin: 0.5em auto; border-radius: 2px; }

/* ── Glass Card — gradient top border ── */
.glass-card {
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  backdrop-filter: blur(16px) saturate(180%);
  -webkit-backdrop-filter: blur(16px) saturate(180%);
  border-radius: 16px;
  padding: 1.2em;
  position: relative;
  overflow: hidden;
  transition: transform 0.3s cubic-bezier(0.22,1,0.36,1), box-shadow 0.3s ease;
  cursor: default;
}
.glass-card::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 3px;
  background: linear-gradient(90deg, var(--accent), var(--accent2));
}
.glass-card:hover {
  transform: translateY(-6px);
  box-shadow: 0 16px 40px rgba(0,0,0,${s.isDark ? '0.35' : '0.12'}), 0 0 0 1px ${s.accentColor}22;
}

/* ── Bullet Lists ── */
.bullet-list { list-style: none; padding: 0; margin: 0; width: 100%; color: var(--body-color); font-size: 1.05em; line-height: 1.9; }
.bullet-list.compact { font-size: 0.95em; }
.bullet-list li { display: flex; align-items: flex-start; gap: 0.7em; margin-bottom: 0.4em; padding: 0.5em 0.7em; border-radius: 10px; transition: background 0.2s, padding-left 0.2s; }
.bullet-list li:hover { background: ${s.isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)'}; padding-left: 1em; }
.bullet-icon { flex-shrink: 0; }
.bullet-sym { font-size: 1em; color: var(--accent); }

/* Card-style bullets */
.bullet-cards { display: flex; flex-direction: column; gap: 12px; width: 100%; }
.bullet-card { display: flex; align-items: center; gap: 16px; padding: 18px 24px; border-left: 4px solid; border-image: linear-gradient(180deg, var(--accent), var(--accent2)) 1; transition: transform 0.25s cubic-bezier(0.22,1,0.36,1), box-shadow 0.25s ease; }
.bullet-card:hover { transform: translateX(6px); box-shadow: 0 4px 20px ${s.isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.06)'}; }
.bullet-card-icon .material-symbols-outlined { font-size: 26px; color: var(--accent); }
.bullet-card-text { font-size: 1.1rem; color: var(--body-color); line-height: 1.5; }
ul, ol { overflow: hidden; }
li { word-wrap: break-word; overflow-wrap: break-word; }

/* ── Code ── */
.code-block { background: var(--code-bg); border-radius: 14px; padding: 1.5em 1.6em; text-align: left; overflow: auto; width: 100%; border: 1px solid var(--card-border); box-shadow: ${s.isDark ? '0 0 40px rgba(0,0,0,0.2)' : '0 4px 30px rgba(0,0,0,0.04)'}; }
.code-block code { color: var(--code-color); font-size: 0.85em; line-height: 1.7; white-space: pre-wrap; word-break: break-all; }

/* ── Images ── */
.slide-image { max-width: 90%; height: auto; object-fit: contain; border-radius: 16px; margin: 0 auto; display: block; box-shadow: 0 8px 30px rgba(0,0,0,${s.isDark ? '0.3' : '0.1'}); }

/* ── Two-Column ── */
.slide-columns { display: flex; gap: 1em; width: 100%; }
.slide-col { flex: 1; min-width: 0; }

/* ── Decorative SVG ── */
.deco-blob { top: -80px; right: -80px; opacity: 0.5; }
.deco-circles-pos { bottom: -60px; left: -60px; opacity: 0.4; }
.deco-wave { bottom: 0; left: 0; width: 100%; height: auto; opacity: 0.6; }

/* ── Hero ── */
.hero-content { text-align: center; z-index: 2; position: relative; }
.hero-title { font-size: clamp(2.2em, 5.5vw, 3.4em) !important; margin-bottom: 0.3em; text-shadow: 0 2px 30px rgba(0,0,0,0.4); color: #fff !important; }
.hero-subtitle { font-size: 0.9em; color: rgba(255,255,255,0.9); margin: 0.5em 0; text-shadow: 0 1px 10px rgba(0,0,0,0.3); }
.hero-tagline { font-size: 0.55em; color: var(--accent); letter-spacing: 0.2em; text-transform: uppercase; }
.hero-overlay { position: absolute; inset: 0; z-index: 1; background: linear-gradient(135deg, rgba(0,0,0,0.72) 0%, rgba(0,0,0,0.2) 50%, rgba(0,0,0,0.55) 100%); }

/* ── Stats — gradient icon bg + gradient value ── */
.stats-grid { display: flex; gap: 1.2em; justify-content: center; flex-wrap: nowrap; width: 100%; padding: 0.5em 0; }
.stats-card { flex: 1; min-width: 0; text-align: center; padding: 28px 20px; background: var(--stats-card-bg); display: flex; flex-direction: column; align-items: center; justify-content: center; }
.stats-card:hover { transform: translateY(-6px) scale(1.02); }
.stats-icon .material-symbols-outlined {
  font-size: 26px;
  color: #fff;
  width: 52px; height: 52px;
  line-height: 52px;
  text-align: center;
  border-radius: 14px;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  display: inline-block;
  margin-bottom: 10px;
  box-shadow: 0 4px 15px ${s.accentColor}30;
}
.stats-value {
  font-size: 44px;
  font-weight: 700;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  font-family: var(--font-heading);
  line-height: 1.2;
}
.stats-label { font-size: 13px; color: var(--body-color); margin-top: 6px; text-transform: uppercase; letter-spacing: 0.08em; }
.stats-trend { margin-top: 6px; }
.trend-icon { font-size: 22px; }
.trend-up .trend-icon { color: #48BB78; }
.trend-down .trend-icon { color: #FC8181; }

/* ── Icon Grid — gradient icon backgrounds ── */
.icon-grid { display: grid; gap: 1em; width: 100%; padding: 0.5em 0; }
.cols-1 { grid-template-columns: 1fr; }
.cols-2 { grid-template-columns: repeat(2, 1fr); }
.cols-3 { grid-template-columns: repeat(3, 1fr); }
.cols-4 { grid-template-columns: repeat(4, 1fr); }
.icon-card { text-align: left; padding: 1.6em 1.4em; }
.icon-card-icon .material-symbols-outlined {
  font-size: 30px;
  color: #fff;
  width: 58px; height: 58px;
  line-height: 58px;
  text-align: center;
  border-radius: 16px;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  display: inline-block;
  box-shadow: 0 4px 15px ${s.accentColor}25;
  transition: transform 0.3s cubic-bezier(0.22,1,0.36,1), box-shadow 0.3s ease;
}
.icon-card:hover .icon-card-icon .material-symbols-outlined {
  transform: scale(1.1) rotate(-3deg);
  box-shadow: 0 8px 25px ${s.accentColor}40;
}
.icon-card-img { width: 52px; height: 52px; border-radius: 14px; object-fit: cover; margin: 0 auto 0.4em; display: block; }
.icon-card-title { font-size: 1.1rem; color: var(--heading-color); margin: 0.5em 0 0.3em; font-weight: 700; }
.icon-card-desc { font-size: 0.95rem; color: var(--body-color); margin: 0; line-height: 1.55; opacity: 0.85; }

/* ── Timeline (horizontal) — enhanced with gradient line + card content ── */
.timeline { position: relative; width: 100%; margin-top: 1em; }
.tl-line { position: absolute; top: 22px; left: 5%; right: 5%; height: 4px; background: linear-gradient(90deg, var(--accent), var(--accent2)); opacity: 0.35; border-radius: 2px; }
.tl-items { display: flex; gap: 0.8em; width: 100%; position: relative; z-index: 1; }
.tl-item { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; text-align: center; transition: transform 0.3s; }
.tl-item:hover { transform: translateY(-4px); }
.tl-dot { width: 46px; height: 46px; border-radius: 50%; background: linear-gradient(135deg, var(--accent), var(--accent2)); display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-bottom: 0.7em; box-shadow: 0 0 0 5px ${isGrad ? 'rgba(255,255,255,0.2)' : s.bg}, 0 0 0 7px var(--accent), 0 6px 20px ${s.accentColor}30; transition: transform 0.3s, box-shadow 0.3s; }
.tl-item:hover .tl-dot { transform: scale(1.15); box-shadow: 0 0 0 5px ${isGrad ? 'rgba(255,255,255,0.2)' : s.bg}, 0 0 0 7px var(--accent), 0 10px 30px ${s.accentColor}50; }
.tl-num { font-size: 14px; font-weight: 700; color: #fff; }
.tl-icon { font-size: 22px; color: #fff; }
.tl-content { flex: 1; min-width: 0; background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 12px; padding: 0.7em 0.6em; margin-top: 0.2em; }
.tl-date { font-size: 11px; color: var(--accent); font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; display: block; margin-bottom: 0.15em; }
.tl-title { font-size: 14px; font-weight: 700; color: var(--heading-color); margin: 0.1em 0; }
.tl-desc { font-size: 12px; color: var(--body-color); margin: 0.1em 0 0; line-height: 1.4; }

/* ── Quote — card bg with gradient left accent ── */
.quote-block {
  text-align: center;
  max-width: 82%;
  margin: 0 auto;
  padding: 2.5em 2.5em;
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: 24px;
  position: relative;
  overflow: hidden;
}
.quote-block::before {
  content: '';
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 5px;
  background: linear-gradient(to bottom, var(--accent), var(--accent2));
  border-radius: 24px 0 0 24px;
}
.quote-mark {
  font-size: 5.5em;
  line-height: 0.5;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  font-family: Georgia, serif;
  user-select: none;
}
.quote-text { font-size: 1.05em; color: var(--heading-color); font-style: italic; line-height: 1.7; margin: 0.5em 0 0.8em; border: none; padding: 0; }
.quote-author { font-size: 0.65em; color: var(--accent); font-style: normal; font-weight: 600; letter-spacing: 0.05em; }

/* ── ECharts ── */
.echart-container { width: 100%; height: 420px; max-width: 100%; margin: 0 auto; }
.echart-compact { height: 360px; }

/* ── Image + Text ── */
.image-text-layout { display: flex; gap: 0; align-items: stretch; width: 100%; flex: 1; min-height: 0; }
.image-text-layout.img-right { flex-direction: row-reverse; }
.it-image { flex: 3; min-width: 0; align-self: stretch; }
.it-image img { width: 100%; height: 100%; object-fit: cover; border-radius: 0; box-shadow: none; }
.it-text { flex: 5; min-width: 0; padding: 56px 48px; display: flex; flex-direction: column; justify-content: center; }

/* Side image layout — 1/3 image + 2/3 content for any slide type */
.side-image-layout { display: grid; grid-template-columns: 1fr 40%; gap: 32px; width: 100%; align-items: stretch; }
.side-image-layout.img-left { grid-template-columns: 40% 1fr; }
.side-image-panel { align-self: stretch; }
.side-image-panel img { width: 100%; height: 100%; object-fit: cover; border-radius: 0; }
.side-content-panel { min-width: 0; display: flex; flex-direction: column; justify-content: center; }
/* Flush images against card edges */
.side-image-layout:not(.img-left) .side-image-panel { margin: -56px -56px -56px 0; }
.side-image-layout.img-left .side-image-panel { margin: -56px 0 -56px -56px; }

/* ── Profile — gradient avatar ring + pill links ── */
.profile-layout { text-align: center; display: flex; flex-direction: column; align-items: center; gap: 0.4em; }
.profile-avatar-wrap {
  width: 150px; height: 150px;
  border-radius: 50%;
  overflow: hidden;
  padding: 4px;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  box-shadow: 0 8px 30px ${s.accentColor}30;
}
.profile-avatar { width: 100%; height: 100%; object-fit: cover; border-radius: 50%; }
.profile-name { font-size: 1.8em; font-family: var(--font-heading); color: var(--heading-color); margin: 0.2em 0 0; }
.profile-role { font-size: 0.7em; color: var(--accent); font-weight: 600; text-transform: uppercase; letter-spacing: 0.12em; margin: 0; }
.profile-bio { font-size: 0.6em; color: var(--body-color); max-width: 600px; line-height: 1.7; margin: 0.4em 0; }
.profile-social { display: flex; gap: 1em; justify-content: center; margin-top: 0.6em; }
.profile-link {
  display: flex; align-items: center; gap: 0.3em;
  font-size: 0.55em; color: var(--body-color);
  padding: 0.35em 0.9em;
  background: var(--card-bg); border: 1px solid var(--card-border);
  border-radius: 20px;
  transition: border-color 0.2s, transform 0.2s;
}
.profile-link:hover { border-color: var(--accent); transform: translateY(-2px); }
.profile-link-icon { font-size: 18px !important; color: var(--icon-color); }

/* ── Process — large circles + card descriptions ── */
.process-steps { display: flex; align-items: flex-start; justify-content: center; gap: 0; width: 100%; position: relative; padding-top: 1.5em; }
.process-connector { position: absolute; top: calc(1.5em + 32px); left: 12%; right: 12%; height: 4px; background: linear-gradient(90deg, var(--accent), var(--accent2)); opacity: 0.4; border-radius: 2px; }
.process-step { flex: 1; display: flex; flex-direction: column; align-items: center; text-align: center; position: relative; z-index: 1; }
.process-step-circle { width: 64px; height: 64px; border-radius: 50%; background: linear-gradient(135deg, var(--accent), var(--accent2)); display: flex; align-items: center; justify-content: center; margin-bottom: 0.8em; box-shadow: 0 6px 25px ${s.accentColor}35; transition: transform 0.3s, box-shadow 0.3s; }
.process-step:hover .process-step-circle { transform: scale(1.12); box-shadow: 0 8px 35px ${s.accentColor}50; }
.process-icon { font-size: 28px !important; color: #fff; }
.process-num { font-size: 20px; font-weight: 700; color: #fff; }
.process-step-label { font-size: 0.95em; font-weight: 700; color: var(--heading-color); margin-bottom: 0.2em; }
.process-step-desc { font-size: 0.72em; color: var(--body-color); margin: 0; max-width: 180px; line-height: 1.5; background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 10px; padding: 0.5em 0.8em; }

/* ── Gallery — rounded with shadows ── */
.gallery { display: grid; gap: 0.8em; width: 100%; }
.gallery-2x2 { grid-template-columns: 1fr 1fr; }
.gallery-3-col { grid-template-columns: 1fr 1fr 1fr; }
.gallery-1-hero-2-small { grid-template-columns: 2fr 1fr; grid-template-rows: 1fr 1fr; }
.gallery-1-hero-2-small .gallery-item:first-child { grid-row: 1 / 3; }
.gallery-item { overflow: hidden; border-radius: 16px; position: relative; margin: 0; box-shadow: 0 4px 20px rgba(0,0,0,${s.isDark ? '0.25' : '0.08'}); }
.gallery-item img { width: 100%; height: 100%; object-fit: cover; max-height: 280px; display: block; transition: transform 0.4s cubic-bezier(0.22,1,0.36,1); }
.gallery-item:hover img { transform: scale(1.06); }
.gallery-item figcaption { position: absolute; bottom: 0; left: 0; right: 0; padding: 0.6em 1em; background: linear-gradient(transparent, rgba(0,0,0,0.75)); color: #fff; font-size: 0.55em; font-weight: 500; }

/* ── Team — gradient photo ring ── */
.team-grid { display: flex; gap: 1.5em; justify-content: center; flex-wrap: nowrap; padding: 0.5em 0; }
.team-card { flex: 1; min-width: 0; text-align: center; padding: 1.8em 1.2em; max-width: 260px; }
.team-photo {
  width: 100px; height: 100px;
  border-radius: 50%;
  object-fit: cover;
  padding: 3px;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  margin: 0 auto 0.8em;
  display: block;
  box-shadow: 0 4px 20px ${s.accentColor}25;
  transition: transform 0.3s, box-shadow 0.3s;
}
.team-card:hover .team-photo { transform: scale(1.08); box-shadow: 0 8px 30px ${s.accentColor}40; }
.team-photo-placeholder { width: 100px; height: 100px; border-radius: 50%; background: linear-gradient(135deg, var(--accent), var(--accent2)); display: flex; align-items: center; justify-content: center; margin: 0 auto 0.8em; }
.team-photo-placeholder .material-symbols-outlined { font-size: 40px; color: #fff; }
.team-name { font-size: 0.85em; font-weight: 700; color: var(--heading-color); }
.team-role { font-size: 0.6em; color: var(--accent); font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; margin-top: 0.15em; }
.team-desc { font-size: 0.55em; color: var(--body-color); margin-top: 0.35em; line-height: 1.5; }

/* ── Table — modern with gradient header + hover ── */
.table-wrap { width: 100%; overflow: hidden; border-radius: 16px; border: 1px solid var(--card-border); box-shadow: 0 4px 20px rgba(0,0,0,${s.isDark ? '0.2' : '0.06'}); }
.slide-table { width: 100%; border-collapse: collapse; font-size: 0.6em; }
.slide-table th, .slide-table td { padding: 0.85em 1.2em; text-align: left; border-bottom: 1px solid var(--card-border); color: var(--body-color); transition: background 0.2s; }
.slide-table th { font-weight: 700; color: var(--heading-color); background: var(--card-bg); }
.table-header-highlighted th { background: linear-gradient(135deg, var(--accent), var(--accent2)); color: #fff; }
.slide-table tbody tr:nth-child(even) { background: var(--card-bg); }
.slide-table tbody tr:hover { background: ${hoverBg}; }

/* ── Dashboard — compact KPI + chart ── */
.dashboard-kpis { display: flex; gap: 1em; margin-bottom: 1em; }
.dashboard-kpi-card { padding: 18px 14px; }
.dashboard-kpi-card .stats-value { font-size: 28px; }
.dashboard-kpi-card .stats-label { font-size: 11px; }
.dashboard-kpi-card .stats-icon .material-symbols-outlined { font-size: 22px; width: 40px; height: 40px; line-height: 40px; border-radius: 10px; margin-bottom: 6px; }
.dashboard-chart { width: 100%; }

/* ── Diagram (Mermaid) ── */
.diagram-container { display: flex; justify-content: center; align-items: center; width: 100%; min-height: 400px; overflow: auto; }
.diagram-container .mermaid { font-size: 16px; }
.diagram-container svg { width: 100%; min-height: 360px; height: auto; }

/* ── Mindmap (Markmap) ── */
.mindmap-wrapper { width: 100%; display: flex; flex-direction: column; border-radius: 16px; overflow: hidden; border: 1px solid var(--card-border); background: ${s.isDark ? '#1a1a2e' : 'var(--card-bg)'}; }
.mindmap-container { width: 100%; height: 520px; display: flex; justify-content: center; position: relative; }
.mindmap-svg { width: 100%; height: 100%; }
.mindmap-svg foreignObject > div { color: ${s.isDark ? '#e0e0f0' : '#333'} !important; }
.mindmap-svg foreignObject div, .mindmap-svg foreignObject span { color: ${s.isDark ? '#e0e0f0' : '#333'} !important; }
${s.isDark ? `.mindmap-svg > g > rect, .mindmap-svg > rect { fill: transparent !important; }` : ''}
.mindmap-toolbar { display: flex; align-items: center; gap: 6px; padding: 8px 12px; border-top: 1px solid var(--card-border); background: var(--card-bg); }
.mindmap-toolbar button { display: inline-flex; align-items: center; gap: 4px; padding: 5px 12px; font-size: 12px; font-weight: 600; color: var(--accent); background: transparent; border: 1px solid var(--card-border); border-radius: 8px; cursor: pointer; transition: background 0.2s, border-color 0.2s; }
.mindmap-toolbar button:hover { background: ${s.isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.04)'}; border-color: var(--accent); }
.mindmap-toolbar button .material-symbols-outlined { font-size: 16px; }
.mindmap-hint { display: flex; align-items: center; gap: 4px; margin-left: auto; font-size: 11px; color: var(--subtitle-color); opacity: 0.7; }
.mindmap-hint .material-symbols-outlined { font-size: 13px; }

/* ── Compound Layout System (no fixed height — content flows naturally) ── */
.slide-layout { display: grid; gap: 40px; width: 100%; align-items: center; }
.slide-layout.split-left { grid-template-columns: 38% 1fr; }
.slide-layout.split-right { grid-template-columns: 1fr 38%; }
.slide--title .slide-layout.split-right { grid-template-columns: 1fr 35%; }
.slide-layout.top-bottom { grid-template-columns: 1fr; }

/* Text block — left accent border */
.layout-text {
  display: flex; flex-direction: column; gap: 20px; justify-content: center; min-width: 0;
  padding-left: 28px;
  border-left: 3px solid transparent;
  border-image: linear-gradient(180deg, ${s.accentColor}, ${s.accentColor2 || s.accentColor}) 1;
}
.layout-visual { min-width: 0; display: flex; align-items: center; justify-content: center; }

/* Description */
.compound-description {
  font-size: 1em; line-height: 1.8; color: var(--body-color); margin: 0;
  font-weight: 300; letter-spacing: 0.01em;
  font-family: var(--font-heading), serif;
}

/* Highlights — pill cards */
.compound-highlights { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 12px; }
.compound-highlights li {
  display: flex; align-items: center; gap: 12px; font-size: 0.9em; color: var(--body-color);
  line-height: 1.5; padding: 12px 18px;
  background: ${s.isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)'};
  border: 1px solid ${s.isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'};
  border-radius: 12px; transition: transform 0.2s, border-color 0.2s, background 0.2s;
  font-weight: 500; letter-spacing: 0.02em;
}
.compound-highlights li:hover { transform: translateX(6px); border-color: var(--accent); background: ${s.isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.03)'}; }
.highlight-icon { font-size: 20px !important; color: var(--accent); flex-shrink: 0; }
.compound-side-image {
  width: 100%; max-height: 180px; object-fit: cover; border-radius: 14px; margin-top: 4px;
  box-shadow: 0 4px 20px ${s.isDark ? 'rgba(0,0,0,0.3)' : 'rgba(0,0,0,0.08)'};
}

/* Title slide with side image */
.title-text-block { display: flex; flex-direction: column; justify-content: center; gap: 16px; border-left: none; padding-left: 0; }
.title-text-block .accent-line { margin: 0.3em 0 !important; }
.title-side-image { min-height: 400px; overflow: hidden; border-radius: 24px; }
.title-side-image img { width: 100%; height: 100%; min-height: 400px; object-fit: cover; border-radius: 24px; }

/* Compound-mode chart/diagram sizing */
.slide-layout .echart-container { height: 380px; max-width: 100%; }
.slide-layout.top-bottom .echart-container { height: 320px; }
.slide-layout .diagram-container { min-height: 340px; }
.slide-layout .diagram-container svg { min-height: 300px; }
.slide-layout .mindmap-container { height: 400px; }
.slide-layout.top-bottom .mindmap-container { height: 360px; }

/* Compound-mode: process vertical in split — horizontal items + vertical connector */
.slide-layout.split-left .process-steps,
.slide-layout.split-right .process-steps { flex-direction: column; align-items: stretch; gap: 1em; padding-top: 0; padding-left: 0; position: relative; }
.slide-layout.split-left .process-connector,
.slide-layout.split-right .process-connector { top: 0; bottom: 0; left: 23px; right: auto; width: 3px; height: auto; }
.slide-layout.split-left .process-step,
.slide-layout.split-right .process-step { flex-direction: row; text-align: left; align-items: center; gap: 16px; }
.slide-layout.split-left .process-step-circle,
.slide-layout.split-right .process-step-circle { width: 48px; height: 48px; margin-bottom: 0; flex-shrink: 0; }
.slide-layout.split-left .process-icon,
.slide-layout.split-right .process-icon { font-size: 22px !important; }
.slide-layout.split-left .process-step-label,
.slide-layout.split-right .process-step-label { font-size: 1em; }
.slide-layout.split-left .process-step-desc,
.slide-layout.split-right .process-step-desc { max-width: none; font-size: 0.8em; padding: 0.6em 1em; }

/* Compound-mode: timeline vertical in split — horizontal items + vertical line */
.slide-layout.split-left .timeline .tl-items,
.slide-layout.split-right .timeline .tl-items { flex-direction: column; gap: 0.6em; }
.slide-layout.split-left .timeline .tl-line,
.slide-layout.split-right .timeline .tl-line { top: 0; bottom: 0; left: 20px; right: auto; width: 3px; height: auto; background: linear-gradient(180deg, var(--accent), var(--accent2)); }
.slide-layout.split-left .timeline .tl-item,
.slide-layout.split-right .timeline .tl-item { flex-direction: row; text-align: left; align-items: center; gap: 16px; }
.slide-layout.split-left .timeline .tl-dot,
.slide-layout.split-right .timeline .tl-dot { width: 40px; height: 40px; margin-bottom: 0; flex-shrink: 0; }
.slide-layout.split-left .timeline .tl-content,
.slide-layout.split-right .timeline .tl-content { margin-top: 0; padding: 0.8em 1em; }
.slide-layout.split-left .timeline .tl-title,
.slide-layout.split-right .timeline .tl-title { font-size: 16px; }
.slide-layout.split-left .timeline .tl-desc,
.slide-layout.split-right .timeline .tl-desc { font-size: 13px; }
.slide-layout.split-left .timeline .tl-date,
.slide-layout.split-right .timeline .tl-date { font-size: 12px; }

/* Compound-mode stats in split — 2×2 grid */
.slide-layout.split-left .stats-grid,
.slide-layout.split-right .stats-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.8em; }
.slide-layout.split-left .stats-card,
.slide-layout.split-right .stats-card { padding: 18px 14px; }
.slide-layout.split-left .stats-value,
.slide-layout.split-right .stats-value { font-size: 32px; }

/* Compound-mode icon-grid in split — 2-col */
.slide-layout.split-left .icon-grid,
.slide-layout.split-right .icon-grid { grid-template-columns: repeat(2, 1fr) !important; }

/* Compound-mode gallery in split */
.slide-layout.split-left .gallery,
.slide-layout.split-right .gallery { grid-template-columns: 1fr 1fr !important; grid-template-rows: auto !important; }

/* Side-image-layout — constrained grids (same as compound split) */
.side-image-layout .stats-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.8em; }
.side-image-layout .stats-card { padding: 18px 14px; }
.side-image-layout .stats-value { font-size: 32px; }
.side-image-layout .icon-grid { grid-template-columns: repeat(2, 1fr) !important; }
.side-image-layout .process-steps { flex-direction: column; align-items: stretch; gap: 1em; padding-top: 0; padding-left: 0; position: relative; }
.side-image-layout .process-connector { top: 0; bottom: 0; left: 23px; right: auto; width: 3px; height: auto; }
.side-image-layout .process-step { flex-direction: row; text-align: left; align-items: center; gap: 16px; }
.side-image-layout .process-step-circle { width: 48px; height: 48px; margin-bottom: 0; flex-shrink: 0; }

/* ── RWD ── */
@media (max-width: 768px) {
  .slide-inner { padding: 32px 24px; margin: 20px auto; min-height: calc(100vh - 40px); border-radius: 16px; }
  .slide--hero .slide-inner { margin: 0; padding: 40px 24px; min-height: 100vh; border-radius: 0; }
  h1 { font-size: 1.8em; }
  .slide--image-text .slide-inner { padding: 24px; }
  .slide-columns, .image-text-layout, .image-text-layout.img-right { flex-direction: column; }
  .side-image-layout, .side-image-layout.img-left { grid-template-columns: 1fr; }
  /* Reset flush margins on mobile */
  .side-image-layout:not(.img-left) .side-image-panel,
  .side-image-layout.img-left .side-image-panel { margin: 0; }
  .side-image-panel img, .it-image img { border-radius: 16px; height: auto; max-height: 300px; object-fit: contain; }
  .it-text { padding: 24px 0; }
  .stats-grid, .dashboard-kpis { flex-direction: column; align-items: center; }
  .icon-grid { grid-template-columns: repeat(2, 1fr) !important; }
  .tl-items { flex-direction: column; }
  .tl-line { display: none; }
  .process-steps { flex-direction: column; align-items: center; }
  .process-connector { display: none; }
  .gallery { grid-template-columns: 1fr !important; grid-template-rows: auto !important; }
  .gallery-1-hero-2-small .gallery-item:first-child { grid-row: auto; }
  .team-grid { flex-direction: column; align-items: center; }
  .echart-container { height: 280px; }
  .slide-layout.split-left, .slide-layout.split-right { grid-template-columns: 1fr; }
  .title-side-image { min-height: 250px; }
  .slides-container { scroll-snap-type: y proximity; }
  .slide-nav { display: none; }
}

/* ── Print ── */
@media print {
  .slides-container { scroll-snap-type: none; height: auto; overflow: visible; }
  .slide { min-height: auto; page-break-after: always; scroll-snap-align: none; }
  .slide-nav, .nav-progress, .slide-counter, .fullscreen-btn { display: none; }
}

@media (prefers-reduced-motion: reduce) {
  .animate-on-scroll { transition: none; opacity: 1; transform: none; }
  .slides-container { scroll-behavior: auto; }
  html { scroll-behavior: auto; }
}

${s.extra || ''}
`;
}

// ── HTML Generator ─────────────────────────────────────────────

function generateHtml(input: SlidesInput): string {
  const s = STYLES[input.style || ''] || DEFAULT_STYLE;

  // Reset CDN flags
  echartsUsed = false;
  mermaidUsed = false;
  markmapUsed = false;
  echartsConfigs.length = 0;
  mindmapConfigs.length = 0;
  mermaidConfigs.length = 0;

  const slides = input.slides.map((slide, i) => renderSlide(slide, s, i)).join('\n');

  // Build conditional CDN scripts
  const cdnScripts: string[] = [];
  if (echartsUsed) {
    cdnScripts.push(`<script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"><\/script>`);
  }
  if (mermaidUsed) {
    cdnScripts.push(`<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"><\/script>`);
  }
  if (markmapUsed) {
    cdnScripts.push(`<script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"><\/script>`);
    cdnScripts.push(`<script src="https://cdn.jsdelivr.net/npm/markmap-lib/dist/browser/index.iife.js"><\/script>`);
    cdnScripts.push(`<script src="https://cdn.jsdelivr.net/npm/markmap-view/dist/browser/index.js"><\/script>`);
  }

  // Build ECharts init code — IntersectionObserver-based lazy loading
  let echartsInitCode = '';
  if (echartsUsed && echartsConfigs.length > 0) {
    const configs = echartsConfigs.map(c =>
      `{ id: '${c.id}', option: ${JSON.stringify(c.option)} }`
    ).join(',\n      ');
    // Map GeoJSON URLs
    const mapUrls: Record<string, string> = {
      world: 'https://cdn.jsdelivr.net/npm/echarts@4.9.0/map/json/world.json',
      china: 'https://cdn.jsdelivr.net/npm/echarts@4.9.0/map/json/china.json',
    };
    const mapLoadCode = echartsMapTypes.size > 0 ? `
    var mapUrls = ${JSON.stringify(Object.fromEntries([...echartsMapTypes].map(m => [m, mapUrls[m] || mapUrls.world])))};
    function loadMaps(cb) {
      var keys = Object.keys(mapUrls);
      var loaded = 0;
      if (keys.length === 0) return cb();
      keys.forEach(function(name) {
        fetch(mapUrls[name]).then(function(r) { return r.json(); }).then(function(geo) {
          echarts.registerMap(name, geo);
          loaded++;
          if (loaded === keys.length) cb();
        }).catch(function() { loaded++; if (loaded === keys.length) cb(); });
      });
    }` : `
    function loadMaps(cb) { cb(); }`;

    echartsInitCode = `
  <script>
  (function() {
    var configs = [
      ${configs}
    ];
    var instances = {};
    ${mapLoadCode}
    function initChart(cfg) {
      var el = document.getElementById(cfg.id);
      if (!el || instances[cfg.id]) return;
      var chart = echarts.init(el, ${s.isDark ? "'dark'" : 'null'}, { renderer: 'canvas' });
      chart.setOption(cfg.option);
      instances[cfg.id] = chart;
      setTimeout(function() { chart.resize(); }, 100);
    }
    // Init charts — load maps first, then use IntersectionObserver
    function setupCharts() {
      var sc = document.querySelector('.slides-container');
      var obs = new IntersectionObserver(function(entries) {
        entries.forEach(function(entry) {
          if (entry.isIntersecting) {
            configs.forEach(function(cfg) {
              if (entry.target.querySelector('#' + cfg.id)) initChart(cfg);
            });
          }
        });
      }, { root: sc, threshold: 0.1 });
      document.querySelectorAll('.slide').forEach(function(s) { obs.observe(s); });
      // Fallback: init all charts
      configs.forEach(initChart);
    }
    window.addEventListener('load', function() { loadMaps(setupCharts); });
    // ResizeObserver for responsive charts
    var resizer = new ResizeObserver(function(entries) {
      entries.forEach(function(e) { if (instances[e.target.id]) instances[e.target.id].resize(); });
    });
    configs.forEach(function(cfg) { var el = document.getElementById(cfg.id); if (el) resizer.observe(el); });
    window.addEventListener('resize', function() { Object.keys(instances).forEach(function(k) { instances[k].resize(); }); });
  })();
  <\/script>`;
  }

  // Build Mermaid init code — render on page load
  let mermaidInitCode = '';
  if (mermaidUsed && mermaidConfigs.length > 0) {
    const mermaidCfgs = mermaidConfigs.map(c =>
      `{ id: '${c.id}', code: ${JSON.stringify(c.code)} }`
    ).join(',\n      ');
    mermaidInitCode = `
  <script>
  (function() {
    var configs = [
      ${mermaidCfgs}
    ];
    mermaid.initialize({ startOnLoad: false, theme: '${s.isDark ? 'dark' : 'default'}', themeVariables: { primaryColor: '${s.accentColor}', primaryTextColor: '${s.headingColor}', lineColor: '${s.bodyColor}' } });
    function renderAll() {
      configs.forEach(function(cfg, i) {
        var el = document.getElementById(cfg.id);
        if (!el || el.getAttribute('data-rendered')) return;
        var svgId = 'mermaid-svg-' + i + '-' + Date.now();
        mermaid.render(svgId, cfg.code).then(function(result) {
          el.innerHTML = result.svg;
          el.setAttribute('data-rendered', 'true');
          el.classList.remove('mermaid');
          // Make SVG fill container properly
          var svg = el.querySelector('svg');
          if (svg) { svg.style.width = '100%'; svg.style.minHeight = '360px'; svg.style.height = 'auto'; svg.removeAttribute('height'); }
        }).catch(function(e) { console.warn('Mermaid render error for ' + cfg.id + ':', e); });
      });
    }
    // Render all diagrams on page load
    if (document.readyState === 'complete') renderAll();
    else window.addEventListener('load', renderAll);
  })();
  <\/script>`;
  }

  // Build Markmap init code — IntersectionObserver-based + interactive controls
  let markmapInitCode = '';
  if (markmapUsed && mindmapConfigs.length > 0) {
    const mmConfigs = mindmapConfigs.map(c =>
      `{ id: '${c.id}', code: ${JSON.stringify(c.code)} }`
    ).join(',\n      ');
    markmapInitCode = `
  <script>
  (function() {
    var configs = [
      ${mmConfigs}
    ];
    var transformer = new markmap.Transformer();

    // Tree manipulation helpers
    function foldTree(node, depth, maxLevel) {
      if (depth >= maxLevel && node.children && node.children.length) {
        node.payload = Object.assign({}, node.payload, { fold: 1 });
      }
      if (node.children) node.children.forEach(function(c) { foldTree(c, depth + 1, maxLevel); });
    }
    function unfoldAll(node) {
      if (node.payload && node.payload.fold) {
        node.payload = Object.assign({}, node.payload, { fold: 0 });
      }
      if (node.children) node.children.forEach(unfoldAll);
    }

    function initMindmap(cfg) {
      var el = document.getElementById(cfg.id);
      if (!el || el.getAttribute('data-rendered')) return;
      el.setAttribute('data-rendered', 'true');
      var result = transformer.transform(cfg.code);
      // Start collapsed at depth 1 — user expands manually
      foldTree(result.root, 0, 1);
      var mm = markmap.Markmap.create(el, {
        autoFit: false,
        duration: 300,
        color: function(node) {
          var colors = ${JSON.stringify(s.chartColors)};
          return colors[(node.state ? node.state.id : 0) % colors.length];
        },
        paddingX: 16,
      }, result.root);
      el.__markmap = mm;
      mm.fit();
      ${s.isDark ? `// Inject dark-theme styles into the SVG AFTER markmap renders
      var svgStyle = document.createElementNS('http://www.w3.org/2000/svg', 'style');
      svgStyle.textContent = 'foreignObject div, foreignObject span { color: #e0e0f0 !important; } text { fill: #e0e0f0 !important; }';
      el.insertBefore(svgStyle, el.firstChild);` : ''}
      // Click handler: toggle node + pan to show children
      mm.handleClick = function(e, d) {
        var wasFolded = d.payload && d.payload.fold;
        var recursive = (navigator.platform.startsWith('Mac') ? e.metaKey : e.ctrlKey) && mm.options.toggleRecursively;
        mm.toggleNode(d, recursive).then(function() {
          if (wasFolded && d.children && d.children.length) {
            var vw = mm.svg.node().getBoundingClientRect().width;
            var ratio = vw < 768 ? 0.85 : 0.5;
            mm.centerNode(d, { right: vw * ratio });
          } else {
            mm.centerNode(d);
          }
        });
      };
    }

    // Global toolbar functions
    window.mmExpandAll = function(id) {
      var el = document.getElementById(id);
      if (!el || !el.__markmap) return;
      var mm = el.__markmap;
      unfoldAll(mm.state.data);
      mm.renderData().then(function() { mm.fit(); });
    };
    window.mmCollapseAll = function(id) {
      var el = document.getElementById(id);
      if (!el || !el.__markmap) return;
      var mm = el.__markmap;
      foldTree(mm.state.data, 0, 1);
      mm.renderData().then(function() { mm.fit(); });
    };
    window.mmFitView = function(id) {
      var el = document.getElementById(id);
      if (el && el.__markmap) el.__markmap.fit();
    };

    // Lazy-init mindmaps — use scrollable container as root
    var sc = document.querySelector('.slides-container');
    var obs = new IntersectionObserver(function(entries) {
      entries.forEach(function(entry) {
        if (entry.isIntersecting) {
          configs.forEach(function(cfg) {
            if (entry.target.querySelector('#' + cfg.id)) {
              initMindmap(cfg);
              var el = document.getElementById(cfg.id);
              if (el && el.__markmap) setTimeout(function() { el.__markmap.fit(); }, 200);
            }
          });
        }
      });
    }, { root: sc, threshold: 0.1 });
    document.querySelectorAll('.slide').forEach(function(s) { obs.observe(s); });
    // Fallback: init on page load
    window.addEventListener('load', function() { configs.forEach(initMindmap); });
  })();
  <\/script>`;
  }

  // Stats count-up animation — IntersectionObserver-based
  const hasStats = input.slides.some(sl => sl.type === 'stats' || sl.type === 'dashboard');
  const statsScript = hasStats ? `
  <script>
  (function() {
    function animateNumbers(section) {
      section.querySelectorAll('.stats-value').forEach(function(el) {
        if (el.getAttribute('data-animated')) return;
        el.setAttribute('data-animated', 'true');
        var text = el.textContent || '';
        var match = text.match(/([\\d,.]+)/);
        if (!match) return;
        var target = parseFloat(match[1].replace(/,/g, ''));
        if (isNaN(target)) return;
        var prefix = text.substring(0, text.indexOf(match[1]));
        var suffix = text.substring(text.indexOf(match[1]) + match[1].length);
        var duration = 800, start = performance.now();
        function tick(now) {
          var p = Math.min((now - start) / duration, 1);
          p = 1 - Math.pow(1 - p, 3);
          var current = Math.round(target * p);
          el.textContent = prefix + current.toLocaleString() + suffix;
          if (p < 1) requestAnimationFrame(tick);
          else el.textContent = text;
        }
        el.textContent = prefix + '0' + suffix;
        requestAnimationFrame(tick);
      });
    }
    var sc = document.querySelector('.slides-container');
    var obs = new IntersectionObserver(function(entries) {
      entries.forEach(function(entry) {
        if (entry.isIntersecting && (entry.target.querySelector('.stats-grid') || entry.target.querySelector('.dashboard-kpis'))) {
          animateNumbers(entry.target);
        }
      });
    }, { root: sc, threshold: 0.3 });
    document.querySelectorAll('.slide').forEach(function(s) { obs.observe(s); });
  })();
  <\/script>` : '';

  // Total slide count for navigation
  const totalSlides = input.slides.length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="author" content="${escapeHtml(input.author || 'AI Agents Office')}">
  <title>${escapeHtml(input.title)}</title>
  <!-- Google Fonts -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="${s.googleFontsUrl}" rel="stylesheet">
  <!-- Material Symbols -->
  <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0,0" rel="stylesheet">
  <!-- Syntax Highlighting -->
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11/styles/atom-one-${s.isDark ? 'dark' : 'light'}.min.css">
  <style>${generateCSS(s)}</style>
</head>
<body>
  <div class="presentation">
    <!-- Navigation overlay -->
    <div class="nav-progress"></div>
    <nav class="slide-nav" aria-label="Slide navigation"></nav>
    <div class="slide-counter"><span class="current-slide">1</span> / <span class="total-slides">${totalSlides}</span></div>
    <button class="fullscreen-btn" aria-label="Toggle fullscreen">
      <span class="material-symbols-outlined">fullscreen</span>
    </button>

    <!-- Scroll-snap container -->
    <main class="slides-container">
      ${slides}
    </main>
  </div>

  <!-- Syntax highlighting -->
  <script src="https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11/highlight.min.js"><\/script>
  ${cdnScripts.join('\n  ')}

  <!-- Navigation controller -->
  <script>
  (function() {
    var container = document.querySelector('.slides-container');
    var allSlides = Array.from(document.querySelectorAll('.slide'));
    var nav = document.querySelector('.slide-nav');
    var progress = document.querySelector('.nav-progress');
    var counterCurrent = document.querySelector('.current-slide');
    var currentIndex = 0;

    // Create nav dots
    allSlides.forEach(function(_, i) {
      var dot = document.createElement('button');
      dot.className = 'nav-dot' + (i === 0 ? ' active' : '');
      dot.setAttribute('aria-label', 'Go to slide ' + (i + 1));
      dot.addEventListener('click', function() { scrollToSlide(i); });
      nav.appendChild(dot);
    });

    function scrollToSlide(index) {
      index = Math.max(0, Math.min(index, allSlides.length - 1));
      allSlides[index].scrollIntoView({ behavior: 'smooth' });
    }

    function updateNav(idx) {
      var dots = nav.querySelectorAll('.nav-dot');
      dots.forEach(function(d, i) { d.classList.toggle('active', i === idx); });
      progress.style.transform = 'scaleX(' + ((idx + 1) / allSlides.length) + ')';
      counterCurrent.textContent = idx + 1;
    }

    // Track current slide via IntersectionObserver
    var slideObs = new IntersectionObserver(function(entries) {
      entries.forEach(function(entry) {
        if (entry.isIntersecting && entry.intersectionRatio > 0.4) {
          var idx = allSlides.indexOf(entry.target);
          if (idx !== -1 && idx !== currentIndex) {
            currentIndex = idx;
            updateNav(idx);
            history.replaceState(null, '', '#slide-' + idx);
          }
        }
      });
    }, { root: container, threshold: 0.4 });
    allSlides.forEach(function(s) { slideObs.observe(s); });

    // Keyboard navigation
    document.addEventListener('keydown', function(e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') {
        e.preventDefault(); scrollToSlide(currentIndex + 1);
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault(); scrollToSlide(currentIndex - 1);
      } else if (e.key === 'Home') {
        e.preventDefault(); scrollToSlide(0);
      } else if (e.key === 'End') {
        e.preventDefault(); scrollToSlide(allSlides.length - 1);
      }
    });

    // Fullscreen toggle
    document.querySelector('.fullscreen-btn').addEventListener('click', function() {
      if (!document.fullscreenElement) document.documentElement.requestFullscreen();
      else document.exitFullscreen();
    });

    // Hash-based deep linking
    var hash = window.location.hash;
    if (hash && hash.startsWith('#slide-')) {
      var el = document.querySelector(hash);
      if (el) setTimeout(function() { el.scrollIntoView(); }, 100);
    }
  })();
  <\/script>

  <!-- Scroll-triggered animations -->
  <script>
  (function() {
    var sc = document.querySelector('.slides-container');
    var obs = new IntersectionObserver(function(entries) {
      entries.forEach(function(entry) {
        if (entry.isIntersecting) entry.target.classList.add('is-visible');
      });
    }, { root: sc, threshold: 0.15 });
    document.querySelectorAll('.animate-on-scroll').forEach(function(el) { obs.observe(el); });
  })();
  <\/script>

  <!-- Syntax highlighting init -->
  <script>hljs.highlightAll();<\/script>

  ${echartsInitCode}
  ${mermaidInitCode}
  ${markmapInitCode}
  ${statsScript}
</body>
</html>`;
}

// ── CLI Entry ──────────────────────────────────────────────────
const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  console.error('Usage: generate-slides.ts <input.json> <output.html>');
  process.exit(1);
}

try {
  const input: SlidesInput = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
  const html = generateHtml(input);
  fs.writeFileSync(outputPath, html, 'utf-8');
  console.log(`HTML slides generated: ${outputPath}`);
} catch (err) {
  console.error('Failed to generate slides:', err);
  process.exit(1);
}
