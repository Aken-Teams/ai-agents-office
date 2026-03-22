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
  total_tokens: number;
  file_count: number;
  conversation_count: number;
}

interface UserDetail {
  id: string;
  email: string;
  display_name: string | null;
  status: string;
  role: string;
  created_at: string;
  updated_at: string;
  tokenStats: { total_input: number; total_output: number; invocation_count: number };
  recentFiles: { id: string; filename: string; file_type: string; file_size: number; created_at: string }[];
  recentConversations: { id: string; title: string; skill_id: string | null; status: string; created_at: string }[];
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
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
  const limit = 10;

  const fetchUsers = useCallback(() => {
    if (!token) return;
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (search) params.set('search', search);
    if (statusFilter) params.set('status', statusFilter);

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
  }, [token, page, search, statusFilter]);

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setPage(1);
    fetchUsers();
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

  return (
    <>
      {/* Header */}
      <header className="sticky top-0 h-16 bg-surface/80 backdrop-blur-xl flex justify-between items-center px-8 z-40 shadow-[0_1px_0_0_rgba(255,255,255,0.05)]">
        <div className="flex items-center gap-4">
          <span className="text-lg font-black text-on-surface font-headline">{t('admin.users.title')}</span>
          <span className="text-sm text-on-surface-variant font-mono">{t('admin.users.count', { count: total })}</span>
        </div>
        <div className="flex items-center gap-3">
          <button className="flex items-center gap-2 px-4 py-2 bg-surface-container text-on-surface-variant text-sm font-bold uppercase tracking-wider hover:bg-surface-container-high transition-colors cursor-pointer">
            <span className="material-symbols-outlined text-sm">download</span>
            {t('admin.users.exportCsv')}
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Main Table Area */}
        <div className="flex-1 flex flex-col p-8 overflow-hidden">
          {/* Filters */}
          <div className="flex items-center gap-4 mb-6">
            <form onSubmit={handleSearch} className="flex-1 relative">
              <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline text-sm">search</span>
              <input
                className="w-full bg-surface-container-highest border-none focus:ring-1 focus:ring-primary/40 rounded py-2.5 pl-10 pr-4 text-sm text-on-surface placeholder:text-outline font-body"
                placeholder={t('admin.users.search.placeholder')}
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </form>
            <div className="flex rounded overflow-hidden border border-outline-variant/15">
              {[
                { value: '', label: t('admin.users.filter.all') },
                { value: 'pending', label: t('admin.users.filter.pending') },
                { value: 'active', label: t('admin.users.filter.active') },
                { value: 'suspended', label: t('admin.users.filter.suspended') },
              ].map(opt => (
                <button
                  key={opt.value}
                  onClick={() => { setStatusFilter(opt.value); setPage(1); }}
                  className={`px-4 py-2 text-sm font-bold uppercase tracking-wider cursor-pointer transition-colors ${
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

          {/* Table */}
          <div className="flex-1 overflow-y-auto">
            <table className="w-full">
              <thead className="sticky top-0 bg-surface-container-lowest">
                <tr className="text-left text-sm uppercase tracking-widest text-on-surface-variant">
                  <th className="py-3 px-4 font-bold">{t('admin.users.table.user')}</th>
                  <th className="py-3 px-4 font-bold">{t('admin.users.table.registered')}</th>
                  <th className="py-3 px-4 font-bold">{t('admin.users.table.role')}</th>
                  <th className="py-3 px-4 font-bold">{t('admin.users.table.status')}</th>
                  <th className="py-3 px-4 font-bold text-right">Tokens</th>
                  <th className="py-3 px-4 font-bold text-right">{t('admin.users.table.files')}</th>
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
                    <td className="py-3 px-4 text-sm text-on-surface-variant font-mono">
                      {new Date(user.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}
                    </td>
                    <td className="py-3 px-4">
                      <span className={`px-2 py-0.5 text-sm font-bold uppercase tracking-wider rounded ${
                        user.role === 'admin' ? 'bg-primary/15 text-primary' : 'bg-surface-container text-on-surface-variant'
                      }`}>
                        {user.role === 'admin' ? 'Admin' : 'User'}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <span className={`px-2 py-0.5 text-sm font-bold uppercase tracking-wider rounded ${
                        user.status === 'active'
                          ? 'bg-success/15 text-success'
                          : user.status === 'pending'
                          ? 'bg-warning/15 text-warning'
                          : 'bg-error/15 text-error'
                      }`}>
                        {user.status === 'active' ? 'Active' : user.status === 'pending' ? 'Pending' : 'Suspended'}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right text-sm text-on-surface font-mono">{formatTokens(user.total_tokens)}</td>
                    <td className="py-3 px-4 text-right text-sm text-on-surface-variant">{user.file_count}</td>
                  </tr>
                ))}
                {users.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-12 text-center text-on-surface-variant">{t('admin.users.table.empty')}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between pt-4 border-t border-outline-variant/10 mt-4">
              <span className="text-sm text-on-surface-variant">
                {t('admin.users.pagination.summary', { start: (page - 1) * limit + 1, end: Math.min(page * limit, total), total })}
              </span>
              <div className="flex gap-1">
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="px-3 py-1.5 text-sm bg-surface-container text-on-surface-variant rounded disabled:opacity-30 cursor-pointer hover:bg-surface-container-high transition-colors"
                >
                  {t('common.prev')}
                </button>
                {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => i + 1).map(p => (
                  <button
                    key={p}
                    onClick={() => setPage(p)}
                    className={`px-3 py-1.5 text-sm rounded cursor-pointer transition-colors ${
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
                  className="px-3 py-1.5 text-sm bg-surface-container text-on-surface-variant rounded disabled:opacity-30 cursor-pointer hover:bg-surface-container-high transition-colors"
                >
                  {t('common.next')}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* User Detail Sidebar */}
        {selectedUser && (
          <div className="w-[340px] bg-surface-container-low border-l border-outline-variant/10 flex flex-col overflow-y-auto">
            {/* Close */}
            <div className="flex justify-end p-3 pb-0">
              <button
                onClick={() => setSelectedUser(null)}
                className="w-8 h-8 flex items-center justify-center rounded hover:bg-surface-container-high transition-colors bg-transparent cursor-pointer"
              >
                <span className="material-symbols-outlined text-on-surface-variant text-sm">close</span>
              </button>
            </div>

            {/* Profile Card */}
            <div className="px-6 pb-5">
              <div className="bg-surface-container rounded-lg p-5 border border-outline-variant/10">
                <div className="flex items-center gap-4 mb-4">
                  <div className="w-12 h-12 rounded-lg bg-primary/15 flex items-center justify-center text-lg font-black text-primary shrink-0">
                    {(selectedUser.display_name || selectedUser.email).slice(0, 2).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-sm font-bold text-on-surface truncate">{selectedUser.display_name || selectedUser.email.split('@')[0]}</h3>
                    <p className="text-sm text-on-surface-variant font-mono mt-0.5">ID: {selectedUser.id.slice(0, 8)}</p>
                    <p className="text-sm text-on-surface-variant font-mono mt-0.5 truncate">{selectedUser.email}</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="bg-surface-container-high rounded p-2.5">
                    <p className="text-xs uppercase tracking-wider text-on-surface-variant font-bold">{t('admin.users.detail.statusLabel')}</p>
                    <p className={`text-sm font-black mt-0.5 ${
                      selectedUser.status === 'active' ? 'text-success' : selectedUser.status === 'pending' ? 'text-warning' : 'text-error'
                    }`}>
                      {selectedUser.status === 'active' ? 'Active' : selectedUser.status === 'pending' ? 'Pending' : 'Suspended'}
                    </p>
                  </div>
                  <div className="bg-surface-container-high rounded p-2.5">
                    <p className="text-xs uppercase tracking-wider text-on-surface-variant font-bold">{t('admin.users.detail.registeredLabel')}</p>
                    <p className="text-sm font-bold text-on-surface mt-0.5">{new Date(selectedUser.created_at).toLocaleDateString('zh-TW')}</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Role Control */}
            <div className="px-6 pb-5 border-t border-outline-variant/25 pt-5">
              <h4 className="text-sm uppercase tracking-widest text-on-surface-variant font-bold mb-3">{t('admin.users.detail.roleLabel')}</h4>
              <div className="flex rounded overflow-hidden border border-outline-variant/15">
                {(['user', 'admin'] as const).map(r => (
                  <button
                    key={r}
                    onClick={() => changeRole(selectedUser.id, r)}
                    disabled={actionLoading || selectedUser.role === r}
                    className={`flex-1 py-2 text-sm font-bold uppercase tracking-wider cursor-pointer transition-colors disabled:cursor-default ${
                      selectedUser.role === r
                        ? r === 'admin' ? 'bg-primary/15 text-primary' : 'bg-surface-container-high text-on-surface'
                        : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high'
                    }`}
                  >
                    {r === 'admin' ? 'Admin' : 'User'}
                  </button>
                ))}
              </div>
            </div>

            {/* Token Stats */}
            <div className="px-6 pb-5 border-t border-outline-variant/25 pt-5">
              <h4 className="text-sm uppercase tracking-widest text-on-surface-variant font-bold mb-3">{t('admin.users.detail.tokenUsage')}</h4>
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-surface-container p-3 rounded">
                  <p className="text-xs uppercase text-on-surface-variant">{t('admin.users.detail.tokenInput')}</p>
                  <p className="text-lg font-bold text-on-surface font-headline">{formatTokens(selectedUser.tokenStats.total_input)}</p>
                </div>
                <div className="bg-surface-container p-3 rounded">
                  <p className="text-xs uppercase text-on-surface-variant">{t('admin.users.detail.tokenOutput')}</p>
                  <p className="text-lg font-bold text-on-surface font-headline">{formatTokens(selectedUser.tokenStats.total_output)}</p>
                </div>
              </div>
              <p className="text-sm text-on-surface-variant mt-2">{t('admin.users.detail.invocationCount', { count: selectedUser.tokenStats.invocation_count })}</p>
            </div>

            {/* Recent Files */}
            <div className="px-6 pb-5 border-t border-outline-variant/25 pt-5">
              <h4 className="text-sm uppercase tracking-widest text-on-surface-variant font-bold mb-3">{t('admin.users.detail.recentFiles')}</h4>
              {selectedUser.recentFiles.length === 0 ? (
                <p className="text-sm text-on-surface-variant">{t('admin.users.detail.noFiles')}</p>
              ) : (
                <div className="space-y-1.5">
                  {selectedUser.recentFiles.map(f => (
                    <div key={f.id} className="flex items-center gap-2 text-sm p-2 rounded hover:bg-surface-container/50 transition-colors">
                      <span className="material-symbols-outlined text-sm text-on-surface-variant shrink-0">draft</span>
                      <span className="flex-1 text-on-surface truncate">{f.filename}</span>
                      <span className="text-sm text-on-surface-variant shrink-0">{formatFileSize(f.file_size)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Admin Controls */}
            <div className="px-6 pb-6 mt-auto border-t border-outline-variant/25 pt-5">
              <h4 className="text-sm uppercase tracking-widest text-on-surface-variant font-bold mb-3">{t('admin.users.detail.adminControls')}</h4>
              {selectedUser.status === 'pending' ? (
                <div className="space-y-2">
                  <button
                    onClick={() => toggleUserStatus(selectedUser.id, 'active')}
                    disabled={actionLoading}
                    className="w-full py-2 px-4 bg-success/10 text-success text-sm font-bold uppercase tracking-wider rounded hover:bg-success/20 transition-colors cursor-pointer disabled:opacity-50"
                  >
                    {t('admin.users.detail.approve')}
                  </button>
                  <button
                    onClick={() => toggleUserStatus(selectedUser.id, 'suspended')}
                    disabled={actionLoading}
                    className="w-full py-2 px-4 bg-error/10 text-error text-sm font-bold uppercase tracking-wider rounded hover:bg-error/20 transition-colors cursor-pointer disabled:opacity-50"
                  >
                    {t('admin.users.detail.reject')}
                  </button>
                </div>
              ) : selectedUser.status === 'active' ? (
                <button
                  onClick={() => toggleUserStatus(selectedUser.id, 'suspended')}
                  disabled={actionLoading}
                  className="w-full py-2 px-4 bg-error/10 text-error text-sm font-bold uppercase tracking-wider rounded hover:bg-error/20 transition-colors cursor-pointer disabled:opacity-50"
                >
                  {t('admin.users.detail.suspend')}
                </button>
              ) : (
                <button
                  onClick={() => toggleUserStatus(selectedUser.id, 'active')}
                  disabled={actionLoading}
                  className="w-full py-2 px-4 bg-success/10 text-success text-sm font-bold uppercase tracking-wider rounded hover:bg-success/20 transition-colors cursor-pointer disabled:opacity-50"
                >
                  {t('admin.users.detail.activate')}
                </button>
              )}

              {/* Delete Button */}
              <button
                onClick={() => setDeleteConfirm({ id: selectedUser.id, email: selectedUser.email })}
                className="w-full mt-3 py-2 px-4 border border-error/30 text-error/70 text-sm font-bold uppercase tracking-wider rounded hover:bg-error/10 hover:text-error transition-colors cursor-pointer flex items-center justify-center gap-2"
              >
                <span className="material-symbols-outlined text-sm">delete_forever</span>
                {t('admin.users.detail.delete')}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Delete Confirmation Modal */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-surface-container w-full max-w-md mx-4 rounded-lg shadow-2xl border border-outline-variant/10 overflow-hidden">
            <div className="p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-full bg-error/15 flex items-center justify-center shrink-0">
                  <span className="material-symbols-outlined text-error">warning</span>
                </div>
                <h3 className="text-lg font-headline font-bold text-on-surface">{t('admin.users.deleteModal.title')}</h3>
              </div>
              <p className="text-sm text-on-surface-variant mb-2">
                {t('admin.users.deleteModal.warning')}
              </p>
              <div className="bg-surface-container-highest rounded p-3 mb-4">
                <p className="text-sm font-mono text-on-surface font-bold">{deleteConfirm.email}</p>
                <p className="text-sm text-on-surface-variant mt-0.5">ID: {deleteConfirm.id.slice(0, 8)}...</p>
              </div>
              <div className="bg-error/5 border border-error/15 rounded p-3 text-sm text-error/90">
                <p className="font-bold mb-1">{t('admin.users.deleteModal.irreversible')}</p>
                <ul className="list-disc list-inside space-y-0.5 text-sm">
                  <li>{t('admin.users.deleteModal.itemAccount')}</li>
                  <li>{t('admin.users.deleteModal.itemConversations')}</li>
                  <li>{t('admin.users.deleteModal.itemFiles')}</li>
                  <li>{t('admin.users.deleteModal.itemTokens')}</li>
                  <li>{t('admin.users.deleteModal.itemWorkspace')}</li>
                </ul>
              </div>
            </div>
            <div className="flex gap-3 px-6 pb-6">
              <button
                onClick={() => setDeleteConfirm(null)}
                disabled={deleteLoading}
                className="flex-1 py-2.5 px-4 bg-surface-container-high text-on-surface-variant text-sm font-bold uppercase tracking-wider rounded hover:bg-surface-variant transition-colors cursor-pointer disabled:opacity-50"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => deleteUser(deleteConfirm.id)}
                disabled={deleteLoading}
                className="flex-1 py-2.5 px-4 bg-error text-on-error text-sm font-bold uppercase tracking-wider rounded hover:bg-error/90 transition-colors cursor-pointer disabled:opacity-50 flex items-center justify-center gap-2"
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
