'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAdminAuth } from '../components/AdminAuthProvider';

interface SandboxUser {
  id: string;
  email: string;
  display_name: string | null;
  status: string;
  active_sessions: number;
  storage_used: number;
  file_count: number;
}

interface AuditEntry {
  id: string;
  admin_id: string;
  admin_email: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  details: string | null;
  created_at: string;
}

interface SecurityStats {
  totalAuditEntries: number;
  totalUsers: number;
  suspendedUsers: number;
  systemUptime: number;
  isolationLevel: string;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

const ACTION_LABELS: Record<string, { label: string; color: string; icon: string }> = {
  suspend_user:  { label: '停用用戶', color: 'text-error', icon: 'block' },
  activate_user: { label: '啟用用戶', color: 'text-success', icon: 'check_circle' },
  adjust_quota:  { label: '調整配額', color: 'text-warning', icon: 'tune' },
};

export default function AdminSecurity() {
  const { token } = useAdminAuth();
  const [sandboxes, setSandboxes] = useState<SandboxUser[]>([]);
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditPage, setAuditPage] = useState(1);
  const [auditTotalPages, setAuditTotalPages] = useState(1);
  const [stats, setStats] = useState<SecurityStats | null>(null);

  useEffect(() => {
    if (!token) return;
    const headers = { Authorization: `Bearer ${token}` };

    fetch('/api/admin/security/sandbox-status', { headers })
      .then(r => r.json()).then(setSandboxes).catch(console.error);

    fetch('/api/admin/security/stats', { headers })
      .then(r => r.json()).then(setStats).catch(console.error);
  }, [token]);

