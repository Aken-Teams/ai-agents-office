'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAdminAuth } from '../components/AdminAuthProvider';
import { useTranslation } from '../../../i18n';

interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  status: string;
  role: string;
  created_at: string;
  last_login_at: string | null;
  total_tokens: number;
  total_input_tokens: number;
  total_output_tokens: number;
  file_count: number;
  conversation_count: number;
}

function calcCost(input: number, output: number): number {
  return ((input / 1_000_000 * 3) + (output / 1_000_000 * 15)) * 10;
}

function formatCost(cost: number): string {
  if (cost < 0.01) return '-';
  return '$' + cost.toFixed(2);
}

interface UserDetail {
  id: string;
  email: string;
  display_name: string | null;
  status: string;
  role: string;
  quota_override: number | null;
  created_at: string;
  updated_at: string;
  tokenStats: { total_input: number; total_output: number; invocation_count: number };
  recentFiles: { id: string; filename: string; file_type: string; file_size: number; created_at: string }[];
  recentConversations: { id: string; title: string; skill_id: string | null; status: string; created_at: string }[];
  conversation_count: number;
  file_count: number;
  memory_count: number;
  effective_limit: number;
  display_cost: number;
  deploy_mode: string;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function toUTC(dateStr: string): Date {
  if (!dateStr) return new Date(0);
  const s = dateStr.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(dateStr) ? dateStr : dateStr.replace(' ', 'T') + 'Z';
  return new Date(s);
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function StatusBadge({ status }: { status: string }) {
  const cls = status === 'active'
    ? 'bg-success/15 text-success'
    : status === 'pending' || status === 'pending_verification'
    ? 'bg-warning/15 text-warning'
    : 'bg-error/15 text-error';
  const label = status === 'active' ? 'Active'
    : status === 'pending' ? 'Pending'
    : status === 'pending_verification' ? 'Verifying'
    : 'Suspended';
  return <span className={`px-2 py-0.5 text-xs font-bold uppercase tracking-wider rounded ${cls}`}>{label}</span>;
}

function RoleBadge({ role }: { role: string }) {
  const cls = role === 'admin' ? 'bg-primary/15 text-primary' : 'bg-surface-container text-on-surface-variant';
  return <span className={`px-2 py-0.5 text-xs font-bold uppercase tracking-wider rounded ${cls}`}>{role === 'admin' ? 'Admin' : 'User'}</span>;
}

export default function AdminUsers() {
  const { token } = useAdminAuth();
  const { t } = useTranslation();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [selectedUser, setSelectedUser] = useState<UserDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; email: string } | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [quotaInput, setQuotaInput] = useState('');
  const [quotaLoading, setQuotaLoading] = useState(false);
  const [sortBy, setSortBy] = useState('');
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc');
  const [exporting, setExporting] = useState(false);
  const limit = 10;

  async function exportCsv() {
    if (!token || exporting) return;
    setExporting(true);
    try {
      const params = new URLSearchParams({ page: '1', limit: '9999' });
      if (search) params.set('search', search);
      if (statusFilter) params.set('status', statusFilter);
      if (sortBy) { params.set('sortBy', sortBy); params.set('sortDir', sortDir); }
      const res = await fetch(`/api/admin/users?${params}`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      const rows: UserRow[] = data.users;
      const header = ['Email', 'Display Name', 'Role', 'Status', 'Total Tokens', 'Input Tokens', 'Output Tokens', 'Cost (USD)', 'Conversations', 'Files', 'Created At', 'Last Login'];
      const csvRows = rows.map(u => [
        u.email,
        u.display_name || '',
        u.role,
        u.status,
        u.total_tokens,
        u.total_input_tokens,
        u.total_output_tokens,
        calcCost(u.total_input_tokens, u.total_output_tokens).toFixed(2),
        u.conversation_count,
        u.file_count,
        u.created_at,
        u.last_login_at || '',
      ]);
      const csv = '\uFEFF' + [header, ...csvRows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `users_${new Date().toISOString().slice(0, 10)}.csv`; a.click();
      URL.revokeObjectURL(url);
    } finally { setExporting(false); }
  }

  const fetchUsers = useCallback(() => {
    if (!token) return;
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (search) params.set('search', search);
    if (statusFilter) params.set('status', statusFilter);
    if (sortBy) { params.set('sortBy', sortBy); params.set('sortDir', sortDir); }

    fetch(`/api/admin/users?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(data => {
        setUsers(data.users);
        setTotal(data.total);
        setTotalPages(data.totalPages);
      })
      .catch(console.error);
  }, [token, page, search, statusFilter, sortBy, sortDir]);

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setPage(1);
    fetchUsers();
  }

  function toggleSort(col: string) {
    if (sortBy === col) {
      if (sortDir === 'desc') setSortDir('asc');
      else { setSortBy(''); setSortDir('desc'); } // third click clears sort
    } else {
      setSortBy(col);
      setSortDir('desc');
    }
    setPage(1);
  }

  async function selectUser(userId: string) {
    if (!token) return;
    setLoadingDetail(true);
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setSelectedUser(data);
      setQuotaInput(data.quota_override != null ? String(data.quota_override) : '');
    } catch {
      // ignore
    } finally {
      setLoadingDetail(false);
    }
  }

  async function toggleUserStatus(userId: string, newStatus: string) {
    if (!token || actionLoading) return;
    setActionLoading(true);
    try {
      await fetch(`/api/admin/users/${userId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ status: newStatus }),
      });
      fetchUsers();
      if (selectedUser?.id === userId) {
        setSelectedUser(prev => prev ? { ...prev, status: newStatus } : null);
      }
    } finally {
      setActionLoading(false);
    }
  }

  async function changeRole(userId: string, newRole: string) {
    if (!token || actionLoading) return;
    setActionLoading(true);
    try {
      const res = await fetch(`/api/admin/users/${userId}/role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ role: newRole }),
      });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || 'Failed to change role');
        return;
      }
      fetchUsers();
      if (selectedUser?.id === userId) {
        setSelectedUser(prev => prev ? { ...prev, role: newRole } : null);
      }
    } finally {
      setActionLoading(false);
    }
  }

  async function deleteUser(userId: string) {
    if (!token || deleteLoading) return;
    setDeleteLoading(true);
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        setDeleteConfirm(null);
        setSelectedUser(null);
        fetchUsers();
      }
    } finally {
      setDeleteLoading(false);
    }
  }

  async function updateQuota(userId: string) {
    if (!token || quotaLoading) return;
    setQuotaLoading(true);
    try {
      const value = quotaInput.trim() === '' ? null : parseFloat(quotaInput);
      const res = await fetch(`/api/admin/users/${userId}/quota`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ quota_override: value }),
      });
      if (res.ok) {
        const data = await res.json();
        setSelectedUser(prev => prev ? { ...prev, quota_override: data.quota_override, effective_limit: data.effective_limit } : null);
      }
    } finally {
      setQuotaLoading(false);
    }
  }

  /* ---- Detail Panel Content (shared between mobile overlay & desktop sidebar) ---- */
  function renderDetail(detail: UserDetail, onClose: () => void) {
    return (
      <>
        {/* Header: Avatar + Name + Close */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-outline-variant/10">
          <div className="w-9 h-9 rounded-lg bg-primary/15 flex items-center justify-center text-sm font-black text-primary shrink-0">
            {(detail.display_name || detail.email).slice(0, 2).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-bold text-on-surface truncate">{detail.display_name || detail.email.split('@')[0]}</h3>
            <p className="text-xs text-on-surface-variant truncate">{detail.email}</p>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded hover:bg-surface-container-high transition-colors bg-transparent cursor-pointer shrink-0"
          >
            <span className="material-symbols-outlined text-on-surface-variant text-sm">close</span>
          </button>
        </div>

        {/* Info Row: Status + Role + Registered */}
        <div className="px-4 py-3 flex items-center gap-2 text-xs border-b border-outline-variant/10">
          <StatusBadge status={detail.status} />
          <RoleBadge role={detail.role} />
          <span className="text-on-surface-variant ml-auto">{toUTC(detail.created_at).toLocaleDateString('zh-TW')}</span>
        </div>

        {/* Role Toggle */}
        <div className="px-4 py-3 border-b border-outline-variant/10">
          <div className="flex items-center gap-2">
            <span className="text-xs uppercase tracking-wider text-on-surface-variant font-bold">{t('admin.users.detail.roleLabel')}</span>
            <div className="flex rounded overflow-hidden border border-outline-variant/15 ml-auto">
              {(['user', 'admin'] as const).map(r => (
                <button
                  key={r}
                  onClick={() => changeRole(detail.id, r)}
                  disabled={actionLoading || detail.role === r}
                  className={`px-3 py-1 text-xs font-bold uppercase tracking-wider cursor-pointer transition-colors disabled:cursor-default ${
                    detail.role === r
                      ? r === 'admin' ? 'bg-primary/15 text-primary' : 'bg-surface-container-high text-on-surface'
                      : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high'
                  }`}
                >
                  {r === 'admin' ? 'Admin' : 'User'}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Token Stats */}
        <div className="px-4 py-3 border-b border-outline-variant/10">
          <div className="flex items-center justify-between text-xs">
            <span className="uppercase tracking-wider text-on-surface-variant font-bold">{t('admin.users.detail.tokenUsage')}</span>
            <span className="text-on-surface-variant">{detail.tokenStats.invocation_count} calls</span>
          </div>
          <div className="flex gap-4 mt-2 items-center">
            <div>
              <span className="text-xs text-on-surface-variant">{t('admin.users.detail.tokenInput')} </span>
              <span className="text-sm font-bold text-on-surface">{formatTokens(detail.tokenStats.total_input)}</span>
            </div>
            <div>
              <span className="text-xs text-on-surface-variant">{t('admin.users.detail.tokenOutput')} </span>
              <span className="text-sm font-bold text-on-surface">{formatTokens(detail.tokenStats.total_output)}</span>
            </div>
            {calcCost(detail.tokenStats.total_input, detail.tokenStats.total_output) >= 0.01 && (
              <div className="ml-auto">
                <span className="text-sm font-bold text-success font-mono">{formatCost(calcCost(detail.tokenStats.total_input, detail.tokenStats.total_output))}</span>
              </div>
            )}
          </div>
        </div>

        {/* Quota / Usage */}
        <div className="px-4 py-3 border-b border-outline-variant/10">
          <div className="flex items-center justify-between text-xs mb-2">
            <span className="uppercase tracking-wider text-on-surface-variant font-bold">{t('admin.users.detail.quota' as any)}</span>
            <span className="text-on-surface-variant font-mono">
              ${detail.display_cost?.toFixed(2) ?? '0.00'} / ${detail.effective_limit?.toFixed(2) ?? '50.00'}
            </span>
          </div>
          {/* Progress bar */}
          <div className="h-1.5 bg-surface-container-highest rounded-full overflow-hidden mb-2">
            <div
              className={`h-full rounded-full transition-all ${
                (detail.display_cost ?? 0) >= (detail.effective_limit ?? 50) ? 'bg-error' : 'bg-primary'
              }`}
              style={{ width: `${Math.min(100, ((detail.display_cost ?? 0) / (detail.effective_limit ?? 50)) * 100)}%` }}
            />
          </div>
          <div className="flex items-center gap-2 mt-2">
            <input
              type="text"
              inputMode="decimal"
              placeholder={t('admin.users.detail.quotaPlaceholder' as any)}
              value={quotaInput}
              onChange={e => { if (/^\d*\.?\d{0,2}$/.test(e.target.value) || e.target.value === '') setQuotaInput(e.target.value); }}
              className="flex-1 bg-surface-container-highest border-none focus:ring-1 focus:ring-primary/40 text-on-surface py-1.5 px-2.5 text-xs font-mono rounded placeholder:text-outline min-w-0 [appearance:textfield]"
            />
            <button
              onClick={() => updateQuota(detail.id)}
              disabled={quotaLoading}
              className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider bg-primary/10 text-primary rounded hover:bg-primary/20 transition-colors cursor-pointer disabled:opacity-50 shrink-0"
            >
              {t('admin.users.detail.quotaSave' as any)}
            </button>
          </div>
          {detail.quota_override != null && (
            <div className="flex items-center gap-1 mt-1.5">
              <span className="text-[10px] text-on-surface-variant">{t('admin.users.detail.quotaOverride' as any)}: ${detail.quota_override}</span>
              <button
                onClick={() => { setQuotaInput(''); updateQuota(detail.id); }}
                className="text-[10px] text-error hover:text-error/80 transition-colors cursor-pointer ml-1"
              >
                {t('admin.users.detail.quotaReset' as any)}
              </button>
            </div>
          )}
        </div>

        {/* Recent Files */}
        <div className="px-4 py-3 border-b border-outline-variant/10 flex-1 min-h-0 overflow-y-auto">
          <p className="text-xs uppercase tracking-wider text-on-surface-variant font-bold mb-2">{t('admin.users.detail.recentFiles')} ({detail.file_count})</p>
          {detail.recentFiles.length === 0 ? (
            <p className="text-xs text-on-surface-variant">{t('admin.users.detail.noFiles')}</p>
          ) : (
            <div className="space-y-0.5">
              {detail.recentFiles.slice(0, 5).map(f => (
                <div key={f.id} className="flex items-center gap-1.5 text-xs py-1 rounded">
                  <span className="material-symbols-outlined text-xs text-on-surface-variant shrink-0">draft</span>
                  <span className="flex-1 text-on-surface truncate">{f.filename}</span>
                  <span className="text-on-surface-variant shrink-0">{formatFileSize(f.file_size)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* AI Memories */}
        <div className="px-4 py-3 border-b border-outline-variant/10">
          <p className="text-xs uppercase tracking-wider text-on-surface-variant font-bold mb-2">
            {t('admin.users.detail.memories' as any)} ({detail.memory_count})
          </p>
          {detail.memory_count > 0 ? (
            <AdminMemoryList userId={detail.id} token={token!} t={t} />
          ) : (
            <p className="text-xs text-on-surface-variant">{t('admin.users.detail.noMemories' as any)}</p>
          )}
        </div>

        {/* Actions */}
        <div className="px-4 py-3 space-y-2">
          {(detail.status === 'pending' || detail.status === 'pending_verification') ? (
            <div className="flex gap-2">
              <button
                onClick={() => toggleUserStatus(detail.id, 'active')}
                disabled={actionLoading}
                className="flex-1 h-9 flex items-center justify-center bg-success/10 text-success text-xs font-bold uppercase tracking-wider rounded hover:bg-success/20 transition-colors cursor-pointer disabled:opacity-50"
              >
                {t('admin.users.detail.approve')}
              </button>
              <button
                onClick={() => toggleUserStatus(detail.id, 'suspended')}
                disabled={actionLoading}
                className="flex-1 h-9 flex items-center justify-center bg-error/10 text-error text-xs font-bold uppercase tracking-wider rounded hover:bg-error/20 transition-colors cursor-pointer disabled:opacity-50"
              >
                {t('admin.users.detail.reject')}
              </button>
            </div>
          ) : detail.status === 'active' ? (
            <button
              onClick={() => toggleUserStatus(detail.id, 'suspended')}
              disabled={actionLoading}
              className="w-full h-9 flex items-center justify-center bg-error/10 text-error text-xs font-bold uppercase tracking-wider rounded hover:bg-error/20 transition-colors cursor-pointer disabled:opacity-50"
            >
              {t('admin.users.detail.suspend')}
            </button>
          ) : (
            <button
              onClick={() => toggleUserStatus(detail.id, 'active')}
              disabled={actionLoading}
              className="w-full h-9 flex items-center justify-center bg-success/10 text-success text-xs font-bold uppercase tracking-wider rounded hover:bg-success/20 transition-colors cursor-pointer disabled:opacity-50"
            >
              {t('admin.users.detail.activate')}
            </button>
          )}
          <button
            onClick={() => setDeleteConfirm({ id: detail.id, email: detail.email })}
            className="w-full h-9 flex items-center justify-center gap-1.5 border border-error/30 text-error/70 text-xs font-bold uppercase tracking-wider rounded hover:bg-error/10 hover:text-error transition-colors cursor-pointer"
          >
            <span className="material-symbols-outlined text-xs">delete_forever</span>
            {t('admin.users.detail.delete')}
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      {/* Header */}
      <header className="sticky top-0 h-14 md:h-16 bg-surface/80 backdrop-blur-xl flex justify-between items-center px-4 md:px-8 z-40 shadow-[0_1px_0_0_rgba(255,255,255,0.05)]">
        <div className="flex items-center gap-2 md:gap-4">
          <span className="text-base md:text-lg font-black text-on-surface font-headline">{t('admin.users.title')}</span>
          <span className="text-xs md:text-sm text-on-surface-variant font-mono">{t('admin.users.count', { count: total })}</span>
        </div>
        <button
          onClick={exportCsv}
          disabled={exporting}
          className="flex items-center gap-1.5 md:gap-2 px-2.5 md:px-4 py-1.5 md:py-2 bg-surface-container text-on-surface-variant text-xs md:text-sm font-bold uppercase tracking-wider hover:bg-surface-container-high transition-colors cursor-pointer disabled:opacity-50"
        >
          <span className={`material-symbols-outlined text-sm ${exporting ? 'animate-spin' : ''}`}>{exporting ? 'progress_activity' : 'download'}</span>
          <span className="hidden md:inline">{t('admin.users.exportCsv')}</span>
          <span className="md:hidden">CSV</span>
        </button>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Main Table Area */}
        <div className="flex-1 flex flex-col p-4 md:p-8 overflow-hidden">
          {/* Filters */}
          <div className="flex flex-col md:flex-row md:items-center gap-3 md:gap-4 mb-4 md:mb-6">
            <form onSubmit={handleSearch} className="flex-1 relative">
              <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline text-sm">search</span>
              <input
                className="w-full bg-surface-container-highest border-none focus:ring-1 focus:ring-primary/40 rounded py-2.5 pl-10 pr-4 text-sm text-on-surface placeholder:text-outline font-body"
                placeholder={t('admin.users.search.placeholder')}
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </form>
            <div className="flex rounded overflow-hidden border border-outline-variant/15 shrink-0">
              {[
                { value: '', label: t('admin.users.filter.all') },
                { value: 'pending', label: t('admin.users.filter.pending') },
                { value: 'active', label: t('admin.users.filter.active') },
                { value: 'suspended', label: t('admin.users.filter.suspended') },
              ].map(opt => (
                <button
                  key={opt.value}
                  onClick={() => { setStatusFilter(opt.value); setPage(1); }}
                  className={`flex-1 md:flex-none px-3 md:px-4 py-2 text-xs md:text-sm font-bold uppercase tracking-wider cursor-pointer transition-colors ${
                    statusFilter === opt.value
                      ? 'bg-primary/15 text-primary'
                      : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Desktop Table */}
          <div className="hidden md:block flex-1 overflow-y-auto">
            <table className="w-full">
              <thead className="sticky top-0 bg-surface-container-lowest">
                <tr className="text-left text-sm uppercase tracking-widest text-on-surface-variant">
                  <th className="py-3 px-4 font-bold">{t('admin.users.table.user')}</th>
                  <th className="py-3 px-4 font-bold">{t('admin.users.table.role')}</th>
                  <th className="py-3 px-4 font-bold">{t('admin.users.table.status')}</th>
                  <th className="py-3 px-4 font-bold text-right">
                    <button onClick={() => toggleSort('tokens')} className="inline-flex items-center gap-1 cursor-pointer hover:text-on-surface transition-colors">
                      Tokens
                      {sortBy === 'tokens' && <span className="material-symbols-outlined text-primary text-sm">{sortDir === 'desc' ? 'arrow_downward' : 'arrow_upward'}</span>}
                    </button>
                  </th>
                  <th className="py-3 px-4 font-bold text-right">
                    <button onClick={() => toggleSort('conversations')} className="inline-flex items-center gap-1 cursor-pointer hover:text-on-surface transition-colors">
                      {t('admin.users.table.conversations')}
                      {sortBy === 'conversations' && <span className="material-symbols-outlined text-primary text-sm">{sortDir === 'desc' ? 'arrow_downward' : 'arrow_upward'}</span>}
                    </button>
                  </th>
                  <th className="py-3 px-4 font-bold text-right">
                    <button onClick={() => toggleSort('files')} className="inline-flex items-center gap-1 cursor-pointer hover:text-on-surface transition-colors">
                      {t('admin.users.table.files')}
                      {sortBy === 'files' && <span className="material-symbols-outlined text-primary text-sm">{sortDir === 'desc' ? 'arrow_downward' : 'arrow_upward'}</span>}
                    </button>
                  </th>
                  <th className="py-3 px-4 font-bold text-right">{t('admin.users.table.dates' as any)}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant/10">
                {users.map(user => (
                  <tr
                    key={user.id}
                    className={`hover:bg-surface-container/50 cursor-pointer transition-colors ${selectedUser?.id === user.id ? 'bg-surface-container' : ''}`}
                    onClick={() => selectUser(user.id)}
                  >
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded bg-primary/15 flex items-center justify-center text-sm font-bold text-primary shrink-0">
                          {(user.display_name || user.email)[0].toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm text-on-surface font-medium truncate">{user.display_name || user.email.split('@')[0]}</p>
                          <p className="text-sm text-on-surface-variant font-mono truncate">{user.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="py-3 px-4"><RoleBadge role={user.role} /></td>
                    <td className="py-3 px-4"><StatusBadge status={user.status} /></td>
                    <td className="py-3 px-4 text-right text-sm font-mono">
                      <span className="text-on-surface">{formatTokens(user.total_tokens)}</span>
                      {calcCost(user.total_input_tokens, user.total_output_tokens) >= 0.01 && (
                        <span className="text-xs text-success ml-1">({formatCost(calcCost(user.total_input_tokens, user.total_output_tokens))})</span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right text-sm text-on-surface-variant">{user.conversation_count}</td>
                    <td className="py-3 px-4 text-right text-sm text-on-surface-variant">{user.file_count}</td>
                    <td className="py-3 px-4 text-right text-xs font-mono leading-relaxed">
                      <div className="text-on-surface-variant">{toUTC(user.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}</div>
                      <div className="text-on-surface-variant/60">{user.last_login_at ? toUTC(user.last_login_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '-'}</div>
                    </td>
                  </tr>
                ))}
                {users.length === 0 && (
                  <tr>
                    <td colSpan={7} className="py-12 text-center text-on-surface-variant">{t('admin.users.table.empty')}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Mobile Card List */}
          <div className="md:hidden flex-1 overflow-y-auto -mx-4 px-4 space-y-2">
            {users.map(user => (
              <div
                key={user.id}
                className={`bg-surface-container rounded-lg p-3 active:bg-surface-container-high transition-colors cursor-pointer ${selectedUser?.id === user.id ? 'ring-1 ring-primary/30' : ''}`}
                onClick={() => selectUser(user.id)}
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-primary/15 flex items-center justify-center text-sm font-black text-primary shrink-0">
                    {(user.display_name || user.email)[0].toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-bold text-on-surface truncate">{user.display_name || user.email.split('@')[0]}</p>
                      <RoleBadge role={user.role} />
                    </div>
                    <p className="text-xs text-on-surface-variant font-mono truncate">{user.email}</p>
                  </div>
                  <StatusBadge status={user.status} />
                </div>
                <div className="flex items-center gap-4 mt-2 ml-[52px] text-[11px] text-on-surface-variant">
                  <span className="font-mono">
                    {formatTokens(user.total_tokens)}
                    {calcCost(user.total_input_tokens, user.total_output_tokens) >= 0.01 && (
                      <span className="text-success ml-1">({formatCost(calcCost(user.total_input_tokens, user.total_output_tokens))})</span>
                    )}
                  </span>
                  <span>{user.conversation_count} {t('admin.users.table.conversations')}</span>
                  <span>{user.file_count} {t('admin.users.table.files')}</span>
                  <span className="ml-auto font-mono">{user.last_login_at ? toUTC(user.last_login_at).toLocaleDateString('zh-TW') : '-'}</span>
                </div>
              </div>
            ))}
            {users.length === 0 && (
              <div className="py-12 text-center text-on-surface-variant text-sm">{t('admin.users.table.empty')}</div>
            )}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between pt-4 border-t border-outline-variant/10 mt-4">
              <span className="text-xs md:text-sm text-on-surface-variant hidden md:block">
                {t('admin.users.pagination.summary', { start: (page - 1) * limit + 1, end: Math.min(page * limit, total), total })}
              </span>
              <span className="text-xs text-on-surface-variant md:hidden">{page}/{totalPages}</span>
              <div className="flex gap-1">
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="px-2.5 md:px-3 py-1.5 text-xs md:text-sm bg-surface-container text-on-surface-variant rounded disabled:opacity-30 cursor-pointer hover:bg-surface-container-high transition-colors"
                >
                  {t('common.prev')}
                </button>
                {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => i + 1).map(p => (
                  <button
                    key={p}
                    onClick={() => setPage(p)}
                    className={`px-2.5 md:px-3 py-1.5 text-xs md:text-sm rounded cursor-pointer transition-colors ${
                      page === p
                        ? 'bg-primary/15 text-primary font-bold'
                        : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high'
                    }`}
                  >
                    {p}
                  </button>
                ))}
                <button
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  className="px-2.5 md:px-3 py-1.5 text-xs md:text-sm bg-surface-container text-on-surface-variant rounded disabled:opacity-30 cursor-pointer hover:bg-surface-container-high transition-colors"
                >
                  {t('common.next')}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Desktop User Detail Sidebar */}
        {selectedUser && (
          <div className="hidden md:flex w-[320px] bg-surface-container-low border-l border-outline-variant/10 flex-col">
            {renderDetail(selectedUser, () => setSelectedUser(null))}
          </div>
        )}
      </div>

      {/* Mobile User Detail Overlay */}
      {selectedUser && (
        <div className="md:hidden fixed inset-0 z-50 flex flex-col bg-surface-container-lowest animate-[slideDown_0.2s_ease-out]">
          {/* Mobile detail top bar */}
          <div className="h-14 flex items-center gap-3 px-4 border-b border-outline-variant/10 bg-surface-dim shrink-0">
            <button
              onClick={() => setSelectedUser(null)}
              className="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-surface-container text-on-surface-variant cursor-pointer"
            >
              <span className="material-symbols-outlined">arrow_back</span>
            </button>
            <span className="text-sm font-bold text-on-surface font-headline">{t('admin.users.detail.title' as any)}</span>
          </div>
          <div className="flex-1 overflow-y-auto flex flex-col">
            {renderDetail(selectedUser, () => setSelectedUser(null))}
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-surface-container w-full max-w-md mx-4 rounded-lg shadow-2xl border border-outline-variant/10 overflow-hidden">
            <div className="p-4 md:p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-full bg-error/15 flex items-center justify-center shrink-0">
                  <span className="material-symbols-outlined text-error">warning</span>
                </div>
                <h3 className="text-base md:text-lg font-headline font-bold text-on-surface">{t('admin.users.deleteModal.title')}</h3>
              </div>
              <p className="text-sm text-on-surface-variant mb-2">
                {t('admin.users.deleteModal.warning')}
              </p>
              <div className="bg-surface-container-highest rounded p-3 mb-4">
                <p className="text-sm font-mono text-on-surface font-bold">{deleteConfirm.email}</p>
                <p className="text-xs text-on-surface-variant mt-0.5">ID: {deleteConfirm.id.slice(0, 8)}...</p>
              </div>
              <div className="bg-error/5 border border-error/15 rounded p-3 text-xs md:text-sm text-error/90">
                <p className="font-bold mb-1">{t('admin.users.deleteModal.irreversible')}</p>
                <ul className="list-disc list-inside space-y-0.5">
                  <li>{t('admin.users.deleteModal.itemAccount')}</li>
                  <li>{t('admin.users.deleteModal.itemConversations')}</li>
                  <li>{t('admin.users.deleteModal.itemFiles')}</li>
                  <li>{t('admin.users.deleteModal.itemTokens')}</li>
                  <li>{t('admin.users.deleteModal.itemWorkspace')}</li>
                </ul>
              </div>
            </div>
            <div className="flex gap-3 px-4 pb-4 md:px-6 md:pb-6">
              <button
                onClick={() => setDeleteConfirm(null)}
                disabled={deleteLoading}
                className="flex-1 py-2 md:py-2.5 px-4 bg-surface-container-high text-on-surface-variant text-xs md:text-sm font-bold uppercase tracking-wider rounded hover:bg-surface-variant transition-colors cursor-pointer disabled:opacity-50"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => deleteUser(deleteConfirm.id)}
                disabled={deleteLoading}
                className="flex-1 py-2 md:py-2.5 px-4 bg-error text-on-error text-xs md:text-sm font-bold uppercase tracking-wider rounded hover:bg-error/90 transition-colors cursor-pointer disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {deleteLoading ? (
                  t('admin.users.deleteModal.deleting')
                ) : (
                  <>
                    <span className="material-symbols-outlined text-sm">delete_forever</span>
                    {t('admin.users.deleteModal.confirm')}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function AdminMemoryList({ userId, token, t }: { userId: string; token: string; t: (key: any) => string }) {
  const [memories, setMemories] = useState<Array<{ id: string; content: string; category: string; created_at: string }>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/admin/users/${userId}/memories`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(data => { setMemories(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, [userId, token]);

  const catColors: Record<string, string> = {
    preference: 'bg-blue-500/15 text-blue-400',
    company: 'bg-green-500/15 text-green-400',
    project: 'bg-purple-500/15 text-purple-400',
    style: 'bg-orange-500/15 text-orange-400',
    general: 'bg-surface-container-high text-on-surface-variant',
  };

  if (loading) return <span className="material-symbols-outlined text-sm animate-spin text-on-surface-variant">progress_activity</span>;

  return (
    <div className="space-y-1">
      {memories.slice(0, 3).map(m => (
        <div key={m.id} className="flex items-start gap-1.5 text-xs">
          <span className={`inline-block text-[10px] font-bold px-1.5 py-0.5 rounded-full shrink-0 ${catColors[m.category] || catColors.general}`}>
            {t(`userMenu.memory.category.${m.category}` as any)}
          </span>
          <span className="text-on-surface">{m.content}</span>
        </div>
      ))}
    </div>
  );
}
