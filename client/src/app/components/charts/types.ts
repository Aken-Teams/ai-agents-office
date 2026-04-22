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
