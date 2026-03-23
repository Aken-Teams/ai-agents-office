'use client';

import { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import {
  ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  LineChart, Line,
  AreaChart, Area,
  PieChart, Pie, Cell,
  RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar,
  ScatterChart, Scatter, ZAxis,
} from 'recharts';
import type { ChartData, DataSeries } from './types';
import { validateChartData } from './types';
import { getChartColors, getThemeVars } from './chartTheme';

function isIncompleteJson(s: string): boolean {
  const t = s.trim();
  if (!t) return true;
  return (t[0] === '{' || t[0] === '[') && !t.endsWith('}') && !t.endsWith(']');
}

function mergeSeriesData(series: DataSeries[]) {
  const map = new Map<string, Record<string, string | number>>();
  for (const s of series) {
    for (const pt of s.data) {
      if (!map.has(pt.name)) map.set(pt.name, { name: pt.name });
      map.get(pt.name)![s.name] = pt.value;
    }
  }
  return Array.from(map.values());
}

interface ChatChartProps {
  rawJson: string;
}

export default function ChatChart({ rawJson }: ChatChartProps) {
  const [showRaw, setShowRaw] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [themeKey, setThemeKey] = useState(0);
  const chartRef = useRef<HTMLDivElement>(null);

  // Re-render on theme change
  useEffect(() => {
    const observer = new MutationObserver(() => setThemeKey(k => k + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  const parsed = useMemo<{ data: ChartData | null; error: string | null }>(() => {
    try {
      const obj = JSON.parse(rawJson);
      if (!obj || !obj.type) return { data: null, error: 'Missing "type" field' };
      const validTypes = ['bar', 'line', 'area', 'pie', 'donut', 'radar', 'scatter'];
      if (!validTypes.includes(obj.type)) return { data: null, error: `Unknown type: "${obj.type}"` };
      const err = validateChartData(obj as ChartData);
      if (err) return { data: null, error: err };
      return { data: obj as ChartData, error: null };
    } catch (e) {
      return { data: null, error: (e as Error).message };
    }
  }, [rawJson]);

  // Show loading during streaming
  if (parsed.error && isIncompleteJson(rawJson)) {
    return (
      <div className="chat-chart-container">
        <div className="chat-chart-body" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span className="text-sm opacity-50 animate-pulse">Rendering chart...</span>
        </div>
      </div>
    );
  }

  if (parsed.error || !parsed.data) {
    return (
      <div className="chat-chart-fallback">
        <div className="chat-chart-fallback-header">
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>warning</span>
          <span>Chart error{parsed.error ? `: ${parsed.error}` : ''}</span>
        </div>
        <pre><code>{rawJson}</code></pre>
      </div>
    );
  }

  const chart = parsed.data;
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const { colors, theme } = useMemo(() => {
    void themeKey; // depend on themeKey to refresh colors on theme change
    return { colors: getChartColors(), theme: getThemeVars() };
  }, [themeKey]);

  const tooltipStyle = {
    contentStyle: { background: theme.bg, border: `1px solid ${theme.grid}`, borderRadius: 8, fontSize: 13 },
    labelStyle: { color: theme.text },
  };
  const axisStyle = { tick: { fill: theme.subtext, fontSize: 12 }, axisLine: { stroke: theme.grid } };
  const gridStyle = { strokeDasharray: '3 3', stroke: theme.grid, opacity: 0.5 };

  const handleDownloadPng = useCallback(() => {
    const el = chartRef.current;
    if (!el) return;
    const svgEl = el.querySelector('svg');
    if (!svgEl) return;
    const svgData = new XMLSerializer().serializeToString(svgEl);
    const canvas = document.createElement('canvas');
    const scale = 2;
    const w = svgEl.clientWidth || 600;
    const h = svgEl.clientHeight || 280;
    canvas.width = w * scale;
    canvas.height = h * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(scale, scale);
    const img = new Image();
    const blob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      ctx.fillStyle = theme.bg;
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      const a = document.createElement('a');
      a.href = canvas.toDataURL('image/png');
      a.download = `${chart.title || 'chart'}.png`;
      a.click();
    };
    img.src = url;
  }, [chart.title, theme.bg]);

  return (
    <>
      <div className="chat-chart-container">
        {chart.title && <div className="chat-chart-title">{chart.title}</div>}
        <div className="chat-chart-body" ref={chartRef}>
          <ResponsiveContainer width="100%" height={280}>
            {renderChart(chart, colors, theme, axisStyle, gridStyle, tooltipStyle)}
          </ResponsiveContainer>
        </div>
        {/* Toolbar */}
        <div className="flex items-center gap-1 px-3 py-1.5 border-t border-[var(--chart-border)]">
          <button className="chat-chart-toggle flex items-center gap-1" onClick={() => setFullscreen(true)}>
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>fullscreen</span>
            <span>Expand</span>
          </button>
          <button className="chat-chart-toggle flex items-center gap-1" onClick={handleDownloadPng}>
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>image</span>
            <span>PNG</span>
          </button>
          <button className="chat-chart-toggle flex items-center gap-1" onClick={() => setShowRaw(!showRaw)}>
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>{showRaw ? 'visibility_off' : 'data_object'}</span>
            <span>{showRaw ? 'Hide' : 'Data'}</span>
          </button>
        </div>
        {showRaw && (
          <pre className="chat-chart-raw"><code>{JSON.stringify(chart, null, 2)}</code></pre>
        )}
      </div>

      {/* Fullscreen modal */}
      {fullscreen && (
        <div
          className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm flex items-center justify-center"
          onClick={() => setFullscreen(false)}
        >
          <div
            className="bg-surface rounded-xl shadow-2xl w-[85vw] max-h-[90vh] overflow-auto p-8 relative"
            onClick={e => e.stopPropagation()}
          >
            <button
              onClick={() => setFullscreen(false)}
              className="absolute top-3 right-3 w-8 h-8 flex items-center justify-center rounded-lg bg-surface-container-high hover:bg-surface-container-highest text-on-surface-variant cursor-pointer transition-colors"
            >
              <span className="material-symbols-outlined text-sm">close</span>
            </button>
            {chart.title && <div className="text-lg font-bold text-on-surface mb-4">{chart.title}</div>}
            <ResponsiveContainer width="100%" height={500}>
              {renderChart(chart, colors, theme, axisStyle, gridStyle, tooltipStyle)}
            </ResponsiveContainer>
            <div className="flex items-center gap-2 mt-4 pt-3 border-t border-outline-variant/20">
              <button onClick={handleDownloadPng} className="px-3 py-1.5 text-xs font-bold bg-primary/10 text-primary rounded-lg hover:bg-primary/20 transition-colors cursor-pointer flex items-center gap-1">
                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>image</span> Download PNG
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function renderChart(
  chart: ChartData,
  colors: string[],
  theme: ReturnType<typeof getThemeVars>,
  axisStyle: Record<string, unknown>,
  gridStyle: Record<string, unknown>,
  tooltipStyle: Record<string, unknown>,
) {
  switch (chart.type) {
    case 'bar': {
      return (
        <BarChart data={chart.data} layout={chart.horizontal ? 'vertical' : 'horizontal'}>
          <CartesianGrid {...gridStyle} />
          {chart.horizontal ? (
            <>
              <YAxis dataKey="name" type="category" {...axisStyle} width={80} />
              <XAxis type="number" {...axisStyle} />
            </>
          ) : (
            <>
              <XAxis dataKey="name" {...axisStyle} />
              <YAxis {...axisStyle} />
            </>
          )}
          <Tooltip {...tooltipStyle} />
          <Bar dataKey="value" radius={[4, 4, 0, 0]}>
            {chart.data.map((entry, i) => (
              <Cell key={i} fill={entry.color || colors[i % colors.length]} />
            ))}
          </Bar>
        </BarChart>
      );
    }

    case 'line': {
      const merged = mergeSeriesData(chart.series);
      return (
        <LineChart data={merged}>
          <CartesianGrid {...gridStyle} />
          <XAxis dataKey="name" {...axisStyle} />
          <YAxis {...axisStyle} />
          <Tooltip {...tooltipStyle} />
          {chart.series.length > 1 && <Legend />}
          {chart.series.map((s, i) => (
            <Line key={s.name} type={chart.smooth ? 'monotone' : 'linear'}
              dataKey={s.name} stroke={s.color || colors[i % colors.length]}
              strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} />
          ))}
        </LineChart>
      );
    }

    case 'area': {
      const merged = mergeSeriesData(chart.series);
      return (
        <AreaChart data={merged}>
          <CartesianGrid {...gridStyle} />
          <XAxis dataKey="name" {...axisStyle} />
          <YAxis {...axisStyle} />
          <Tooltip {...tooltipStyle} />
          {chart.series.length > 1 && <Legend />}
          {chart.series.map((s, i) => (
            <Area key={s.name} type="monotone" dataKey={s.name}
              fill={s.color || colors[i % colors.length]}
              stroke={s.color || colors[i % colors.length]}
              fillOpacity={0.3} stackId={chart.stacked ? 'stack' : undefined} />
          ))}
        </AreaChart>
      );
    }

    case 'pie':
    case 'donut': {
      const innerR = chart.type === 'donut' ? (chart.innerRadius ?? 60) : 0;
      return (
        <PieChart>
          <Pie data={chart.data} dataKey="value" nameKey="name" cx="50%" cy="50%"
            innerRadius={innerR} outerRadius={100} paddingAngle={2}
            label={({ name, percent }: // eslint-disable-next-line @typescript-eslint/no-explicit-any
              any) => `${name || ''} ${((percent || 0) * 100).toFixed(0)}%`}
            labelLine={{ stroke: theme.subtext }}>
            {chart.data.map((entry, i) => (
              <Cell key={i} fill={entry.color || colors[i % colors.length]} />
            ))}
          </Pie>
          <Tooltip {...tooltipStyle} />
        </PieChart>
      );
    }

    case 'radar': {
      const radarData = chart.axes.map((axis, i) => {
        const point: Record<string, string | number> = { axis };
        chart.series.forEach(s => { point[s.name] = s.values[i] ?? 0; });
        return point;
      });
      return (
        <RadarChart data={radarData} cx="50%" cy="50%" outerRadius={100}>
          <PolarGrid stroke={theme.grid} />
          <PolarAngleAxis dataKey="axis" tick={{ fill: theme.subtext, fontSize: 11 }} />
          <PolarRadiusAxis tick={{ fill: theme.subtext, fontSize: 10 }} />
          {chart.series.map((s, i) => (
            <Radar key={s.name} name={s.name} dataKey={s.name}
              stroke={s.color || colors[i % colors.length]}
              fill={s.color || colors[i % colors.length]}
              fillOpacity={0.2} />
          ))}
          {chart.series.length > 1 && <Legend />}
          <Tooltip {...tooltipStyle} />
        </RadarChart>
      );
    }

    case 'scatter': {
      return (
        <ScatterChart>
          <CartesianGrid {...gridStyle} />
          <XAxis dataKey="x" name={chart.xLabel || 'X'} type="number" {...axisStyle} />
          <YAxis dataKey="y" name={chart.yLabel || 'Y'} type="number" {...axisStyle} />
          <ZAxis dataKey="z" range={[20, 400]} />
          <Tooltip {...tooltipStyle} cursor={{ strokeDasharray: '3 3' }} />
          {chart.series.length > 1 && <Legend />}
          {chart.series.map((s, i) => (
            <Scatter key={s.name} name={s.name} data={s.data}
              fill={s.color || colors[i % colors.length]} />
          ))}
        </ScatterChart>
      );
    }
  }
}
