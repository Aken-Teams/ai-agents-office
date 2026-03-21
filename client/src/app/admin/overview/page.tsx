'use client';

import { useState, useEffect } from 'react';
import { useAdminAuth } from '../components/AdminAuthProvider';

interface Stats {
  totalUsers: number;
  activeSkills: number;
  totalTokens: number;
  totalFiles: number;
  systemUptime: number;
  systemHealth: string;
}

interface VelocityPoint {
  date: string;
  total_input: number;
  total_output: number;
  invocation_count: number;
}

interface ActivityEvent {
  event_type: string;
  entity_id: string;
  description: string;
  created_at: string;
}

const EVENT_META: Record<string, { icon: string; color: string; label: string }> = {
  user_registered:      { icon: 'person_add', color: 'text-primary', label: '用戶註冊' },
  file_generated:       { icon: 'draft', color: 'text-success', label: '檔案生成' },
  conversation_created: { icon: 'chat', color: 'text-tertiary', label: '對話建立' },
};

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = Math.floor((now - then) / 1000);
  if (diff < 60) return '剛剛';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分鐘前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小時前`;
  return `${Math.floor(diff / 86400)} 天前`;
}

export default function AdminOverview() {
  const { token } = useAdminAuth();
  const [stats, setStats] = useState<Stats | null>(null);
  const [velocity, setVelocity] = useState<VelocityPoint[]>([]);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [period, setPeriod] = useState<'7d' | '30d'>('7d');

  useEffect(() => {
    if (!token) return;
    const headers = { Authorization: `Bearer ${token}` };

    fetch('/api/admin/overview/stats', { headers })
      .then(r => r.json()).then(setStats).catch(console.error);

    fetch('/api/admin/overview/recent-activity?limit=3', { headers })
      .then(r => r.json()).then(setActivity).catch(console.error);
  }, [token]);

  useEffect(() => {
    if (!token) return;
    fetch(`/api/admin/overview/token-velocity?period=${period}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json()).then(setVelocity).catch(console.error);
  }, [token, period]);

  const maxTokens = Math.max(...velocity.map(v => v.total_input + v.total_output), 1);

  return (
    <>
      {/* Header */}
      <header className="sticky top-0 h-16 bg-surface/80 backdrop-blur-xl flex justify-between items-center px-8 z-40 shadow-[0_1px_0_0_rgba(255,255,255,0.05)]">
        <div className="flex items-center gap-4">
          <span className="text-lg font-black text-on-surface font-headline">系統控制中心</span>
          <div className="flex items-center gap-1.5 px-3 py-1 bg-primary/10 rounded-full">
            <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
            <span className="text-[10px] text-primary font-bold tracking-widest uppercase">所有節點正常</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button className="flex items-center gap-2 px-4 py-2 bg-surface-container text-on-surface-variant text-xs font-bold uppercase tracking-wider hover:bg-surface-container-high transition-colors cursor-pointer">
            <span className="material-symbols-outlined text-sm">download</span>
            匯出報表
          </button>
        </div>
      </header>

      {/* Content */}
      <div className="p-8 flex-1 space-y-6">
        {/* Stat Cards */}
        <div className="grid grid-cols-4 gap-6">
          {/* Total Users */}
          <div className="bg-surface-container p-6 rounded-lg group relative overflow-hidden">
            <span className="material-symbols-outlined absolute -bottom-6 -right-6 text-[12rem] text-on-surface opacity-[0.04] group-hover:opacity-[0.08] transition-opacity pointer-events-none">group</span>
            <p className="text-xs uppercase tracking-widest text-on-surface-variant mb-2">用戶總數</p>
            <div className="flex items-end gap-2">
              <span className="text-4xl font-headline font-black text-on-surface">{stats?.totalUsers ?? '—'}</span>
            </div>
            <p className="text-xs text-on-surface-variant mt-3 font-mono">已註冊帳號</p>
          </div>

          {/* Active Agents */}
          <div className="bg-surface-container p-6 rounded-lg group relative overflow-hidden">
            <span className="material-symbols-outlined absolute -bottom-6 -right-6 text-[12rem] text-on-surface opacity-[0.04] group-hover:opacity-[0.08] transition-opacity pointer-events-none">smart_toy</span>
            <p className="text-xs uppercase tracking-widest text-on-surface-variant mb-2">活躍代理</p>
            <div className="flex items-end gap-2">
              <span className="text-4xl font-headline font-black text-on-surface">{stats?.activeSkills ?? '—'}</span>
              <div className="flex items-center gap-1 mb-1.5">
                <div className="w-2 h-2 rounded-full bg-success animate-pulse" />
                <span className="text-[10px] text-success font-bold">運行中</span>
              </div>
            </div>
            <p className="text-xs text-on-surface-variant mt-3 font-mono">已載入 Skills</p>
          </div>

          {/* Tokens Consumed */}
          <div className="bg-surface-container p-6 rounded-lg group relative overflow-hidden">
            <span className="material-symbols-outlined absolute -bottom-6 -right-6 text-[12rem] text-on-surface opacity-[0.04] group-hover:opacity-[0.08] transition-opacity pointer-events-none">token</span>
            <p className="text-xs uppercase tracking-widest text-on-surface-variant mb-2">Token 消耗</p>
            <div className="flex items-end gap-2">
              <span className="text-4xl font-headline font-black text-on-surface">{stats ? formatTokens(stats.totalTokens) : '—'}</span>
            </div>
            <div className="mt-3 w-full h-1.5 bg-surface-container-highest rounded-full overflow-hidden">
              <div className="h-full bg-gradient-to-r from-primary to-tertiary rounded-full" style={{ width: `${Math.min((stats?.totalTokens ?? 0) / 10_000_000 * 100, 100)}%` }} />
            </div>
          </div>

          {/* System Health */}
          <div className="bg-surface-container p-6 rounded-lg group relative overflow-hidden">
            <span className="material-symbols-outlined absolute -bottom-6 -right-6 text-[12rem] text-on-surface opacity-[0.04] group-hover:opacity-[0.08] transition-opacity pointer-events-none">monitor_heart</span>
            <p className="text-xs uppercase tracking-widest text-on-surface-variant mb-2">系統健康度</p>
            <div className="flex items-end gap-2">
              <span className="text-4xl font-headline font-black text-success">99.8%</span>
            </div>
            <p className="text-xs text-on-surface-variant mt-3 font-mono">運行時間: {stats ? formatUptime(stats.systemUptime) : '—'}</p>
          </div>
        </div>

        {/* Two columns: Chart + Activity */}
        <div className="grid grid-cols-12 gap-6">
          {/* Token Velocity Chart */}
          <div className="col-span-8 bg-surface-container rounded-lg overflow-hidden">
            <div className="px-6 py-4 bg-surface-container-high flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="material-symbols-outlined text-tertiary">show_chart</span>
                <span className="text-xs font-bold uppercase tracking-widest">Token 消耗速度</span>
              </div>
              <div className="flex gap-1">
                {(['7d', '30d'] as const).map(p => (
                  <button
                    key={p}
                    onClick={() => setPeriod(p)}
                    className={`px-3 py-1 text-[10px] font-bold uppercase tracking-wider cursor-pointer transition-colors ${
                      period === p
                        ? 'text-primary border-b-2 border-primary'
                        : 'text-on-surface-variant hover:text-on-surface'
                    }`}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
            <div className="p-6">
              {velocity.length === 0 ? (
                <div className="h-48 flex items-center justify-center text-on-surface-variant text-sm">
                  <span className="material-symbols-outlined mr-2">info</span>
                  此時段無資料
                </div>
              ) : (
                <div className="flex items-end gap-2 h-48">
                  {velocity.map((v, i) => {
                    const total = v.total_input + v.total_output;
                    const pct = (total / maxTokens) * 100;
                    const inputPct = total > 0 ? (v.total_input / total) * 100 : 0;
                    const barHeight = Math.max(pct, 4);
                    return (
                      <div key={i} className="flex-1 flex flex-col items-center gap-1 h-full group/bar">
                        <span className="text-xs text-on-surface-variant opacity-0 group-hover/bar:opacity-100 transition-opacity font-mono font-bold">
                          {formatTokens(total)}
                        </span>
                        <div className="flex-1 w-full flex items-end">
                          <div className="w-full rounded-t overflow-hidden relative" style={{ height: `${barHeight}%` }}>
                            <div className="absolute inset-0 bg-primary/70" style={{ top: `${100 - inputPct}%` }} />
                            <div className="absolute inset-0 bg-tertiary/50" style={{ bottom: `${inputPct}%` }} />
                          </div>
                        </div>
                        <span className="text-[10px] text-outline truncate w-full text-center">
                          {v.date.split(' ')[0]?.slice(5) || v.date.slice(5)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Recent Activity */}
          <div className="col-span-4 bg-surface-container rounded-lg overflow-hidden flex flex-col">
            <div className="px-6 py-4 bg-surface-container-high flex items-center gap-3">
              <span className="material-symbols-outlined text-on-surface-variant">history</span>
              <span className="text-xs font-bold uppercase tracking-widest">最近活動</span>
            </div>
            <div className="flex-1 overflow-y-auto">
              {activity.length === 0 ? (
                <div className="p-6 text-center text-on-surface-variant text-sm">尚無活動記錄</div>
              ) : (
                <div className="p-4 space-y-0">
                  {activity.map((evt, i) => {
                    const meta = EVENT_META[evt.event_type] || { icon: 'info', color: 'text-on-surface-variant', label: evt.event_type };
                    return (
                      <div key={i} className="flex gap-3 py-3 border-b border-outline-variant/10 last:border-0">
                        <div className="flex flex-col items-center">
                          <div className={`w-8 h-8 rounded-full bg-surface-container-highest flex items-center justify-center shrink-0`}>
                            <span className={`material-symbols-outlined text-sm ${meta.color}`}>{meta.icon}</span>
                          </div>
                          {i < activity.length - 1 && <div className="w-px flex-1 bg-outline-variant/10 mt-1" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-bold text-on-surface">{meta.label}</p>
                          <p className="text-[11px] text-on-surface-variant truncate">{evt.description}</p>
                          <p className="text-[10px] text-outline mt-0.5 font-mono">{timeAgo(evt.created_at)}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* System Info + Files Summary */}
        <div className="grid grid-cols-12 gap-6">
          {/* System Info */}
          <div className="col-span-8 bg-surface-container-low border border-outline-variant/5 p-8 relative overflow-hidden">
            <div className="absolute right-6 bottom-6 opacity-[0.04] pointer-events-none">
              <span className="material-symbols-outlined text-[8rem]">security</span>
            </div>
            <div className="relative z-10">
              <h2 className="text-2xl font-headline font-bold text-on-surface mb-4">自動化威脅回應</h2>
              <p className="text-on-surface-variant max-w-2xl mb-6">
                AI Agents Office 目前處於「Sovereign」模式。所有沙箱代理程式在隔離環境中運行，具備即時監控功能。
              </p>
              <div className="grid grid-cols-3 gap-4">
                <div className="bg-surface-container p-4 border-l-2 border-primary">
                  <h4 className="text-on-surface font-bold text-sm mb-1">主動防護</h4>
                  <p className="text-xs text-on-surface-variant">沙箱隔離 v2.4 — 所有代理已容器化</p>
                </div>
                <div className="bg-surface-container p-4 border-l-2 border-tertiary">
                  <h4 className="text-on-surface font-bold text-sm mb-1">已生成檔案</h4>
                  <p className="text-xs text-on-surface-variant">全部用戶共 {stats?.totalFiles ?? 0} 份文件</p>
                </div>
                <div className="bg-surface-container p-4 border-l-2 border-success">
                  <h4 className="text-on-surface font-bold text-sm mb-1">執行環境</h4>
                  <p className="text-xs text-on-surface-variant font-mono">Node.js Runtime</p>
                </div>
              </div>
            </div>
          </div>

          {/* Quick Actions */}
          <div className="col-span-4 bg-surface-container p-6 rounded-lg flex flex-col justify-between">
            <div>
              <h3 className="text-xs font-bold uppercase tracking-widest mb-4">快速操作</h3>
              <div className="space-y-2">
                <a href="/admin/users" className="flex items-center gap-3 p-3 bg-surface-container-high rounded hover:bg-surface-variant transition-colors no-underline group">
                  <span className="material-symbols-outlined text-primary">corporate_fare</span>
                  <span className="text-sm text-on-surface">用戶管理</span>
                  <span className="material-symbols-outlined text-sm text-outline-variant ml-auto group-hover:text-primary transition-colors">arrow_forward</span>
                </a>
                <a href="/admin/tokens" className="flex items-center gap-3 p-3 bg-surface-container-high rounded hover:bg-surface-variant transition-colors no-underline group">
                  <span className="material-symbols-outlined text-tertiary">payments</span>
                  <span className="text-sm text-on-surface">Token 帳本</span>
                  <span className="material-symbols-outlined text-sm text-outline-variant ml-auto group-hover:text-primary transition-colors">arrow_forward</span>
                </a>
                <a href="/admin/security" className="flex items-center gap-3 p-3 bg-surface-container-high rounded hover:bg-surface-variant transition-colors no-underline group">
                  <span className="material-symbols-outlined text-warning">shield_with_heart</span>
                  <span className="text-sm text-on-surface">安全審計</span>
                  <span className="material-symbols-outlined text-sm text-outline-variant ml-auto group-hover:text-primary transition-colors">arrow_forward</span>
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
