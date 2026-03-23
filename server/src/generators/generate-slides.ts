#!/usr/bin/env node
/**
 * Reveal.js Premium Slides Generator
 * Usage: node --import tsx generate-slides.ts <input.json> <output.html>
 *
 * 8 styles: minimal | dark | gradient | neon | corporate | creative | elegant | tech
 * 13 slide types: title | section | content | two-column | code | image |
 *                 hero | stats | icon-grid | timeline | quote | chart | image-text
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

interface ChartData {
  type: 'bar' | 'pie' | 'donut' | 'line';
  bars?: ChartBarItem[];
  maxValue?: number;
  slices?: ChartPieSlice[];
  series?: ChartLineSeries[];
  labels?: string[];
}

interface StatItem { value: string; label: string; icon?: string; trend?: 'up' | 'down' | 'neutral'; }
interface IconGridItem { icon: string; title: string; description?: string; }
interface TimelineMilestone { date?: string; title: string; description?: string; icon?: string; }

interface SlideData {
  type: 'title' | 'content' | 'two-column' | 'section' | 'code' | 'image'
    | 'hero' | 'stats' | 'icon-grid' | 'timeline' | 'quote' | 'chart' | 'image-text';
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
  // New fields
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

// ── Chart Renderers ────────────────────────────────────────────

function renderBarChart(chart: ChartData, s: StylePreset): string {
  const bars = chart.bars || [];
  if (bars.length === 0) return '';
  const maxVal = chart.maxValue || Math.ceil(Math.max(...bars.map(b => b.value)) * 1.2) || 100;
  const barHtml = bars.map((b, i) => {
    const color = b.color || s.chartColors[i % s.chartColors.length];
    const pct = Math.min((b.value / maxVal) * 100, 100);
    return `<div class="bar-row">
      <span class="bar-label">${escapeHtml(b.label)}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${color};"></div></div>
      <span class="bar-value">${b.value}</span>
    </div>`;
  }).join('');
  return `<div class="chart-bar">${barHtml}</div>`;
}

function renderPieChart(chart: ChartData, s: StylePreset): string {
  const slices = chart.slices || [];
  if (slices.length === 0) return '';
  const total = slices.reduce((sum, sl) => sum + sl.value, 0) || 1;
  let cum = 0;
  const stops = slices.map((sl, i) => {
    const color = sl.color || s.chartColors[i % s.chartColors.length];
    const start = (cum / total) * 100;
    cum += sl.value;
    const end = (cum / total) * 100;
    return `${color} ${start.toFixed(1)}% ${end.toFixed(1)}%`;
  }).join(', ');
  const isDonut = chart.type === 'donut';
  const legend = slices.map((sl, i) => {
    const color = sl.color || s.chartColors[i % s.chartColors.length];
    return `<div class="chart-legend-item"><span class="chart-dot" style="background:${color};"></span><span>${escapeHtml(sl.label)} (${sl.value}%)</span></div>`;
  }).join('');
  return `<div class="chart-pie-wrap">
    <div class="chart-pie${isDonut ? ' donut' : ''}" style="background:conic-gradient(${stops});"></div>
    <div class="chart-legend">${legend}</div>
  </div>`;
}

function renderLineChart(chart: ChartData, s: StylePreset): string {
  const series = chart.series || [];
  if (series.length === 0) return '';
  const allVals = series.flatMap(sr => sr.points.map(p => p.value));
  const maxVal = Math.ceil(Math.max(...allVals) * 1.15) || 100;
  const minVal = 0;
  const labels = chart.labels || series[0]?.points.map(p => p.label) || [];
  const W = 600, H = 280, PL = 50, PR = 20, PT = 20, PB = 40;
  const cW = W - PL - PR, cH = H - PT - PB;

  // Grid lines
  const gridCount = 4;
  let gridSvg = '';
  for (let i = 0; i <= gridCount; i++) {
    const y = PT + (cH / gridCount) * i;
    const val = Math.round(maxVal - (maxVal - minVal) * (i / gridCount));
    gridSvg += `<line x1="${PL}" y1="${y}" x2="${W - PR}" y2="${y}" stroke="var(--body-color)" stroke-opacity="0.15" stroke-width="0.5"/>`;
    gridSvg += `<text x="${PL - 8}" y="${y + 4}" text-anchor="end" fill="var(--body-color)" font-size="10" opacity="0.6">${val}</text>`;
  }

  // X labels
  let xLabelSvg = '';
  labels.forEach((lbl, i) => {
    const x = PL + (cW / Math.max(labels.length - 1, 1)) * i;
    xLabelSvg += `<text x="${x}" y="${H - 8}" text-anchor="middle" fill="var(--body-color)" font-size="10" opacity="0.6">${escapeHtml(lbl)}</text>`;
  });

  // Series lines
  const linesSvg = series.map((sr, si) => {
    const color = sr.color || s.chartColors[si % s.chartColors.length];
    const pts = sr.points.map((p, pi) => {
      const x = PL + (cW / Math.max(sr.points.length - 1, 1)) * pi;
      const y = PT + cH - ((p.value - minVal) / (maxVal - minVal)) * cH;
      return `${x},${y}`;
    });
    const dots = sr.points.map((p, pi) => {
      const x = PL + (cW / Math.max(sr.points.length - 1, 1)) * pi;
      const y = PT + cH - ((p.value - minVal) / (maxVal - minVal)) * cH;
      return `<circle cx="${x}" cy="${y}" r="3.5" fill="${color}" stroke="var(--slide-bg)" stroke-width="2"/>`;
    }).join('');
    return `<polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}`;
  }).join('');

  // Legend
  const legendSvg = series.length > 1 ? series.map((sr, si) => {
    const color = sr.color || s.chartColors[si % s.chartColors.length];
    const x = PL + si * 120;
    return `<circle cx="${x}" cy="${H + 16}" r="4" fill="${color}"/>
    <text x="${x + 10}" y="${H + 20}" fill="var(--body-color)" font-size="11">${escapeHtml(sr.name)}</text>`;
  }).join('') : '';

  const svgH = series.length > 1 ? H + 30 : H;
  return `<svg class="chart-line-svg" viewBox="0 0 ${W} ${svgH}" xmlns="http://www.w3.org/2000/svg">
  ${gridSvg}${xLabelSvg}${linesSvg}${legendSvg}
</svg>`;
}

function renderChart(chart: ChartData | undefined, s: StylePreset): string {
  if (!chart) return '';
  switch (chart.type) {
    case 'bar': return renderBarChart(chart, s);
    case 'pie': case 'donut': return renderPieChart(chart, s);
    case 'line': return renderLineChart(chart, s);
    default: return '';
  }
}

// ── Slide Renderers ────────────────────────────────────────────

function renderSlide(slide: SlideData, s: StylePreset, idx: number): string {
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

    // ── New Types ──

    case 'hero': {
      const bgAttr = slide.imageSrc
        ? ` data-background-image="${escapeHtml(slide.imageSrc)}" data-background-opacity="0.3"`
        : '';
      return `<section${sa}${bgAttr}>
  ${deco ? renderDecoBlob(s.decorationColors, idx) : ''}
  ${deco ? `<div class="deco-svg" style="bottom:-60px;left:-60px;opacity:0.3;">${renderDecoCircles(s.decorationColors, idx)}</div>` : ''}
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
      const cards = statsItems.map((st, i) => {
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
      const cards = items.map(it =>
        `<div class="icon-card glass-card"${fa ? ` ${fa.trim()}` : ''}>
  <div class="icon-card-icon">${renderIcon(it.icon)}</div>
  <h4 class="icon-card-title">${escapeHtml(it.title)}</h4>
  ${it.description ? `<p class="icon-card-desc">${escapeHtml(it.description)}</p>` : ''}
</div>`
      ).join('');
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
    <h4 class="tl-title">${escapeHtml(m.title)}</h4>
    ${m.description ? `<p class="tl-desc">${escapeHtml(m.description)}</p>` : ''}
  </div>
</div>`
      ).join('');
      return `<section${sa}>
  ${slide.title ? `<h2 class="slide-title">${escapeHtml(slide.title)}</h2>` : ''}
  <div class="timeline">${items}</div>
  ${notes}
</section>`;
    }

    case 'quote':
      return `<section${sa}>
  <div class="quote-block">
    <div class="quote-mark">"</div>
    <blockquote class="quote-text">${escapeHtml(slide.quote || slide.text || '')}</blockquote>
    ${slide.attribution ? `<cite class="quote-author">— ${escapeHtml(slide.attribution)}</cite>` : ''}
  </div>
  ${notes}
</section>`;

    case 'chart':
      return `<section${sa}>
  ${slide.title ? `<h2 class="slide-title">${escapeHtml(slide.title)}</h2>` : ''}
  ${renderChart(slide.chart, s)}
  ${notes}
</section>`;

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

    default:
      return `<section><p class="body-text">${escapeHtml(slide.title || 'Untitled Slide')}</p></section>`;
  }
}

// ── CSS Generator ──────────────────────────────────────────────

function generateCSS(s: StylePreset): string {
  const isGrad = s.bg.startsWith('linear-gradient');
  const bgRule = isGrad ? `background: ${s.bg};` : `background-color: ${s.bg};`;

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
html, body { width: 100%; height: 100%; margin: 0; padding: 0; overflow: hidden; ${bgRule} }
.reveal-viewport { ${bgRule} }
.reveal { font-family: var(--font-body); }

/* ── Sections ── */
.reveal .slides section {
  ${bgRule}
  padding: 2em 3em;
  overflow: hidden;
  position: relative;
  text-align: left;
}
.reveal .slides section > *:not(.deco-svg) { position: relative; z-index: 1; max-width: 100%; }
/* Reveal.js 5 uses its own flex centering via center:true config — do not override display/flex on section */

