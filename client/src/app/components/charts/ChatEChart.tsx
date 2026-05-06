'use client';

import { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from '../../../i18n/index';
import { getChartColors, getThemeVars } from './chartTheme';

function isIncompleteJson(s: string): boolean {
  const t = s.trim();
  if (!t) return true;
  return (t[0] === '{' || t[0] === '[') && !t.endsWith('}') && !t.endsWith(']');
}

function extractTitle(option: any): string {
  if (!option) return '';
  if (typeof option.title === 'string') return option.title;
  if (option.title?.text) return option.title.text;
  if (Array.isArray(option.title) && option.title[0]?.text) return option.title[0].text;
  return '';
}

function buildEChartsTheme() {
  const theme = getThemeVars();
  const colors = getChartColors();
  return {
    colors,
    themeOption: {
      color: colors,
      backgroundColor: 'transparent',
      textStyle: { color: theme.text, fontFamily: 'Inter, system-ui, sans-serif' },
      title: { textStyle: { color: theme.text, fontSize: 14, fontWeight: 600 } },
      legend: { textStyle: { color: theme.subtext, fontSize: 12 } },
      tooltip: {
        backgroundColor: theme.bg,
        borderColor: theme.grid,
        textStyle: { color: theme.text, fontSize: 12 },
      },
      categoryAxis: {
        axisLine: { lineStyle: { color: theme.grid } },
        axisLabel: { color: theme.subtext, fontSize: 11 },
        splitLine: { lineStyle: { color: theme.grid, opacity: 0.3 } },
      },
      valueAxis: {
        axisLine: { lineStyle: { color: theme.grid } },
        axisLabel: { color: theme.subtext, fontSize: 11 },
        splitLine: { lineStyle: { color: theme.grid, opacity: 0.3 } },
      },
    },
    themeVars: theme,
  };
}

interface ChatEChartProps {
  rawJson: string;
}

export default function ChatEChart({ rawJson }: ChatEChartProps) {
  const { t } = useTranslation();
  const [showRaw, setShowRaw] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [themeKey, setThemeKey] = useState(0);
  const chartRef = useRef<HTMLDivElement>(null);
  const echartsInstanceRef = useRef<any>(null);
  const fullscreenChartRef = useRef<HTMLDivElement>(null);
  const fullscreenInstanceRef = useRef<any>(null);
  const roRef = useRef<ResizeObserver | null>(null);

  // Theme change detection
  useEffect(() => {
    const observer = new MutationObserver(() => setThemeKey(k => k + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  // Parse ECharts option
  const parsed = useMemo<{ option: any | null; error: string | null }>(() => {
    try {
      const obj = JSON.parse(rawJson);
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        return { option: null, error: 'EChart option must be a JSON object' };
      }
      const hasContent = obj.series || obj.xAxis || obj.yAxis || obj.radar ||
        obj.geo || obj.graphic || obj.dataset || obj.calendar || obj.visualMap;
      if (!hasContent) {
        return { option: null, error: 'EChart option missing series or axis config' };
      }
      return { option: obj, error: null };
    } catch (e) {
      return { option: null, error: (e as Error).message };
    }
  }, [rawJson]);

  const title = parsed.option ? extractTitle(parsed.option) : '';

  // Initialize main chart
  useEffect(() => {
    if (!parsed.option || !chartRef.current) return;
    let cancelled = false;

    (async () => {
      const echarts = await import('echarts');
      if (cancelled || !chartRef.current) return;

      if (echartsInstanceRef.current) {
        echartsInstanceRef.current.dispose();
      }

      const el = chartRef.current;
      if (!el.clientWidth || !el.clientHeight) return;

      const { themeOption } = buildEChartsTheme();
      const instance = echarts.init(el);
      // Merge theme defaults with user option
      const mergedOption = { ...themeOption, ...parsed.option };
      if (!parsed.option.color) mergedOption.color = themeOption.color;
      try {
        instance.setOption(mergedOption);
      } catch {
        instance.dispose();
        return;
      }
      echartsInstanceRef.current = instance;

      roRef.current?.disconnect();
      roRef.current = new ResizeObserver(() => instance.resize());
      roRef.current.observe(chartRef.current);
    })();

    return () => {
      cancelled = true;
      roRef.current?.disconnect();
      if (echartsInstanceRef.current) {
        echartsInstanceRef.current.dispose();
        echartsInstanceRef.current = null;
      }
    };
  }, [parsed.option, themeKey]);

  // Initialize fullscreen chart
  useEffect(() => {
    if (!fullscreen || !parsed.option || !fullscreenChartRef.current) return;
    let cancelled = false;

    (async () => {
      const echarts = await import('echarts');
      if (cancelled || !fullscreenChartRef.current) return;

      if (fullscreenInstanceRef.current) {
        fullscreenInstanceRef.current.dispose();
      }

      const { themeOption } = buildEChartsTheme();
      const instance = echarts.init(fullscreenChartRef.current);
      const mergedOption = { ...themeOption, ...parsed.option };
      if (!parsed.option.color) mergedOption.color = themeOption.color;
      instance.setOption(mergedOption);
      fullscreenInstanceRef.current = instance;

      const ro = new ResizeObserver(() => instance.resize());
      ro.observe(fullscreenChartRef.current);

      return () => ro.disconnect();
    })();

    return () => {
      cancelled = true;
      if (fullscreenInstanceRef.current) {
        fullscreenInstanceRef.current.dispose();
        fullscreenInstanceRef.current = null;
      }
    };
  }, [fullscreen, parsed.option, themeKey]);

  // PNG export via ECharts built-in getDataURL
  const handleDownloadPng = useCallback(() => {
    const instance = fullscreen ? fullscreenInstanceRef.current : echartsInstanceRef.current;
    if (!instance) return;
    const { themeVars } = buildEChartsTheme();
    const url = instance.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: themeVars.bg });
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title || 'echart'}.png`;
    a.click();
  }, [title, fullscreen]);

  // HTML export with ECharts CDN
  const handleDownloadHtml = useCallback(() => {
    if (!parsed.option) return;
    const json = JSON.stringify(parsed.option);
    const safeTitle = (title || 'EChart').replace(/</g, '&lt;');
    const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${safeTitle}</title>
<style>body{margin:0;padding:40px;font-family:Inter,system-ui,sans-serif;background:#f8f9fa;display:flex;justify-content:center}
#chart{width:100%;max-width:960px;height:600px;background:#fff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,.1);padding:20px;box-sizing:border-box}</style>
</head><body><div id="chart"></div>
<script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"><\/script>
<script>
var chart=echarts.init(document.getElementById('chart'));
chart.setOption(${json});
window.addEventListener('resize',function(){chart.resize()});
<\/script></body></html>`;
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title || 'echart'}.html`;
    a.click();
    URL.revokeObjectURL(url);
  }, [parsed.option, title]);

  // Streaming state
  if (parsed.error && isIncompleteJson(rawJson)) {
    return (
      <div className="chat-chart-container">
        <div className="chat-echart-body" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span className="text-sm opacity-50 animate-pulse">{t('chart.status.rendering' as any)}</span>
        </div>
      </div>
    );
  }

  // Error state
  if (parsed.error || !parsed.option) {
    return (
      <div className="chat-chart-fallback">
        <div className="chat-chart-fallback-header">
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>warning</span>
          <span>{t('chart.error.chart' as any)}{parsed.error ? `: ${parsed.error}` : ''}</span>
        </div>
        <pre><code>{rawJson}</code></pre>
      </div>
    );
  }

  return (
    <>
      <div className="chat-chart-container">
        {title && <div className="chat-chart-title">{title}</div>}
        <div className="chat-echart-body" ref={chartRef} />
        {/* Toolbar */}
        <div className="flex items-center flex-wrap gap-1 px-2 md:px-3 py-1.5 border-t border-[var(--chart-border)]">
          <button className="chat-chart-toggle flex items-center gap-1" onClick={() => setFullscreen(true)}>
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>fullscreen</span>
            <span>{t('chart.action.expand' as any)}</span>
          </button>
          <button className="chat-chart-toggle flex items-center gap-1" onClick={handleDownloadHtml}>
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>code</span>
            <span>{t('chart.action.downloadHtml' as any)}</span>
          </button>
          <button className="chat-chart-toggle flex items-center gap-1" onClick={handleDownloadPng}>
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>image</span>
            <span>{t('chart.action.downloadPng' as any)}</span>
          </button>
          <button className="chat-chart-toggle flex items-center gap-1" onClick={() => setShowRaw(!showRaw)}>
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>{showRaw ? 'visibility_off' : 'data_object'}</span>
            <span>{showRaw ? t('chart.action.hide' as any) : t('chart.action.data' as any)}</span>
          </button>
        </div>
        {showRaw && (
          <pre className="chat-chart-raw"><code>{JSON.stringify(parsed.option, null, 2)}</code></pre>
        )}
      </div>

      {/* Fullscreen modal */}
      {fullscreen && (
        <div
          className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm flex items-center justify-center"
          onClick={() => setFullscreen(false)}
        >
          <div
            className="bg-surface rounded-xl shadow-2xl w-[95vw] md:w-[85vw] max-h-[90vh] overflow-auto p-4 md:p-8 relative"
            onClick={e => e.stopPropagation()}
          >
            <button
              onClick={() => setFullscreen(false)}
              className="absolute top-3 right-3 w-8 h-8 flex items-center justify-center rounded-lg bg-surface-container-high hover:bg-surface-container-highest text-on-surface-variant cursor-pointer transition-colors z-10"
            >
              <span className="material-symbols-outlined text-sm">close</span>
            </button>
            {title && <div className="text-base md:text-lg font-bold text-on-surface mb-3 md:mb-4 pr-10">{title}</div>}
            <div ref={fullscreenChartRef} style={{ width: '100%', height: typeof window !== 'undefined' && window.innerWidth < 768 ? 320 : 500 }} />
            <div className="flex items-center flex-wrap gap-2 mt-3 md:mt-4 pt-3 border-t border-outline-variant/20">
              <button onClick={handleDownloadHtml} className="px-3 py-1.5 text-xs font-bold bg-primary/10 text-primary rounded-lg hover:bg-primary/20 transition-colors cursor-pointer flex items-center gap-1">
                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>code</span> {t('chart.action.downloadHtml' as any)}
              </button>
              <button onClick={handleDownloadPng} className="px-3 py-1.5 text-xs font-bold bg-primary/10 text-primary rounded-lg hover:bg-primary/20 transition-colors cursor-pointer flex items-center gap-1">
                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>image</span> {t('chart.action.downloadPngFull' as any)}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
