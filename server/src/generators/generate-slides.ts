#!/usr/bin/env node
/**
 * Reveal.js Slides Generator Script
 * Usage: node --import tsx generate-slides.ts <input.json> <output.html>
 *
 * Supports "style" field: "minimal" | "dark" | "gradient" | "neon"
 * Generates a self-contained HTML file with Reveal.js loaded from CDN.
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
  codeBg: string;
  codeColor: string;
  fontFamily: string;
  headingFontFamily: string;
  transition: string;
  extra?: string; // additional CSS
}

const STYLES: Record<string, StylePreset> = {
  'minimal': {
    bg: '#ffffff',
    titleColor: '#2d2d2d',
    subtitleColor: '#888888',
    headingColor: '#333333',
    bodyColor: '#555555',
    accentColor: '#aaaaaa',
    codeBg: '#f5f5f5',
    codeColor: '#333333',
    fontFamily: '"Segoe UI", "Helvetica Neue", Arial, sans-serif',
    headingFontFamily: '"Segoe UI", "Helvetica Neue", Arial, sans-serif',
    transition: 'slide',
  },
  'dark': {
    bg: '#1a1a2e',
    titleColor: '#00f0ff',
    subtitleColor: '#8888aa',
    headingColor: '#e0e0ff',
    bodyColor: '#aaaacc',
    accentColor: '#00f0ff',
    codeBg: '#0f0f23',
    codeColor: '#00f0ff',
    fontFamily: '"Segoe UI", "Helvetica Neue", Arial, sans-serif',
    headingFontFamily: '"Consolas", "Courier New", monospace',
    transition: 'convex',
  },
  'gradient': {
    bg: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    titleColor: '#ffffff',
    subtitleColor: 'rgba(255,255,255,0.7)',
    headingColor: '#ffffff',
    bodyColor: 'rgba(255,255,255,0.9)',
    accentColor: '#ffd700',
    codeBg: 'rgba(0,0,0,0.3)',
    codeColor: '#ffd700',
    fontFamily: '"Segoe UI", "Helvetica Neue", Arial, sans-serif',
    headingFontFamily: '"Segoe UI", "Helvetica Neue", Arial, sans-serif',
    transition: 'fade',
  },
  'neon': {
    bg: '#000000',
    titleColor: '#ff00ff',
    subtitleColor: '#00ffcc',
    headingColor: '#00ffcc',
    bodyColor: '#cccccc',
    accentColor: '#ff00ff',
    codeBg: '#111111',
    codeColor: '#00ff88',
    fontFamily: '"Segoe UI", "Helvetica Neue", Arial, sans-serif',
    headingFontFamily: '"Consolas", "Courier New", monospace',
    transition: 'zoom',
    extra: `
      .reveal h1, .reveal h2 { text-shadow: 0 0 20px currentColor, 0 0 40px currentColor; }
      .reveal .accent-line { box-shadow: 0 0 10px currentColor, 0 0 20px currentColor; }
    `,
  },
};

const DEFAULT_STYLE = STYLES['minimal'];

// ── Types ──────────────────────────────────────────────────────
interface SlideData {
  type: 'title' | 'content' | 'two-column' | 'section' | 'code' | 'image';
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
}

interface SlidesInput {
  title: string;
  author?: string;
  style?: string;
  slides: SlideData[];
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderSlide(slide: SlideData, s: StylePreset): string {
  const fragClass = slide.fragments ? ' class="fragment"' : '';

  switch (slide.type) {
    case 'title':
      return `
      <section>
        <h1 style="color:${s.titleColor};font-family:${s.headingFontFamily};margin-bottom:0.3em;">${escapeHtml(slide.title || '')}</h1>
        <div class="accent-line" style="width:120px;height:4px;background:${s.accentColor};margin:0.5em auto;"></div>
        ${slide.subtitle ? `<p style="color:${s.subtitleColor};font-size:0.7em;margin-top:0.8em;">${escapeHtml(slide.subtitle)}</p>` : ''}
      </section>`;

    case 'section':
      return `
      <section>
        <h2 style="color:${s.titleColor};font-family:${s.headingFontFamily};font-size:1.8em;">${escapeHtml(slide.title || '')}</h2>
        <div class="accent-line" style="width:80px;height:3px;background:${s.accentColor};margin:0.5em auto;"></div>
      </section>`;

    case 'content': {
      let body = '';
      if (slide.bullets) {
        body = `<ul style="color:${s.bodyColor};font-size:0.75em;line-height:1.8;list-style:none;padding:0;">
          ${slide.bullets.map(b => `<li${fragClass} style="margin-bottom:0.4em;padding-left:1.2em;position:relative;">
            <span style="position:absolute;left:0;color:${s.accentColor};">▸</span>${escapeHtml(b)}</li>`).join('\n          ')}
        </ul>`;
      } else if (slide.text) {
        body = `<p style="color:${s.bodyColor};font-size:0.75em;line-height:1.6;">${escapeHtml(slide.text)}</p>`;
      }
      return `
      <section>
        ${slide.title ? `<h2 style="color:${s.headingColor};font-family:${s.headingFontFamily};text-align:left;font-size:1.3em;margin-bottom:0.6em;">${escapeHtml(slide.title)}</h2>` : ''}
        ${body}
      </section>`;
    }

    case 'two-column': {
      const renderCol = (col: { heading: string; bullets: string[] }) => `
        <div style="flex:1;padding:0 0.5em;">
          <h3 style="color:${s.headingColor};font-size:0.9em;margin-bottom:0.5em;">${escapeHtml(col.heading)}</h3>
          <ul style="color:${s.bodyColor};font-size:0.65em;line-height:1.8;list-style:none;padding:0;">
            ${col.bullets.map(b => `<li${fragClass} style="margin-bottom:0.3em;padding-left:1em;position:relative;">
              <span style="position:absolute;left:0;color:${s.accentColor};">▸</span>${escapeHtml(b)}</li>`).join('\n            ')}
          </ul>
        </div>`;
      return `
      <section>
        ${slide.title ? `<h2 style="color:${s.headingColor};font-family:${s.headingFontFamily};text-align:left;font-size:1.3em;margin-bottom:0.6em;">${escapeHtml(slide.title)}</h2>` : ''}
        <div style="display:flex;gap:1em;">
          ${slide.left ? renderCol(slide.left) : ''}
          ${slide.right ? renderCol(slide.right) : ''}
        </div>
      </section>`;
    }

    case 'code':
      return `
      <section>
        ${slide.title ? `<h2 style="color:${s.headingColor};font-family:${s.headingFontFamily};text-align:left;font-size:1.3em;margin-bottom:0.6em;">${escapeHtml(slide.title)}</h2>` : ''}
        <pre style="background:${s.codeBg};border-radius:8px;padding:1em;text-align:left;"><code class="language-${slide.language || 'plaintext'}" style="color:${s.codeColor};font-size:0.6em;line-height:1.6;">${escapeHtml(slide.code || '')}</code></pre>
      </section>`;

    case 'image':
      return `
      <section>
        ${slide.title ? `<h2 style="color:${s.headingColor};font-family:${s.headingFontFamily};font-size:1.3em;margin-bottom:0.6em;">${escapeHtml(slide.title)}</h2>` : ''}
        <img src="${escapeHtml(slide.imageSrc || '')}" alt="${escapeHtml(slide.imageAlt || '')}" style="max-width:80%;max-height:60vh;border-radius:8px;">
      </section>`;

    default:
      return `<section><p style="color:${s.bodyColor};">${escapeHtml(slide.title || 'Untitled Slide')}</p></section>`;
  }
}

function generateHtml(input: SlidesInput): string {
  const s = STYLES[input.style || ''] || DEFAULT_STYLE;
  const isGradientBg = s.bg.startsWith('linear-gradient');
  const bgStyle = isGradientBg ? `background: ${s.bg};` : `background-color: ${s.bg};`;

  const slides = input.slides.map(slide => renderSlide(slide, s)).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="author" content="${escapeHtml(input.author || 'AI Agents Office')}">
  <title>${escapeHtml(input.title)}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/reveal.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/theme/white.css" id="theme">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/plugin/highlight/monokai.css">
  <style>
    .reveal { font-family: ${s.fontFamily}; }
    .reveal .slides section { ${bgStyle} padding: 2em; box-sizing: border-box; }
    .reveal h1, .reveal h2, .reveal h3 { font-family: ${s.headingFontFamily}; font-weight: 700; }
    .reveal .slide-background { ${bgStyle} }
    .reveal .progress { color: ${s.accentColor}; }
    .reveal .controls { color: ${s.accentColor}; }
    /* Override theme background */
    body { ${bgStyle} margin: 0; }
    .reveal-viewport { ${bgStyle} }
    ${s.extra || ''}
  </style>
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
