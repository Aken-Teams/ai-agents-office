'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useAdminAuth } from '../components/AdminAuthProvider';
import { useTranslation } from '../../../i18n';

// ── Types ──────────────────────────────────────────────────────────────────
interface AnalyticsSummary { totalConversations: number; totalFiles: number; newUsers: number; activeUsers: number; }
interface TrendPoint { date: string; conversations: number; files: number; }
interface AnalyticsOverview {
  period: string; summary: AnalyticsSummary; trend: TrendPoint[];
  byCategory: Array<{ category: string | null; count: number }>;
  byMode: Array<{ mode: string | null; count: number }>;
  byFileType: Array<{ file_type: string | null; count: number }>;
  bySkill: Array<{ skill_id: string | null; count: number }>;
}
interface TopUser { id: string; email: string; display_name: string | null; conversations: number; files: number; total_input: number; total_output: number; }
interface TopicCategory { name: string; count: number; pct: number; examples: string[]; }
interface TopicAnalysis { summary: string; categories: TopicCategory[]; }

// ── Label maps ────────────────────────────────────────────────────────────
const CAT_LABELS: Record<string, string> = { document: '文件生成', assistant: 'AI 助手' };
const MODE_LABELS: Record<string, string> = { orchestrated: '多智能體', direct: '直接執行' };
const SKILL_LABELS: Record<string, string> = {
  'pptx-gen': 'PPT 簡報生成', 'docx-gen': 'Word 文件生成', 'xlsx-gen': 'Excel 試算表生成',
  'pdf-gen': 'PDF 生成', 'slides-gen': '投影片生成', 'webapp-gen': '網頁應用生成',
  'data-analyst': '資料分析', 'research': '研究調查', 'rag-analyst': 'RAG 文件分析',
  'planner': '任務規劃', 'reviewer': '內容審閱', 'router': '路由規劃',
};
const labelCat = (v: string | null) => v ? (CAT_LABELS[v] ?? v) : '未指定';
const labelMode = (v: string | null) => v ? (MODE_LABELS[v] ?? v) : '未指定';
const labelSkill = (v: string | null) => v ? (SKILL_LABELS[v] ?? v) : '—';

function formatNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

// ── Palette for charts ────────────────────────────────────────────────────
const PIE_COLORS = ['#3FBBC0', '#6B9BD2', '#F5A623', '#7BC87A', '#B07BB0', '#E07070', '#54B6B0', '#E8956D'];
const TOPIC_COLORS = ['bg-[#3FBBC0]/80', 'bg-[#6B9BD2]/80', 'bg-[#F5A623]/80', 'bg-[#7BC87A]/80', 'bg-[#B07BB0]/80', 'bg-[#E07070]/80'];