/* ── Typography ── */
.reveal h1, .reveal h2, .reveal h3, .reveal h4 {
  font-family: var(--font-heading);
  font-weight: 700;
  color: var(--heading-color);
  word-wrap: break-word;
  margin: 0 0 0.4em;
  line-height: 1.2;
}
.reveal h1 { font-size: clamp(1.6em, 4vw, 2.4em); color: var(--title-color); }
.reveal h2 { font-size: clamp(1.2em, 3vw, 1.6em); }
.reveal h3 { font-size: clamp(1em, 2.5vw, 1.2em); }
.reveal h4 { font-size: clamp(0.85em, 2vw, 1em); font-weight: 600; }
.slide-title { text-align: left; margin-bottom: 0.8em; }
.section-heading { font-size: clamp(1.4em, 3.5vw, 2em); text-align: center; color: var(--title-color); }
.subtitle { color: var(--subtitle-color); font-size: 0.7em; margin: 0; }
.tagline { color: var(--accent); font-size: 0.55em; letter-spacing: 0.15em; text-transform: uppercase; margin-top: 0.8em; }
.body-text { color: var(--body-color); font-size: 0.72em; line-height: 1.7; }

/* ── Accent Line ── */
.accent-line { width: 80px; height: 4px; background: var(--accent); margin: 0.4em auto; border-radius: 2px; }

