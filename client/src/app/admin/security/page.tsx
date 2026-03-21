'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAdminAuth } from '../components/AdminAuthProvider';

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
  systemUptime: number;
}

interface WorkspaceScan {
  userId: string;
  email: string;
  displayName: string | null;
  dirCount: number;
  fileCount: number;
  totalSize: number;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}天 ${h}時 ${m}分`;
  if (h > 0) return `${h}時 ${m}分`;
  return `${m}分`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

const EVENT_META: Record<string, { label: string; color: string }> = {
  user_registered:      { label: '用戶註冊', color: 'text-tertiary' },
  conversation_created: { label: '建立對話', color: 'text-on-surface-variant' },
  file_generated:       { label: '檔案生成', color: 'text-success' },
  admin_suspend_user:   { label: '停用用戶', color: 'text-error' },
  admin_activate_user:  { label: '啟用用戶', color: 'text-success' },
};

export default function AdminSecurity() {
  const { token } = useAdminAuth();
  const [stats, setStats] = useState<SecurityStats | null>(null);
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditPage, setAuditPage] = useState(1);
  const [auditTotalPages, setAuditTotalPages] = useState(1);
  const [workspace, setWorkspace] = useState<WorkspaceScan[]>([]);
  const [scanning, setScanning] = useState(false);
  const [lastScan, setLastScan] = useState<string | null>(null);

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
          <span className="text-lg font-black text-on-surface font-headline">安全與審計</span>
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
          <div className="bg-surface-container p-6 rounded-lg group relative overflow-hidden">
            <span className="material-symbols-outlined absolute -bottom-4 -right-2 text-on-surface opacity-[0.07] group-hover:opacity-[0.12] transition-opacity pointer-events-none" style={{ fontSize: '100px' }}>receipt_long</span>
            <p className="text-xs uppercase tracking-widest text-on-surface-variant mb-2">審計記錄</p>
            <span className="text-3xl font-headline font-black text-on-surface">{stats?.totalAuditEntries ?? 0}</span>
            <p className="text-xs text-on-surface-variant mt-2 font-mono">Admin 操作記錄</p>
          </div>
          <div className="bg-surface-container p-6 rounded-lg group relative overflow-hidden">
            <span className="material-symbols-outlined absolute -bottom-4 -right-2 text-on-surface opacity-[0.07] group-hover:opacity-[0.12] transition-opacity pointer-events-none" style={{ fontSize: '100px' }}>person_off</span>
            <p className="text-xs uppercase tracking-widest text-on-surface-variant mb-2">已停用帳號</p>
            <span className="text-3xl font-headline font-black text-error">{stats?.suspendedUsers ?? 0}</span>
            <p className="text-xs text-on-surface-variant mt-2 font-mono">共 {stats?.totalUsers ?? 0} 個用戶</p>
          </div>
          <div className="bg-surface-container p-6 rounded-lg group relative overflow-hidden">
            <span className="material-symbols-outlined absolute -bottom-4 -right-2 text-on-surface opacity-[0.07] group-hover:opacity-[0.12] transition-opacity pointer-events-none" style={{ fontSize: '100px' }}>schedule</span>
            <p className="text-xs uppercase tracking-widest text-on-surface-variant mb-2">系統運行時間</p>
            <span className="text-3xl font-headline font-black text-on-surface">{stats ? formatUptime(stats.systemUptime) : '—'}</span>
            <p className="text-xs text-on-surface-variant mt-2 font-mono">自上次啟動</p>
          </div>
          <div className="bg-surface-container p-6 rounded-lg group relative overflow-hidden">
            <span className="material-symbols-outlined absolute -bottom-4 -right-2 text-on-surface opacity-[0.07] group-hover:opacity-[0.12] transition-opacity pointer-events-none" style={{ fontSize: '100px' }}>description</span>
            <p className="text-xs uppercase tracking-widest text-on-surface-variant mb-2">已生成檔案</p>
            <span className="text-3xl font-headline font-black text-primary">{stats?.totalFiles ?? 0}</span>
            <p className="text-xs text-on-surface-variant mt-2 font-mono">跨 {stats?.totalConversations ?? 0} 個對話</p>
          </div>
        </div>

        {/* Workspace Scan + Audit Log */}
        <div className="grid grid-cols-12 gap-6">
          {/* Workspace Disk Usage */}
          <div className="col-span-5 bg-surface-container rounded-lg overflow-hidden flex flex-col">
            <div className="px-6 py-4 bg-surface-container-high flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="material-symbols-outlined text-primary">hard_drive_2</span>
                <span className="text-xs font-bold uppercase tracking-widest">沙箱磁碟用量</span>
              </div>
              <button
                onClick={handleScan}
                disabled={scanning}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-primary/10 text-primary text-[10px] font-bold uppercase tracking-wider rounded hover:bg-primary/20 transition-colors cursor-pointer disabled:opacity-50"
              >
                <span className={`material-symbols-outlined text-sm ${scanning ? 'animate-spin' : ''}`}>
                  {scanning ? 'progress_activity' : 'radar'}
                </span>
                {scanning ? '掃描中...' : '掃描'}
              </button>
            </div>

            {workspace.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center p-8 text-on-surface-variant">
                <span className="material-symbols-outlined text-4xl mb-3 opacity-30">folder_open</span>
                <p className="text-sm mb-1">尚未掃描</p>
                <p className="text-xs text-outline">點擊上方「掃描」按鈕檢查 workspace 目錄</p>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto">
                {/* Summary bar */}
                <div className="px-6 py-3 border-b border-outline-variant/10 flex items-center justify-between">
                  <span className="text-xs text-on-surface-variant">
                    {workspace.length} 個用戶沙箱 · {totalFiles} 檔案
                  </span>
                  <span className="text-xs font-mono font-bold text-on-surface">{formatFileSize(totalDisk)}</span>
                </div>
                {lastScan && (
                  <div className="px-6 py-1.5 text-[10px] text-outline">
                    最後掃描: {lastScan}
                  </div>
                )}

                <div className="divide-y divide-outline-variant/10">
                  {workspace.slice(0, 5).map(w => {
                    const pct = (w.totalSize / maxSize) * 100;
                    return (
                      <div key={w.userId} className="px-6 py-3 hover:bg-surface-container-high/50 transition-colors">
                        <div className="flex justify-between items-center mb-1.5">
                          <div className="min-w-0 flex-1">
                            <p className="text-xs text-on-surface truncate">{w.displayName || w.email.split('@')[0]}</p>
                            <p className="text-[10px] text-on-surface-variant font-mono truncate">{w.email}</p>
                          </div>
                          <div className="text-right shrink-0 ml-3">
                            <p className="text-xs font-mono font-bold text-on-surface">{formatFileSize(w.totalSize)}</p>
                            <p className="text-[10px] text-on-surface-variant">{w.fileCount} 檔案 · {w.dirCount} 資料夾</p>
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
                <span className="text-[10px] text-on-surface-variant font-mono tracking-wider">SYSTEM_AUDIT_LOG</span>
              </div>
              <span className="text-[10px] text-on-surface-variant font-mono">共 {auditTotal} 筆</span>
            </div>
            <div className="flex-1 overflow-y-auto p-4 font-mono text-xs space-y-1 min-h-[300px] max-h-[500px]">
              {auditLog.length === 0 ? (
                <div className="text-on-surface-variant py-8 text-center">
                  <p>[SYSTEM] 尚無記錄</p>
                  <p className="text-outline mt-1">[INFO] 系統活動將自動記錄於此</p>
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
                        {entry.detail ? ` — ${entry.detail}` : ''}
                      </span>
                    </div>
                  );
                })
              )}
            </div>

            {/* Pagination */}
            {auditTotalPages > 1 && (
              <div className="flex items-center justify-between px-6 py-3 border-t border-outline-variant/10 bg-surface-container-low">
                <span className="text-xs text-on-surface-variant">
                  第 {(auditPage - 1) * 13 + 1}-{Math.min(auditPage * 13, auditTotal)} 筆，共 {auditTotal} 筆
                </span>
                <div className="flex gap-1">
                  <button
                    onClick={() => setAuditPage(p => Math.max(1, p - 1))}
                    disabled={auditPage === 1}
                    className="px-3 py-1.5 text-xs bg-surface-container text-on-surface-variant rounded disabled:opacity-30 cursor-pointer"
                  >
                    上一頁
                  </button>
                  <button
                    onClick={() => setAuditPage(p => Math.min(auditTotalPages, p + 1))}
                    disabled={auditPage === auditTotalPages}
                    className="px-3 py-1.5 text-xs bg-surface-container text-on-surface-variant rounded disabled:opacity-30 cursor-pointer"
                  >
                    下一頁
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Security Architecture */}
        <div className="bg-surface-container rounded-lg overflow-hidden">
          <div className="px-6 py-4 bg-surface-container-high flex items-center gap-3">
            <span className="material-symbols-outlined text-on-surface-variant">security</span>
            <span className="text-xs font-bold uppercase tracking-widest">安全架構</span>
          </div>
          <div className="p-6 grid grid-cols-3 gap-4">
            <div className="bg-surface-container-high p-5 border-l-2 border-primary">
              <div className="flex items-center gap-2 mb-2">
                <span className="material-symbols-outlined text-primary text-lg">folder_special</span>
                <h4 className="text-on-surface font-bold text-sm">目錄隔離</h4>
              </div>
              <p className="text-xs text-on-surface-variant leading-relaxed">
                每位用戶的檔案限制在 <span className="text-on-surface font-mono">workspace/&#123;userId&#125;/</span> 目錄中，路徑驗證防止目錄遍歷攻擊。
              </p>
            </div>
            <div className="bg-surface-container-high p-5 border-l-2 border-tertiary">
              <div className="flex items-center gap-2 mb-2">
                <span className="material-symbols-outlined text-tertiary text-lg">build_circle</span>
                <h4 className="text-on-surface font-bold text-sm">工具白名單</h4>
              </div>
              <p className="text-xs text-on-surface-variant leading-relaxed">
                Claude CLI 透過 <span className="text-on-surface font-mono">--allowedTools</span> 限制可用工具，依 Skill 角色動態配置權限。
              </p>
            </div>
            <div className="bg-surface-container-high p-5 border-l-2 border-success">
              <div className="flex items-center gap-2 mb-2">
                <span className="material-symbols-outlined text-success text-lg">verified_user</span>
                <h4 className="text-on-surface font-bold text-sm">身分驗證</h4>
              </div>
              <p className="text-xs text-on-surface-variant leading-relaxed">
                JWT Token 驗證 + bcrypt 密碼雜湊，Admin 角色需通過額外的 <span className="text-on-surface font-mono">role</span> 檢查。
              </p>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
