'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAdminAuth } from '../components/AdminAuthProvider';
import { useTranslation } from '../../../i18n';

interface AuditEntry {
  event_type: string;
  event_id: string;
  actor: string | null;
  actor_name: string | null;
  detail: string | null;
  created_at: string;
}

interface SecurityStats {
  totalAuditEntries: number;
  totalUsers: number;
  suspendedUsers: number;
  totalConversations: number;
  totalFiles: number;
  securityEventsCount: number;
  blockedThreats: number;
  systemUptime: number;
}

interface SecurityEvent {
  id: string;
  user_id: string;
  user_email: string | null;
  user_name: string | null;
  event_type: string;
  severity: string;
  detail: string;
  raw_input: string | null;
  created_at: string;
}

interface WorkspaceScan {
  userId: string;
  email: string;
  displayName: string | null;
  dirCount: number;
  fileCount: number;
  totalSize: number;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

export default function AdminSecurity() {
  const { token } = useAdminAuth();
  const { t } = useTranslation();
  const [stats, setStats] = useState<SecurityStats | null>(null);
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditPage, setAuditPage] = useState(1);
  const [auditTotalPages, setAuditTotalPages] = useState(1);
  const [workspace, setWorkspace] = useState<WorkspaceScan[]>([]);
  const [scanning, setScanning] = useState(false);
  const [lastScan, setLastScan] = useState<string | null>(null);
  const [secEvents, setSecEvents] = useState<SecurityEvent[]>([]);
  const [secPage, setSecPage] = useState(1);
  const [secTotal, setSecTotal] = useState(0);
  const [secTotalPages, setSecTotalPages] = useState(1);

  const EVENT_META: Record<string, { label: string; color: string }> = {
    user_registered:      { label: t('admin.security.event.userRegistered'), color: 'text-tertiary' },
    conversation_created: { label: t('admin.security.event.conversationCreated'), color: 'text-on-surface-variant' },
    file_generated:       { label: t('admin.security.event.fileGenerated'), color: 'text-success' },
    admin_suspend_user:   { label: t('admin.security.event.adminSuspendUser'), color: 'text-error' },
    admin_activate_user:  { label: t('admin.security.event.adminActivateUser'), color: 'text-success' },
  };

  function formatUptime(seconds: number): string {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const parts: string[] = [];
    if (d > 0) parts.push(`${d}${t('admin.security.uptime.days')}`);
    if (h > 0) parts.push(`${h}${t('admin.security.uptime.hours')}`);
    parts.push(`${m}${t('admin.security.uptime.minutes')}`);
    return parts.join(' ');
  }

  useEffect(() => {
    if (!token) return;
    fetch('/api/admin/security/stats', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json()).then(setStats).catch(console.error);
  }, [token]);