/* ── Glass Card ── */
.glass-card {
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  ${s.isDark ? 'backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);' : ''}
  border-radius: 16px;
  padding: 1.2em;
  transition: transform 0.2s;
}

/* ── Bullet Lists ── */
.bullet-list { list-style: none; padding: 0; margin: 0; width: 100%; color: var(--body-color); font-size: 0.72em; line-height: 1.8; }
.bullet-list.compact { font-size: 0.65em; }
.bullet-list li { display: flex; align-items: flex-start; gap: 0.5em; margin-bottom: 0.35em; }
.bullet-icon { flex-shrink: 0; }
.bullet-sym { font-size: 1em; color: var(--accent); }
.reveal ul, .reveal ol { max-height: 65vh; overflow-y: auto; }
.reveal li { word-wrap: break-word; overflow-wrap: break-word; }

/* ── Code ── */
.code-block { background: var(--code-bg); border-radius: 12px; padding: 1em 1.2em; text-align: left; max-height: 55vh; overflow: auto; width: 100%; border: 1px solid var(--card-border); }
.code-block code { color: var(--code-color); font-size: 0.58em; line-height: 1.7; white-space: pre-wrap; word-break: break-all; }

/* ── Images ── */
.slide-image { max-width: 85%; max-height: 58vh; height: auto; object-fit: contain; border-radius: 12px; margin: 0 auto; display: block; }

