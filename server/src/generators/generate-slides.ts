#!/usr/bin/env node
/**
 * Reveal.js Premium Slides Generator v2
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
 * Generates a self-contained HTML with Reveal.js, Google Fonts, Material Symbols from CDN.
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
  type: 'bar' | 'pie' | 'donut' | 'line' | 'radar' | 'funnel' | 'gauge' | 'treemap' | 'waterfall' | 'scatter';
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

function fragAttr(slide: SlideData, anim = 'slide-up'): string {
  return slide.fragments ? ` class="fragment ${anim}"` : '';
}

function sectionAttrs(slide: SlideData): string {
  const parts: string[] = [];
  if (slide.autoAnimate) parts.push('data-auto-animate');
  if (slide.background) {
    if (slide.background.startsWith('http')) parts.push(`data-background-image="${escapeHtml(slide.background)}"`);
    else parts.push(`data-background="${escapeHtml(slide.background)}"`);
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

function renderNotes(notes?: string): string {
  return notes ? `<aside class="notes">${escapeHtml(notes)}</aside>` : '';
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
        legend: { orient: 'vertical', right: '5%', top: 'center', textStyle: { color: textColor, fontSize: 12 } },
        series: [{
          type: 'pie', radius: chart.type === 'donut' ? ['40%', '70%'] : ['0%', '70%'],
          center: ['40%', '50%'], padAngle: 2, itemStyle: { borderRadius: 6 },
          data: slices.map(sl => ({ value: sl.value, name: sl.label })),
          label: { color: textColor, fontSize: 12 },
          emphasis: { itemStyle: { shadowBlur: 20, shadowColor: 'rgba(0,0,0,0.3)' } },
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
  if (s.code) {
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
  return s;
}

// ── Slide Renderers ────────────────────────────────────────────

// Track CDN needs
let echartsUsed = false;
let mermaidUsed = false;
let markmapUsed = false;
const echartsConfigs: { id: string; option: object }[] = [];
const mindmapConfigs: { id: string; code: string }[] = [];
const mermaidConfigs: { id: string; code: string }[] = [];

function renderSlide(rawSlide: SlideData, s: StylePreset, idx: number): string {
  const slide = sanitizeSlide(rawSlide);
  const fa = fragAttr(slide);
  const sa = sectionAttrs(slide);
  const notes = renderNotes(slide.notes);
  const deco = s.decorations && s.decorationColors.length > 0;

  switch (slide.type) {

    case 'title':
      return `<section${sa}>
  ${deco ? renderDecoBlob(s.decorationColors, idx) : ''}
  ${deco ? `<div class="deco-svg deco-circles-pos">${renderDecoCircles(s.decorationColors, idx)}</div>` : ''}
  <h1>${escapeHtml(slide.title || '')}</h1>
  <div class="accent-line"></div>
  ${slide.subtitle ? `<p class="subtitle">${escapeHtml(slide.subtitle)}</p>` : ''}
  ${slide.tagline ? `<p class="tagline">${escapeHtml(slide.tagline)}</p>` : ''}
  ${notes}
</section>`;

    case 'section':
      return `<section${sa}>
  ${deco ? renderDecoWave(s.decorationColors[0] || s.accentColor) : ''}
  <h2 class="section-heading">${escapeHtml(slide.title || '')}</h2>
  <div class="accent-line"></div>
  ${slide.subtitle ? `<p class="subtitle">${escapeHtml(slide.subtitle)}</p>` : ''}
  ${notes}
</section>`;

    case 'content': {
      let body = '';
      if (slide.bullets) {
        body = `<ul class="bullet-list">${slide.bullets.map(b =>
          `<li${fa}><span class="bullet-icon">${renderIcon('arrow_right', 'bullet-sym')}</span><span>${escapeHtml(b)}</span></li>`
        ).join('')}</ul>`;
      } else if (slide.text) {
        body = `<p class="body-text">${escapeHtml(slide.text)}</p>`;
      }
      return `<section${sa}>
  ${slide.title ? `<h2 class="slide-title">${escapeHtml(slide.title)}</h2>` : ''}
  ${body}
  ${notes}
</section>`;
    }

    case 'two-column': {
      const renderCol = (col: { heading: string; bullets: string[] }) =>
        `<div class="slide-col glass-card">
          <h3>${escapeHtml(col.heading)}</h3>
          <ul class="bullet-list compact">${col.bullets.map(b =>
            `<li${fa}><span class="bullet-icon">${renderIcon('chevron_right', 'bullet-sym')}</span><span>${escapeHtml(b)}</span></li>`
          ).join('')}</ul>
        </div>`;
      return `<section${sa}>
  ${slide.title ? `<h2 class="slide-title">${escapeHtml(slide.title)}</h2>` : ''}
  <div class="slide-columns">${slide.left ? renderCol(slide.left) : ''}${slide.right ? renderCol(slide.right) : ''}</div>
  ${notes}
</section>`;
    }

    case 'code':
      return `<section${sa}>
  ${slide.title ? `<h2 class="slide-title">${escapeHtml(slide.title)}</h2>` : ''}
  <pre class="code-block"><code class="language-${slide.language || 'plaintext'}">${escapeHtml(slide.code || '')}</code></pre>
  ${notes}
</section>`;

    case 'image':
      return `<section${sa}>
  ${slide.title ? `<h2 class="slide-title">${escapeHtml(slide.title)}</h2>` : ''}
  <img src="${escapeHtml(slide.imageSrc || '')}" alt="${escapeHtml(slide.imageAlt || '')}" loading="lazy" class="slide-image">
  ${notes}
</section>`;

    case 'hero': {
      const bgAttr = slide.imageSrc
        ? ` data-background-image="${escapeHtml(slide.imageSrc)}" data-background-opacity="1"`
        : '';
      return `<section${sa}${bgAttr}>
  ${slide.imageSrc ? '<div class="hero-overlay"></div>' : ''}
  ${deco && !slide.imageSrc ? renderDecoBlob(s.decorationColors, idx) : ''}
  <div class="hero-content">
    <h1 class="hero-title">${escapeHtml(slide.title || '')}</h1>
    ${slide.subtitle ? `<p class="hero-subtitle">${escapeHtml(slide.subtitle)}</p>` : ''}
    ${slide.tagline ? `<p class="hero-tagline">${escapeHtml(slide.tagline)}</p>` : ''}
  </div>
  ${notes}
</section>`;
    }

    case 'stats': {
      const statsItems = slide.stats || [];
      const cards = statsItems.map(st => {
        const trendIcon = st.trend === 'up' ? 'trending_up' : st.trend === 'down' ? 'trending_down' : '';
        const trendClass = st.trend === 'up' ? 'trend-up' : st.trend === 'down' ? 'trend-down' : '';
        return `<div class="stats-card glass-card"${fa ? ` ${fa.trim()}` : ''}>
  ${st.icon ? `<div class="stats-icon">${renderIcon(st.icon)}</div>` : ''}
  <div class="stats-value">${escapeHtml(st.value)}</div>
  <div class="stats-label">${escapeHtml(st.label)}</div>
  ${trendIcon ? `<div class="stats-trend ${trendClass}">${renderIcon(trendIcon, 'trend-icon')}</div>` : ''}
</div>`;
      }).join('');
      return `<section${sa}>
  ${slide.title ? `<h2 class="slide-title">${escapeHtml(slide.title)}</h2>` : ''}
  <div class="stats-grid">${cards}</div>
  ${notes}
</section>`;
    }

    case 'icon-grid': {
      const items = slide.items || [];
      const cols = Math.min(slide.columns || 3, 4);
      const cards = items.map(it => {
        const iconHtml = it.imageSrc
          ? `<img src="${escapeHtml(it.imageSrc)}" class="icon-card-img" loading="lazy" alt="${escapeHtml(it.title)}" />`
          : `<div class="icon-card-icon">${renderIcon(it.icon)}</div>`;
        return `<div class="icon-card glass-card"${fa ? ` ${fa.trim()}` : ''}>
  ${iconHtml}
  <div class="icon-card-title">${escapeHtml(it.title)}</div>
  ${it.description ? `<p class="icon-card-desc">${escapeHtml(it.description)}</p>` : ''}
</div>`;
      }).join('');
      return `<section${sa}>
  ${slide.title ? `<h2 class="slide-title">${escapeHtml(slide.title)}</h2>` : ''}
  <div class="icon-grid cols-${cols}">${cards}</div>
  ${notes}
</section>`;
    }

    case 'timeline': {
      const milestones = slide.milestones || [];
      const items = milestones.map((m, i) =>
        `<div class="tl-item"${fa ? ` ${fa.trim()}` : ''}>
  <div class="tl-dot">${m.icon ? renderIcon(m.icon, 'tl-icon') : `<span class="tl-num">${i + 1}</span>`}</div>
  <div class="tl-content">
    ${m.date ? `<span class="tl-date">${escapeHtml(m.date)}</span>` : ''}
    <div class="tl-title">${escapeHtml(m.title)}</div>
    ${m.description ? `<p class="tl-desc">${escapeHtml(m.description)}</p>` : ''}
  </div>
</div>`
      ).join('');
      return `<section${sa}>
  ${slide.title ? `<h2 class="slide-title">${escapeHtml(slide.title)}</h2>` : ''}
  <div class="timeline">
    <div class="tl-line"></div>
    <div class="tl-items">${items}</div>
  </div>
  ${notes}
</section>`;
    }

    case 'quote':
      return `<section${sa}>
  <div class="quote-block">
    <div class="quote-mark">\u201C</div>
    <blockquote class="quote-text">${escapeHtml(slide.quote || slide.text || '')}</blockquote>
    ${slide.attribution ? `<cite class="quote-author">\u2014 ${escapeHtml(slide.attribution)}</cite>` : ''}
  </div>
  ${notes}
</section>`;

    case 'chart': {
      echartsUsed = true;
      const chartId = `echart-${idx}`;
      echartsConfigs.push({ id: chartId, option: buildEChartsOption(slide.chart || { type: 'bar' }, s) });
      return `<section${sa}>
  ${slide.title ? `<h2 class="slide-title">${escapeHtml(slide.title)}</h2>` : ''}
  <div id="${chartId}" class="echart-container"></div>
  ${notes}
</section>`;
    }

    case 'image-text': {
      const pos = slide.imagePosition || 'left';
      const imgBlock = `<div class="it-image"><img src="${escapeHtml(slide.imageSrc || '')}" alt="${escapeHtml(slide.imageAlt || '')}" loading="lazy"></div>`;
      let textBlock = `<div class="it-text">`;
      if (slide.title) textBlock += `<h2 class="slide-title">${escapeHtml(slide.title)}</h2>`;
      if (slide.text) textBlock += `<p class="body-text">${escapeHtml(slide.text)}</p>`;
      if (slide.bullets) {
        textBlock += `<ul class="bullet-list compact">${slide.bullets.map(b =>
          `<li${fa}><span class="bullet-icon">${renderIcon('arrow_right', 'bullet-sym')}</span><span>${escapeHtml(b)}</span></li>`
        ).join('')}</ul>`;
      }
      textBlock += `</div>`;
      return `<section${sa}>
  <div class="image-text-layout ${pos === 'right' ? 'img-right' : ''}">${pos === 'left' ? imgBlock + textBlock : textBlock + imgBlock}</div>
  ${notes}
</section>`;
    }

    // ── New Types ──

    case 'profile': {
      const links = (slide.socialLinks || []).map(l =>
        `<span class="profile-link">${renderIcon(l.icon, 'profile-link-icon')}<span>${escapeHtml(l.label)}</span></span>`
      ).join('');
      return `<section${sa}>
  <div class="profile-layout">
    ${slide.avatar ? `<div class="profile-avatar-wrap"><img src="${escapeHtml(slide.avatar)}" class="profile-avatar" loading="lazy" alt="${escapeHtml(slide.name || '')}" /></div>` : ''}
    ${slide.name ? `<h2 class="profile-name">${escapeHtml(slide.name)}</h2>` : ''}
    ${slide.role ? `<p class="profile-role">${escapeHtml(slide.role)}</p>` : ''}
    ${slide.bio ? `<p class="profile-bio">${escapeHtml(slide.bio)}</p>` : ''}
    ${links ? `<div class="profile-social">${links}</div>` : ''}
  </div>
  ${notes}
</section>`;
    }

    case 'process': {
      const steps = slide.steps || [];
      const stepsHtml = steps.map((st, i) =>
        `<div class="process-step"${fa ? ` ${fa.trim()}` : ''}>
  <div class="process-step-circle">${st.icon ? renderIcon(st.icon, 'process-icon') : `<span class="process-num">${i + 1}</span>`}</div>
  <div class="process-step-label">${escapeHtml(st.title)}</div>
  ${st.description ? `<div class="process-step-desc">${escapeHtml(st.description)}</div>` : ''}
</div>`
      ).join('');
      return `<section${sa}>
  ${slide.title ? `<h2 class="slide-title">${escapeHtml(slide.title)}</h2>` : ''}
  <div class="process-steps">
    <div class="process-connector"></div>
    ${stepsHtml}
  </div>
  ${notes}
</section>`;
    }

    case 'gallery': {
      const images = slide.images || [];
      const layout = slide.galleryLayout || (images.length <= 3 ? '3-col' : '2x2');
      const items = images.map(img =>
        `<figure class="gallery-item">
  <img src="${escapeHtml(img.src)}" alt="${escapeHtml(img.alt || img.caption || '')}" loading="lazy" />
  ${img.caption ? `<figcaption>${escapeHtml(img.caption)}</figcaption>` : ''}
</figure>`
      ).join('');
      return `<section${sa}>
  ${slide.title ? `<h2 class="slide-title">${escapeHtml(slide.title)}</h2>` : ''}
  <div class="gallery gallery-${layout}">${items}</div>
  ${notes}
</section>`;
    }

    case 'team': {
      const members = slide.members || [];
      const cards = members.map(m =>
        `<div class="team-card glass-card"${fa ? ` ${fa.trim()}` : ''}>
  ${m.photo ? `<img src="${escapeHtml(m.photo)}" class="team-photo" loading="lazy" alt="${escapeHtml(m.name)}" />` : `<div class="team-photo-placeholder">${renderIcon('person')}</div>`}
  <div class="team-name">${escapeHtml(m.name)}</div>
  <div class="team-role">${escapeHtml(m.role)}</div>
  ${m.description ? `<div class="team-desc">${escapeHtml(m.description)}</div>` : ''}
</div>`
      ).join('');
      return `<section${sa}>
  ${slide.title ? `<h2 class="slide-title">${escapeHtml(slide.title)}</h2>` : ''}
  <div class="team-grid">${cards}</div>
  ${notes}
</section>`;
    }

    case 'table': {
      const headers = slide.headers || [];
      const rows = slide.rows || [];
      const thClass = slide.highlightHeader ? ' class="table-header-highlighted"' : '';
      const headerRow = headers.length ? `<thead${thClass}><tr>${headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>` : '';
      const bodyRows = rows.map(r => `<tr>${r.map(c => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('');
      return `<section${sa}>
  ${slide.title ? `<h2 class="slide-title">${escapeHtml(slide.title)}</h2>` : ''}
  <div class="table-wrap"><table class="slide-table">${headerRow}<tbody>${bodyRows}</tbody></table></div>
  ${notes}
</section>`;
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
        const chartId = `echart-dash-${idx}`;
        echartsConfigs.push({ id: chartId, option: buildEChartsOption(slide.dashboardChart, s) });
        chartHtml = `<div id="${chartId}" class="echart-container echart-compact"></div>`;
      }

      return `<section${sa}>
  ${slide.title ? `<h2 class="slide-title">${escapeHtml(slide.title)}</h2>` : ''}
  <div class="dashboard-kpis">${kpiCards}</div>
  ${chartHtml ? `<div class="dashboard-chart">${chartHtml}</div>` : ''}
  ${notes}
</section>`;
    }

    case 'diagram': {
      mermaidUsed = true;
      const mermaidId = `mermaid-${idx}`;
      mermaidConfigs.push({ id: mermaidId, code: slide.code || '' });
      return `<section${sa}>
  ${slide.title ? `<h2 class="slide-title">${escapeHtml(slide.title)}</h2>` : ''}
  <div class="diagram-container"><pre class="mermaid" id="${mermaidId}"></pre></div>
  ${notes}
</section>`;
    }

    case 'mindmap': {
      markmapUsed = true;
      const mmId = `mindmap-${idx}`;
      mindmapConfigs.push({ id: mmId, code: slide.code || '' });
      return `<section${sa}>
  ${slide.title ? `<h2 class="slide-title">${escapeHtml(slide.title)}</h2>` : ''}
  <div class="mindmap-container"><svg id="${mmId}" class="mindmap-svg"></svg></div>
  ${notes}
</section>`;
    }

    default:
      return `<section><p class="body-text">${escapeHtml(slide.title || 'Untitled Slide')}</p></section>`;
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
html, body { width: 100%; height: 100%; margin: 0; padding: 0; overflow: hidden; }
.reveal-viewport { ${bgRule} }
.reveal { font-family: var(--font-body); }

/* ── Sections — grid background + floating gradient decorations ── */
.reveal .slides section {
  background-color: transparent;
  background-image:
    linear-gradient(${s.isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)'} 1px, transparent 1px),
    linear-gradient(90deg, ${s.isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)'} 1px, transparent 1px);
  background-size: 50px 50px;
  padding: 48px 64px !important;
  text-align: left;
  overflow: hidden !important;
}
.reveal .slides section .deco-svg { position: absolute; pointer-events: none; z-index: 0; }
.reveal .slides section > *:not(.deco-svg):not(.hero-overlay) { position: relative; z-index: 1; }

/* Floating gradient orbs — adds depth to every slide */
.reveal .slides section::before {
  content: '';
  position: absolute;
  width: 420px;
  height: 420px;
  border-radius: 50%;
  background: radial-gradient(circle, ${s.accentColor} 0%, transparent 70%);
  opacity: ${s.isDark ? '0.1' : '0.06'};
  pointer-events: none;
  z-index: 0;
  filter: blur(50px);
}
.reveal .slides section:nth-child(odd)::before { top: -200px; right: -160px; }
.reveal .slides section:nth-child(even)::before { bottom: -200px; left: -160px; }
.reveal .slides section::after {
  content: '';
  position: absolute;
  width: 300px;
  height: 300px;
  border-radius: 50%;
  background: radial-gradient(circle, ${s.accentColor2} 0%, transparent 70%);
  opacity: ${s.isDark ? '0.07' : '0.04'};
  pointer-events: none;
  z-index: 0;
  filter: blur(35px);
}
.reveal .slides section:nth-child(odd)::after { bottom: -130px; left: -100px; }
.reveal .slides section:nth-child(even)::after { top: -130px; right: -100px; }

/* ── Typography ── */
.reveal h1, .reveal h2, .reveal h3, .reveal h4 {
  font-family: var(--font-heading);
  font-weight: 700;
  color: var(--heading-color);
  word-wrap: break-word;
  margin: 0 0 0.3em;
  line-height: 1.1;
  letter-spacing: -0.02em;
}
.reveal h1 { font-size: clamp(2em, 4.5vw, 2.8em); color: var(--title-color); }
.reveal h2 { font-size: clamp(1.2em, 3vw, 1.65em); }
.reveal h3 { font-size: clamp(0.95em, 2.2vw, 1.15em); }
.reveal h4 { font-size: clamp(0.85em, 1.8vw, 1em); font-weight: 600; }
.slide-title {
  text-align: left;
  margin-bottom: 0.65em;
  padding-left: 20px;
  padding-bottom: 0.3em;
  border-left: 4px solid var(--accent);
  border-image: linear-gradient(to bottom, var(--accent), var(--accent2)) 1;
}
.section-heading { font-size: clamp(1.5em, 3.5vw, 2em); text-align: center; color: var(--title-color); }
.subtitle { color: var(--subtitle-color); font-size: 0.7em; margin: 0; }
.tagline { color: var(--accent); font-size: 0.5em; letter-spacing: 0.18em; text-transform: uppercase; margin-top: 0.6em; font-weight: 600; }
.body-text { color: var(--body-color); font-size: 0.65em; line-height: 1.7; }

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
.bullet-list { list-style: none; padding: 0; margin: 0; width: 100%; color: var(--body-color); font-size: 0.7em; line-height: 1.8; }
.bullet-list.compact { font-size: 0.6em; }
.bullet-list li { display: flex; align-items: flex-start; gap: 0.6em; margin-bottom: 0.35em; padding: 0.35em 0.5em; border-radius: 8px; transition: background 0.2s, padding-left 0.2s; }
.bullet-list li:hover { background: ${s.isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)'}; padding-left: 0.8em; }
.bullet-icon { flex-shrink: 0; }
.bullet-sym { font-size: 1em; color: var(--accent); }
.reveal ul, .reveal ol { overflow: hidden; }
.reveal li { word-wrap: break-word; overflow-wrap: break-word; }
* { scrollbar-width: none; -ms-overflow-style: none; }
*::-webkit-scrollbar { display: none; }

/* ── Code ── */
.code-block { background: var(--code-bg); border-radius: 14px; padding: 1.2em 1.4em; text-align: left; max-height: 380px; overflow: hidden; width: 100%; border: 1px solid var(--card-border); box-shadow: ${s.isDark ? '0 0 40px rgba(0,0,0,0.2)' : '0 4px 30px rgba(0,0,0,0.04)'}; }
.code-block code { color: var(--code-color); font-size: 0.58em; line-height: 1.7; white-space: pre-wrap; word-break: break-all; }

/* ── Images ── */
.slide-image { max-width: 85%; max-height: 400px; height: auto; object-fit: contain; border-radius: 16px; margin: 0 auto; display: block; box-shadow: 0 8px 30px rgba(0,0,0,${s.isDark ? '0.3' : '0.1'}); }

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
.icon-card { text-align: center; padding: 1.4em 1em; }
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
.icon-card-title { font-size: 16px; color: var(--heading-color); margin: 0.5em 0 0.2em; font-weight: 700; }
.icon-card-desc { font-size: 13px; color: var(--body-color); margin: 0; line-height: 1.5; }

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
.echart-container { width: 100%; height: 380px; max-width: 900px; margin: 0 auto; }
.echart-compact { height: 260px; }

/* ── Image + Text ── */
.image-text-layout { display: flex; gap: 2.5em; align-items: center; width: 100%; }
.image-text-layout.img-right { flex-direction: row-reverse; }
.it-image { flex: 1; min-width: 0; }
.it-image img { width: 100%; height: auto; max-height: 400px; object-fit: cover; border-radius: 20px; box-shadow: 0 12px 40px rgba(0,0,0,${s.isDark ? '0.3' : '0.1'}); }
.it-text { flex: 1; min-width: 0; }

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
.process-step-label { font-size: 0.78em; font-weight: 700; color: var(--heading-color); margin-bottom: 0.2em; }
.process-step-desc { font-size: 0.55em; color: var(--body-color); margin: 0; max-width: 150px; line-height: 1.5; background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 10px; padding: 0.5em 0.6em; }

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
.diagram-container { display: flex; justify-content: center; align-items: center; width: 100%; min-height: 300px; }
.diagram-container .mermaid { font-size: 14px; }
.diagram-container svg { max-width: 100%; max-height: 480px; }

/* ── Mindmap (Markmap) ── */
.mindmap-container { width: 100%; height: 480px; display: flex; justify-content: center; }
.mindmap-svg { width: 100%; height: 100%; }

/* ── Fragment Animations ── */
.fragment.slide-up { transform: translateY(20px); opacity: 0; transition: all 0.5s ease; }
.fragment.slide-up.visible { transform: translateY(0); opacity: 1; }
.fragment.blur { filter: blur(6px); opacity: 0; transition: all 0.5s ease; }
.fragment.blur.visible { filter: none; opacity: 1; }
.fragment.scale-in { transform: scale(0.85); opacity: 0; transition: all 0.4s ease; }
.fragment.scale-in.visible { transform: scale(1); opacity: 1; }
.fragment.fade-up { transform: translateY(30px); opacity: 0; transition: all 0.6s cubic-bezier(0.22, 1, 0.36, 1); }
.fragment.fade-up.visible { transform: translateY(0); opacity: 1; }

/* ── Theme Overrides ── */
.reveal .slide-background { ${bgRule} }
.reveal .slides > section { margin: 0; }
.reveal .progress { color: var(--accent); height: 4px; }
.reveal .controls { color: var(--accent); }
.reveal .controls button { opacity: 0.6; transition: opacity 0.2s; }
.reveal .controls button:hover { opacity: 1; }

/* ── RWD ── */
@media (max-width: 768px) {
  .reveal .slides section { padding: 1.2em 1.5em !important; }
  .reveal h1 { font-size: 1.4em; }
  .slide-columns, .image-text-layout, .image-text-layout.img-right { flex-direction: column; }
  .stats-grid, .dashboard-kpis { flex-direction: column; align-items: center; }
  .icon-grid { grid-template-columns: repeat(2, 1fr) !important; }
  .tl-items { flex-direction: column; }
  .tl-line { display: none; }
  .process-steps { flex-direction: column; align-items: center; }
  .process-connector { display: none; }
  .gallery { grid-template-columns: 1fr !important; grid-template-rows: auto !important; }
  .gallery-1-hero-2-small .gallery-item:first-child { grid-row: auto; }
  .team-grid { flex-direction: column; align-items: center; }
  .echart-container { height: 260px; }
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

  // Build ECharts init code
  let echartsInitCode = '';
  if (echartsUsed && echartsConfigs.length > 0) {
    const configs = echartsConfigs.map(c =>
      `{ id: '${c.id}', option: ${JSON.stringify(c.option)} }`
    ).join(',\n      ');
    echartsInitCode = `
  <script>
  (function() {
    var configs = [
      ${configs}
    ];
    var instances = {};
    function initChart(cfg) {
      var el = document.getElementById(cfg.id);
      if (!el || instances[cfg.id]) return;
      var chart = echarts.init(el, ${s.isDark ? "'dark'" : 'null'}, { renderer: 'canvas' });
      chart.setOption(cfg.option);
      instances[cfg.id] = chart;
    }
    function initVisibleCharts() {
      var current = Reveal.getCurrentSlide();
      if (!current) return;
      configs.forEach(function(cfg) {
        if (current.querySelector('#' + cfg.id)) initChart(cfg);
      });
    }
    function resizeAll() {
      Object.keys(instances).forEach(function(k) { instances[k].resize(); });
    }
    Reveal.on('ready', initVisibleCharts);
    Reveal.on('slidechanged', function(e) {
      configs.forEach(function(cfg) {
        if (e.currentSlide.querySelector('#' + cfg.id)) {
          if (!instances[cfg.id]) initChart(cfg);
          else instances[cfg.id].resize();
        }
      });
    });
    window.addEventListener('resize', resizeAll);
  })();
  <\/script>`;
  }

  // Build Mermaid init code — uses mermaid.render(id, code) to pass code directly as string
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
        }).catch(function(e) { console.warn('Mermaid render error for ' + cfg.id + ':', e); });
      });
    }
    if (typeof Reveal !== 'undefined' && Reveal.isReady && Reveal.isReady()) {
      renderAll();
    } else {
      Reveal.on('ready', renderAll);
    }
    Reveal.on('slidechanged', function() { renderAll(); });
  })();
  <\/script>`;
  }

  // Build Markmap init code
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
    function initMarkmaps() {
      configs.forEach(function(cfg) {
        var el = document.getElementById(cfg.id);
        if (!el || el.getAttribute('data-rendered')) return;
        el.setAttribute('data-rendered', 'true');
        var result = transformer.transform(cfg.code);
        var mm = markmap.Markmap.create(el, {
          color: function(node) {
            var colors = ${JSON.stringify(s.chartColors)};
            return colors[(node.state ? node.state.id : 0) % colors.length];
          },
          paddingX: 16,
          initialExpandLevel: 2,
        }, result.root);
        el.__markmap = mm;
        mm.fit();
      });
    }
    if (typeof Reveal !== 'undefined' && Reveal.isReady && Reveal.isReady()) {
      initMarkmaps();
    } else {
      Reveal.on('ready', initMarkmaps);
    }
    Reveal.on('slidechanged', function(e) {
      initMarkmaps();
      configs.forEach(function(cfg) {
        var el = e.currentSlide.querySelector('#' + cfg.id);
        if (el && el.__markmap) el.__markmap.fit();
      });
    });
  })();
  <\/script>`;
  }

  // Stats count-up animation (always included if stats exist)
  const hasStats = input.slides.some(sl => sl.type === 'stats' || sl.type === 'dashboard');
  const statsScript = hasStats ? `
  <script>
  (function() {
    function animateNumbers(section) {
      section.querySelectorAll('.stats-value').forEach(function(el) {
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
    Reveal.on('slidechanged', function(e) {
      if (e.currentSlide.querySelector('.stats-grid') || e.currentSlide.querySelector('.dashboard-kpis')) animateNumbers(e.currentSlide);
    });
    Reveal.on('ready', function(e) {
      if (e.currentSlide && (e.currentSlide.querySelector('.stats-grid') || e.currentSlide.querySelector('.dashboard-kpis'))) animateNumbers(e.currentSlide);
    });
  })();
  <\/script>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="author" content="${escapeHtml(input.author || 'AI Agents Office')}">
  <title>${escapeHtml(input.title)}</title>
  <!-- Reveal.js -->
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/reveal.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/theme/white.css" id="theme">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/plugin/highlight/monokai.css">
  <!-- Google Fonts -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="${s.googleFontsUrl}" rel="stylesheet">
  <!-- Material Symbols -->
  <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0,0" rel="stylesheet">
  <style>${generateCSS(s)}</style>
</head>
<body>
  <div class="reveal">
    <div class="slides">
      ${slides}
    </div>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/reveal.js"><\/script>
  <script src="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/plugin/highlight/highlight.js"><\/script>
  ${cdnScripts.join('\n  ')}
  <script>
    Reveal.initialize({
      hash: true,
      transition: '${s.transition}',
      plugins: [RevealHighlight],
      width: 1280,
      height: 720,
      margin: 0.04,
      minScale: 0.2,
      maxScale: 1.5,
      center: true,
      controlsLayout: 'edges',
      controlsBackArrows: 'visible',
      autoAnimateDuration: 0.8,
      slideNumber: 'c/t',
      disableLayout: false,
    });
  <\/script>
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
