'use client';

/**
 * Stacked token-usage bar chart for admin dashboards.
 *
 * Each day is rendered as one vertical bar, segmented by model. The top N
 * models across the period get distinct colours; everything else is folded
 * into an "其他" / "其他" / "Other" bucket. A legend below the bars maps
 * colour → short model name.
 */

import { useMemo } from 'react';
import { useTranslation } from '../../../i18n';

export interface ChartByModelEntry {
  model: string;
  provider: string;
  input: number;
  output: number;
}

export interface TokenChartPoint {
  date: string;
  total_input: number;
  total_output: number;
  invocation_count: number;
  byModel: ChartByModelEntry[];
}

interface Props {
  data: TokenChartPoint[];
  period: '7d' | '30d';
}

/**
 * Display palette — Tailwind theme tokens already wired up for both light
 * and dark mode. Listed in usage priority order; the most-used model gets
 * the brightest accent.
 */
const PALETTE: { bg: string; legend: string }[] = [
  { bg: 'bg-primary',    legend: 'bg-primary' },
  { bg: 'bg-tertiary',   legend: 'bg-tertiary' },
  { bg: 'bg-success',    legend: 'bg-success' },
  { bg: 'bg-warning',    legend: 'bg-warning' },
  { bg: 'bg-secondary',  legend: 'bg-secondary' },
];
const OTHER_BG = 'bg-on-surface-variant';
const TOP_N = PALETTE.length;

