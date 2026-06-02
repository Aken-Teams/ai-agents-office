/**
 * Server-side chart renderer for LINE bot.
 *
 * Pipeline: chart JSON spec → echarts SSR → SVG string → sharp → PNG buffer.
 *
 * The LINE bot can't render markdown code fences like the web UI does, so
 * `\`\`\`chart` / `\`\`\`echart` blocks were ending up as raw JSON text in
 * the chat. We instead:
 *   1. extract those blocks before the markdown stripper touches them
 *      (see formatter.extractChartBlocks)
 *   2. render each to a PNG via this module
 *   3. push the PNG as a LINE image message (handler.ts)
 *
 * Supported chart types: bar, pie, donut, line, area, radar, scatter — the
 * same shapes the web's ChatChart/ChatEChart components accept. We translate
 * each into ECharts options at the buildOption() layer.
 *
 * echarts is dynamic-imported on first use so cold-start cost is paid only
 * when a chart shows up, not on every server start.
 */

import sharp from 'sharp';

const CANVAS_WIDTH = 900;
const CANVAS_HEIGHT = 540;

const PALETTE = [
  '#1F77B4', '#FF7F0E', '#2CA02C', '#D62728', '#9467BD',
  '#8C564B', '#E377C2', '#7F7F7F', '#BCBD22', '#17BECF',
];

interface NamedValue { name: string; value: number; color: string | undefined }
interface SeriesPoints { name: string; data: NamedValue[]; color: string | undefined }
interface LineSeries { name: string; values?: number[]; color?: string; data?: NamedValue[] }

type Renderable = Record<string, unknown>;

let echartsPromise: Promise<typeof import('echarts')> | null = null;
function loadECharts(): Promise<typeof import('echarts')> {
  if (!echartsPromise) echartsPromise = import('echarts');
  return echartsPromise;
}

export interface RenderedChart {
  png: Buffer;
  width: number;
  height: number;
  title: string;
}

/**
 * Render a chart spec (already parsed JSON) to a PNG. Returns null when the
 * spec is unrecognisable so the caller can fall back to a text summary.
 */
export async function renderChartToPng(spec: unknown): Promise<RenderedChart | null> {
  const option = buildOption(spec);
  if (!option) return null;

  const echarts = await loadECharts();
  const chart = echarts.init(null, null, {
    renderer: 'svg',
    ssr: true,
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
  });
  try {
    chart.setOption({
      backgroundColor: '#FFFFFF',
      animation: false,
      color: PALETTE,
      ...option,
    });
    const svg = chart.renderToSVGString();
    const png = await sharp(Buffer.from(svg, 'utf-8'))
      .png({ compressionLevel: 9 })
      .toBuffer();
    return {
      png,
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT,
      title: extractTitle(spec) || 'chart',
    };
  } finally {
    chart.dispose();
  }
}

function extractTitle(spec: unknown): string {
  if (spec && typeof spec === 'object' && 'title' in spec) {
    const t = (spec as { title?: unknown }).title;
    if (typeof t === 'string') return t;
  }
  return '';
}

/**
 * Translate a chart spec (web-app native shape) into ECharts options.
 *
 * Web shape examples:
 *   {type:'bar', data:[{name, value}], horizontal?, xLabel, yLabel}
 *   {type:'pie'|'donut', data:[{name, value}]}
 *   {type:'line'|'area', series:[{name, data:[{name, value}]}], xLabel, yLabel}
 *   {type:'radar', axes:[...], series:[{name, values:[...]}]}
 *   {type:'scatter', series:[{name, data:[{x, y, z?}]}]}
 */
