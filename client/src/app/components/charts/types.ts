// Chart data types for inline chat charts

export interface DataPoint {
  name: string;
  value: number;
  color?: string;
}

export interface DataSeries {
  name: string;
  data: DataPoint[];
  color?: string;
}

export interface BarChartData {
  type: 'bar';
  title?: string;
  data: DataPoint[];
  horizontal?: boolean;
  xLabel?: string;
  yLabel?: string;
}

export interface LineChartData {
  type: 'line';
  title?: string;
  series: DataSeries[];
  xLabel?: string;
  yLabel?: string;
  smooth?: boolean;
}

export interface AreaChartData {
  type: 'area';
  title?: string;
  series: DataSeries[];
  stacked?: boolean;
  xLabel?: string;
  yLabel?: string;
}

export interface PieChartData {
  type: 'pie' | 'donut';
  title?: string;
  data: DataPoint[];
  innerRadius?: number;
}

export interface RadarChartData {
  type: 'radar';
  title?: string;
  axes: string[];
  series: { name: string; values: number[]; color?: string }[];
}

export interface ScatterChartData {
  type: 'scatter';
  title?: string;
  series: { name: string; data: { x: number; y: number; z?: number }[]; color?: string }[];
  xLabel?: string;
  yLabel?: string;
}

export type ChartData =
  | BarChartData
  | LineChartData
  | AreaChartData
  | PieChartData
  | RadarChartData
  | ScatterChartData;

// Accept common AI-emitted variants and coerce them into the canonical ChartData shape.
// Covers Recharts-native radar ({data:[{subject,...}], dataKeys:[]}) and ECharts-native
// radar ({indicator:[{name}], series:[{data:[{value,name}]}]}).
export function normalizeChartData(input: any): any {
  if (!input || typeof input !== 'object' || !input.type) return input;

  if (input.type === 'radar') {
    // Already canonical — nothing to do.
    if (Array.isArray(input.axes) && Array.isArray(input.series)
        && input.series.every((s: any) => Array.isArray(s?.values))) {
      return input;
    }

    // ECharts-style: indicator[] + series[].data[].value
    if (Array.isArray(input.indicator) && Array.isArray(input.series)) {
      const axes = input.indicator.map((it: any) => it?.name).filter((x: any) => typeof x === 'string');
      const series: { name: string; values: number[]; color?: string }[] = [];
      for (const s of input.series) {
        const rows = Array.isArray(s?.data) ? s.data : [];
        for (const r of rows) {
          if (Array.isArray(r?.value)) series.push({ name: r.name || s.name || '', values: r.value, color: r.color });
        }
      }
      if (axes.length && series.length) return { ...input, axes, series };
    }

    // Recharts-style: data[{<subjectKey>, <seriesName>: number, ...}] + dataKeys[]
    if (Array.isArray(input.data) && input.data.length > 0) {
      const rows = input.data;
      const subjectKey = ['subject', 'name', 'axis', 'category', 'label'].find(k =>
        rows.every((r: any) => r && typeof r[k] === 'string'),
      );
      const dataKeys: string[] = Array.isArray(input.dataKeys) && input.dataKeys.length
        ? input.dataKeys
        : Object.keys(rows[0]).filter(k => k !== subjectKey && typeof rows[0][k] === 'number');
      if (subjectKey && dataKeys.length) {
        const axes = rows.map((r: any) => r[subjectKey]);
        const series = dataKeys.map(name => ({
          name,
          values: rows.map((r: any) => Number(r[name] ?? 0)),
        }));
        return { ...input, axes, series };
      }
    }
  }

  return input;
}

export function validateChartData(data: ChartData): string | null {
  switch (data.type) {
    case 'bar':
      if (!Array.isArray(data.data) || data.data.length === 0) return 'Bar chart requires non-empty "data" array';
      break;
    case 'line':
    case 'area':
      if (!Array.isArray(data.series) || data.series.length === 0) return `${data.type} chart requires non-empty "series" array`;
      break;
    case 'pie':
    case 'donut':
      if (!Array.isArray(data.data) || data.data.length === 0) return 'Pie chart requires non-empty "data" array';
      break;
    case 'radar':
      if (!Array.isArray(data.axes) || !Array.isArray(data.series)) return 'Radar chart requires "axes" and "series" arrays';
      break;
    case 'scatter':
      if (!Array.isArray(data.series) || data.series.length === 0) return 'Scatter chart requires non-empty "series" array';
      break;
  }
  return null;
}
