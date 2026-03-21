'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { AuthProvider, useAuth } from '../components/AuthProvider';
import Navbar from '../components/Navbar';

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
  const router = useRouter();
  const [daily, setDaily] = useState<DailyUsage[]>([]);
  const [total, setTotal] = useState<UsageTotal | null>(null);
  const [showAllRows, setShowAllRows] = useState(false);
  const LEDGER_DEFAULT_ROWS = 4;

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

  // Chart data: always show at least 7 days, fill missing days with 0
  const CHART_MIN_DAYS = 7;
  const chartData = (() => {
    const dataMap = new Map(daily.map(d => [d.date, d]));
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

      <main className="ml-64 pt-8 pb-12 px-10">
          {/* Page Header */}
          <header className="mb-10 flex justify-between items-end">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-tertiary text-xs font-bold tracking-[0.3em] uppercase">系統監控</span>
                <div className="h-px w-12 bg-tertiary/30" />
              </div>
              <h2 className="text-4xl font-headline font-bold text-on-surface tracking-tight mb-2">用量統計</h2>
              <p className="text-on-surface-variant leading-relaxed max-w-xl">
                即時追蹤 AI 代理的 Token 消耗量與生成活動記錄。
              </p>
            </div>
            <button
              onClick={() => {
                if (!token || daily.length === 0) return;
                const header = 'Date,Generations,Input Tokens,Output Tokens,Total\n';
                const rows = daily.map(d => `${d.date},${d.invocation_count},${d.total_input},${d.total_output},${d.total_input + d.total_output}`).join('\n');
                const blob = new Blob([header + rows], { type: 'text/csv' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = 'token-usage.csv';
                document.body.appendChild(a); a.click(); a.remove();
                URL.revokeObjectURL(url);
              }}
              className="flex items-center gap-2 px-5 py-2.5 bg-surface-container-high text-on-surface-variant hover:text-primary transition-colors text-xs font-bold uppercase tracking-widest shrink-0"
            >
              <span className="material-symbols-outlined text-sm">download</span>
              匯出 CSV
            </button>
          </header>

          {/* ===== Top Bento: Stats + Chart ===== */}
          <div className="grid grid-cols-12 gap-6 mb-10">

            {/* Left: Overview Card */}
            <div className="col-span-12 lg:col-span-4 bg-surface-container p-8 relative overflow-hidden flex flex-col justify-between min-h-[260px]">
              <div className="absolute top-0 right-0 w-32 h-32 bg-primary/5 rounded-full -mr-10 -mt-10 blur-3xl" />
              <div>
                <span className="text-xs uppercase tracking-[0.2em] text-primary font-bold mb-4 block">總覽</span>
                <h3 className="text-on-surface-variant text-sm mb-1">累計 Token 用量</h3>
                <div className="text-5xl font-bold text-on-surface font-headline">{totalTokens.toLocaleString()}</div>
              </div>
              <div className="grid grid-cols-3 gap-4 mt-6">
                <div>
                  <p className="text-[10px] text-on-surface-variant uppercase tracking-wider mb-1">生成次數</p>
                  <p className="text-xl font-headline font-bold text-primary">{total?.totalInvocations ?? 0}</p>
                </div>
                <div>
                  <p className="text-[10px] text-on-surface-variant uppercase tracking-wider mb-1">輸入</p>
                  <p className="text-xl font-headline font-bold text-tertiary">{total?.totalInput.toLocaleString() ?? 0}</p>
                </div>
                <div>
                  <p className="text-[10px] text-on-surface-variant uppercase tracking-wider mb-1">輸出</p>
                  <p className="text-xl font-headline font-bold text-secondary">{total?.totalOutput.toLocaleString() ?? 0}</p>
                </div>
              </div>
            </div>

            {/* Right: Bar Chart */}
            <div className="col-span-12 lg:col-span-8 bg-surface-container p-8">
              <div className="flex justify-between items-center mb-8">
                <div>
                  <span className="text-xs uppercase tracking-[0.2em] text-tertiary font-bold block mb-1">趨勢</span>
                  <h3 className="text-xl font-bold font-headline text-on-surface">Token 消耗速率</h3>
                </div>
                <div className="flex items-center gap-4 text-[10px]">
                  <span className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 bg-primary inline-block" />
                    <span className="text-on-surface-variant uppercase tracking-wider">Input</span>
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 bg-tertiary inline-block" />
                    <span className="text-on-surface-variant uppercase tracking-wider">Output</span>
                  </span>
                </div>
              </div>

              {chartData.length === 0 ? (
                <div className="h-40 flex items-center justify-center">
                  <p className="text-sm text-on-surface-variant/60 uppercase tracking-widest">尚無用量數據</p>
                </div>
              ) : (
                <div className="flex items-end gap-1.5 px-1">
                  {chartData.map(day => {
                    const dayTotal = day.total_input + day.total_output;
                    const pct = (dayTotal / maxTokens) * 100;
                    const inputPct = dayTotal > 0 ? (day.total_input / dayTotal) * 100 : 0;
                    return (
                      <div key={day.date} className="flex-1 flex flex-col items-center group">
                        {/* Bar area */}
                        <div className="w-full h-40 flex flex-col justify-end relative">
                          {/* Tooltip */}
                          <div className="absolute -top-6 left-1/2 -translate-x-1/2 bg-surface-container-highest text-on-surface px-2.5 py-1 text-xs font-mono whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-10 pointer-events-none">
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
                        {/* Date label */}
                        <span className="mt-2 text-[10px] text-on-surface-variant/60 font-mono">{day.date}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* ===== Bottom: Breakdown + Table ===== */}
          <div className="grid grid-cols-12 gap-6">

            {/* Left Column: Token Ratio + Quick Stats */}
            <div className="col-span-12 lg:col-span-4 space-y-6">

              {/* Token Ratio */}
              <section className="bg-surface-container p-6">
                <h4 className="text-sm font-bold font-headline uppercase tracking-widest mb-6 text-on-surface flex items-center gap-2">
                  <span className="material-symbols-outlined text-primary text-lg">donut_large</span>
                  Token 分佈
                </h4>
                <div className="space-y-5">
                  <div>
                    <div className="flex justify-between text-xs mb-2">
                      <span className="text-on-surface-variant">輸入 Token (Input)</span>
                      <span className="text-on-surface font-mono">{inputRatio}%</span>
                    </div>
                    <div className="h-1.5 bg-surface-variant w-full overflow-hidden">
                      <div className="h-full bg-primary transition-all duration-500" style={{ width: `${inputRatio}%` }} />
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between text-xs mb-2">
                      <span className="text-on-surface-variant">輸出 Token (Output)</span>
                      <span className="text-on-surface font-mono">{outputRatio}%</span>
                    </div>
                    <div className="h-1.5 bg-surface-variant w-full overflow-hidden">
                      <div className="h-full bg-tertiary transition-all duration-500" style={{ width: `${outputRatio}%` }} />
                    </div>
                  </div>
                </div>
              </section>

              {/* Activity Summary */}
              <section className="bg-surface-container p-6">
                <h4 className="text-sm font-bold font-headline uppercase tracking-widest mb-6 text-on-surface flex items-center gap-2">
                  <span className="material-symbols-outlined text-primary text-lg">insights</span>
                  活動摘要
                </h4>
                <div className="space-y-4">
                  {daily.slice(0, 5).map(day => (
                    <div key={day.date} className="flex justify-between items-center bg-surface-container-low p-3 hover:bg-surface-container-high transition-colors">
                      <div>
                        <p className="text-xs font-bold text-on-surface">{day.date}</p>
                        <p className="text-[10px] text-on-surface-variant">
                          {day.invocation_count} 次生成 · {(day.total_input + day.total_output).toLocaleString()} tokens
                        </p>
                      </div>
                      <span className="text-xs font-mono text-primary">{day.total_output.toLocaleString()}</span>
                    </div>
                  ))}
                  {daily.length === 0 && (
                    <p className="text-xs text-on-surface-variant/60 text-center py-4 uppercase tracking-widest">尚無記錄</p>
                  )}
                </div>
              </section>
            </div>

            {/* Right Column: Session Ledger Table */}
            <div className="col-span-12 lg:col-span-8 bg-surface-container overflow-hidden">
              <div className="p-6 border-b border-white/5 flex justify-between items-center">
                <h4 className="text-sm font-bold font-headline uppercase tracking-widest text-on-surface">用量明細</h4>
                <span className="text-[10px] text-on-surface-variant/60 uppercase tracking-widest">
                  共 {daily.length} 筆記錄
                </span>
              </div>

              {daily.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16">
                  <span className="material-symbols-outlined text-3xl text-on-surface-variant/30 mb-3">analytics</span>
                  <p className="text-sm text-on-surface-variant/60 uppercase tracking-widest">尚無用量數據</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-surface-container-high/50 text-[10px] uppercase tracking-widest text-on-surface-variant">
                        <th className="px-6 py-4 font-bold">日期</th>
                        <th className="px-6 py-4 font-bold">生成次數</th>
                        <th className="px-6 py-4 font-bold">輸入 Token</th>
                        <th className="px-6 py-4 font-bold">輸出 Token</th>
                        <th className="px-6 py-4 font-bold text-right">合計</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {(showAllRows ? daily : daily.slice(0, LEDGER_DEFAULT_ROWS)).map((day, i) => (
                        <tr
                          key={day.date}
                          className={`hover:bg-primary/5 transition-colors ${i % 2 === 1 ? 'bg-surface-container-high/20' : ''}`}
                        >
                          <td className="px-6 py-4 text-xs font-mono text-on-surface-variant">{day.date}</td>
                          <td className="px-6 py-4">
                            <div className="flex items-center gap-2">
                              <span className="material-symbols-outlined text-sm text-tertiary">bolt</span>
                              <span className="text-xs text-on-surface font-medium">{day.invocation_count}</span>
                            </div>
                          </td>
                          <td className="px-6 py-4 text-xs font-mono text-on-surface">{day.total_input.toLocaleString()}</td>
                          <td className="px-6 py-4 text-xs font-mono text-on-surface">{day.total_output.toLocaleString()}</td>
                          <td className="px-6 py-4 text-xs font-mono text-primary font-bold text-right">
                            {(day.total_input + day.total_output).toLocaleString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {daily.length > LEDGER_DEFAULT_ROWS && (
                <div className="p-4 border-t border-white/5 flex justify-center">
                  <button
                    onClick={() => setShowAllRows(v => !v)}
                    className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant hover:text-primary transition-colors cursor-pointer flex items-center gap-1"
                  >
                    {showAllRows ? '收合' : `顯示全部 ${daily.length} 筆記錄`}
                    <span className={`material-symbols-outlined text-sm transition-transform ${showAllRows ? 'rotate-180' : ''}`}>expand_more</span>
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* ===== Bottom Info Banner ===== */}
          <div className="mt-10 bg-surface-variant/20 backdrop-blur-sm p-6 border-l-2 border-tertiary">
            <div className="flex items-start gap-4">
              <span className="material-symbols-outlined text-tertiary">info</span>
              <div>
                <h5 className="text-on-surface text-sm font-bold font-headline mb-1">用量計算說明</h5>
                <p className="text-xs text-on-surface-variant leading-relaxed">
                  Token 用量統計包含所有 AI 代理的輸入提示詞與輸出生成內容。每次文件生成或對話互動均會產生 Token 消耗。輸入 Token 來自系統指令與用戶訊息，輸出 Token 來自 AI 回應與生成的檔案內容。
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
      <UsageContent />
    </AuthProvider>
  );
}
