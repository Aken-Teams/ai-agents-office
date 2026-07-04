'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { AuthProvider, useAuth } from '../components/AuthProvider';
import { I18nProvider, useTranslation } from '../../i18n';
import Navbar from '../components/Navbar';
import { useSidebarMargin } from '../hooks/useSidebarCollapsed';
import HelpButton from '../components/HelpButton';

// Token counts on this page are shown RAW (no markup) so they match the admin
// back-office figures exactly. Cost/費用 comes boundary-exact from the server.
const rawTokens = (n: number): number => n;

interface DailyUsage {
  date: string;
  total_input: number;
  total_output: number;
  invocation_count: number;
  cost: number;   // boundary-exact (server-computed)
}

interface UsageTotal {
  totalInput: number;
  totalOutput: number;
  totalInvocations: number;
  cost: number;   // boundary-exact (server-computed)
}

type UsageCategory = 'document' | 'team' | 'email';

interface UsageResponse {
  summary: DailyUsage[];
  byCategory?: Record<UsageCategory, DailyUsage[]>;
  total: UsageTotal;
  limit: number;
  isBeta: boolean;
}

function UsageContent() {
  const { user, token, isLoading } = useAuth();
  const { t, locale } = useTranslation();
  const router = useRouter();
  const [daily, setDaily] = useState<DailyUsage[]>([]);
  const [byCategory, setByCategory] = useState<Record<UsageCategory, DailyUsage[]>>({ document: [], team: [], email: [] });
  const [detailCat, setDetailCat] = useState<'all' | UsageCategory>('all');
  const [total, setTotal] = useState<UsageTotal | null>(null);
  const [isBeta, setIsBeta] = useState(true);
  const [chartPeriod, setChartPeriod] = useState<'7d' | '30d'>('7d');
  const [filterFrom, setFilterFrom] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  });
  const [filterTo, setFilterTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [ledgerPage, setLedgerPage] = useState(1);
  const PAGE_SIZE = 6;
  const sidebarMargin = useSidebarMargin();

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  useEffect(() => {
    if (!token) return;

    fetch('/api/usage', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then((data: UsageResponse) => {
        setDaily(data.summary);
        setByCategory(data.byCategory ?? { document: [], team: [], email: [] });
        setTotal(data.total);
        setIsBeta(data.isBeta ?? true);
      })
      .catch(console.error);
  }, [token]);

  if (isLoading || !user) return null;

  // Chart data: filtered range when filter active, else fixed 7D/30D
  const chartData = (() => {
    const dataMap = new Map(daily.map(d => [d.date.slice(0, 10), d]));
    const days: DailyUsage[] = [];
    if (filterFrom || filterTo) {
      const start = new Date(filterFrom || daily[daily.length - 1]?.date.slice(0, 10) || new Date().toISOString().slice(0, 10));
      const end = new Date(filterTo || new Date().toISOString().slice(0, 10));
      for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const key = d.toISOString().slice(0, 10);
        days.push(dataMap.get(key) ?? { date: key, total_input: 0, total_output: 0, invocation_count: 0, cost: 0 });
      }
    } else {
      const today = new Date();
      const totalDays = chartPeriod === '30d' ? 30 : 7;
      for (let i = totalDays - 1; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        const key = d.toISOString().slice(0, 10);
        days.push(dataMap.get(key) ?? { date: key, total_input: 0, total_output: 0, invocation_count: 0, cost: 0 });
      }
    }
    return days;
  })();
  const maxTokens = Math.max(...chartData.map(d => d.total_input + d.total_output), 1);

  // Ledger: filter by date range
  const filteredDaily = daily.filter(d => {
    const date = d.date.slice(0, 10);
    if (filterFrom && date < filterFrom) return false;
    if (filterTo && date > filterTo) return false;
    return true;
  });

  // Usage-detail table source, switchable by product surface (全部 / 文件產生 /
  // AI 團隊 / 信件助手). Same date-range filtering as the overview.
  const catSource = detailCat === 'all' ? daily : (byCategory[detailCat] ?? []);
  const filteredCatDaily = catSource.filter(d => {
    const date = d.date.slice(0, 10);
    if (filterFrom && date < filterFrom) return false;
    if (filterTo && date > filterTo) return false;
    return true;
  });
  const CATEGORY_TABS: { key: 'all' | UsageCategory; label: string; icon: string }[] = [
    { key: 'all', label: locale === 'en' ? 'All' : '全部', icon: 'apps' },
    { key: 'document', label: locale === 'en' ? 'Documents' : '文件產生', icon: 'description' },
    { key: 'team', label: locale === 'en' ? 'AI Teams' : 'AI 團隊', icon: 'groups' },
    { key: 'email', label: locale === 'en' ? 'Email' : '信件助手', icon: 'mail' },
  ];

  // When date filter is active, overview card reflects filtered range
  const hasFilter = !!(filterFrom || filterTo);
  const activeTotal = hasFilter
    ? {
        totalInput: filteredDaily.reduce((s, d) => s + d.total_input, 0),
        totalOutput: filteredDaily.reduce((s, d) => s + d.total_output, 0),
        totalInvocations: filteredDaily.reduce((s, d) => s + d.invocation_count, 0),
        cost: filteredDaily.reduce((s, d) => s + (d.cost || 0), 0),
      }
    : total;

  const totalTokens = activeTotal ? activeTotal.totalInput + activeTotal.totalOutput : 0;
  const inputRatio = totalTokens > 0 ? ((activeTotal!.totalInput / totalTokens) * 100).toFixed(1) : '0';
  const outputRatio = totalTokens > 0 ? ((activeTotal!.totalOutput / totalTokens) * 100).toFixed(1) : '0';
  // Boundary-exact cost from the server (per record; ×10 before 2026-07-03 16:00, ×5 after).
  const estimatedCost = activeTotal?.cost ?? 0;

  return (
    <div className="min-h-screen bg-surface-container-lowest">
      <Navbar />

      <main className={`${sidebarMargin} md:pt-10 pb-12 px-4 md:px-10 transition-all duration-300`}>
          {/* Page Header */}
          <header className="mt-4 md:mt-0 mb-6 md:mb-10 flex flex-col md:flex-row md:justify-between md:items-end gap-4 md:gap-8">
            {/* Left: Title */}
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-tertiary text-xs md:text-sm font-bold tracking-[0.3em] uppercase">{t('usage.header.subtitle')}</span>
                <div className="h-px w-8 md:w-12 bg-tertiary/30" />
              </div>
              <div className="flex items-center gap-2 mb-1 md:mb-2">
                <h2 className="text-2xl md:text-4xl font-headline font-bold text-on-surface tracking-tight leading-none">{t('usage.header.title')}</h2>
                <HelpButton pageId="usage" />
              </div>
              <p className="text-sm md:text-base text-on-surface-variant leading-relaxed max-w-xl">
                {t('usage.header.description')}
              </p>
            </div>
            {/* Right: Date filter + CSV */}
            <div className="flex flex-col gap-2 shrink-0">
              {/* Date filter bar */}
              <div className={`flex items-center gap-2 px-3 py-2 border transition-colors ${hasFilter ? 'bg-tertiary/5 border-tertiary/30' : 'bg-surface-container border-outline-variant/20'}`}>
                <span className={`material-symbols-outlined text-sm ${hasFilter ? 'text-tertiary' : 'text-on-surface-variant/50'}`}>date_range</span>
                <input
                  type="date"
                  value={filterFrom}
                  onChange={e => { setFilterFrom(e.target.value); setLedgerPage(1); }}
                  className="bg-transparent text-on-surface text-xs font-mono focus:outline-none cursor-pointer min-w-0"
                />
                <span className="text-xs text-on-surface-variant/40 shrink-0">—</span>
                <input
                  type="date"
                  value={filterTo}
                  onChange={e => { setFilterTo(e.target.value); setLedgerPage(1); }}
                  className="bg-transparent text-on-surface text-xs font-mono focus:outline-none cursor-pointer min-w-0"
                />
                {hasFilter && (
                  <>
                    <span className="text-xs text-tertiary font-bold font-mono shrink-0">{filteredDaily.length}d</span>
                    <button
                      onClick={() => { setFilterFrom(''); setFilterTo(''); setLedgerPage(1); }}
                      className="text-on-surface-variant/50 hover:text-primary transition-colors cursor-pointer shrink-0"
                      title={locale === 'en' ? 'Clear filter' : '清除篩選'}
                    >
                      <span className="material-symbols-outlined text-sm">close</span>
                    </button>
                  </>
                )}
              </div>
              {/* CSV export button */}
              <button
                onClick={() => {
                  if (!token || daily.length === 0) return;
                  const q = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
                  const header = [t('usage.ledger.date'), t('usage.ledger.generations'), t('usage.ledger.inputTokens'), t('usage.ledger.outputTokens'), t('usage.ledger.total'), t('usage.overview.estimatedCost') + ' (USD)'].map(q).join(',');
                  const csvRows = daily.map(d => {
                    return [d.date.slice(0, 10), d.invocation_count, rawTokens(d.total_input), rawTokens(d.total_output), rawTokens(d.total_input + d.total_output), `$${(d.cost || 0).toFixed(4)}`].map(q).join(',');
                  });
                  const csv = '\uFEFF' + [header, ...csvRows].join('\n');
                  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url; a.download = `token_usage_${new Date().toISOString().slice(0, 10)}.csv`;
                  document.body.appendChild(a); a.click(); a.remove();
                  URL.revokeObjectURL(url);
                }}
                className="flex items-center justify-center gap-2 px-5 py-2.5 bg-surface-container-high text-on-surface-variant hover:text-primary active:bg-surface-container-highest transition-colors text-sm font-bold uppercase tracking-widest w-full"
              >
                <span className="material-symbols-outlined text-sm">download</span>
                {t('usage.header.exportCsv')}
              </button>
            </div>
          </header>

          {/* ===== Top Bento: Stats + Chart ===== */}
          <div className="grid grid-cols-12 gap-4 md:gap-6 mb-6 md:mb-10">

            {/* Left: Overview Card */}
            <div className="col-span-12 lg:col-span-4 bg-surface-container p-5 md:p-8 relative overflow-hidden flex flex-col justify-between gap-5 md:gap-0">
              <div className="absolute top-0 right-0 w-32 h-32 bg-primary/5 rounded-full -mr-10 -mt-10 blur-3xl" />
              <div>
                <div className="flex items-center gap-2 mb-2 md:mb-3">
                  <span className="text-xs md:text-sm uppercase tracking-[0.2em] text-primary font-bold">{t('usage.overview.title')}</span>
                  {!isBeta && !hasFilter && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary font-bold uppercase tracking-wider">
                      {locale === 'en' ? 'This Month' : '本月'}
                    </span>
                  )}
                  {hasFilter && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-tertiary/10 text-tertiary font-bold uppercase tracking-wider">
                      {locale === 'en' ? 'Filtered' : '篩選中'}
                    </span>
                  )}
                </div>
                <h3 className="text-on-surface-variant text-xs md:text-sm mb-1">
                  {hasFilter
                    ? (locale === 'en' ? 'Filtered Token Usage' : '篩選期間 Token 用量')
                    : !isBeta ? (locale === 'en' ? 'This Month\'s Token Usage' : '本月 Token 用量') : t('usage.overview.totalTokenUsage')}
                </h3>
                <div className="text-3xl md:text-5xl font-bold text-on-surface font-headline">{rawTokens(totalTokens).toLocaleString()}</div>
                <p className="text-xs md:text-sm text-on-surface-variant mt-1.5 md:mt-2">
                  {t('usage.overview.estimatedCost')} <span className="text-primary font-bold font-headline text-base md:text-lg">${estimatedCost.toFixed(4)}</span> <span className="text-xs md:text-sm uppercase tracking-wider">USD</span>
                </p>
              </div>
              <div className="grid grid-cols-3 gap-3 md:gap-4">
                <div>
                  <p className="text-xs md:text-sm text-on-surface-variant uppercase tracking-wider mb-1">{t('usage.overview.generations')}</p>
                  <p className="text-xl md:text-2xl font-headline font-bold text-primary">{activeTotal?.totalInvocations ?? 0}</p>
                </div>
                <div>
                  <p className="text-xs md:text-sm text-on-surface-variant uppercase tracking-wider mb-1">{t('usage.overview.input')}</p>
                  <p className="text-xl md:text-2xl font-headline font-bold text-tertiary">{rawTokens(activeTotal?.totalInput ?? 0).toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-xs md:text-sm text-on-surface-variant uppercase tracking-wider mb-1">{t('usage.overview.output')}</p>
                  <p className="text-xl md:text-2xl font-headline font-bold text-secondary">{rawTokens(activeTotal?.totalOutput ?? 0).toLocaleString()}</p>
                </div>
              </div>
            </div>

            {/* Right: Bar Chart */}
            <div className="col-span-12 lg:col-span-8 bg-surface-container p-4 md:p-8">
              <div className="flex flex-col md:flex-row md:justify-between md:items-center gap-2 md:gap-0 mb-4 md:mb-8">
                <div>
                  <span className="text-xs md:text-sm uppercase tracking-[0.2em] text-tertiary font-bold block mb-1">{t('usage.chart.title')}</span>
                  <h3 className="text-base md:text-xl font-bold font-headline text-on-surface">{t('usage.chart.subtitle')}</h3>
                </div>
                <div className="flex items-center gap-3 md:gap-4 text-xs">
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 bg-primary inline-block" />
                    <span className="text-on-surface-variant uppercase tracking-wider">Input</span>
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 bg-tertiary inline-block" />
                    <span className="text-on-surface-variant uppercase tracking-wider">Output</span>
                  </span>
                  {!hasFilter && <div className="flex gap-1 ml-2 border-l border-outline-variant/20 pl-3">
                    {(['7d', '30d'] as const).map(p => (
                      <button
                        key={p}
                        onClick={() => setChartPeriod(p)}
                        className={`px-2 py-0.5 text-xs font-bold uppercase tracking-wider cursor-pointer transition-colors ${
                          chartPeriod === p
                            ? 'text-primary border-b-2 border-primary'
                            : 'text-on-surface-variant hover:text-on-surface'
                        }`}
                      >
                        {p}
                      </button>
                    ))}
                  </div>}
                </div>
              </div>

              {chartData.length === 0 ? (
                <div className="h-32 md:h-40 flex items-center justify-center">
                  <p className="text-xs md:text-sm text-on-surface-variant/60 uppercase tracking-widest">{t('usage.chart.noData')}</p>
                </div>
              ) : (
                <div className="pt-7">
                  {/* Bars */}
                  <div className={`relative flex items-end h-36 md:h-52 ${
                    chartData.length > 20 ? 'gap-px' :
                    chartData.length > 10 ? 'gap-0.5 md:gap-1' :
                    'gap-1 md:gap-1.5'
                  }`}>
                    {/* Reference lines */}
                    {[75, 50, 25].map(pct => (
                      <div key={pct} className="absolute left-0 right-0 h-px bg-outline-variant/10 pointer-events-none" style={{ bottom: `${pct}%` }} />
                    ))}
                    {chartData.map(day => {
                      const dayTotal = day.total_input + day.total_output;
                      const pct = (dayTotal / maxTokens) * 100;
                      const inputPct = dayTotal > 0 ? (day.total_input / dayTotal) * 100 : 0;
                      return (
                        <div key={day.date} className="flex-1 min-w-0 h-full flex items-end relative z-10 group">
                          <div className="absolute -top-6 left-1/2 -translate-x-1/2 bg-surface-container-highest text-on-surface px-2 py-0.5 text-[10px] md:text-xs font-mono whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-20 pointer-events-none">
                            {day.date.slice(5)} · {rawTokens(dayTotal).toLocaleString()}
                          </div>
                          <div
                            className="w-full rounded-t-sm overflow-hidden transition-all duration-300 group-hover:brightness-125"
                            style={{ height: `${Math.max(pct, 2)}%` }}
                          >
                            <div className="bg-tertiary/70" style={{ height: `${100 - inputPct}%` }} />
                            <div className="bg-primary" style={{ height: `${inputPct}%` }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {/* Date labels */}
                  {chartData.length > 10 ? (
                    <div className={`flex mt-2 h-14 ${chartData.length > 20 ? 'gap-px' : 'gap-0.5 md:gap-1'}`}>
                      {chartData.map((day, i) => {
                        const step = Math.ceil(chartData.length / 10);
                        const show = i % step === 0 || i === chartData.length - 1;
                        return (
                          <div key={day.date} className="flex-1 min-w-0 relative overflow-visible">
                            {show && (
                              <span
                                className="absolute top-0 left-0 text-[10px] text-outline/60 font-mono whitespace-nowrap leading-none"
                                style={{ transform: 'rotate(45deg)', transformOrigin: 'top left' }}
                              >
                                {day.date.slice(5)}
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="flex mt-1.5 gap-1 md:gap-1.5">
                      {chartData.map(day => (
                        <span key={day.date} className="flex-1 min-w-0 text-[10px] md:text-xs text-center text-outline/60 font-mono truncate">
                          {day.date.slice(5)}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* ===== Bottom: Breakdown + Table ===== */}
          <div className="grid grid-cols-12 gap-4 md:gap-6">

            {/* Left Column: Token Ratio + Quick Stats */}
            <div className="col-span-12 lg:col-span-4 space-y-4 md:space-y-6">

              {/* Token Ratio */}
              <section className="bg-surface-container p-4 md:p-6">
                <h4 className="text-xs md:text-sm font-bold font-headline uppercase tracking-widest mb-4 md:mb-6 text-on-surface flex items-center gap-2">
                  <span className="material-symbols-outlined text-primary text-base md:text-lg">donut_large</span>
                  {t('usage.distribution.title')}
                </h4>
                <div className="space-y-4 md:space-y-5">
                  <div>
                    <div className="flex justify-between text-xs md:text-sm mb-2">
                      <span className="text-on-surface-variant">{t('usage.distribution.inputToken')}</span>
                      <span className="text-on-surface font-mono">{inputRatio}%</span>
                    </div>
                    <div className="h-1.5 bg-surface-variant w-full overflow-hidden">
                      <div className="h-full bg-primary transition-all duration-500" style={{ width: `${inputRatio}%` }} />
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between text-xs md:text-sm mb-2">
                      <span className="text-on-surface-variant">{t('usage.distribution.outputToken')}</span>
                      <span className="text-on-surface font-mono">{outputRatio}%</span>
                    </div>
                    <div className="h-1.5 bg-surface-variant w-full overflow-hidden">
                      <div className="h-full bg-tertiary transition-all duration-500" style={{ width: `${outputRatio}%` }} />
                    </div>
                  </div>
                </div>
              </section>

              {/* Activity Summary */}
              <section className="bg-surface-container p-4 md:p-6">
                <h4 className="text-xs md:text-sm font-bold font-headline uppercase tracking-widest mb-4 md:mb-6 text-on-surface flex items-center gap-2">
                  <span className="material-symbols-outlined text-primary text-base md:text-lg">insights</span>
                  {t('usage.activity.title')}
                </h4>
                <div className="space-y-3 md:space-y-4">
                  {daily.slice(0, 3).map(day => (
                    <div key={day.date} className="flex justify-between items-center bg-surface-container-low p-2.5 md:p-3 active:bg-surface-container-high md:hover:bg-surface-container-high transition-colors">
                      <div className="min-w-0 flex-1">
                        <p className="text-xs md:text-sm font-bold text-on-surface">{new Date(day.date).toLocaleDateString(locale === 'en' ? 'en-US' : 'zh-TW', { month: 'short', day: 'numeric', weekday: 'short' })}</p>
                        <p className="text-xs md:text-sm text-on-surface-variant truncate">
                          {t('usage.activity.generationCount', { count: day.invocation_count })} · {rawTokens(day.total_input + day.total_output).toLocaleString()} tokens
                        </p>
                      </div>
                      <span className="text-xs md:text-sm font-mono text-primary ml-2 shrink-0">{rawTokens(day.total_output).toLocaleString()}</span>
                    </div>
                  ))}
                  {daily.length === 0 && (
                    <p className="text-xs md:text-sm text-on-surface-variant/60 text-center py-4 uppercase tracking-widest">{t('usage.activity.noRecords')}</p>
                  )}
                </div>
              </section>
            </div>

            {/* Right Column: Session Ledger */}
            <div className="col-span-12 lg:col-span-8 bg-surface-container overflow-hidden">
              <div className="p-4 md:p-6 border-b border-white/5">
                <div className="flex justify-between items-center mb-3 md:mb-4">
                  <h4 className="text-xs md:text-sm font-bold font-headline uppercase tracking-widest text-on-surface">{t('usage.ledger.title')}</h4>
                  <span className="text-xs md:text-sm text-on-surface-variant/60 uppercase tracking-widest">
                    {filterFrom || filterTo
                      ? `${filteredCatDaily.length} / ${catSource.length}`
                      : t('usage.ledger.totalRecords', { count: catSource.length })}
                  </span>
                </div>
                {/* Product-surface tabs — 全部 / 文件產生 / AI 團隊 / 信件助手.
                    Single scrollable row on mobile (no awkward 2-row wrap). */}
                <div className="flex gap-1.5 overflow-x-auto -mx-1 px-1 pb-0.5 md:flex-wrap md:overflow-visible md:mx-0 md:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  {CATEGORY_TABS.map(tab => (
                    <button
                      key={tab.key}
                      onClick={() => { setDetailCat(tab.key); setLedgerPage(1); }}
                      className={`shrink-0 whitespace-nowrap flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors cursor-pointer ${
                        detailCat === tab.key
                          ? 'bg-primary text-on-primary'
                          : 'bg-surface-container-high text-on-surface-variant hover:text-primary'
                      }`}
                    >
                      <span className="material-symbols-outlined text-sm">{tab.icon}</span>
                      {tab.label}
                    </button>
                  ))}
                </div>
              </div>

              {daily.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 md:py-16">
                  <span className="material-symbols-outlined text-2xl md:text-3xl text-on-surface-variant/30 mb-3">analytics</span>
                  <p className="text-xs md:text-sm text-on-surface-variant/60 uppercase tracking-widest">{t('usage.ledger.noData')}</p>
                </div>
              ) : filteredCatDaily.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 md:py-16">
                  <span className="material-symbols-outlined text-2xl md:text-3xl text-on-surface-variant/30 mb-3">search_off</span>
                  <p className="text-xs md:text-sm text-on-surface-variant/60 uppercase tracking-widest">查無資料</p>
                </div>
              ) : (
                <>
                  {/* Desktop Table */}
                  <div className="hidden md:block overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="bg-surface-container-high/50 text-sm uppercase tracking-widest text-on-surface-variant">
                          <th className="px-6 py-4 font-bold">{t('usage.ledger.date')}</th>
                          <th className="px-6 py-4 font-bold">{t('usage.ledger.generations')}</th>
                          <th className="px-6 py-4 font-bold">{t('usage.ledger.inputTokens')}</th>
                          <th className="px-6 py-4 font-bold">{t('usage.ledger.outputTokens')}</th>
                          <th className="px-6 py-4 font-bold text-right">{t('usage.ledger.total')}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5">
                        {filteredCatDaily.slice((ledgerPage - 1) * PAGE_SIZE, ledgerPage * PAGE_SIZE).map((day, i) => (
                          <tr
                            key={day.date}
                            className={`hover:bg-primary/5 transition-colors ${i % 2 === 1 ? 'bg-surface-container-high/20' : ''}`}
                          >
                            <td className="px-6 py-4 text-sm font-mono text-on-surface-variant">{day.date.slice(0, 10)}</td>
                            <td className="px-6 py-4">
                              <div className="flex items-center gap-2">
                                <span className="material-symbols-outlined text-sm text-tertiary">bolt</span>
                                <span className="text-sm text-on-surface font-medium">{day.invocation_count}</span>
                              </div>
                            </td>
                            <td className="px-6 py-4 text-sm font-mono text-on-surface">{rawTokens(day.total_input).toLocaleString()}</td>
                            <td className="px-6 py-4 text-sm font-mono text-on-surface">{rawTokens(day.total_output).toLocaleString()}</td>
                            <td className="px-6 py-4 text-sm font-mono text-primary font-bold text-right">
                              {rawTokens(day.total_input + day.total_output).toLocaleString()}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Mobile Card List */}
                  <div className="md:hidden divide-y divide-white/5">
                    {filteredCatDaily.slice((ledgerPage - 1) * PAGE_SIZE, ledgerPage * PAGE_SIZE).map((day, i) => (
                      <div
                        key={day.date}
                        className={`p-3.5 active:bg-primary/5 transition-colors ${i % 2 === 1 ? 'bg-surface-container-high/20' : ''}`}
                      >
                        {/* Row 1: Date + Total */}
                        <div className="flex justify-between items-baseline gap-2 mb-1.5">
                          <span className="text-xs font-mono text-on-surface-variant">{day.date.slice(0, 10)}</span>
                          <span className="text-base font-mono text-primary font-bold tabular-nums">
                            {rawTokens(day.total_input + day.total_output).toLocaleString()}
                          </span>
                        </div>
                        {/* Row 2: Generations + Input/Output breakdown (wraps, never overflows) */}
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-on-surface-variant">
                          <span className="flex items-center gap-1">
                            <span className="material-symbols-outlined text-xs text-tertiary">bolt</span>
                            {day.invocation_count}
                          </span>
                          <span className="text-on-surface-variant/40">|</span>
                          <span>In <span className="font-mono text-on-surface tabular-nums">{rawTokens(day.total_input).toLocaleString()}</span></span>
                          <span>Out <span className="font-mono text-on-surface tabular-nums">{rawTokens(day.total_output).toLocaleString()}</span></span>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
              {(() => {
                const totalPages = Math.ceil(filteredCatDaily.length / PAGE_SIZE);
                if (totalPages <= 1) return null;
                return (
                  <div className="p-3 md:p-4 border-t border-white/5 flex items-center justify-between">
                    <button
                      onClick={() => setLedgerPage(p => Math.max(1, p - 1))}
                      disabled={ledgerPage === 1}
                      className="flex items-center gap-1 text-xs font-bold uppercase tracking-wider text-on-surface-variant hover:text-primary disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer"
                    >
                      <span className="material-symbols-outlined text-sm">chevron_left</span>
                      上一頁
                    </button>
                    {/* Mobile: compact indicator (numbered strip overflows on phones) */}
                    <span className="md:hidden text-xs font-mono text-on-surface-variant">{ledgerPage} / {totalPages}</span>
                    {/* Desktop: numbered buttons */}
                    <div className="hidden md:flex items-center gap-1">
                      {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
                        <button
                          key={p}
                          onClick={() => setLedgerPage(p)}
                          className={`w-7 h-7 rounded-lg text-xs font-bold font-mono transition-colors cursor-pointer ${
                            p === ledgerPage
                              ? 'bg-primary text-on-primary'
                              : 'text-on-surface-variant hover:text-primary'
                          }`}
                        >
                          {p}
                        </button>
                      ))}
                    </div>
                    <button
                      onClick={() => setLedgerPage(p => Math.min(totalPages, p + 1))}
                      disabled={ledgerPage === totalPages}
                      className="flex items-center gap-1 text-xs font-bold uppercase tracking-wider text-on-surface-variant hover:text-primary disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer"
                    >
                      下一頁
                      <span className="material-symbols-outlined text-sm">chevron_right</span>
                    </button>
                  </div>
                );
              })()}
            </div>
          </div>

          {/* ===== Bottom Info Banner ===== */}
          <div className="mt-6 md:mt-10 bg-surface-variant/20 backdrop-blur-sm p-4 md:p-6 border-l-2 border-tertiary">
            <div className="flex items-start gap-3 md:gap-4">
              <span className="material-symbols-outlined text-tertiary text-lg md:text-2xl shrink-0">info</span>
              <div>
                <h5 className="text-on-surface text-xs md:text-sm font-bold font-headline mb-1">{t('usage.info.title')}</h5>
                <p className="text-xs md:text-sm text-on-surface-variant leading-relaxed">
                  {t('usage.info.description')}
                </p>
              </div>
            </div>
          </div>
      </main>
    </div>
  );
}

export default function UsagePage() {
  return (
    <AuthProvider>
      <UsageWithI18n />
    </AuthProvider>
  );
}

function UsageWithI18n() {
  const { user } = useAuth();
  return (
    <I18nProvider initialLocale={user?.locale} initialTheme={user?.theme}>
      <UsageContent />
    </I18nProvider>
  );
}
