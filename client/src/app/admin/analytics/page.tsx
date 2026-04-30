'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAdminAuth } from '../components/AdminAuthProvider';
import { useTranslation } from '../../../i18n';

interface AnalyticsSummary {
  totalConversations: number;
  totalFiles: number;
  newUsers: number;
  activeUsers: number;
}

interface TrendPoint {
  date: string;
  conversations: number;
  files: number;
}

interface AnalyticsOverview {
  period: string;
  summary: AnalyticsSummary;
  trend: TrendPoint[];
  byCategory: Array<{ category: string | null; count: number }>;
  byMode: Array<{ mode: string | null; count: number }>;
  byFileType: Array<{ file_type: string | null; count: number }>;
  bySkill: Array<{ skill_id: string | null; count: number }>;
}

interface TopUser {
  id: string;
  email: string;
  display_name: string | null;
  conversations: number;
  files: number;
  total_input: number;
  total_output: number;
}

interface HotTopic {
  id: string;
  title: string | null;
  category: string | null;
  user_email: string;
  user_name: string | null;
  total_tokens: number;
  message_count: number;
}

interface TopicCategory {
  name: string;
  count: number;
  pct: number;
  examples: string[];
}

interface TopicAnalysis {
  summary: string;
  categories: TopicCategory[];
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

// Map DB values to Chinese labels
const CAT_LABELS: Record<string, string> = {
  document: '文件生成',
  assistant: 'AI 助手',
};
const MODE_LABELS: Record<string, string> = {
  orchestrated: '多智能體',
  direct: '直接執行',
};
function labelCat(v: string | null) { return v ? (CAT_LABELS[v] ?? v) : '未指定'; }
function labelMode(v: string | null) { return v ? (MODE_LABELS[v] ?? v) : '未指定'; }

// Horizontal bar list
function BarList({ items, total, colorClass = 'bg-primary/60' }: {
  items: Array<{ label: string; count: number }>;
  total: number;
  colorClass?: string;
}) {
  if (!items.length) return null;
  return (
    <div className="space-y-2.5">
      {items.slice(0, 8).map((item, i) => {
        const pct = total > 0 ? ((item.count / total) * 100).toFixed(1) : '0';
        return (
          <div key={i}>
            <div className="flex justify-between text-xs md:text-sm mb-1">
              <span className="text-on-surface truncate max-w-[65%]" title={item.label}>{item.label}</span>
              <span className="text-on-surface-variant font-mono shrink-0">{item.count} <span className="text-outline">({pct}%)</span></span>
            </div>
            <div className="w-full h-1.5 bg-surface-container-highest rounded-full overflow-hidden">
              <div className={`h-full ${colorClass} rounded-full transition-all duration-500`} style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Dual bar chart — fix: percentage height requires a sized parent
function TrendBars({ data, convLabel, fileLabel }: { data: TrendPoint[]; convLabel: string; fileLabel: string }) {
  if (!data.length) return null;
  const maxY = Math.max(...data.map(d => Math.max(d.conversations, d.files)), 1);
  const is30d = data.length > 10;

  return (
    <div>
      {/* Outer row: gap between DAYS */}
      <div className={`flex items-end h-40 md:h-48 ${is30d ? 'gap-0.5' : 'gap-2 md:gap-3'}`}>
        {data.map((v, i) => {
          const convH = Math.max((v.conversations / maxY) * 100, v.conversations > 0 ? 3 : 0);
          const fileH = Math.max((v.files / maxY) * 100, v.files > 0 ? 3 : 0);
          return (
            // Each day: a fixed-height container; bars are absolutely-bottom aligned inside
            <div key={i} className="relative flex-1 min-w-0 h-full group/bar">
              {/* Conv bar */}
              <div
                className="absolute bottom-0 left-0 bg-primary/65 rounded-t-sm transition-all group-hover/bar:brightness-125"
                style={{ width: 'calc(50% - 1px)', height: `${convH}%` }}
              />
              {/* File bar */}
              <div
                className="absolute bottom-0 right-0 bg-secondary/45 rounded-t-sm transition-all group-hover/bar:brightness-125"
                style={{ width: 'calc(50% - 1px)', height: `${fileH}%` }}
              />
              {/* Hover tooltip */}
              <span className="absolute -top-8 left-1/2 -translate-x-1/2 text-[10px] bg-surface-container-highest text-on-surface px-1.5 py-0.5 rounded opacity-0 group-hover/bar:opacity-100 transition-opacity font-mono font-bold whitespace-nowrap pointer-events-none z-10 shadow-sm">
                {v.date.slice(5)} · {convLabel} {v.conversations} / {fileLabel} {v.files}
              </span>
            </div>
          );
        })}
      </div>
      {/* Date labels */}
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

// Topic analysis card with DeepSeek
function TopicAnalysisCard({ period, token }: { period: string; token: string }) {
  const { t } = useTranslation();
  const [data, setData] = useState<TopicAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const analyze = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/admin/analytics/topic-analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ period }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error || 'Error');
      } else {
        const j = await res.json();
        setData(j);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [period, token]);

  // Auto-analyze on mount / period change
  useEffect(() => {
    analyze();
  }, [analyze]);

  const catColors = ['bg-primary/70', 'bg-secondary/60', 'bg-tertiary/60', 'bg-error/50', 'bg-primary/40', 'bg-secondary/35'];

  return (
    <div className="bg-surface-container rounded-lg overflow-hidden">
      <div className="px-4 md:px-6 py-3 md:py-4 bg-surface-container-high flex items-center justify-between">
        <div className="flex items-center gap-2 md:gap-3">
          <span className="material-symbols-outlined text-primary text-base md:text-[24px]" style={{ fontVariationSettings: "'FILL' 1" }}>psychology</span>
          <span className="text-xs md:text-sm font-bold uppercase tracking-widest">{t('admin.analytics.topicAnalysis' as any)}</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary font-bold uppercase tracking-wider">DeepSeek</span>
        </div>
        <button
          onClick={analyze}
          disabled={loading}
          className="flex items-center gap-1.5 text-xs text-on-surface-variant hover:text-primary transition-colors cursor-pointer disabled:opacity-50 bg-transparent"
        >
          <span className={`material-symbols-outlined text-sm ${loading ? 'animate-spin' : ''}`}>
            {loading ? 'progress_activity' : 'refresh'}
          </span>
          <span className="hidden md:inline">{t('admin.analytics.topicAnalyzeBtn' as any)}</span>
        </button>
      </div>

      <div className="p-4 md:p-6">
        {loading ? (
          <div className="flex items-center justify-center py-10 gap-2 text-on-surface-variant">
            <span className="material-symbols-outlined animate-spin">progress_activity</span>
            <span className="text-sm">{t('admin.analytics.topicAnalyzing' as any)}</span>
          </div>
        ) : error ? (
          <div className="flex items-center gap-2 py-8 text-error text-sm justify-center">
            <span className="material-symbols-outlined">error</span>
            {error}
          </div>
        ) : !data?.categories?.length ? (
          <div className="flex items-center gap-2 justify-center py-8 text-on-surface-variant text-sm">
            <span className="material-symbols-outlined">info</span>
            {t('admin.analytics.noData' as any)}
          </div>
        ) : (
          <div className="space-y-5">
            {/* Summary sentence */}
            {data.summary && (
              <div className="flex items-start gap-3 p-4 bg-primary/5 rounded-lg border border-primary/10">
                <span className="material-symbols-outlined text-primary text-lg shrink-0 mt-0.5" style={{ fontVariationSettings: "'FILL' 1" }}>lightbulb</span>
                <p className="text-sm text-on-surface leading-relaxed">{data.summary}</p>
              </div>
            )}

            {/* Category bars */}
            <div className="space-y-3">
              {data.categories.map((cat, i) => (
                <div key={i}>
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`w-2.5 h-2.5 rounded-sm shrink-0 ${catColors[i % catColors.length]}`} />
                      <span className="text-sm font-bold text-on-surface truncate">{cat.name}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 ml-3">
                      <span className="text-xs text-on-surface-variant font-mono">{cat.count} 筆</span>
                      <span className="text-sm font-bold text-primary font-mono">{cat.pct}%</span>
                    </div>
                  </div>
                  <div className="w-full h-2 bg-surface-container-highest rounded-full overflow-hidden mb-1.5">
                    <div className={`h-full ${catColors[i % catColors.length]} rounded-full transition-all duration-700`} style={{ width: `${cat.pct}%` }} />
                  </div>
                  {cat.examples?.length > 0 && (
                    <p className="text-xs text-on-surface-variant truncate pl-4" title={cat.examples.join('、')}>
                      例：{cat.examples.slice(0, 2).join('、')}
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

export default function AdminAnalytics() {
  const { token } = useAdminAuth();
  const { t } = useTranslation();
  const [period, setPeriod] = useState<'7d' | '30d'>('7d');
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [topUsers, setTopUsers] = useState<TopUser[]>([]);
  const [hotTopics, setHotTopics] = useState<HotTopic[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [ovRes, tuRes, htRes] = await Promise.all([
        fetch(`/api/admin/analytics/overview?period=${period}`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`/api/admin/analytics/top-users?period=${period}&limit=10`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`/api/admin/analytics/hot-topics?period=${period}&limit=15`, { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      if (ovRes.ok) setOverview(await ovRes.json());
      if (tuRes.ok) setTopUsers(await tuRes.json());
      if (htRes.ok) setHotTopics(await htRes.json());
    } finally {
      setLoading(false);
    }
  }, [token, period]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const s = overview?.summary;
  const convTotal = (overview?.byCategory ?? []).reduce((a, b) => a + b.count, 0) || 1;
  const modeTotal = (overview?.byMode ?? []).reduce((a, b) => a + b.count, 0) || 1;
  const fileTotal = (overview?.byFileType ?? []).reduce((a, b) => a + b.count, 0) || 1;
  const maxTopicTokens = hotTopics[0]?.total_tokens ?? 1;

  const convLabel = t('admin.analytics.conversations' as any);
  const fileLabel = t('admin.analytics.files' as any);

  return (
    <>
      {/* Sticky Header */}
      <header className="sticky top-0 h-14 md:h-16 bg-surface/80 backdrop-blur-xl flex justify-between items-center px-4 md:px-8 z-40 shadow-[0_1px_0_0_rgba(255,255,255,0.05)]">
        <span className="text-base md:text-lg font-black text-on-surface font-headline truncate">
          {t('admin.analytics.title' as any)}
        </span>
        <div className="flex gap-1">
          {(['7d', '30d'] as const).map(p => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-2 md:px-3 py-0.5 md:py-1 text-xs md:text-sm font-bold uppercase tracking-wider cursor-pointer transition-colors ${
                period === p ? 'text-primary border-b-2 border-primary' : 'text-on-surface-variant hover:text-on-surface'
              }`}
            >
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
            {/* Summary Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-6">
              {[
                { icon: 'forum', label: t('admin.analytics.totalConversations' as any), value: s?.totalConversations ?? 0 },
                { icon: 'description', label: t('admin.analytics.totalFiles' as any), value: s?.totalFiles ?? 0 },
                { icon: 'person_add', label: t('admin.analytics.newUsers' as any), value: s?.newUsers ?? 0 },
                { icon: 'groups', label: t('admin.analytics.activeUsers' as any), value: s?.activeUsers ?? 0 },
              ].map((card, i) => (
                <div key={i} className="bg-surface-container p-3 md:p-6 rounded-lg group relative overflow-hidden">
                  <span className="material-symbols-outlined absolute -bottom-4 -right-2 max-md:-bottom-2 max-md:-right-1 max-md:!text-[56px] text-on-surface opacity-[0.07] group-hover:opacity-[0.12] transition-opacity pointer-events-none" style={{ fontSize: 100, fontVariationSettings: "'FILL' 1" }}>{card.icon}</span>
                  <p className="text-[10px] md:text-sm uppercase tracking-widest text-on-surface-variant mb-1 md:mb-2">{card.label}</p>
                  <span className="text-xl md:text-3xl font-headline font-black text-on-surface">{formatNum(card.value)}</span>
                </div>
              ))}
            </div>

            {/* Trend Chart */}
            <div className="bg-surface-container rounded-lg overflow-hidden">
              <div className="px-4 md:px-6 py-3 md:py-4 bg-surface-container-high flex items-center justify-between">
                <div className="flex items-center gap-2 md:gap-3">
                  <span className="material-symbols-outlined text-tertiary text-base md:text-[24px]">show_chart</span>
                  <span className="text-xs md:text-sm font-bold uppercase tracking-widest">{t('admin.analytics.trendTitle' as any)}</span>
                </div>
                <div className="flex items-center gap-3 text-xs text-on-surface-variant">
                  <span className="flex items-center gap-1.5">
                    <span className="w-3 h-2.5 rounded-sm inline-block bg-primary/65" />
                    {convLabel}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="w-3 h-2.5 rounded-sm inline-block bg-secondary/45" />
                    {fileLabel}
                  </span>
                </div>
              </div>
              <div className="p-4 md:p-6">
                {(overview?.trend?.length ?? 0) > 0 ? (
                  <TrendBars data={overview!.trend} convLabel={convLabel} fileLabel={fileLabel} />
                ) : (
                  <div className="h-40 flex items-center justify-center text-on-surface-variant text-sm">
                    <span className="material-symbols-outlined mr-2">info</span>
                    {t('admin.analytics.noData' as any)}
                  </div>
                )}
              </div>
            </div>

            {/* Hot Topics list + AI Analysis side by side on desktop */}
            <div className="grid grid-cols-1 md:grid-cols-12 gap-4 md:gap-6">
              {/* Hot Topics — left 7 cols */}
              <div className="md:col-span-7 bg-surface-container rounded-lg overflow-hidden">
                <div className="px-4 md:px-6 py-3 md:py-4 bg-surface-container-high flex items-center gap-2 md:gap-3">
                  <span className="material-symbols-outlined text-on-surface-variant text-base md:text-[24px]">whatshot</span>
                  <span className="text-xs md:text-sm font-bold uppercase tracking-widest">{t('admin.analytics.hotTopics' as any)}</span>
                  <span className="hidden md:inline text-xs text-on-surface-variant ml-1">{t('admin.analytics.hotTopicsDesc' as any)}</span>
                </div>
                {hotTopics.length === 0 ? (
                  <div className="flex items-center justify-center py-10 text-on-surface-variant text-sm">
                    <span className="material-symbols-outlined mr-2">info</span>
                    {t('admin.analytics.noData' as any)}
                  </div>
                ) : (
                  <div className="divide-y divide-outline-variant/10">
                    {hotTopics.map((topic, i) => {
                      const pct = maxTopicTokens > 0 ? ((topic.total_tokens / maxTopicTokens) * 100).toFixed(0) : '0';
                      return (
                        <div key={topic.id} className="px-4 md:px-6 py-3 hover:bg-surface-container-high/50 transition-colors">
                          <div className="flex items-start gap-3">
                            <span className="text-sm text-on-surface-variant font-mono w-5 shrink-0 pt-0.5">{i + 1}</span>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0 flex-1">
                                  <p className="text-sm text-on-surface font-bold truncate" title={topic.title || '—'}>
                                    {topic.title || '—'}
                                  </p>
                                  <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                                    <span className="text-xs text-on-surface-variant truncate max-w-[120px]">
                                      {topic.user_name || topic.user_email.split('@')[0]}
                                    </span>
                                    {topic.category && (
                                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary font-bold uppercase tracking-wider shrink-0">
                                        {labelCat(topic.category)}
                                      </span>
                                    )}
                                    <span className="text-xs text-on-surface-variant shrink-0">
                                      {topic.message_count} {t('admin.analytics.messages' as any)}
                                    </span>
                                  </div>
                                </div>
                                <div className="text-right shrink-0">
                                  <span className="text-sm font-mono font-bold text-on-surface">{formatNum(topic.total_tokens)}</span>
                                  <p className="text-[10px] text-on-surface-variant">tokens</p>
                                </div>
                              </div>
                              <div className="mt-1.5 w-full h-1 bg-surface-container-highest rounded-full overflow-hidden">
                                <div className="h-full bg-primary/40 rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* AI Topic Analysis — right 5 cols */}
              <div className="md:col-span-5">
                {token && <TopicAnalysisCard period={period} token={token} />}
              </div>
            </div>

            {/* Distribution Row */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-6">
              <div className="bg-surface-container rounded-lg overflow-hidden">
                <div className="px-4 md:px-6 py-3 md:py-4 bg-surface-container-high flex items-center gap-2 md:gap-3">
                  <span className="material-symbols-outlined text-on-surface-variant text-base md:text-[24px]">category</span>
                  <span className="text-xs md:text-sm font-bold uppercase tracking-widest">{t('admin.analytics.byCategory' as any)}</span>
                </div>
                <div className="p-4 md:p-6">
                  {(overview?.byCategory?.length ?? 0) > 0 ? (
                    <BarList
                      items={overview!.byCategory.map(d => ({ label: labelCat(d.category), count: d.count }))}
                      total={convTotal}
                      colorClass="bg-primary/60"
                    />
                  ) : <p className="text-sm text-on-surface-variant text-center py-6">{t('admin.analytics.noData' as any)}</p>}
                </div>
              </div>

              <div className="bg-surface-container rounded-lg overflow-hidden">
                <div className="px-4 md:px-6 py-3 md:py-4 bg-surface-container-high flex items-center gap-2 md:gap-3">
                  <span className="material-symbols-outlined text-on-surface-variant text-base md:text-[24px]">hub</span>
                  <span className="text-xs md:text-sm font-bold uppercase tracking-widest">{t('admin.analytics.byMode' as any)}</span>
                </div>
                <div className="p-4 md:p-6">
                  {(overview?.byMode?.length ?? 0) > 0 ? (
                    <BarList
                      items={overview!.byMode.map(d => ({ label: labelMode(d.mode), count: d.count }))}
                      total={modeTotal}
                      colorClass="bg-tertiary/60"
                    />
                  ) : <p className="text-sm text-on-surface-variant text-center py-6">{t('admin.analytics.noData' as any)}</p>}
                </div>
              </div>

              <div className="bg-surface-container rounded-lg overflow-hidden">
                <div className="px-4 md:px-6 py-3 md:py-4 bg-surface-container-high flex items-center gap-2 md:gap-3">
                  <span className="material-symbols-outlined text-on-surface-variant text-base md:text-[24px]">folder</span>
                  <span className="text-xs md:text-sm font-bold uppercase tracking-widest">{t('admin.analytics.byFileType' as any)}</span>
                </div>
                <div className="p-4 md:p-6">
                  {(overview?.byFileType?.length ?? 0) > 0 ? (
                    <BarList
                      items={overview!.byFileType.map(d => ({ label: d.file_type || '—', count: d.count }))}
                      total={fileTotal}
                      colorClass="bg-secondary/60"
                    />
                  ) : <p className="text-sm text-on-surface-variant text-center py-6">{t('admin.analytics.noData' as any)}</p>}
                </div>
              </div>
            </div>

            {/* Skill Usage */}
            <div className="bg-surface-container rounded-lg overflow-hidden">
              <div className="px-4 md:px-6 py-3 md:py-4 bg-surface-container-high flex items-center gap-2 md:gap-3">
                <span className="material-symbols-outlined text-on-surface-variant text-base md:text-[24px]">smart_toy</span>
                <span className="text-xs md:text-sm font-bold uppercase tracking-widest">{t('admin.analytics.bySkill' as any)}</span>
              </div>
              <div className="p-4 md:p-6">
                {(overview?.bySkill?.length ?? 0) > 0 ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-2.5">
                    {overview!.bySkill.slice(0, 10).map((item, i) => {
                      const maxSkill = overview!.bySkill[0]?.count ?? 1;
                      const pct = ((item.count / maxSkill) * 100).toFixed(0);
                      const label = item.skill_id || '—';
                      return (
                        <div key={i}>
                          <div className="flex justify-between text-xs md:text-sm mb-1">
                            <span className="text-on-surface font-mono truncate max-w-[65%]">{label}</span>
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
                    <span className="material-symbols-outlined mr-2">info</span>
                    {t('admin.analytics.noData' as any)}
                  </div>
                )}
              </div>
            </div>

            {/* Top Users */}
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