  const fetchAudit = useCallback(() => {
    if (!token) return;
    fetch(`/api/admin/security/audit-log?page=${auditPage}&limit=13`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(data => {
        setAuditLog(data.entries);
        setAuditTotal(data.total);
        setAuditTotalPages(data.totalPages);
      })
      .catch(console.error);
  }, [token, auditPage]);

  useEffect(() => { fetchAudit(); }, [fetchAudit]);

  const fetchSecEvents = useCallback(() => {
    if (!token) return;
    fetch(`/api/admin/security/events?page=${secPage}&limit=10`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(data => {
        setSecEvents(data.events);
        setSecTotal(data.total);
        setSecTotalPages(data.totalPages);
      })
      .catch(console.error);
  }, [token, secPage]);

  useEffect(() => { fetchSecEvents(); }, [fetchSecEvents]);

  function handleScan() {
    if (!token || scanning) return;
    setScanning(true);
    fetch('/api/admin/security/workspace-scan', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(data => {
        setWorkspace(data);
        setLastScan(new Date().toLocaleTimeString('zh-TW'));
      })
      .catch(console.error)
      .finally(() => setScanning(false));
  }

  const totalDisk = workspace.reduce((sum, w) => sum + w.totalSize, 0);
  const totalFiles = workspace.reduce((sum, w) => sum + w.fileCount, 0);
  const maxSize = Math.max(...workspace.map(w => w.totalSize), 1);

  return (
    <>
      {/* Header */}
      <header className="sticky top-0 h-16 bg-surface/80 backdrop-blur-xl flex justify-between items-center px-8 z-40 shadow-[0_1px_0_0_rgba(255,255,255,0.05)]">
        <div className="flex items-center gap-4">
          <span className="text-lg font-black text-on-surface font-headline">{t('admin.security.title')}</span>
        </div>
        <div className="flex items-center gap-3">
          <button className="flex items-center gap-2 px-4 py-2 bg-surface-container text-on-surface-variant text-sm font-bold uppercase tracking-wider hover:bg-surface-container-high transition-colors cursor-pointer">
            <span className="material-symbols-outlined text-sm">download</span>
            {t('admin.security.exportLog')}
          </button>
        </div>
      </header>

      <div className="p-8 flex-1 space-y-6 overflow-y-auto">
        {/* Stats Row */}
        <div className="grid grid-cols-4 gap-6">
          <div className="bg-surface-container p-6 rounded-lg group relative overflow-hidden">
            <span className="material-symbols-outlined absolute -bottom-4 -right-2 text-on-surface opacity-[0.07] group-hover:opacity-[0.12] transition-opacity pointer-events-none" style={{ fontSize: '100px' }}>shield</span>
            <p className="text-sm uppercase tracking-widest text-on-surface-variant mb-2">{t('admin.security.stats.securityEvents')}</p>
            <span className="text-3xl font-headline font-black text-on-surface">{stats?.securityEventsCount ?? 0}</span>
            <p className="text-sm text-on-surface-variant mt-2 font-mono">{t('admin.security.stats.securityEventsDesc')}</p>
          </div>
          <div className="bg-surface-container p-6 rounded-lg group relative overflow-hidden">
            <span className="material-symbols-outlined absolute -bottom-4 -right-2 text-on-surface opacity-[0.07] group-hover:opacity-[0.12] transition-opacity pointer-events-none" style={{ fontSize: '100px' }}>block</span>
            <p className="text-sm uppercase tracking-widest text-on-surface-variant mb-2">{t('admin.security.stats.blockedThreats')}</p>
            <span className="text-3xl font-headline font-black text-error">{stats?.blockedThreats ?? 0}</span>
            <p className="text-sm text-on-surface-variant mt-2 font-mono">{t('admin.security.stats.blockedThreatsDesc')}</p>
          </div>
          <div className="bg-surface-container p-6 rounded-lg group relative overflow-hidden">
            <span className="material-symbols-outlined absolute -bottom-4 -right-2 text-on-surface opacity-[0.07] group-hover:opacity-[0.12] transition-opacity pointer-events-none" style={{ fontSize: '100px' }}>schedule</span>
            <p className="text-sm uppercase tracking-widest text-on-surface-variant mb-2">{t('admin.security.stats.systemUptime')}</p>
            <span className="text-3xl font-headline font-black text-on-surface">{stats ? formatUptime(stats.systemUptime) : '\u2014'}</span>
            <p className="text-sm text-on-surface-variant mt-2 font-mono">{t('admin.security.stats.systemUptimeDesc')}</p>
          </div>
          <div className="bg-surface-container p-6 rounded-lg group relative overflow-hidden">
            <span className="material-symbols-outlined absolute -bottom-4 -right-2 text-on-surface opacity-[0.07] group-hover:opacity-[0.12] transition-opacity pointer-events-none" style={{ fontSize: '100px' }}>description</span>
            <p className="text-sm uppercase tracking-widest text-on-surface-variant mb-2">{t('admin.security.stats.filesGenerated')}</p>
            <span className="text-3xl font-headline font-black text-primary">{stats?.totalFiles ?? 0}</span>
            <p className="text-sm text-on-surface-variant mt-2 font-mono">{t('admin.security.stats.filesGeneratedDesc', { count: stats?.totalConversations ?? 0 })}</p>
          </div>
        </div>

        {/* Workspace Scan + Audit Log */}
        <div className="grid grid-cols-12 gap-6">
          {/* Workspace Disk Usage */}
          <div className="col-span-5 bg-surface-container rounded-lg overflow-hidden flex flex-col">
            <div className="px-6 py-4 bg-surface-container-high flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="material-symbols-outlined text-primary">hard_drive_2</span>
                <span className="text-sm font-bold uppercase tracking-widest">{t('admin.security.workspace.title')}</span>
              </div>
              <button
                onClick={handleScan}
                disabled={scanning}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-primary/10 text-primary text-sm font-bold uppercase tracking-wider rounded hover:bg-primary/20 transition-colors cursor-pointer disabled:opacity-50"
              >
                <span className={`material-symbols-outlined text-sm ${scanning ? 'animate-spin' : ''}`}>
                  {scanning ? 'progress_activity' : 'radar'}
                </span>
                {scanning ? t('admin.security.workspace.scanning') : t('admin.security.workspace.scan')}
              </button>
            </div>

            {workspace.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center p-8 text-on-surface-variant">
                <span className="material-symbols-outlined text-4xl mb-3 opacity-30">folder_open</span>
                <p className="text-sm mb-1">{t('admin.security.workspace.notScanned')}</p>
                <p className="text-sm text-outline">{t('admin.security.workspace.notScannedHint')}</p>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto">
                {/* Summary bar */}
                <div className="px-6 py-3 border-b border-outline-variant/10 flex items-center justify-between">
                  <span className="text-sm text-on-surface-variant">
                    {t('admin.security.workspace.sandboxCount', { count: workspace.length })} · {t('admin.security.workspace.fileCount', { count: totalFiles })}
                  </span>
                  <span className="text-sm font-mono font-bold text-on-surface">{formatFileSize(totalDisk)}</span>
                </div>
                {lastScan && (
                  <div className="px-6 py-1.5 text-sm text-outline">
                    {t('admin.security.workspace.lastScan')} {lastScan}
                  </div>
                )}

                <div className="divide-y divide-outline-variant/10">
                  {workspace.slice(0, 5).map(w => {
                    const pct = (w.totalSize / maxSize) * 100;
                    return (
                      <div key={w.userId} className="px-6 py-3 hover:bg-surface-container-high/50 transition-colors">
                        <div className="flex justify-between items-center mb-1.5">
                          <div className="min-w-0 flex-1">
                            <p className="text-sm text-on-surface truncate">{w.displayName || w.email.split('@')[0]}</p>
                            <p className="text-sm text-on-surface-variant font-mono truncate">{w.email}</p>
                          </div>
                          <div className="text-right shrink-0 ml-3">
                            <p className="text-sm font-mono font-bold text-on-surface">{formatFileSize(w.totalSize)}</p>
                            <p className="text-sm text-on-surface-variant">{t('admin.security.workspace.fileCount', { count: w.fileCount })} · {w.dirCount}</p>
                          </div>
                        </div>
                        <div className="w-full h-1.5 bg-surface-container-highest rounded-full overflow-hidden">
                          <div
                            className="h-full bg-primary/60 rounded-full transition-all"
                            style={{ width: `${Math.max(pct, 2)}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Audit Log Terminal */}
          <div className="col-span-7 bg-surface-container-lowest border border-outline-variant/10 rounded-lg overflow-hidden flex flex-col">
            <div className="px-6 py-3 bg-surface-container-low flex items-center justify-between border-b border-outline-variant/10">
              <div className="flex items-center gap-3">
                <div className="flex gap-1.5">
                  <div className="w-3 h-3 rounded-full bg-error/60" />
                  <div className="w-3 h-3 rounded-full bg-warning/60" />
                  <div className="w-3 h-3 rounded-full bg-success/60" />
                </div>
                <span className="text-sm text-on-surface-variant font-mono tracking-wider">SYSTEM_AUDIT_LOG</span>
              </div>
              <span className="text-sm text-on-surface-variant font-mono">{t('admin.security.audit.total', { count: auditTotal })}</span>
            </div>
            <div className="flex-1 overflow-y-auto p-4 font-mono text-sm space-y-1 min-h-[300px] max-h-[500px]">
              {auditLog.length === 0 ? (
                <div className="text-on-surface-variant py-8 text-center">
                  <p>{t('admin.security.audit.emptyTitle')}</p>
                  <p className="text-outline mt-1">{t('admin.security.audit.emptyHint')}</p>
                </div>
              ) : (
                auditLog.map(entry => {
                  const meta = EVENT_META[entry.event_type] || { label: entry.event_type, color: 'text-on-surface-variant' };
                  const actor = entry.actor_name || entry.actor?.split('@')[0] || '';
                  return (
                    <div key={entry.event_id} className="flex gap-2 py-1">
                      <span className="text-outline shrink-0">[{new Date(entry.created_at.endsWith('Z') ? entry.created_at : entry.created_at + 'Z').toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}]</span>
                      <span className={`${meta.color} shrink-0`}>[{meta.label}]</span>
                      <span className="text-on-surface-variant">
                        <span className="text-on-surface">{actor}</span>
                        {entry.detail ? ` \u2014 ${entry.detail}` : ''}
                      </span>
                    </div>
                  );
                })
              )}
            </div>

            {/* Pagination */}
            {auditTotalPages > 1 && (
              <div className="flex items-center justify-between px-6 py-3 border-t border-outline-variant/10 bg-surface-container-low">
                <span className="text-sm text-on-surface-variant">
                  {t('admin.security.audit.paginationSummary', { start: (auditPage - 1) * 13 + 1, end: Math.min(auditPage * 13, auditTotal), total: auditTotal })}
                </span>
                <div className="flex gap-1">
                  <button
                    onClick={() => setAuditPage(p => Math.max(1, p - 1))}
                    disabled={auditPage === 1}
                    className="px-3 py-1.5 text-sm bg-surface-container text-on-surface-variant rounded disabled:opacity-30 cursor-pointer"
                  >
                    {t('common.prev')}
                  </button>
                  <button
                    onClick={() => setAuditPage(p => Math.min(auditTotalPages, p + 1))}
                    disabled={auditPage === auditTotalPages}
                    className="px-3 py-1.5 text-sm bg-surface-container text-on-surface-variant rounded disabled:opacity-30 cursor-pointer"
                  >
                    {t('common.next')}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Security Events (Input Guard) */}
        <div className="bg-surface-container rounded-lg overflow-hidden">
          <div className="px-6 py-4 bg-surface-container-high flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="material-symbols-outlined text-error">gpp_maybe</span>
              <span className="text-sm font-bold uppercase tracking-widest">{t('admin.security.inputGuard.title')}</span>
            </div>
            <span className="text-sm text-on-surface-variant font-mono">{t('admin.security.inputGuard.total', { count: secTotal })}</span>
          </div>
          {secEvents.length === 0 ? (
            <div className="p-8 text-center text-on-surface-variant">
              <span className="material-symbols-outlined text-4xl mb-3 opacity-30">verified_user</span>
              <p className="text-sm">{t('admin.security.inputGuard.empty')}</p>
              <p className="text-sm text-outline mt-1">{t('admin.security.inputGuard.emptyHint')}</p>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-outline-variant/10 text-on-surface-variant uppercase tracking-wider">
                      <th className="py-3 px-4 text-left font-bold">{t('admin.security.inputGuard.colTime')}</th>
                      <th className="py-3 px-4 text-left font-bold">{t('admin.security.inputGuard.colSeverity')}</th>
                      <th className="py-3 px-4 text-left font-bold">{t('admin.security.inputGuard.colType')}</th>
                      <th className="py-3 px-4 text-left font-bold">{t('admin.security.inputGuard.colUser')}</th>
                      <th className="py-3 px-4 text-left font-bold">{t('admin.security.inputGuard.colDetail')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-outline-variant/10">
                    {secEvents.map(ev => {
                      const sevColor = ev.severity === 'critical' ? 'text-error font-bold' :
                        ev.severity === 'high' ? 'text-error' :
                        ev.severity === 'medium' ? 'text-warning' : 'text-on-surface-variant';
                      const sevLabel = ev.severity === 'critical' ? t('admin.security.inputGuard.severityCritical') :
                        ev.severity === 'high' ? t('admin.security.inputGuard.severityHigh') :
                        ev.severity === 'medium' ? t('admin.security.inputGuard.severityMedium') : t('admin.security.inputGuard.severityLow');
                      return (
                        <tr key={ev.id} className="hover:bg-surface-container-high/50 transition-colors">
                          <td className="py-3 px-4 text-on-surface-variant font-mono whitespace-nowrap">
                            {new Date(ev.created_at.endsWith('Z') ? ev.created_at : ev.created_at + 'Z').toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}
                          </td>
                          <td className="py-3 px-4">
                            <span className={`px-2 py-0.5 rounded text-sm font-bold uppercase ${sevColor} bg-current/10`}>
                              {sevLabel}
                            </span>
                          </td>
                          <td className="py-3 px-4 text-on-surface font-mono">{ev.event_type}</td>
                          <td className="py-3 px-4 text-on-surface-variant">{ev.user_name || ev.user_email || ev.user_id}</td>
                          <td className="py-3 px-4 text-on-surface-variant max-w-xs truncate">{ev.detail}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {secTotalPages > 1 && (
                <div className="flex items-center justify-between px-6 py-3 border-t border-outline-variant/10 bg-surface-container-high">
                  <span className="text-sm text-on-surface-variant">
                    {t('admin.security.audit.paginationSummary', { start: (secPage - 1) * 10 + 1, end: Math.min(secPage * 10, secTotal), total: secTotal })}
                  </span>
                  <div className="flex gap-1">
                    <button
                      onClick={() => setSecPage(p => Math.max(1, p - 1))}
                      disabled={secPage === 1}
                      className="px-3 py-1.5 text-sm bg-surface-container text-on-surface-variant rounded disabled:opacity-30 cursor-pointer"
                    >{t('common.prev')}</button>
                    <button
                      onClick={() => setSecPage(p => Math.min(secTotalPages, p + 1))}
                      disabled={secPage === secTotalPages}
                      className="px-3 py-1.5 text-sm bg-surface-container text-on-surface-variant rounded disabled:opacity-30 cursor-pointer"
                    >{t('common.next')}</button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Security Architecture */}
        <div className="bg-surface-container rounded-lg overflow-hidden">
          <div className="px-6 py-4 bg-surface-container-high flex items-center gap-3">
            <span className="material-symbols-outlined text-on-surface-variant">security</span>
            <span className="text-sm font-bold uppercase tracking-widest">{t('admin.security.architecture.title')}</span>
          </div>
          <div className="p-6 grid grid-cols-4 gap-4">
            <div className="bg-surface-container-high p-5 border-l-2 border-primary">
              <div className="flex items-center gap-2 mb-2">
                <span className="material-symbols-outlined text-primary text-lg">folder_special</span>
                <h4 className="text-on-surface font-bold text-sm">{t('admin.security.architecture.dirIsolationTitle')}</h4>
              </div>
              <p className="text-sm text-on-surface-variant leading-relaxed">
                {t('admin.security.architecture.dirIsolationDesc')}
              </p>
            </div>
            <div className="bg-surface-container-high p-5 border-l-2 border-tertiary">
              <div className="flex items-center gap-2 mb-2">
                <span className="material-symbols-outlined text-tertiary text-lg">build_circle</span>
                <h4 className="text-on-surface font-bold text-sm">{t('admin.security.architecture.toolWhitelistTitle')}</h4>
              </div>
              <p className="text-sm text-on-surface-variant leading-relaxed">
                {t('admin.security.architecture.toolWhitelistDesc')}
              </p>
            </div>
            <div className="bg-surface-container-high p-5 border-l-2 border-success">
              <div className="flex items-center gap-2 mb-2">
                <span className="material-symbols-outlined text-success text-lg">verified_user</span>
                <h4 className="text-on-surface font-bold text-sm">{t('admin.security.architecture.authTitle')}</h4>
              </div>
              <p className="text-sm text-on-surface-variant leading-relaxed">
                {t('admin.security.architecture.authDesc')}
              </p>
            </div>
            <div className="bg-surface-container-high p-5 border-l-2 border-error">
              <div className="flex items-center gap-2 mb-2">
                <span className="material-symbols-outlined text-error text-lg">shield</span>
                <h4 className="text-on-surface font-bold text-sm">{t('admin.security.architecture.inputGuardTitle')}</h4>
              </div>
              <p className="text-sm text-on-surface-variant leading-relaxed">
                {t('admin.security.architecture.inputGuardDesc')}
              </p>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
