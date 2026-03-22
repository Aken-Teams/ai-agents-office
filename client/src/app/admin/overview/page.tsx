'use client';

import { useState, useEffect } from 'react';
import { useAdminAuth } from '../components/AdminAuthProvider';
import { useTranslation } from '../../../i18n';

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

export default function AdminOverview() {
  const { token } = useAdminAuth();
  const { t } = useTranslation();
  const [stats, setStats] = useState<Stats | null>(null);
  const [velocity, setVelocity] = useState<VelocityPoint[]>([]);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [period, setPeriod] = useState<'7d' | '30d'>('7d');

  const EVENT_META: Record<string, { icon: string; color: string; label: string }> = {
    user_registered:      { icon: 'person_add', color: 'text-primary', label: t('admin.overview.event.userRegistered') },
    file_generated:       { icon: 'draft', color: 'text-success', label: t('admin.overview.event.fileGenerated') },
    conversation_created: { icon: 'chat', color: 'text-tertiary', label: t('admin.overview.event.conversationCreated') },
  };

  function timeAgo(dateStr: string): string {
    const now = Date.now();
    const then = new Date(dateStr).getTime();
    const diff = Math.floor((now - then) / 1000);
    if (diff < 60) return t('admin.overview.time.justNow');
    if (diff < 3600) return t('admin.overview.time.minutesAgo', { count: Math.floor(diff / 60) });
    if (diff < 86400) return t('admin.overview.time.hoursAgo', { count: Math.floor(diff / 3600) });
    return t('admin.overview.time.daysAgo', { count: Math.floor(diff / 86400) });
  }

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
          <span className="text-lg font-black text-on-surface font-headline">{t('admin.overview.title')}</span>
          <div className="flex items-center gap-1.5 px-3 py-1 bg-primary/10 rounded-full">
            <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
            <span className="text-sm text-primary font-bold tracking-widest uppercase">{t('admin.overview.allNodesNormal')}</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button className="flex items-center gap-2 px-4 py-2 bg-surface-container text-on-surface-variant text-sm font-bold uppercase tracking-wider hover:bg-surface-container-high transition-colors cursor-pointer">
            <span className="material-symbols-outlined text-sm">download</span>
            {t('admin.overview.exportReport')}
          </button>
        </div>
      </header>

      {/* Content */}
      <div className="p-8 flex-1 space-y-6">
        {/* Stat Cards */}
        <div className="grid grid-cols-4 gap-6">
          {/* Total Users */}
          <div className="bg-surface-container p-6 rounded-lg group relative overflow-hidden">
            <span className="material-symbols-outlined absolute -bottom-4 -right-2 text-on-surface opacity-[0.07] group-hover:opacity-[0.12] transition-opacity pointer-events-none" style={{ fontSize: '100px' }}>group</span>
            <p className="text-sm uppercase tracking-widest text-on-surface-variant mb-2">{t('admin.overview.stats.totalUsers')}</p>
            <div className="flex items-end gap-2">
              <span className="text-4xl font-headline font-black text-on-surface">{stats?.totalUsers ?? '\u2014'}</span>
            </div>
            <p className="text-sm text-on-surface-variant mt-3 font-mono">{t('admin.overview.stats.totalUsersDesc')}</p>
          </div>

          {/* Active Agents */}
          <div className="bg-surface-container p-6 rounded-lg group relative overflow-hidden">
            <span className="material-symbols-outlined absolute -bottom-4 -right-2 text-on-surface opacity-[0.07] group-hover:opacity-[0.12] transition-opacity pointer-events-none" style={{ fontSize: '100px' }}>smart_toy</span>
            <p className="text-sm uppercase tracking-widest text-on-surface-variant mb-2">{t('admin.overview.stats.activeAgents')}</p>
            <div className="flex items-end gap-2">
              <span className="text-4xl font-headline font-black text-on-surface">{stats?.activeSkills ?? '\u2014'}</span>
              <div className="flex items-center gap-1 mb-1.5">
                <div className="w-2 h-2 rounded-full bg-success animate-pulse" />
                <span className="text-sm text-success font-bold">{t('admin.overview.stats.activeAgentsRunning')}</span>
              </div>
            </div>
            <p className="text-sm text-on-surface-variant mt-3 font-mono">{t('admin.overview.stats.activeAgentsDesc')}</p>
          </div>

          {/* Tokens Consumed */}
          <div className="bg-surface-container p-6 rounded-lg group relative overflow-hidden">
            <span className="material-symbols-outlined absolute -bottom-4 -right-2 text-on-surface opacity-[0.07] group-hover:opacity-[0.12] transition-opacity pointer-events-none" style={{ fontSize: '100px' }}>token</span>
            <p className="text-sm uppercase tracking-widest text-on-surface-variant mb-2">{t('admin.overview.stats.tokenConsumed')}</p>
            <div className="flex items-end gap-2">
              <span className="text-4xl font-headline font-black text-on-surface">{stats ? formatTokens(stats.totalTokens) : '\u2014'}</span>
            </div>
            <div className="mt-3 w-full h-1.5 bg-surface-container-highest rounded-full overflow-hidden">
              <div className="h-full bg-gradient-to-r from-primary to-tertiary rounded-full" style={{ width: `${Math.min((stats?.totalTokens ?? 0) / 10_000_000 * 100, 100)}%` }} />
            </div>
          </div>

          {/* System Health */}
          <div className="bg-surface-container p-6 rounded-lg group relative overflow-hidden">
            <span className="material-symbols-outlined absolute -bottom-4 -right-2 text-on-surface opacity-[0.07] group-hover:opacity-[0.12] transition-opacity pointer-events-none" style={{ fontSize: '100px' }}>monitor_heart</span>
            <p className="text-sm uppercase tracking-widest text-on-surface-variant mb-2">{t('admin.overview.stats.systemHealth')}</p>
            <div className="flex items-end gap-2">
              <span className="text-4xl font-headline font-black text-success">99.8%</span>
            </div>
            <p className="text-sm text-on-surface-variant mt-3 font-mono">{t('admin.overview.stats.uptime')} {stats ? formatUptime(stats.systemUptime) : '\u2014'}</p>
          </div>
        </div>

        {/* Two columns: Chart + Activity */}
        <div className="grid grid-cols-12 gap-6">
          {/* Token Velocity Chart */}
          <div className="col-span-8 bg-surface-container rounded-lg overflow-hidden">
            <div className="px-6 py-4 bg-surface-container-high flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="material-symbols-outlined text-tertiary">show_chart</span>
                <span className="text-sm font-bold uppercase tracking-widest">{t('admin.overview.chart.title')}</span>
              </div>
              <div className="flex gap-1">
                {(['7d', '30d'] as const).map(p => (
                  <button
                    key={p}
                    onClick={() => setPeriod(p)}
                    className={`px-3 py-1 text-sm font-bold uppercase tracking-wider cursor-pointer transition-colors ${
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
                  {t('admin.overview.chart.noData')}
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
                        <span className="text-sm text-on-surface-variant opacity-0 group-hover/bar:opacity-100 transition-opacity font-mono font-bold">
                          {formatTokens(total)}
                        </span>
                        <div className="flex-1 w-full flex items-end">
                          <div className="w-full rounded-t overflow-hidden relative" style={{ height: `${barHeight}%` }}>
                            <div className="absolute inset-0 bg-primary/70" style={{ top: `${100 - inputPct}%` }} />
                            <div className="absolute inset-0 bg-tertiary/50" style={{ bottom: `${inputPct}%` }} />
                          </div>
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

          {/* Recent Activity */}
          <div className="col-span-4 bg-surface-container rounded-lg overflow-hidden flex flex-col">
            <div className="px-6 py-4 bg-surface-container-high flex items-center gap-3">
              <span className="material-symbols-outlined text-on-surface-variant">history</span>
              <span className="text-sm font-bold uppercase tracking-widest">{t('admin.overview.activity.title')}</span>
            </div>
            <div className="flex-1 overflow-y-auto">
              {activity.length === 0 ? (
                <div className="p-6 text-center text-on-surface-variant text-sm">{t('admin.overview.activity.empty')}</div>
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
                          <p className="text-sm font-bold text-on-surface">{meta.label}</p>
                          <p className="text-sm text-on-surface-variant truncate">{evt.description}</p>
                          <p className="text-sm text-outline mt-0.5 font-mono">{timeAgo(evt.created_at)}</p>
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
              <h2 className="text-2xl font-headline font-bold text-on-surface mb-4">{t('admin.overview.systemInfo.title')}</h2>
              <p className="text-on-surface-variant max-w-2xl mb-6">
                {t('admin.overview.systemInfo.description')}
              </p>
              <div className="grid grid-cols-3 gap-4">
                <div className="bg-surface-container p-4 border-l-2 border-primary">
                  <h4 className="text-on-surface font-bold text-sm mb-1">{t('admin.overview.systemInfo.protectionTitle')}</h4>
                  <p className="text-sm text-on-surface-variant">{t('admin.overview.systemInfo.protectionDesc')}</p>
                </div>
                <div className="bg-surface-container p-4 border-l-2 border-tertiary">
                  <h4 className="text-on-surface font-bold text-sm mb-1">{t('admin.overview.systemInfo.filesTitle')}</h4>
                  <p className="text-sm text-on-surface-variant">{t('admin.overview.systemInfo.filesDesc', { count: stats?.totalFiles ?? 0 })}</p>
                </div>
                <div className="bg-surface-container p-4 border-l-2 border-success">
                  <h4 className="text-on-surface font-bold text-sm mb-1">{t('admin.overview.systemInfo.runtimeTitle')}</h4>
                  <p className="text-sm text-on-surface-variant font-mono">Node.js Runtime</p>
                </div>
              </div>
            </div>
          </div>

          {/* Quick Actions */}
          <div className="col-span-4 bg-surface-container p-6 rounded-lg flex flex-col justify-between">
            <div>
              <h3 className="text-sm font-bold uppercase tracking-widest mb-4">{t('admin.overview.quickActions.title')}</h3>
              <div className="space-y-2">
                <a href="/admin/users" className="flex items-center gap-3 p-3 bg-surface-container-high rounded hover:bg-surface-variant transition-colors no-underline group">
                  <span className="material-symbols-outlined text-primary">corporate_fare</span>
                  <span className="text-sm text-on-surface">{t('admin.overview.quickActions.users')}</span>
                  <span className="material-symbols-outlined text-sm text-outline-variant ml-auto group-hover:text-primary transition-colors">arrow_forward</span>
                </a>
                <a href="/admin/tokens" className="flex items-center gap-3 p-3 bg-surface-container-high rounded hover:bg-surface-variant transition-colors no-underline group">
                  <span className="material-symbols-outlined text-tertiary">payments</span>
                  <span className="text-sm text-on-surface">{t('admin.overview.quickActions.tokens')}</span>
                  <span className="material-symbols-outlined text-sm text-outline-variant ml-auto group-hover:text-primary transition-colors">arrow_forward</span>
                </a>
                <a href="/admin/security" className="flex items-center gap-3 p-3 bg-surface-container-high rounded hover:bg-surface-variant transition-colors no-underline group">
                  <span className="material-symbols-outlined text-warning">shield_with_heart</span>
                  <span className="text-sm text-on-surface">{t('admin.overview.quickActions.security')}</span>
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