/** Friendly short label for full model IDs. */
function shortModelName(model: string): string {
  if (!model || model === 'unknown') return '(unknown)';
  // claude-sonnet-4-5-20250929 → Claude Sonnet 4.5
  if (/^claude-?sonnet/i.test(model)) return 'Claude Sonnet';
  if (/^claude-?haiku/i.test(model)) return 'Claude Haiku';
  if (/^claude-?opus/i.test(model)) return 'Claude Opus';
  if (/^claude/i.test(model)) return 'Claude';
  // mlx-community/gpt-oss-120b-MXFP4-Q4 → GPT-OSS 120B
  if (/gpt-?oss/i.test(model)) {
    const sizeMatch = model.match(/(\d+)b/i);
    return sizeMatch ? `GPT-OSS ${sizeMatch[1]}B` : 'GPT-OSS';
  }
  if (/deepseek-?v?(\d+)?-?flash/i.test(model)) return 'DeepSeek Flash';
  if (/deepseek/i.test(model)) return 'DeepSeek';
  if (/^gpt-/i.test(model)) return model.toUpperCase().slice(0, 14);
  if (/llama/i.test(model)) return 'Llama';
  // Path-style names → take last segment
  const tail = model.split('/').pop() ?? model;
  return tail.length > 18 ? tail.slice(0, 16) + '…' : tail;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

interface ModelSlot {
  key: string;       // canonical model id (or '_other')
  label: string;
  total: number;
  colorBg: string;
}

export default function TokenChartBars({ data, period }: Props) {
  const { t } = useTranslation();

  // 1) Aggregate totals per model across the whole range so we can pick the top N.
  // 2) Each day's bar is split into TOP_N coloured segments + one "other" segment.
  const { modelSlots, otherSlot, perDayBuckets, maxDayTotal } = useMemo(() => {
    const totals = new Map<string, number>();
    for (const day of data) {
      for (const m of day.byModel) {
        totals.set(m.model, (totals.get(m.model) ?? 0) + m.input + m.output);
      }
    }
    const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
    const topModels = sorted.slice(0, TOP_N).map(([m]) => m);
    const otherModels = new Set(sorted.slice(TOP_N).map(([m]) => m));

    const slotByModel = new Map<string, ModelSlot>();
    topModels.forEach((m, i) => {
      slotByModel.set(m, {
        key: m,
        label: shortModelName(m),
        total: totals.get(m) ?? 0,
        colorBg: PALETTE[i].bg,
      });
    });

    const otherTotal = [...otherModels].reduce((s, m) => s + (totals.get(m) ?? 0), 0);
    const otherSlot: ModelSlot | null = otherTotal > 0
      ? { key: '_other', label: t('admin.tokens.chart.other' as any) || 'Other', total: otherTotal, colorBg: OTHER_BG }
      : null;

    const slotOrder: ModelSlot[] = [...slotByModel.values()];
    if (otherSlot) slotOrder.push(otherSlot);

    // For each day, compute the total for every slot (in the same order).
    const perDayBuckets = data.map(day => {
      const buckets = slotOrder.map(slot => ({ slot, value: 0 }));
      for (const m of day.byModel) {
        const idx = topModels.indexOf(m.model);
        if (idx >= 0) {
          buckets[idx].value += m.input + m.output;
        } else if (otherSlot) {
          buckets[buckets.length - 1].value += m.input + m.output;
        }
      }
      const total = buckets.reduce((s, b) => s + b.value, 0);
      return { date: day.date, total, buckets };
    });

    const maxDayTotal = Math.max(...perDayBuckets.map(d => d.total), 1);
    return { modelSlots: slotOrder, otherSlot, perDayBuckets, maxDayTotal };
  }, [data, t]);

  if (data.length === 0 || perDayBuckets.every(d => d.total === 0)) {
    return (
      <div className="h-40 flex items-center justify-center text-on-surface-variant text-sm">
        <span className="material-symbols-outlined mr-2">info</span>
        {t('admin.tokens.chart.noData' as any)}
      </div>
    );
  }

  return (
    <div>
      {/* Bars */}
      <div className={`flex items-end ${period === '30d' ? 'h-52 gap-px' : 'h-40 md:h-48 gap-1.5'}`}>
        {perDayBuckets.map((day, i) => {
          const barHeight = Math.max((day.total / maxDayTotal) * 100, day.total > 0 ? 3 : 0);
          return (
            <div key={i} className="flex-1 min-w-0 h-full flex items-end group/bar relative">
              <div
                className="w-full rounded-t overflow-hidden flex flex-col-reverse transition-all group-hover/bar:brightness-125"
                style={{ height: `${barHeight}%` }}
              >
                {day.buckets.map((b, j) => {
                  if (b.value <= 0) return null;
                  const segPct = (b.value / day.total) * 100;
                  return (
                    <div
                      key={j}
                      className={`w-full ${b.slot.colorBg} opacity-90`}
                      style={{ height: `${segPct}%` }}
                    />
                  );
                })}
              </div>
              {/* Tooltip — date + breakdown */}
              <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 bg-surface-container-highest border border-outline-variant/30 text-on-surface px-2.5 py-1.5 rounded shadow-lg opacity-0 group-hover/bar:opacity-100 transition-opacity pointer-events-none z-10 whitespace-nowrap text-[11px] font-mono">
                <div className="font-bold text-on-surface mb-0.5">{day.date.slice(5)} · {formatTokens(day.total)}</div>
                {day.buckets.filter(b => b.value > 0).reverse().map((b, j) => (
                  <div key={j} className="flex items-center gap-1.5 text-on-surface-variant">
                    <span className={`inline-block w-2 h-2 rounded-sm ${b.slot.colorBg}`} />
                    <span>{b.slot.label}</span>
                    <span className="ml-auto pl-2 text-on-surface">{formatTokens(b.value)}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Date labels */}
      {period === '30d' ? (
        <div className="flex gap-px mt-4 h-14">
          {perDayBuckets.map((v, i) => (
            <div key={i} className="flex-1 min-w-0 relative">
              <span className="absolute top-0 left-1/2 -translate-x-1/2 origin-top -rotate-55 text-[11px] text-outline font-mono whitespace-nowrap">
                {v.date.slice(5)}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex gap-1.5 mt-1.5">
          {perDayBuckets.map((v, i) => (
            <span key={i} className="flex-1 min-w-0 text-xs text-center text-outline font-mono truncate">
              {v.date.slice(5)}
            </span>
          ))}
        </div>
      )}

      {/* Legend */}
      <div className="flex flex-wrap gap-x-3 gap-y-1.5 mt-4 pt-3 border-t border-outline-variant/10">
        {modelSlots.map(slot => (
          <div key={slot.key} className="flex items-center gap-1.5 text-[11px] md:text-xs font-mono">
            <span className={`inline-block w-3 h-3 rounded-sm ${slot.colorBg}`} />
            <span className="text-on-surface-variant">{slot.label}</span>
            <span className="text-outline">· {formatTokens(slot.total)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
