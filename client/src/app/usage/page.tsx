'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { AuthProvider, useAuth } from '../components/AuthProvider';
import { I18nProvider, useTranslation } from '../../i18n';
import Navbar from '../components/Navbar';
import { useSidebarMargin } from '../hooks/useSidebarCollapsed';

interface DailyUsage {
  date: string;
  total_input: number;
  total_output: number;
  invocation_count: number;
}

interface UsageTotal {
  totalInput: number;
  totalOutput: number;
  totalInvocations: number;
}

function UsageContent() {
  const { user, token, isLoading } = useAuth();
  const { t, locale } = useTranslation();
  const router = useRouter();
  const [daily, setDaily] = useState<DailyUsage[]>([]);
  const [total, setTotal] = useState<UsageTotal | null>(null);
  const [showAllRows, setShowAllRows] = useState(false);
  const LEDGER_DEFAULT_ROWS = 8;
  const sidebarMargin = useSidebarMargin();

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  useEffect(() => {
    if (!token) return;

    fetch('/api/usage', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(data => {
        setDaily(data.summary);
        setTotal(data.total);
      })
      .catch(console.error);
  }, [token]);

  if (isLoading || !user) return null;

  const totalTokens = total ? total.totalInput + total.totalOutput : 0;
  const inputRatio = totalTokens > 0 ? ((total!.totalInput / totalTokens) * 100).toFixed(1) : '0';
  const outputRatio = totalTokens > 0 ? ((total!.totalOutput / totalTokens) * 100).toFixed(1) : '0';

  // Claude Sonnet 4 pricing: Input $3/M, Output $15/M (×10 billing markup)
  const estimatedCost = total
    ? ((total.totalInput / 1_000_000) * 3 + (total.totalOutput / 1_000_000) * 15) * 10
    : 0;

  // Chart data: always show at least 7 days, fill missing days with 0
  const CHART_MIN_DAYS = 7;
  const chartData = (() => {
    const dataMap = new Map(daily.map(d => [d.date.slice(0, 10), d]));
    const days: DailyUsage[] = [];
    const today = new Date();
    // Determine how many days to show: max(7, actual data range)
    const totalDays = Math.max(CHART_MIN_DAYS, daily.length);
    for (let i = totalDays - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      days.push(dataMap.get(key) ?? { date: key, total_input: 0, total_output: 0, invocation_count: 0 });
    }
    return days;
  })();
  const maxTokens = Math.max(...chartData.map(d => d.total_input + d.total_output), 1);

  return (
    <div className="min-h-screen bg-surface-container-lowest">
      <Navbar />

      <main className={`${sidebarMargin} md:pt-10 pb-12 px-4 md:px-10 transition-all duration-300`}>
          {/* Page Header */}
          <header className="mt-4 md:mt-0 mb-6 md:mb-10 flex flex-col md:flex-row md:justify-between md:items-end gap-4">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-tertiary text-xs md:text-sm font-bold tracking-[0.3em] uppercase">{t('usage.header.subtitle')}</span>
                <div className="h-px w-8 md:w-12 bg-tertiary/30" />
              </div>
              <h2 className="text-2xl md:text-4xl font-headline font-bold text-on-surface tracking-tight mb-1 md:mb-2">{t('usage.header.title')}</h2>
              <p className="text-sm md:text-base text-on-surface-variant leading-relaxed max-w-xl">
                {t('usage.header.description')}
              </p>
            </div>
            <button
              onClick={() => {
                if (!token || daily.length === 0) return;
                const q = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
                const header = [t('usage.ledger.date'), t('usage.ledger.generations'), t('usage.ledger.inputTokens'), t('usage.ledger.outputTokens'), t('usage.ledger.total'), t('usage.overview.estimatedCost') + ' (USD)'].map(q).join(',');
                const csvRows = daily.map(d => {
                  const total = d.total_input + d.total_output;
                  const cost = ((d.total_input / 1_000_000) * 3 + (d.total_output / 1_000_000) * 15) * 10;
                  return [d.date.slice(0, 10), d.invocation_count, d.total_input, d.total_output, total, `$${cost.toFixed(4)}`].map(q).join(',');
                });
                const csv = '\uFEFF' + [header, ...csvRows].join('\n');
                const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = `token_usage_${new Date().toISOString().slice(0, 10)}.csv`;
                document.body.appendChild(a); a.click(); a.remove();
                URL.revokeObjectURL(url);
              }}
              className="flex items-center justify-center gap-2 px-5 py-2.5 bg-surface-container-high text-on-surface-variant hover:text-primary active:bg-surface-container-highest transition-colors text-sm font-bold uppercase tracking-widest shrink-0 w-full md:w-auto"
            >
              <span className="material-symbols-outlined text-sm">download</span>
              {t('usage.header.exportCsv')}
            </button>
          </header>

          {/* ===== Top Bento: Stats + Chart ===== */}
          <div className="grid grid-cols-12 gap-4 md:gap-6 mb-6 md:mb-10">

            {/* Left: Overview Card */}
            <div className="col-span-12 lg:col-span-4 bg-surface-container p-5 md:p-8 relative overflow-hidden flex flex-col justify-between gap-5 md:gap-0">
              <div className="absolute top-0 right-0 w-32 h-32 bg-primary/5 rounded-full -mr-10 -mt-10 blur-3xl" />
              <div>
                <span className="text-xs md:text-sm uppercase tracking-[0.2em] text-primary font-bold mb-2 md:mb-3 block">{t('usage.overview.title')}</span>
                <h3 className="text-on-surface-variant text-xs md:text-sm mb-1">{t('usage.overview.totalTokenUsage')}</h3>
                <div className="text-3xl md:text-5xl font-bold text-on-surface font-headline">{totalTokens.toLocaleString()}</div>
                <p className="text-xs md:text-sm text-on-surface-variant mt-1.5 md:mt-2">
                  {t('usage.overview.estimatedCost')} <span className="text-primary font-bold font-headline text-base md:text-lg">${estimatedCost.toFixed(4)}</span> <span className="text-xs md:text-sm uppercase tracking-wider">USD</span>
                </p>
              </div>
              <div className="grid grid-cols-3 gap-3 md:gap-4">
                <div>
                  <p className="text-xs md:text-sm text-on-surface-variant uppercase tracking-wider mb-1">{t('usage.overview.generations')}</p>
                  <p className="text-xl md:text-2xl font-headline font-bold text-primary">{total?.totalInvocations ?? 0}</p>
                </div>
                <div>
                  <p className="text-xs md:text-sm text-on-surface-variant uppercase tracking-wider mb-1">{t('usage.overview.input')}</p>
                  <p className="text-xl md:text-2xl font-headline font-bold text-tertiary">{total?.totalInput.toLocaleString() ?? 0}</p>
                </div>
                <div>
                  <p className="text-xs md:text-sm text-on-surface-variant uppercase tracking-wider mb-1">{t('usage.overview.output')}</p>
                  <p className="text-xl md:text-2xl font-headline font-bold text-secondary">{total?.totalOutput.toLocaleString() ?? 0}</p>
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
                <div className="flex items-center gap-3 md:gap-4 text-xs md:text-sm">
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 md:w-2.5 md:h-2.5 bg-primary inline-block" />
                    <span className="text-on-surface-variant uppercase tracking-wider">Input</span>
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 md:w-2.5 md:h-2.5 bg-tertiary inline-block" />
                    <span className="text-on-surface-variant uppercase tracking-wider">Output</span>
                  </span>
                </div>
              </div>

              {chartData.length === 0 ? (
                <div className="h-32 md:h-40 flex items-center justify-center">
                  <p className="text-xs md:text-sm text-on-surface-variant/60 uppercase tracking-widest">{t('usage.chart.noData')}</p>
                </div>
              ) : (
                <div className="flex items-end gap-1 md:gap-1.5 px-1 pt-8 overflow-x-auto no-scrollbar">
                  {chartData.map(day => {
                    const dayTotal = day.total_input + day.total_output;
                    const pct = (dayTotal / maxTokens) * 100;
                    const inputPct = dayTotal > 0 ? (day.total_input / dayTotal) * 100 : 0;
                    return (
                      <div key={day.date} className="flex-1 min-w-[28px] flex flex-col items-center group">
                        {/* Bar area */}
                        <div className="w-full h-28 md:h-40 flex flex-col justify-end relative">
                          {/* Tooltip */}
                          <div className="absolute -top-6 left-1/2 -translate-x-1/2 bg-surface-container-highest text-on-surface px-2 py-0.5 md:px-2.5 md:py-1 text-xs md:text-sm font-mono whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-10 pointer-events-none">
                            {dayTotal.toLocaleString()}
                          </div>
                          <div
                            className="w-full rounded-t-sm overflow-hidden transition-all duration-300"
                            style={{ height: `${Math.max(pct, 2)}%` }}
                          >
                            <div className="bg-tertiary/70" style={{ height: `${100 - inputPct}%` }} />
                            <div className="bg-primary" style={{ height: `${inputPct}%` }} />
                          </div>
                        </div>
                        {/* Date label — show MM/DD on mobile, full date on desktop */}
                        <span className="mt-1.5 md:mt-2 text-[10px] md:text-sm text-on-surface-variant/60 font-mono md:hidden">{day.date.slice(0, 10).slice(5)}</span>
                        <span className="mt-2 text-sm text-on-surface-variant/60 font-mono hidden md:block">{day.date.slice(0, 10)}</span>
                      </div>
                    );
                  })}
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
                          {t('usage.activity.generationCount', { count: day.invocation_count })} · {(day.total_input + day.total_output).toLocaleString()} tokens
                        </p>
                      </div>
                      <span className="text-xs md:text-sm font-mono text-primary ml-2 shrink-0">{day.total_output.toLocaleString()}</span>
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
              <div className="p-4 md:p-6 border-b border-white/5 flex justify-between items-center">
                <h4 className="text-xs md:text-sm font-bold font-headline uppercase tracking-widest text-on-surface">{t('usage.ledger.title')}</h4>
                <span className="text-xs md:text-sm text-on-surface-variant/60 uppercase tracking-widest">
                  {t('usage.ledger.totalRecords', { count: daily.length })}
                </span>
              </div>

              {daily.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 md:py-16">
                  <span className="material-symbols-outlined text-2xl md:text-3xl text-on-surface-variant/30 mb-3">analytics</span>
                  <p className="text-xs md:text-sm text-on-surface-variant/60 uppercase tracking-widest">{t('usage.ledger.noData')}</p>
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
                        {(showAllRows ? daily : daily.slice(0, LEDGER_DEFAULT_ROWS)).map((day, i) => (
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
                            <td className="px-6 py-4 text-sm font-mono text-on-surface">{day.total_input.toLocaleString()}</td>
                            <td className="px-6 py-4 text-sm font-mono text-on-surface">{day.total_output.toLocaleString()}</td>
                            <td className="px-6 py-4 text-sm font-mono text-primary font-bold text-right">
                              {(day.total_input + day.total_output).toLocaleString()}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Mobile Card List */}
                  <div className="md:hidden divide-y divide-white/5">
                    {(showAllRows ? daily : daily.slice(0, LEDGER_DEFAULT_ROWS)).map((day, i) => (
                      <div
                        key={day.date}
                        className={`p-3.5 active:bg-primary/5 transition-colors ${i % 2 === 1 ? 'bg-surface-container-high/20' : ''}`}
                      >
                        {/* Row 1: Date + Total */}
                        <div className="flex justify-between items-center mb-1.5">
                          <span className="text-xs font-mono text-on-surface-variant">{day.date.slice(0, 10)}</span>
                          <span className="text-sm font-mono text-primary font-bold">
                            {(day.total_input + day.total_output).toLocaleString()}
                          </span>
                        </div>
                        {/* Row 2: Generations + Input/Output breakdown */}
                        <div className="flex items-center gap-3 text-xs text-on-surface-variant">
                          <span className="flex items-center gap-1">
                            <span className="material-symbols-outlined text-xs text-tertiary">bolt</span>
                            {day.invocation_count}
                          </span>
                          <span className="text-on-surface-variant/40">|</span>
                          <span>In: <span className="font-mono text-on-surface">{day.total_input.toLocaleString()}</span></span>
                          <span>Out: <span className="font-mono text-on-surface">{day.total_output.toLocaleString()}</span></span>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
              {daily.length > LEDGER_DEFAULT_ROWS && (
                <div className="p-3 md:p-4 border-t border-white/5 flex justify-center">
                  <button
                    onClick={() => setShowAllRows(v => !v)}
                    className="text-xs md:text-sm font-bold uppercase tracking-widest text-on-surface-variant hover:text-primary active:text-primary transition-colors cursor-pointer flex items-center gap-1"
                  >
                    {showAllRows ? t('usage.ledger.collapse') : t('usage.ledger.showAll', { count: daily.length })}
                    <span className={`material-symbols-outlined text-xs md:text-sm transition-transform ${showAllRows ? 'rotate-180' : ''}`}>expand_more</span>
                  </button>
                </div>
              )}
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
