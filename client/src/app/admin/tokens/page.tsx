'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAdminAuth } from '../components/AdminAuthProvider';
import { useTranslation } from '../../../i18n';

interface TokenSummary {
  totalInput: number;
  totalOutput: number;
  totalInvocations: number;
  estimatedCost: number;
}

interface ChartPoint {
  date: string;
  total_input: number;
  total_output: number;
  invocation_count: number;
}

interface UserBreakdown {
  id: string;
  email: string;
  display_name: string | null;
  total_input: number;
  total_output: number;
  invocation_count: number;
}

interface LedgerEntry {
  id: string;
  user_id: string;
  email: string;
  display_name: string | null;
  conversation_id: string | null;
  conversation_title: string | null;
  input_tokens: number;
  output_tokens: number;
  model: string | null;
  duration_ms: number | null;
  created_at: string;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

export default function AdminTokens() {
  const { token } = useAdminAuth();
  const { t } = useTranslation();
  const [summary, setSummary] = useState<TokenSummary | null>(null);
  const [chart, setChart] = useState<ChartPoint[]>([]);
  const [byUser, setByUser] = useState<UserBreakdown[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [ledgerTotal, setLedgerTotal] = useState(0);
  const [ledgerPage, setLedgerPage] = useState(1);
  const [ledgerTotalPages, setLedgerTotalPages] = useState(1);
  const [period, setPeriod] = useState<'7d' | '30d'>('7d');

  function timeAgo(dateStr: string): string {
    const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
    if (diff < 60) return t('admin.tokens.time.justNow');
    if (diff < 3600) return t('admin.tokens.time.minutesAgo', { count: Math.floor(diff / 60) });
    if (diff < 86400) return t('admin.tokens.time.hoursAgo', { count: Math.floor(diff / 3600) });
    return t('admin.tokens.time.daysAgo', { count: Math.floor(diff / 86400) });
  }

  useEffect(() => {
    if (!token) return;
    const headers = { Authorization: `Bearer ${token}` };

    fetch('/api/admin/tokens/summary', { headers })
      .then(r => r.json()).then(setSummary).catch(console.error);

    fetch('/api/admin/tokens/by-user?limit=10', { headers })
      .then(r => r.json()).then(setByUser).catch(console.error);
  }, [token]);

  useEffect(() => {
    if (!token) return;
    fetch(`/api/admin/tokens/chart?period=${period}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json()).then(setChart).catch(console.error);
  }, [token, period]);

  const fetchLedger = useCallback(() => {
    if (!token) return;
    fetch(`/api/admin/tokens/ledger?page=${ledgerPage}&limit=10`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(data => {
        setLedger(data.entries);
        setLedgerTotal(data.total);
        setLedgerTotalPages(data.totalPages);
      })
      .catch(console.error);
  }, [token, ledgerPage]);

  useEffect(() => { fetchLedger(); }, [fetchLedger]);

  const maxChart = Math.max(...chart.map(v => v.total_input + v.total_output), 1);
  const totalByUserTokens = byUser.reduce((sum, u) => sum + u.total_input + u.total_output, 0) || 1;

  return (
    <>
      {/* Header */}
      <header className="sticky top-0 h-14 md:h-16 bg-surface/80 backdrop-blur-xl flex justify-between items-center px-4 md:px-8 z-40 shadow-[0_1px_0_0_rgba(255,255,255,0.05)]">
        <div className="flex items-center gap-2 md:gap-4 min-w-0">
          <span className="text-base md:text-lg font-black text-on-surface font-headline truncate">{t('admin.tokens.title')}</span>
          <span className="text-[10px] md:text-sm px-1.5 md:px-2 py-0.5 bg-success/10 text-success rounded font-bold tracking-wider uppercase shrink-0">{t('admin.tokens.syncStatus')}</span>
        </div>
        <button className="flex items-center gap-1.5 md:gap-2 px-2.5 md:px-4 py-1.5 md:py-2 bg-surface-container text-on-surface-variant text-xs md:text-sm font-bold uppercase tracking-wider hover:bg-surface-container-high transition-colors cursor-pointer shrink-0">
          <span className="material-symbols-outlined text-sm">download</span>
          <span className="hidden md:inline">{t('admin.tokens.exportCsv')}</span>
          <span className="md:hidden">CSV</span>
        </button>
      </header>

      <div className="p-4 md:p-8 flex-1 space-y-4 md:space-y-6 overflow-y-auto">
        {/* Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-6">
          {/* Total Usage */}
          <div className="bg-surface-container p-3 md:p-6 rounded-lg group relative overflow-hidden">
            <span className="material-symbols-outlined absolute -bottom-4 -right-2 max-md:-bottom-2 max-md:-right-1 max-md:!text-[56px] text-on-surface opacity-[0.07] group-hover:opacity-[0.12] transition-opacity pointer-events-none" style={{ fontSize: 100 }}>token</span>
            <p className="text-[10px] md:text-sm uppercase tracking-widest text-on-surface-variant mb-1 md:mb-2">{t('admin.tokens.summary.totalUsage')}</p>
            <span className="text-xl md:text-3xl font-headline font-black text-on-surface">
              {summary ? formatTokens(summary.totalInput + summary.totalOutput) : '\u2014'}
            </span>
            <p className="text-[10px] md:text-sm text-on-surface-variant mt-1 md:mt-2 font-mono">
              <span className="hidden md:inline">{t('admin.users.detail.tokenInput')}: {summary ? formatTokens(summary.totalInput) : '0'} | {t('admin.users.detail.tokenOutput')}: {summary ? formatTokens(summary.totalOutput) : '0'}</span>
              <span className="md:hidden">In: {summary ? formatTokens(summary.totalInput) : '0'} · Out: {summary ? formatTokens(summary.totalOutput) : '0'}</span>
            </p>
          </div>

          {/* Estimated Cost */}
          <div className="bg-surface-container p-3 md:p-6 rounded-lg group relative overflow-hidden">
            <span className="material-symbols-outlined absolute -bottom-4 -right-2 max-md:-bottom-2 max-md:-right-1 max-md:!text-[56px] text-on-surface opacity-[0.07] group-hover:opacity-[0.12] transition-opacity pointer-events-none" style={{ fontSize: 100 }}>attach_money</span>
            <p className="text-[10px] md:text-sm uppercase tracking-widest text-on-surface-variant mb-1 md:mb-2">{t('admin.tokens.summary.estimatedCost')}</p>
            <span className="text-xl md:text-3xl font-headline font-black text-primary">
              ${summary?.estimatedCost.toFixed(4) ?? '0'}
            </span>
            <p className="text-[10px] md:text-sm text-on-surface-variant mt-1 md:mt-2 font-mono">{t('admin.tokens.summary.pricingNote')}</p>
          </div>

          {/* Total Invocations */}
          <div className="bg-surface-container p-3 md:p-6 rounded-lg group relative overflow-hidden">
            <span className="material-symbols-outlined absolute -bottom-4 -right-2 max-md:-bottom-2 max-md:-right-1 max-md:!text-[56px] text-on-surface opacity-[0.07] group-hover:opacity-[0.12] transition-opacity pointer-events-none" style={{ fontSize: 100 }}>api</span>
            <p className="text-[10px] md:text-sm uppercase tracking-widest text-on-surface-variant mb-1 md:mb-2">{t('admin.tokens.summary.totalInvocations')}</p>
            <span className="text-xl md:text-3xl font-headline font-black text-on-surface">
              {summary?.totalInvocations ?? 0}
            </span>
            <p className="text-[10px] md:text-sm text-on-surface-variant mt-1 md:mt-2 font-mono">{t('admin.tokens.summary.apiCalls')}</p>
          </div>

          {/* Billing Status */}
          <div className="bg-surface-container p-3 md:p-6 rounded-lg group relative overflow-hidden">
            <span className="material-symbols-outlined absolute -bottom-4 -right-2 max-md:-bottom-2 max-md:-right-1 max-md:!text-[56px] text-on-surface opacity-[0.07] group-hover:opacity-[0.12] transition-opacity pointer-events-none" style={{ fontSize: 100 }}>check_circle</span>
            <p className="text-[10px] md:text-sm uppercase tracking-widest text-on-surface-variant mb-1 md:mb-2">{t('admin.tokens.summary.billingStatus')}</p>
            <span className="text-xl md:text-3xl font-headline font-black text-success">{t('admin.tokens.summary.billingActive')}</span>
            <p className="text-[10px] md:text-sm text-on-surface-variant mt-1 md:mt-2 font-mono">{t('admin.tokens.summary.billingPaygo')}</p>
          </div>
        </div>

        {/* Chart + User Breakdown */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-4 md:gap-6">
          {/* Token Chart */}
          <div className="md:col-span-8 bg-surface-container rounded-lg overflow-hidden">
            <div className="px-4 md:px-6 py-3 md:py-4 bg-surface-container-high flex items-center justify-between">
              <div className="flex items-center gap-2 md:gap-3">
                <span className="material-symbols-outlined text-tertiary text-base md:text-[24px]">show_chart</span>
                <span className="text-xs md:text-sm font-bold uppercase tracking-widest">{t('admin.tokens.chart.title')}</span>
              </div>
              <div className="flex gap-1">
                {(['7d', '30d'] as const).map(p => (
                  <button
                    key={p}
                    onClick={() => setPeriod(p)}
                    className={`px-2 md:px-3 py-0.5 md:py-1 text-xs md:text-sm font-bold uppercase tracking-wider cursor-pointer transition-colors ${
                      p === '30d' ? 'hidden md:inline-block' : ''
                    } ${
                      period === p ? 'text-primary border-b-2 border-primary' : 'text-on-surface-variant hover:text-on-surface'
                    }`}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
            <div className="p-4 md:p-6">
              {chart.length === 0 ? (
                <div className="h-40 flex items-center justify-center text-on-surface-variant text-sm">
                  <span className="material-symbols-outlined mr-2">info</span>{t('admin.tokens.chart.noData')}
                </div>
              ) : (
                <div>
                  <div className={`flex items-end ${period === '30d' ? 'h-52 gap-px' : 'h-40 md:h-48 gap-1.5'}`}>
                    {chart.map((v, i) => {
                      const total = v.total_input + v.total_output;
                      const pct = (total / maxChart) * 100;
                      const barHeight = Math.max(pct, 3);
                      return (
                        <div key={i} className="flex-1 min-w-0 h-full flex items-end group/bar relative">
                          <div className="w-full bg-primary/60 rounded-t transition-all group-hover/bar:brightness-125" style={{ height: `${barHeight}%` }} />
                          <span className="absolute top-0 left-1/2 -translate-x-1/2 text-[10px] bg-surface-container-highest text-on-surface px-1.5 py-0.5 rounded opacity-0 group-hover/bar:opacity-100 transition-opacity font-mono font-bold whitespace-nowrap pointer-events-none z-10">
                            {v.date.slice(5)} · {formatTokens(total)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  {/* Date labels */}
                  {period === '30d' ? (
                    <div className="flex gap-px mt-4 h-14">
                      {chart.map((v, i) => (
                        <div key={i} className="flex-1 min-w-0 relative">
                          <span className="absolute top-0 left-1/2 -translate-x-1/2 origin-top -rotate-55 text-[11px] text-outline font-mono whitespace-nowrap">
                            {v.date.slice(5)}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="flex gap-1.5 mt-1.5">
                      {chart.map((v, i) => (
                        <span key={i} className="flex-1 min-w-0 text-xs text-center text-outline font-mono truncate">
                          {v.date.slice(5)}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* User Breakdown */}
          <div className="md:col-span-4 bg-surface-container rounded-lg overflow-hidden">
            <div className="px-4 md:px-6 py-3 md:py-4 bg-surface-container-high flex items-center gap-2 md:gap-3">
              <span className="material-symbols-outlined text-on-surface-variant text-base md:text-[24px]">pie_chart</span>
              <span className="text-xs md:text-sm font-bold uppercase tracking-widest">{t('admin.tokens.userBreakdown.title')}</span>
            </div>
            <div className="p-4 md:p-6 space-y-3">
              {byUser.length === 0 ? (
                <p className="text-sm text-on-surface-variant text-center py-4">{t('admin.tokens.userBreakdown.empty')}</p>
              ) : (
                byUser.slice(0, 6).map(u => {
                  const total = u.total_input + u.total_output;
                  const pct = ((total / totalByUserTokens) * 100).toFixed(1);
                  return (
                    <div key={u.id}>
                      <div className="flex justify-between text-xs md:text-sm mb-1">
                        <span className="text-on-surface truncate max-w-[60%]">{u.display_name || u.email}</span>
                        <span className="text-on-surface-variant font-mono">{pct}%</span>
                      </div>
                      <div className="w-full h-1.5 bg-surface-container-highest rounded-full overflow-hidden">
                        <div className="h-full bg-primary/60 rounded-full" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* Session Ledger */}
        <div className="bg-surface-container rounded-lg overflow-hidden">
          <div className="px-4 md:px-6 py-3 md:py-4 bg-surface-container-high flex items-center justify-between">
            <div className="flex items-center gap-2 md:gap-3">
              <span className="material-symbols-outlined text-on-surface-variant text-base md:text-[24px]">receipt_long</span>
              <span className="text-xs md:text-sm font-bold uppercase tracking-widest">{t('admin.tokens.ledger.title')}</span>
            </div>
            <span className="text-xs md:text-sm text-on-surface-variant">{t('admin.tokens.ledger.count', { count: ledgerTotal })}</span>
          </div>

          {/* Desktop Table */}
          <table className="w-full hidden md:table">
            <thead>
              <tr className="text-left text-sm uppercase tracking-widest text-on-surface-variant border-b border-outline-variant/10">
                <th className="py-3 px-6 font-bold">{t('admin.tokens.ledger.sessionId')}</th>
                <th className="py-3 px-6 font-bold">{t('admin.tokens.ledger.documentAction')}</th>
                <th className="py-3 px-6 font-bold">{t('admin.tokens.ledger.user')}</th>
                <th className="py-3 px-6 font-bold text-right">Tokens</th>
                <th className="py-3 px-6 font-bold text-right">{t('admin.tokens.ledger.cost')}</th>
                <th className="py-3 px-6 font-bold text-right">{t('admin.tokens.ledger.time')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/10">
              {ledger.map(entry => {
                const cost = ((entry.input_tokens / 1_000_000) * 3 + (entry.output_tokens / 1_000_000) * 15) * 10;
                return (
                  <tr key={entry.id} className="hover:bg-surface-container-high/50 transition-colors">
                    <td className="py-3 px-6 text-sm text-primary font-mono">{entry.id.slice(0, 8)}</td>
                    <td className="py-3 px-6 text-sm text-on-surface truncate max-w-[200px]">
                      {entry.conversation_title || '\u2014'}
                    </td>
                    <td className="py-3 px-6 max-w-[180px]">
                      <p className="text-sm text-on-surface truncate">{entry.display_name || entry.email.split('@')[0]}</p>
                      <p className="text-sm text-on-surface-variant font-mono truncate">{entry.email}</p>
                    </td>
                    <td className="py-3 px-6 text-right text-sm text-on-surface font-mono">
                      {formatTokens(entry.input_tokens + entry.output_tokens)}
                    </td>
                    <td className="py-3 px-6 text-right text-sm text-on-surface font-mono">
                      ${cost.toFixed(3)}
                    </td>
                    <td className="py-3 px-6 text-right text-sm text-on-surface-variant">
                      {timeAgo(entry.created_at)}
                    </td>
                  </tr>
                );
              })}
              {ledger.length === 0 && (
                <tr><td colSpan={6} className="py-12 text-center text-on-surface-variant">{t('admin.tokens.ledger.empty')}</td></tr>
              )}
            </tbody>
          </table>

          {/* Mobile Card List */}
          <div className="md:hidden divide-y divide-outline-variant/10">
            {ledger.map(entry => {
              const cost = ((entry.input_tokens / 1_000_000) * 3 + (entry.output_tokens / 1_000_000) * 15) * 10;
              return (
                <div key={entry.id} className="px-4 py-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-primary font-mono">{entry.id.slice(0, 8)}</span>
                    <span className="text-[10px] text-on-surface-variant">{timeAgo(entry.created_at)}</span>
                  </div>
                  <p className="text-sm text-on-surface font-medium truncate">{entry.conversation_title || '\u2014'}</p>
                  <p className="text-xs text-on-surface-variant truncate">{entry.display_name || entry.email.split('@')[0]}</p>
                  <div className="flex items-center gap-3 mt-1.5 text-xs text-on-surface-variant font-mono">
                    <span>{formatTokens(entry.input_tokens + entry.output_tokens)} tokens</span>
                    <span>${cost.toFixed(3)}</span>
                  </div>
                </div>
              );
            })}
            {ledger.length === 0 && (
              <div className="py-12 text-center text-on-surface-variant text-sm">{t('admin.tokens.ledger.empty')}</div>
            )}
          </div>

          {/* Pagination */}
          {ledgerTotalPages > 1 && (
            <div className="flex items-center justify-between px-4 md:px-6 py-3 md:py-4 border-t border-outline-variant/10">
              <span className="text-xs text-on-surface-variant md:hidden">{ledgerPage}/{ledgerTotalPages}</span>
              <span className="text-sm text-on-surface-variant hidden md:block">
                {t('admin.tokens.ledger.paginationSummary', { start: (ledgerPage - 1) * 10 + 1, end: Math.min(ledgerPage * 10, ledgerTotal), total: ledgerTotal })}
              </span>
              <div className="flex gap-1">
                <button
                  onClick={() => setLedgerPage(p => Math.max(1, p - 1))}
                  disabled={ledgerPage === 1}
                  className="px-2.5 md:px-3 py-1.5 text-xs md:text-sm bg-surface-container-high text-on-surface-variant rounded disabled:opacity-30 cursor-pointer"
                >
                  {t('common.prev')}
                </button>
                <button
                  onClick={() => setLedgerPage(p => Math.min(ledgerTotalPages, p + 1))}
                  disabled={ledgerPage === ledgerTotalPages}
                  className="px-2.5 md:px-3 py-1.5 text-xs md:text-sm bg-surface-container-high text-on-surface-variant rounded disabled:opacity-30 cursor-pointer"
                >
                  {t('common.next')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