/* ── Two-Column ── */
.slide-columns { display: flex; gap: 1em; width: 100%; }
.slide-col { flex: 1; min-width: 0; }

/* ── Decorative SVG ── */
.deco-svg { position: absolute; pointer-events: none; z-index: 0; }
.deco-blob { top: -80px; right: -80px; opacity: 0.5; }
.deco-circles-pos { bottom: -60px; left: -60px; opacity: 0.4; }
.deco-wave { bottom: 0; left: 0; width: 100%; height: auto; opacity: 0.6; }

/* ── Hero ── */
.hero-content { text-align: center; z-index: 2; }
.hero-title { font-size: clamp(1.8em, 5vw, 3em) !important; margin-bottom: 0.3em; }
.hero-subtitle { font-size: 0.85em; color: var(--subtitle-color); margin: 0.5em 0; }
.hero-tagline { font-size: 0.55em; color: var(--accent); letter-spacing: 0.2em; text-transform: uppercase; }

/* ── Stats ── */
.stats-grid { display: flex; gap: 1em; justify-content: center; flex-wrap: wrap; width: 100%; }
.stats-card { flex: 1; min-width: 140px; max-width: 220px; text-align: center; padding: 1.2em 0.8em; background: var(--stats-card-bg); }
.stats-icon .material-symbols-outlined { font-size: 1.8em; color: var(--icon-color); margin-bottom: 0.3em; }
.stats-value { font-size: 1.8em; font-weight: 700; color: var(--title-color); font-family: var(--font-heading); line-height: 1.2; }
.stats-label { font-size: 0.6em; color: var(--body-color); margin-top: 0.3em; text-transform: uppercase; letter-spacing: 0.08em; }
.stats-trend { margin-top: 0.4em; }
.trend-icon { font-size: 1.2em; }
.trend-up .trend-icon { color: #48BB78; }
.trend-down .trend-icon { color: #FC8181; }

/* ── Icon Grid ── */
.icon-grid { display: grid; gap: 1em; width: 100%; }
.cols-2 { grid-template-columns: repeat(2, 1fr); }
.cols-3 { grid-template-columns: repeat(3, 1fr); }
.cols-4 { grid-template-columns: repeat(4, 1fr); }
.icon-card { text-align: center; padding: 1em 0.6em; }
.icon-card-icon .material-symbols-outlined { font-size: 2.2em; color: var(--icon-color); }
.icon-card-title { font-size: 0.7em; color: var(--heading-color); margin: 0.5em 0 0.2em; font-weight: 600; }
.icon-card-desc { font-size: 0.55em; color: var(--body-color); margin: 0; line-height: 1.5; }

/* ── Timeline ── */
.timeline { display: flex; flex-direction: column; gap: 0; padding-left: 2em; width: 100%; position: relative; }
.timeline::before { content: ''; position: absolute; left: 0.7em; top: 0.6em; bottom: 0.6em; width: 2px; background: var(--timeline-color); opacity: 0.4; }
.tl-item { display: flex; gap: 1em; align-items: flex-start; position: relative; padding-bottom: 1em; }
.tl-dot { width: 28px; height: 28px; border-radius: 50%; background: var(--timeline-color); display: flex; align-items: center; justify-content: center; flex-shrink: 0; position: relative; z-index: 1; margin-left: -1.3em; }
.tl-num { font-size: 0.55em; font-weight: 700; color: ${s.isDark ? '#000' : '#fff'}; }
.tl-icon { font-size: 0.75em; color: ${s.isDark ? '#000' : '#fff'}; }
.tl-content { flex: 1; min-width: 0; }
.tl-date { font-size: 0.5em; color: var(--accent); font-weight: 600; text-transform: uppercase; letter-spacing: 0.1em; }
.tl-title { font-size: 0.7em; margin: 0.1em 0; color: var(--heading-color); }
.tl-desc { font-size: 0.55em; color: var(--body-color); margin: 0.15em 0 0; line-height: 1.5; }

/* ── Quote ── */
.quote-block { text-align: center; max-width: 85%; margin: 0 auto; }
.quote-mark { font-size: 5em; line-height: 0.6; color: var(--quote-mark-color); font-family: Georgia, serif; user-select: none; }
.quote-text { font-size: 1em; color: var(--heading-color); font-style: italic; line-height: 1.6; margin: 0.3em 0 0.6em; border: none; padding: 0; }
.quote-author { font-size: 0.6em; color: var(--subtitle-color); font-style: normal; letter-spacing: 0.05em; }

/* ── Charts ── */
.chart-bar { width: 100%; max-width: 700px; margin: 0 auto; }
.bar-row { display: flex; align-items: center; gap: 0.6em; margin-bottom: 0.5em; }
.bar-label { font-size: 0.6em; color: var(--body-color); width: 120px; text-align: right; flex-shrink: 0; }
.bar-track { flex: 1; height: 28px; background: ${s.isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)'}; border-radius: 6px; overflow: hidden; }
.bar-fill { height: 100%; border-radius: 6px; transition: width 0.8s ease; }
.bar-value { font-size: 0.6em; color: var(--heading-color); font-weight: 700; width: 40px; }

.chart-pie-wrap { display: flex; align-items: center; justify-content: center; gap: 2em; }
.chart-pie { width: 200px; height: 200px; border-radius: 50%; position: relative; }
.chart-pie.donut::after { content: ''; position: absolute; top: 25%; left: 25%; width: 50%; height: 50%; border-radius: 50%; background: var(--slide-bg); }
.chart-legend { display: flex; flex-direction: column; gap: 0.5em; }
.chart-legend-item { display: flex; align-items: center; gap: 0.5em; font-size: 0.6em; color: var(--body-color); }
.chart-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }

.chart-line-svg { width: 100%; max-width: 700px; height: auto; margin: 0 auto; display: block; }

/* ── Image + Text ── */
.image-text-layout { display: flex; gap: 2em; align-items: center; width: 100%; }
.image-text-layout.img-right { flex-direction: row-reverse; }
.it-image { flex: 1; min-width: 0; }
.it-image img { width: 100%; height: auto; max-height: 55vh; object-fit: cover; border-radius: 16px; }
.it-text { flex: 1; min-width: 0; }

/* ── Fragment Animations ── */
.fragment.slide-up { transform: translateY(20px); opacity: 0; transition: all 0.5s ease; }
.fragment.slide-up.visible { transform: translateY(0); opacity: 1; }
.fragment.blur { filter: blur(6px); opacity: 0; transition: all 0.5s ease; }
.fragment.blur.visible { filter: none; opacity: 1; }
.fragment.scale-in { transform: scale(0.85); opacity: 0; transition: all 0.4s ease; }
.fragment.scale-in.visible { transform: scale(1); opacity: 1; }

/* ── Theme Overrides ── */
.reveal .slide-background { ${bgRule} }
.reveal .progress { color: var(--accent); height: 4px; }
.reveal .controls { color: var(--accent); }
.reveal .controls button { opacity: 0.6; transition: opacity 0.2s; }
.reveal .controls button:hover { opacity: 1; }

/* ── RWD ── */
@media (max-width: 768px) {
  .reveal .slides section { padding: 1.2em 1.5em; }
  .reveal h1 { font-size: 1.4em; }
  .slide-columns, .image-text-layout, .image-text-layout.img-right { flex-direction: column; }
  .stats-grid { flex-direction: column; align-items: center; }
  .icon-grid { grid-template-columns: repeat(2, 1fr) !important; }
  .chart-pie-wrap { flex-direction: column; }
}

${s.extra || ''}
`;
}

// ── HTML Generator ─────────────────────────────────────────────

function generateHtml(input: SlidesInput): string {
  const s = STYLES[input.style || ''] || DEFAULT_STYLE;
  const slides = input.slides.map((slide, i) => renderSlide(slide, s, i)).join('\n');

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