// ── Donut Chart (SVG) with hover tooltip + collapsible legend ─────────────
function DonutChart({ items, showLegend }: { items: Array<{ label: string; count: number }>; showLegend: boolean }) {
  const total = items.reduce((s, d) => s + d.count, 0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<{ label: string; count: number; pct: string; color: string } | null>(null);
  const [tipPos, setTipPos] = useState({ x: 0, y: 0 });

  if (!total) return null;

  const cx = 80, cy = 80, R = 70, r = 44;
  const GAP = 0.022;
  let angle = -Math.PI / 2;

  const slices = items.slice(0, 8).map((item, i) => {
    const rawSweep = (item.count / total) * 2 * Math.PI;
    const sweep = Math.max(rawSweep - GAP, 0.001);
    const startA = angle + GAP / 2;
    const endA = startA + sweep;
    const x1 = cx + R * Math.cos(startA), y1 = cy + R * Math.sin(startA);
    const x2 = cx + R * Math.cos(endA),   y2 = cy + R * Math.sin(endA);
    const ix1 = cx + r * Math.cos(endA),  iy1 = cy + r * Math.sin(endA);
    const ix2 = cx + r * Math.cos(startA),iy2 = cy + r * Math.sin(startA);
    const large = sweep > Math.PI ? 1 : 0;
    const d = `M${x1.toFixed(2)},${y1.toFixed(2)} A${R},${R} 0 ${large},1 ${x2.toFixed(2)},${y2.toFixed(2)} L${ix1.toFixed(2)},${iy1.toFixed(2)} A${r},${r} 0 ${large},0 ${ix2.toFixed(2)},${iy2.toFixed(2)}Z`;
    const result = { d, color: PIE_COLORS[i % PIE_COLORS.length], label: item.label, count: item.count,
      pct: ((item.count / total) * 100).toFixed(1) };
    angle += rawSweep;
    return result;
  });

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!wrapRef.current) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    // Flip tooltip to left if near right edge
    setTipPos({ x: x > rect.width * 0.6 ? x - 140 : x + 12, y: y - 16 });
  };

  return (
    <div className="flex flex-col items-center gap-3">
      {/* SVG */}
      <div ref={wrapRef} className="relative" onMouseMove={handleMouseMove} onMouseLeave={() => setHovered(null)}>
        <svg viewBox="0 0 160 160" className="w-44 h-44 md:w-48 md:h-48">
          {/* Background ring */}
          <circle cx={cx} cy={cy} r={(R + r) / 2} fill="none" stroke="currentColor" strokeWidth={R - r + 1} opacity={0.04} />
          {slices.map((s, i) => (
            <path
              key={i} d={s.d}
              fill={s.color}
              opacity={hovered ? (hovered.label === s.label ? 1 : 0.45) : 0.92}
              className="cursor-pointer transition-opacity duration-150"
              onMouseEnter={() => setHovered({ label: s.label, count: s.count, pct: s.pct, color: s.color })}
            />
          ))}
          {/* Center number */}
          <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central" fill="currentColor">
            <tspan fontSize={18} fontWeight="800" opacity={0.75}>{total}</tspan>
            <tspan fontSize={9} opacity={0.35} dx={2} letterSpacing={1}>筆</tspan>
          </text>
        </svg>

        {/* Hover Tooltip */}
        {hovered && (
          <div
            className="absolute pointer-events-none z-20 bg-surface-container-highest border border-outline-variant/15 shadow-lg rounded-lg px-3 py-2 text-xs whitespace-nowrap"
            style={{ left: tipPos.x, top: tipPos.y }}
          >
            <div className="flex items-center gap-2 mb-0.5">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: hovered.color }} />
              <span className="font-bold text-on-surface">{hovered.label}</span>
            </div>
            <p className="text-on-surface-variant font-mono pl-4">{hovered.count} 筆 · <span className="font-bold" style={{ color: hovered.color }}>{hovered.pct}%</span></p>
          </div>
        )}
      </div>

      {/* Collapsible Legend */}
      {showLegend && (
        <div className="w-full space-y-1.5 pt-1 border-t border-outline-variant/10">
          {slices.map((s, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: s.color }} />
              <span className="text-xs text-on-surface font-medium truncate flex-1 min-w-0" title={s.label}>{s.label}</span>
              <span className="text-xs font-mono font-bold shrink-0" style={{ color: s.color }}>{s.pct}%</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Distribution Card with legend popup ───────────────────────────────────
function DistributionCard({ icon, title, items, noDataLabel }: {
  icon: string; title: string;
  items: Array<{ label: string; count: number }>;
  noDataLabel: string;
}) {
  const [showLegend, setShowLegend] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [popPos, setPopPos] = useState({ top: 0, right: 0 });
  const total = items.reduce((s, d) => s + d.count, 0);

  const handleToggle = () => {
    if (!showLegend && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setPopPos({ top: rect.bottom + 6, right: window.innerWidth - rect.right });
    }
    setShowLegend(v => !v);
  };

  useEffect(() => {
    if (!showLegend) return;
    const handler = (e: MouseEvent) => {
      if (
        btnRef.current && !btnRef.current.contains(e.target as Node) &&
        popRef.current && !popRef.current.contains(e.target as Node)
      ) setShowLegend(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showLegend]);

  return (
    <div className="bg-surface-container rounded-lg overflow-hidden">
      <div className="px-4 md:px-6 py-3 md:py-4 bg-surface-container-high flex items-center justify-between">
        <div className="flex items-center gap-2 md:gap-3">
          <span className="material-symbols-outlined text-on-surface-variant text-base md:text-[24px]">{icon}</span>
          <span className="text-xs md:text-sm font-bold uppercase tracking-widest">{title}</span>
        </div>
        {items.length > 0 && (
          <button
            ref={btnRef}
            onClick={handleToggle}
            title={showLegend ? '收合圖例' : '展開圖例'}
            className={`w-7 h-7 flex items-center justify-center rounded-lg transition-colors cursor-pointer bg-transparent ${showLegend ? 'text-primary bg-primary/8' : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container'}`}
          >
            <span className="material-symbols-outlined text-base">legend_toggle</span>
          </button>
        )}
      </div>
      <div className="p-4 md:p-6 flex justify-center">
        {items.length > 0 ? (
          <DonutChart items={items} showLegend={false} />
        ) : (
          <p className="text-sm text-on-surface-variant text-center py-6">{noDataLabel}</p>
        )}
      </div>

      {/* Legend Popover (Portal) */}
      {showLegend && total > 0 && createPortal(
        <div
          ref={popRef}
          className="fixed z-[200] bg-surface-container-highest border border-outline-variant/20 shadow-2xl rounded-xl p-4 min-w-[180px] max-w-[240px]"
          style={{ top: popPos.top, right: popPos.right }}
        >
          <div className="space-y-1.5">
            {items.slice(0, 8).map((item, i) => {
              const pct = ((item.count / total) * 100).toFixed(1);
              return (
                <div key={i} className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: PIE_COLORS[i % PIE_COLORS.length] }} />
                  <span className="text-xs text-on-surface font-medium truncate flex-1 min-w-0" title={item.label}>{item.label}</span>
                  <span className="text-xs font-mono font-bold shrink-0" style={{ color: PIE_COLORS[i % PIE_COLORS.length] }}>{pct}%</span>
                </div>
              );
            })}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

// ── Trend Bar Chart ───────────────────────────────────────────────────────
function TrendBars({ data, convLabel, fileLabel }: { data: TrendPoint[]; convLabel: string; fileLabel: string }) {
  if (!data.length) return null;
  const maxY = Math.max(...data.map(d => Math.max(d.conversations, d.files)), 1);
  const is30d = data.length > 10;

  return (
    <div>
      <div className={`flex items-end h-40 md:h-48 ${is30d ? 'gap-0.5' : 'gap-2 md:gap-3'}`}>
        {data.map((v, i) => {
          const convH = Math.max((v.conversations / maxY) * 100, v.conversations > 0 ? 3 : 0);
          const fileH = Math.max((v.files / maxY) * 100, v.files > 0 ? 3 : 0);
          return (
            <div key={i} className="relative flex-1 min-w-0 h-full group/bar">
              <div className="absolute bottom-0 left-0 bg-primary/65 rounded-t-sm transition-all group-hover/bar:brightness-125"
                style={{ width: 'calc(50% - 1px)', height: `${convH}%` }} />
              <div className="absolute bottom-0 right-0 rounded-t-sm transition-all group-hover/bar:brightness-125"
                style={{ width: 'calc(50% - 1px)', height: `${fileH}%`, backgroundColor: 'rgba(107,155,210,0.55)' }} />
              <span className="absolute -top-8 left-1/2 -translate-x-1/2 text-[10px] bg-surface-container-highest text-on-surface px-1.5 py-0.5 rounded opacity-0 group-hover/bar:opacity-100 transition-opacity font-mono font-bold whitespace-nowrap pointer-events-none z-10 shadow-sm">
                {v.date.slice(5)} · {convLabel} {v.conversations} / {fileLabel} {v.files}
              </span>
            </div>
          );
        })}
      </div>
      {is30d ? (
        <div className="flex gap-0.5 mt-3 h-12">
          {data.map((v, i) => (
            <div key={i} className="flex-1 min-w-0 relative">
              <span className="absolute top-0 left-1/2 -translate-x-1/2 origin-top -rotate-55 text-[11px] text-outline font-mono whitespace-nowrap">
                {v.date.slice(5)}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex gap-2 md:gap-3 mt-1.5">
          {data.map((v, i) => (
            <span key={i} className="flex-1 min-w-0 text-xs text-center text-outline font-mono truncate">
              {v.date.slice(5)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── AI Topic Analysis Card (full-width) ───────────────────────────────────
function TopicAnalysisCard({ period, token }: { period: string; token: string }) {
  const { t } = useTranslation();
  const [data, setData] = useState<TopicAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const analyze = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await fetch(`/api/admin/analytics/topic-analysis?period=${period}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      const j = await res.json();
      if (!res.ok) setError(j.error || 'Error');
      else setData(j);
    } catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  }, [period, token]);

  useEffect(() => { analyze(); }, [analyze]);

  return (
    <div className="bg-surface-container rounded-lg overflow-hidden">
      <div className="px-4 md:px-6 py-3 md:py-4 bg-surface-container-high flex items-center justify-between">
        <div className="flex items-center gap-2 md:gap-3">
          <span className="material-symbols-outlined text-primary text-base md:text-[24px]" style={{ fontVariationSettings: "'FILL' 1" }}>psychology</span>
          <span className="text-xs md:text-sm font-bold uppercase tracking-widest">{t('admin.analytics.topicAnalysis' as any)}</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary font-bold uppercase tracking-wider">DeepSeek</span>
        </div>
        <button onClick={analyze} disabled={loading}
          className="flex items-center gap-1.5 text-xs text-on-surface-variant hover:text-primary transition-colors cursor-pointer disabled:opacity-50 bg-transparent">
          <span className={`material-symbols-outlined text-sm ${loading ? 'animate-spin' : ''}`}>
            {loading ? 'progress_activity' : 'refresh'}
          </span>
          <span className="hidden md:inline">{t('admin.analytics.topicAnalyzeBtn' as any)}</span>
        </button>
      </div>

      <div className="p-4 md:p-6">
        {loading ? (
          <div className="flex items-center justify-center py-12 gap-2 text-on-surface-variant">
            <span className="material-symbols-outlined animate-spin">progress_activity</span>
            <span className="text-sm">{t('admin.analytics.topicAnalyzing' as any)}</span>
          </div>
        ) : error ? (
          <div className="flex items-center gap-2 py-10 text-error text-sm justify-center">
            <span className="material-symbols-outlined">error</span>{error}
          </div>
        ) : !data?.categories?.length ? (
          <div className="flex items-center gap-2 justify-center py-10 text-on-surface-variant text-sm">
            <span className="material-symbols-outlined">info</span>
            {t('admin.analytics.noData' as any)}
          </div>
        ) : (
          <div className="space-y-5">
            {/* Summary */}
            {data.summary && (
              <div className="flex items-start gap-3 p-4 bg-primary/5 rounded-lg border border-primary/10">
                <span className="material-symbols-outlined text-primary text-lg shrink-0 mt-0.5" style={{ fontVariationSettings: "'FILL' 1" }}>lightbulb</span>
                <p className="text-sm text-on-surface leading-relaxed font-medium">{data.summary}</p>
              </div>
            )}
            {/* Category grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {data.categories.map((cat, i) => (
                <div key={i} className="bg-surface-container-high rounded-lg p-4 border border-outline-variant/10">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`w-2.5 h-2.5 rounded-sm shrink-0 ${TOPIC_COLORS[i % TOPIC_COLORS.length]}`} />
                      <span className="text-sm font-bold text-on-surface truncate">{cat.name}</span>
                    </div>
                    <span className="text-lg font-headline font-black shrink-0" style={{ color: PIE_COLORS[i % PIE_COLORS.length] }}>{cat.pct}%</span>
                  </div>
                  {/* Progress bar */}
                  <div className="w-full h-1.5 bg-surface-container-highest rounded-full overflow-hidden mb-2">
                    <div className="h-full rounded-full transition-all duration-700"
                      style={{ width: `${cat.pct}%`, backgroundColor: PIE_COLORS[i % PIE_COLORS.length] + 'CC' }} />
                  </div>
                  <p className="text-xs text-on-surface-variant mb-1.5">{cat.count} 筆對話</p>
                  {cat.examples?.length > 0 && (
                    <p className="text-xs text-on-surface-variant/70 leading-relaxed line-clamp-2" title={cat.examples.join('、')}>
                      例：{cat.examples.slice(0, 2).join('；')}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────
export default function AdminAnalytics() {
  const { token } = useAdminAuth();
  const { t } = useTranslation();
  const [period, setPeriod] = useState<'7d' | '30d'>('7d');
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [topUsers, setTopUsers] = useState<TopUser[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [ovRes, tuRes] = await Promise.all([
        fetch(`/api/admin/analytics/overview?period=${period}`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`/api/admin/analytics/top-users?period=${period}&limit=10`, { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      if (ovRes.ok) setOverview(await ovRes.json());
      if (tuRes.ok) setTopUsers(await tuRes.json());
    } finally { setLoading(false); }
  }, [token, period]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const s = overview?.summary;
  const convLabel = t('admin.analytics.conversations' as any);
  const fileLabel = t('admin.analytics.files' as any);

  return (
    <>
      {/* Header */}
      <header className="sticky top-0 h-14 md:h-16 bg-surface/80 backdrop-blur-xl flex justify-between items-center px-4 md:px-8 z-40 shadow-[0_1px_0_0_rgba(255,255,255,0.05)]">
        <span className="text-base md:text-lg font-black text-on-surface font-headline truncate">
          {t('admin.analytics.title' as any)}
        </span>
        <div className="flex gap-1">
          {(['7d', '30d'] as const).map(p => (
            <button key={p} onClick={() => setPeriod(p)}
              className={`px-2 md:px-3 py-0.5 md:py-1 text-xs md:text-sm font-bold uppercase tracking-wider cursor-pointer transition-colors ${p === '30d' ? 'hidden md:inline-flex' : ''} ${
                period === p ? 'text-primary border-b-2 border-primary' : 'text-on-surface-variant hover:text-on-surface'
              }`}>
              {t(p === '7d' ? 'admin.analytics.period7d' as any : 'admin.analytics.period30d' as any)}
            </button>
          ))}
        </div>
      </header>

      <div className="p-4 md:p-8 flex-1 space-y-4 md:space-y-6 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-24 text-on-surface-variant">
            <span className="material-symbols-outlined animate-spin text-3xl">progress_activity</span>
          </div>
        ) : (
          <>
            {/* ① Summary Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-6">
              {[
                { icon: 'forum', label: t('admin.analytics.totalConversations' as any), value: s?.totalConversations ?? 0 },
                { icon: 'description', label: t('admin.analytics.totalFiles' as any), value: s?.totalFiles ?? 0 },
                { icon: 'person_add', label: t('admin.analytics.newUsers' as any), value: s?.newUsers ?? 0 },
                { icon: 'groups', label: t('admin.analytics.activeUsers' as any), value: s?.activeUsers ?? 0 },
              ].map((card, i) => (
                <div key={i} className="bg-surface-container p-3 md:p-6 rounded-lg group relative overflow-hidden">
                  <span className="material-symbols-outlined absolute -bottom-4 -right-2 max-md:-bottom-2 max-md:-right-1 max-md:!text-[56px] text-on-surface opacity-[0.07] group-hover:opacity-[0.12] transition-opacity pointer-events-none"
                    style={{ fontSize: 100, fontVariationSettings: "'FILL' 1" }}>{card.icon}</span>
                  <p className="text-[10px] md:text-sm uppercase tracking-widest text-on-surface-variant mb-1 md:mb-2">{card.label}</p>
                  <span className="text-xl md:text-3xl font-headline font-black text-on-surface">{formatNum(card.value)}</span>
                </div>
              ))}
            </div>

            {/* ② Trend Chart */}
            <div className="bg-surface-container rounded-lg overflow-hidden">
              <div className="px-4 md:px-6 py-3 md:py-4 bg-surface-container-high flex items-center justify-between">
                <div className="flex items-center gap-2 md:gap-3">
                  <span className="material-symbols-outlined text-tertiary text-base md:text-[24px]">show_chart</span>
                  <span className="text-xs md:text-sm font-bold uppercase tracking-widest">{t('admin.analytics.trendTitle' as any)}</span>
                </div>
                <div className="flex items-center gap-3 text-xs text-on-surface-variant">
                  <span className="flex items-center gap-1.5">
                    <span className="w-3 h-2.5 rounded-sm inline-block bg-primary/65" />{convLabel}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="w-3 h-2.5 rounded-sm inline-block" style={{ backgroundColor: 'rgba(107,155,210,0.55)' }} />{fileLabel}
                  </span>
                </div>
              </div>
              <div className="p-4 md:p-6">
                {(overview?.trend?.length ?? 0) > 0 ? (
                  <TrendBars data={overview!.trend} convLabel={convLabel} fileLabel={fileLabel} />
                ) : (
                  <div className="h-40 flex items-center justify-center text-on-surface-variant text-sm">
                    <span className="material-symbols-outlined mr-2">info</span>{t('admin.analytics.noData' as any)}
                  </div>
                )}
              </div>
            </div>

            {/* ③ Distribution Donut Charts */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-6">
              <DistributionCard
                icon="category"
                title={t('admin.analytics.byCategory' as any)}
                items={(overview?.byCategory ?? []).map(d => ({ label: labelCat(d.category), count: d.count }))}
                noDataLabel={t('admin.analytics.noData' as any)}
              />
              <DistributionCard
                icon="hub"
                title={t('admin.analytics.byMode' as any)}
                items={(overview?.byMode ?? []).map(d => ({ label: labelMode(d.mode), count: d.count }))}
                noDataLabel={t('admin.analytics.noData' as any)}
              />
              <DistributionCard
                icon="folder"
                title={t('admin.analytics.byFileType' as any)}
                items={(overview?.byFileType ?? []).map(d => ({ label: d.file_type || '—', count: d.count }))}
                noDataLabel={t('admin.analytics.noData' as any)}
              />
            </div>

            {/* ④ Skill Usage */}
            <div className="bg-surface-container rounded-lg overflow-hidden">
              <div className="px-4 md:px-6 py-3 md:py-4 bg-surface-container-high flex items-center gap-2 md:gap-3">
                <span className="material-symbols-outlined text-on-surface-variant text-base md:text-[24px]">smart_toy</span>
                <span className="text-xs md:text-sm font-bold uppercase tracking-widest">{t('admin.analytics.bySkill' as any)}</span>
              </div>
              <div className="p-4 md:p-6">
                {(overview?.bySkill?.length ?? 0) > 0 ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-2.5">
                    {overview!.bySkill.slice(0, 12).map((item, i) => {
                      const maxSkill = overview!.bySkill[0]?.count ?? 1;
                      const pct = ((item.count / maxSkill) * 100).toFixed(0);
                      return (
                        <div key={i}>
                          <div className="flex justify-between text-xs md:text-sm mb-1">
                            <span className="text-on-surface truncate max-w-[65%]">{labelSkill(item.skill_id)}</span>
                            <span className="text-on-surface-variant font-mono shrink-0">{item.count}</span>
                          </div>
                          <div className="w-full h-1.5 bg-surface-container-highest rounded-full overflow-hidden">
                            <div className="h-full bg-primary/50 rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="h-24 flex items-center justify-center text-on-surface-variant text-sm">
                    <span className="material-symbols-outlined mr-2">info</span>{t('admin.analytics.noData' as any)}
                  </div>
                )}
              </div>
            </div>

            {/* ⑤ AI Topic Analysis (full-width) */}
            {token && <TopicAnalysisCard period={period} token={token} />}

            {/* ⑥ Top Users */}
            <div className="bg-surface-container rounded-lg overflow-hidden">
              <div className="px-4 md:px-6 py-3 md:py-4 bg-surface-container-high flex items-center gap-2 md:gap-3">
                <span className="material-symbols-outlined text-on-surface-variant text-base md:text-[24px]">leaderboard</span>
                <span className="text-xs md:text-sm font-bold uppercase tracking-widest">{t('admin.analytics.topUsers' as any)}</span>
              </div>
              <table className="w-full hidden md:table">
                <thead>
                  <tr className="text-left text-sm uppercase tracking-widest text-on-surface-variant border-b border-outline-variant/10">
                    <th className="py-3 px-6 font-bold w-10">{t('admin.analytics.rank' as any)}</th>
                    <th className="py-3 px-6 font-bold">{t('admin.analytics.emailCol' as any)}</th>
                    <th className="py-3 px-6 font-bold text-right">{t('admin.analytics.totalConversations' as any)}</th>
                    <th className="py-3 px-6 font-bold text-right">{t('admin.analytics.totalFiles' as any)}</th>
                    <th className="py-3 px-6 font-bold text-right">{t('admin.analytics.tokens' as any)}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-outline-variant/10">
                  {topUsers.length === 0 ? (
                    <tr><td colSpan={5} className="py-12 text-center text-on-surface-variant">{t('admin.analytics.noData' as any)}</td></tr>
                  ) : topUsers.map((u, i) => (
                    <tr key={u.id} className="hover:bg-surface-container-high/50 transition-colors">
                      <td className="py-3 px-6 text-sm text-on-surface-variant font-mono">{i + 1}</td>
                      <td className="py-3 px-6">
                        <p className="text-sm text-on-surface font-bold truncate max-w-[240px]">{u.display_name || u.email.split('@')[0]}</p>
                        <p className="text-sm text-on-surface-variant font-mono truncate max-w-[240px]">{u.email}</p>
                      </td>
                      <td className="py-3 px-6 text-right text-sm text-on-surface font-mono">{u.conversations}</td>
                      <td className="py-3 px-6 text-right text-sm text-on-surface font-mono">{u.files}</td>
                      <td className="py-3 px-6 text-right text-sm text-on-surface font-mono">{formatNum(u.total_input + u.total_output)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="md:hidden divide-y divide-outline-variant/10">
                {topUsers.length === 0 ? (
                  <p className="py-10 text-center text-sm text-on-surface-variant">{t('admin.analytics.noData' as any)}</p>
                ) : topUsers.map((u, i) => (
                  <div key={u.id} className="px-4 py-3">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs text-on-surface-variant font-mono">#{i + 1}</span>
                      <span className="text-xs font-mono text-on-surface-variant">{formatNum(u.total_input + u.total_output)} tokens</span>
                    </div>
                    <p className="text-sm text-on-surface font-bold truncate">{u.display_name || u.email.split('@')[0]}</p>
                    <p className="text-xs text-on-surface-variant font-mono truncate">{u.email}</p>
                    <div className="flex gap-4 mt-1 text-xs text-on-surface-variant font-mono">
                      <span>{convLabel}: {u.conversations}</span>
                      <span>{fileLabel}: {u.files}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