function buildOption(specIn: unknown): Renderable | null {
  if (!specIn || typeof specIn !== 'object') return null;
  const spec = specIn as Record<string, unknown>;
  const type = String(spec.type || '').toLowerCase();

  const title = typeof spec.title === 'string' ? {
    text: spec.title,
    left: 'center',
    top: 12,
    textStyle: { fontSize: 22, fontWeight: 600 },
  } : undefined;

  const baseGrid = { left: 60, right: 30, top: title ? 80 : 30, bottom: 50, containLabel: true };

  if (type === 'pie' || type === 'donut') {
    const data = sanitizeNamedValues(spec.data);
    if (!data.length) return null;
    return {
      title,
      tooltip: { trigger: 'item' },
      legend: { bottom: 10, type: 'scroll', textStyle: { fontSize: 13 } },
      series: [{
        type: 'pie',
        radius: type === 'donut' ? ['40%', '70%'] : '70%',
        center: ['50%', '52%'],
        data: data.map(d => ({ name: d.name, value: d.value, itemStyle: d.color ? { color: d.color } : undefined })),
        label: {
          formatter: '{b}\n{d}%',
          fontSize: 12,
        },
        labelLine: { length: 8, length2: 6 },
      }],
    };
  }

  if (type === 'bar') {
    const data = sanitizeNamedValues(spec.data);
    if (!data.length) return null;
    const horizontal = spec.horizontal === true;
    const categoryAxis = { type: 'category', data: data.map(d => d.name), axisLabel: { fontSize: 12 } } as Renderable;
    const valueAxis = { type: 'value', axisLabel: { fontSize: 12 } } as Renderable;
    return {
      title,
      grid: baseGrid,
      xAxis: horizontal ? valueAxis : categoryAxis,
      yAxis: horizontal ? categoryAxis : valueAxis,
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      series: [{
        type: 'bar',
        data: data.map((d, i) => ({ value: d.value, itemStyle: { color: d.color || PALETTE[i % PALETTE.length] } })),
        label: { show: true, position: horizontal ? 'right' : 'top', fontSize: 11 },
      }],
    };
  }

  if (type === 'line' || type === 'area') {
    const series = sanitizeSeriesPoints(spec.series);
    if (!series.length) return null;
    const categories = unionCategories(series);
    return {
      title,
      grid: baseGrid,
      legend: { top: title ? 44 : 12, textStyle: { fontSize: 13 } },
      xAxis: { type: 'category', data: categories, axisLabel: { fontSize: 12 } },
      yAxis: { type: 'value', axisLabel: { fontSize: 12 } },
      tooltip: { trigger: 'axis' },
      series: series.map(s => ({
        type: 'line',
        name: s.name,
        smooth: true,
        showSymbol: false,
        areaStyle: type === 'area' ? {} : undefined,
        data: categories.map(c => s.data.find(d => d.name === c)?.value ?? null),
      })),
    };
  }

  if (type === 'radar') {
    const axes = Array.isArray(spec.axes) ? (spec.axes as unknown[]).filter(a => typeof a === 'string') as string[] : [];
    const seriesIn = Array.isArray(spec.series) ? spec.series as LineSeries[] : [];
    if (!axes.length || !seriesIn.length) return null;
    const max = Math.max(1, ...seriesIn.flatMap(s => (s.values ?? []).map(Number).filter(Number.isFinite)));
    return {
      title,
      legend: { top: title ? 44 : 12, textStyle: { fontSize: 13 } },
      tooltip: {},
      radar: {
        indicator: axes.map(a => ({ name: a, max })),
        center: ['50%', '54%'],
        radius: '60%',
      },
      series: [{
        type: 'radar',
        data: seriesIn.map(s => ({ name: s.name, value: s.values ?? [] })),
      }],
    };
  }

  if (type === 'scatter') {
    const seriesIn = Array.isArray(spec.series) ? spec.series : [];
    if (!seriesIn.length) return null;
    return {
      title,
      grid: baseGrid,
      xAxis: { type: 'value' },
      yAxis: { type: 'value' },
      legend: { top: title ? 44 : 12, textStyle: { fontSize: 13 } },
      tooltip: { trigger: 'item' },
      series: seriesIn.map((s: any) => ({
        type: 'scatter',
        name: s?.name,
        data: Array.isArray(s?.data) ? s.data.map((d: any) => [Number(d?.x), Number(d?.y), Number(d?.z ?? 0)]) : [],
      })),
    };
  }

  return null;
}

function sanitizeNamedValues(input: unknown): NamedValue[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter(x => x && typeof x === 'object')
    .map(x => {
      const o = x as Record<string, unknown>;
      const name = typeof o.name === 'string' ? o.name : '';
      const value = Number(o.value);
      if (!name || !Number.isFinite(value)) return null;
      return { name, value, color: typeof o.color === 'string' ? o.color : undefined };
    })
    .filter((x): x is NamedValue => x !== null);
}

function sanitizeSeriesPoints(input: unknown): SeriesPoints[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter(x => x && typeof x === 'object')
    .map(x => {
      const o = x as Record<string, unknown>;
      const name = typeof o.name === 'string' ? o.name : '';
      const data = sanitizeNamedValues(o.data);
      if (!name && !data.length) return null;
      return { name: name || 'series', data, color: typeof o.color === 'string' ? o.color : undefined };
    })
    .filter((x): x is SeriesPoints => x !== null) as SeriesPoints[];
}

function unionCategories(series: SeriesPoints[]): string[] {
  const seen = new Set<string>();
  for (const s of series) for (const d of s.data) seen.add(d.name);
  return Array.from(seen);
}