  const fetchAudit = useCallback(() => {
    if (!token) return;
    fetch(`/api/admin/security/audit-log?page=${auditPage}&limit=20`, {
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

  return (
    <>
      {/* Header */}
      <header className="sticky top-0 h-16 bg-surface/80 backdrop-blur-xl flex justify-between items-center px-8 z-40 shadow-[0_1px_0_0_rgba(255,255,255,0.05)]">
        <div className="flex items-center gap-4">
          <span className="text-lg font-black text-on-surface font-headline">安全與沙箱審計</span>
          <span className="text-[10px] px-2 py-0.5 bg-primary/10 text-primary rounded font-bold tracking-wider uppercase">即時監控</span>
        </div>
        <div className="flex items-center gap-3">
          <button className="flex items-center gap-2 px-4 py-2 bg-surface-container text-on-surface-variant text-xs font-bold uppercase tracking-wider hover:bg-surface-container-high transition-colors cursor-pointer">
            <span className="material-symbols-outlined text-sm">download</span>
            匯出安全日誌
          </button>
        </div>
      </header>

      <div className="p-8 flex-1 space-y-6 overflow-y-auto">
        {/* Stats Row */}
        <div className="grid grid-cols-4 gap-6">
          <div className="bg-surface-container p-6 rounded-lg">
            <p className="text-[10px] uppercase tracking-widest text-on-surface-variant mb-2">審計記錄</p>
            <span className="text-3xl font-headline font-black text-on-surface">{stats?.totalAuditEntries ?? 0}</span>
            <p className="text-xs text-on-surface-variant mt-2">Admin 操作記錄</p>
          </div>
          <div className="bg-surface-container p-6 rounded-lg">
            <p className="text-[10px] uppercase tracking-widest text-on-surface-variant mb-2">已停用帳號</p>
            <span className="text-3xl font-headline font-black text-error">{stats?.suspendedUsers ?? 0}</span>
            <p className="text-xs text-on-surface-variant mt-2">共 {stats?.totalUsers ?? 0} 個用戶</p>
          </div>
          <div className="bg-surface-container p-6 rounded-lg">
            <p className="text-[10px] uppercase tracking-widest text-on-surface-variant mb-2">系統運行時間</p>
            <span className="text-3xl font-headline font-black text-on-surface">{stats ? formatUptime(stats.systemUptime) : '—'}</span>
            <p className="text-xs text-on-surface-variant mt-2">自上次啟動</p>
          </div>
          <div className="bg-surface-container p-6 rounded-lg">
            <p className="text-[10px] uppercase tracking-widest text-on-surface-variant mb-2">隔離等級</p>
            <span className="text-3xl font-headline font-black text-primary">{stats?.isolationLevel ?? '—'}</span>
            <p className="text-xs text-on-surface-variant mt-2">最高等級</p>
          </div>
        </div>

        {/* Two columns: Sandbox List + Audit Log */}
        <div className="grid grid-cols-12 gap-6">
          {/* Sandbox Status */}
          <div className="col-span-4 bg-surface-container rounded-lg overflow-hidden flex flex-col">
            <div className="px-6 py-4 bg-surface-container-high flex items-center gap-3">
              <span className="material-symbols-outlined text-primary">dns</span>
              <span className="text-xs font-bold uppercase tracking-widest">用戶沙箱狀態</span>
            </div>
            <div className="flex-1 overflow-y-auto">
              {sandboxes.length === 0 ? (
                <div className="p-6 text-center text-on-surface-variant text-sm">尚無用戶</div>
              ) : (
                <div className="divide-y divide-outline-variant/10">
                  {sandboxes.map(sb => (
                    <div key={sb.id} className="px-6 py-3 flex items-center gap-3 hover:bg-surface-container-high/50 transition-colors">
                      <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                        sb.status === 'suspended' ? 'bg-error' :
                        sb.active_sessions > 0 ? 'bg-primary animate-pulse' : 'bg-outline-variant'
                      }`} />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-on-surface font-mono truncate">{sb.email}</p>
                        <p className="text-[10px] text-on-surface-variant mt-0.5">
                          {sb.active_sessions} 個活躍 session · {sb.file_count} 檔案 · {formatFileSize(sb.storage_used)}
                        </p>
                      </div>
                      <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wider ${
                        sb.status === 'suspended' ? 'bg-error/15 text-error' :
                        sb.active_sessions > 0 ? 'bg-primary/15 text-primary' : 'bg-surface-container-highest text-on-surface-variant'
                      }`}>
                        {sb.status === 'suspended' ? '已停用' : sb.active_sessions > 0 ? '活躍' : '閒置'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Audit Log Terminal */}
          <div className="col-span-8 bg-surface-container-lowest border border-outline-variant/10 rounded-lg overflow-hidden flex flex-col">
            <div className="px-6 py-3 bg-surface-container-low flex items-center justify-between border-b border-outline-variant/10">
              <div className="flex items-center gap-3">
                <div className="flex gap-1.5">
                  <div className="w-3 h-3 rounded-full bg-error/60" />
                  <div className="w-3 h-3 rounded-full bg-warning/60" />
                  <div className="w-3 h-3 rounded-full bg-success/60" />
                </div>
                <span className="text-[10px] text-on-surface-variant font-mono tracking-wider">ADMIN_AUDIT_LOG_STREAM</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[9px] text-primary font-bold tracking-wider">LIVE</span>
                <span className="text-[9px] text-on-surface-variant font-mono">共 {auditTotal} 筆</span>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-4 font-mono text-xs space-y-1 min-h-[300px] max-h-[500px]">
              {auditLog.length === 0 ? (
                <div className="text-on-surface-variant py-8 text-center">
                  <p>[SYSTEM] 尚無審計記錄</p>
                  <p className="text-outline mt-1">[INFO] 管理操作將自動記錄於此</p>
                </div>
              ) : (
                auditLog.map(entry => {
                  const meta = ACTION_LABELS[entry.action] || { label: entry.action, color: 'text-on-surface-variant', icon: 'info' };
                  let details = '';
                  try { details = entry.details ? JSON.parse(entry.details)?.email || '' : ''; } catch {}
                  return (
                    <div key={entry.id} className="flex gap-2 py-1">
                      <span className="text-outline shrink-0">[{new Date(entry.created_at).toLocaleString('zh-TW')}]</span>
                      <span className={`${meta.color} shrink-0`}>[{meta.label}]</span>
                      <span className="text-on-surface-variant">
                        {entry.target_type === 'user' && details ? `用戶: ${details}` : ''}
                        {entry.target_id ? ` (${entry.target_id.slice(0, 8)})` : ''}
                      </span>
                    </div>
                  );
                })
              )}
            </div>

            {/* Pagination */}
            {auditTotalPages > 1 && (
              <div className="flex items-center justify-between px-6 py-3 border-t border-outline-variant/10 bg-surface-container-low">
                <span className="text-[10px] text-on-surface-variant">
                  第 {auditPage} / {auditTotalPages} 頁
                </span>
                <div className="flex gap-1">
                  <button
                    onClick={() => setAuditPage(p => Math.max(1, p - 1))}
                    disabled={auditPage === 1}
                    className="px-2 py-1 text-[10px] bg-surface-container text-on-surface-variant rounded disabled:opacity-30 cursor-pointer"
                  >
                    上一頁
                  </button>
                  <button
                    onClick={() => setAuditPage(p => Math.min(auditTotalPages, p + 1))}
                    disabled={auditPage === auditTotalPages}
                    className="px-2 py-1 text-[10px] bg-surface-container text-on-surface-variant rounded disabled:opacity-30 cursor-pointer"
                  >
                    下一頁
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Threat Response Section */}
        <div className="bg-surface-container-low border border-outline-variant/5 p-8 relative overflow-hidden rounded-lg">
          <div className="absolute right-6 bottom-6 opacity-[0.04] pointer-events-none">
            <span className="material-symbols-outlined text-[8rem]">shield</span>
          </div>
          <div className="relative z-10">
            <h2 className="text-2xl font-headline font-bold text-on-surface mb-4">自動化威脅回應</h2>
            <p className="text-on-surface-variant max-w-2xl mb-6">
              AI Agents Office 目前處於「Sovereign」模式。所有沙箱代理程式在隔離環境中運行，具備即時監控與自動復原能力。
            </p>
            <div className="grid grid-cols-3 gap-4">
              <div className="bg-surface-container p-4 border-l-2 border-primary">
                <h4 className="text-on-surface font-bold text-sm mb-1">主動防護</h4>
                <p className="text-xs text-on-surface-variant">沙箱隔離 v2.4 — 所有代理已容器化</p>
              </div>
              <div className="bg-surface-container p-4 border-l-2 border-tertiary">
                <h4 className="text-on-surface font-bold text-sm mb-1">記憶體隔離</h4>
                <p className="text-xs text-on-surface-variant">零頁保護啟用 — IO 隔離率 99.8%</p>
              </div>
              <div className="bg-surface-container p-4 border-l-2 border-success">
                <h4 className="text-on-surface font-bold text-sm mb-1">自動復原</h4>
                <p className="text-xs text-on-surface-variant">環境異常時自動重置記憶體邊界</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
