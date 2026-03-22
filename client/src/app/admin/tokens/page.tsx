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
      <header className="sticky top-0 h-16 bg-surface/80 backdrop-blur-xl flex justify-between items-center px-8 z-40 shadow-[0_1px_0_0_rgba(255,255,255,0.05)]">
        <div className="flex items-center gap-4">
          <span className="text-lg font-black text-on-surface font-headline">{t('admin.tokens.title')}</span>
          <span className="text-sm px-2 py-0.5 bg-success/10 text-success rounded font-bold tracking-wider uppercase">{t('admin.tokens.syncStatus')}</span>
        </div>
        <div className="flex items-center gap-3">
          <button className="flex items-center gap-2 px-4 py-2 bg-surface-container text-on-surface-variant text-sm font-bold uppercase tracking-wider hover:bg-surface-container-high transition-colors cursor-pointer">
            <span className="material-symbols-outlined text-sm">download</span>
            {t('admin.tokens.exportCsv')}
          </button>
        </div>
      </header>

      <div className="p-8 flex-1 space-y-6 overflow-y-auto">
        {/* Summary Cards */}
        <div className="grid grid-cols-4 gap-6">
          <div className="bg-surface-container p-6 rounded-lg col-span-1 group relative overflow-hidden">
            <span className="material-symbols-outlined absolute -bottom-4 -right-2 text-on-surface opacity-[0.07] group-hover:opacity-[0.12] transition-opacity pointer-events-none" style={{ fontSize: '100px' }}>token</span>
            <p className="text-sm uppercase tracking-widest text-on-surface-variant mb-2">{t('admin.tokens.summary.totalUsage')}</p>
            <span className="text-3xl font-headline font-black text-on-surface">
              {summary ? formatTokens(summary.totalInput + summary.totalOutput) : '\u2014'}
            </span>
            <p className="text-sm text-on-surface-variant mt-2 font-mono">
              {t('admin.users.detail.tokenInput')}: {summary ? formatTokens(summary.totalInput) : '0'} | {t('admin.users.detail.tokenOutput')}: {summary ? formatTokens(summary.totalOutput) : '0'}
            </p>
          </div>
          <div className="bg-surface-container p-6 rounded-lg col-span-1 group relative overflow-hidden">
            <span className="material-symbols-outlined absolute -bottom-4 -right-2 text-on-surface opacity-[0.07] group-hover:opacity-[0.12] transition-opacity pointer-events-none" style={{ fontSize: '100px' }}>attach_money</span>
            <p className="text-sm uppercase tracking-widest text-on-surface-variant mb-2">{t('admin.tokens.summary.estimatedCost')}</p>
            <span className="text-3xl font-headline font-black text-primary">
              ${summary?.estimatedCost.toFixed(4) ?? '0'}
            </span>
            <p className="text-sm text-on-surface-variant mt-2 font-mono">{t('admin.tokens.summary.pricingNote')}</p>
          </div>
          <div className="bg-surface-container p-6 rounded-lg col-span-1 group relative overflow-hidden">
            <span className="material-symbols-outlined absolute -bottom-4 -right-2 text-on-surface opacity-[0.07] group-hover:opacity-[0.12] transition-opacity pointer-events-none" style={{ fontSize: '100px' }}>api</span>
            <p className="text-sm uppercase tracking-widest text-on-surface-variant mb-2">{t('admin.tokens.summary.totalInvocations')}</p>
            <span className="text-3xl font-headline font-black text-on-surface">
              {summary?.totalInvocations ?? 0}
            </span>
            <p className="text-sm text-on-surface-variant mt-2 font-mono">{t('admin.tokens.summary.apiCalls')}</p>
          </div>
          <div className="bg-surface-container p-6 rounded-lg col-span-1 group relative overflow-hidden">
            <span className="material-symbols-outlined absolute -bottom-4 -right-2 text-on-surface opacity-[0.07] group-hover:opacity-[0.12] transition-opacity pointer-events-none" style={{ fontSize: '100px' }}>check_circle</span>
            <p className="text-sm uppercase tracking-widest text-on-surface-variant mb-2">{t('admin.tokens.summary.billingStatus')}</p>
            <div className="flex items-center gap-2">
              <span className="text-3xl font-headline font-black text-success">{t('admin.tokens.summary.billingActive')}</span>
            </div>
            <p className="text-sm text-on-surface-variant mt-2 font-mono">{t('admin.tokens.summary.billingPaygo')}</p>
          </div>
        </div>

        {/* Chart + User Breakdown */}
        <div className="grid grid-cols-12 gap-6">
          {/* Token Chart */}
          <div className="col-span-8 bg-surface-container rounded-lg overflow-hidden">
            <div className="px-6 py-4 bg-surface-container-high flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="material-symbols-outlined text-tertiary">show_chart</span>
                <span className="text-sm font-bold uppercase tracking-widest">{t('admin.tokens.chart.title')}</span>
              </div>
              <div className="flex gap-1">
                {(['7d', '30d'] as const).map(p => (
                  <button
                    key={p}
                    onClick={() => setPeriod(p)}
                    className={`px-3 py-1 text-sm font-bold uppercase tracking-wider cursor-pointer transition-colors ${
                      period === p ? 'text-primary border-b-2 border-primary' : 'text-on-surface-variant hover:text-on-surface'
                    }`}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
            <div className="p-6">
              {chart.length === 0 ? (
                <div className="h-48 flex items-center justify-center text-on-surface-variant text-sm">
                  <span className="material-symbols-outlined mr-2">info</span>{t('admin.tokens.chart.noData')}
                </div>
              ) : (
                <div className="flex items-end gap-2 h-48">
                  {chart.map((v, i) => {
                    const total = v.total_input + v.total_output;
                    const pct = (total / maxChart) * 100;
                    const barHeight = Math.max(pct, 4);
                    return (
                      <div key={i} className="flex-1 flex flex-col items-center gap-1 h-full group/bar">
                        <span className="text-sm text-on-surface-variant opacity-0 group-hover/bar:opacity-100 transition-opacity font-mono font-bold">
                          {formatTokens(total)}
                        </span>
                        <div className="flex-1 w-full flex items-end">
                          <div className="w-full bg-primary/60 rounded-t transition-all" style={{ height: `${barHeight}%` }} />
                        </div>
                        <span className="text-sm text-outline truncate w-full text-center">
                          {v.date.split(' ')[0]?.slice(5) || v.date.slice(5)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* User Breakdown */}
          <div className="col-span-4 bg-surface-container rounded-lg overflow-hidden">
            <div className="px-6 py-4 bg-surface-container-high flex items-center gap-3">
              <span className="material-symbols-outlined text-on-surface-variant">pie_chart</span>
              <span className="text-sm font-bold uppercase tracking-widest">{t('admin.tokens.userBreakdown.title')}</span>
            </div>
            <div className="p-6 space-y-3">
              {byUser.length === 0 ? (
                <p className="text-sm text-on-surface-variant text-center py-4">{t('admin.tokens.userBreakdown.empty')}</p>
              ) : (
                byUser.slice(0, 6).map(u => {
                  const total = u.total_input + u.total_output;
                  const pct = ((total / totalByUserTokens) * 100).toFixed(1);
                  return (
                    <div key={u.id}>
                      <div className="flex justify-between text-sm mb-1">
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
          <div className="px-6 py-4 bg-surface-container-high flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="material-symbols-outlined text-on-surface-variant">receipt_long</span>
              <span className="text-sm font-bold uppercase tracking-widest">{t('admin.tokens.ledger.title')}</span>
            </div>
            <span className="text-sm text-on-surface-variant">{t('admin.tokens.ledger.count', { count: ledgerTotal })}</span>
          </div>
          <table className="w-full">
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

          {/* Pagination */}
          {ledgerTotalPages > 1 && (
            <div className="flex items-center justify-between px-6 py-4 border-t border-outline-variant/10">
              <span className="text-sm text-on-surface-variant">
                {t('admin.tokens.ledger.paginationSummary', { start: (ledgerPage - 1) * 10 + 1, end: Math.min(ledgerPage * 10, ledgerTotal), total: ledgerTotal })}
              </span>
              <div className="flex gap-1">
                <button
                  onClick={() => setLedgerPage(p => Math.max(1, p - 1))}
                  disabled={ledgerPage === 1}
                  className="px-3 py-1.5 text-sm bg-surface-container-high text-on-surface-variant rounded disabled:opacity-30 cursor-pointer"
                >
                  {t('common.prev')}
                </button>
                <button
                  onClick={() => setLedgerPage(p => Math.min(ledgerTotalPages, p + 1))}
                  disabled={ledgerPage === ledgerTotalPages}
                  className="px-3 py-1.5 text-sm bg-surface-container-high text-on-surface-variant rounded disabled:opacity-30 cursor-pointer"
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
