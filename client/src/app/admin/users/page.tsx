'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAdminAuth } from '../components/AdminAuthProvider';

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
  const [users, setUsers] = useState<UserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [selectedUser, setSelectedUser] = useState<UserDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const limit = 15;

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

  return (
    <>
      {/* Header */}
      <header className="sticky top-0 h-16 bg-surface/80 backdrop-blur-xl flex justify-between items-center px-8 z-40 shadow-[0_1px_0_0_rgba(255,255,255,0.05)]">
        <div className="flex items-center gap-4">
          <span className="text-lg font-black text-on-surface font-headline">用戶身份管理</span>
          <span className="text-xs text-on-surface-variant font-mono">共 {total} 個已註冊身份</span>
        </div>
        <div className="flex items-center gap-3">
          <button className="flex items-center gap-2 px-4 py-2 bg-surface-container text-on-surface-variant text-xs font-bold uppercase tracking-wider hover:bg-surface-container-high transition-colors cursor-pointer">
            <span className="material-symbols-outlined text-sm">download</span>
            匯出 CSV
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
                placeholder="搜尋 Email、用戶 ID..."
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </form>
            <select
              className="bg-surface-container-highest border-none text-sm text-on-surface py-2.5 px-4 rounded cursor-pointer focus:ring-1 focus:ring-primary/40"
              value={statusFilter}
              onChange={e => { setStatusFilter(e.target.value); setPage(1); }}
            >
              <option value="">全部狀態</option>
              <option value="active">啟用</option>
              <option value="suspended">已停用</option>
            </select>
          </div>

          {/* Table */}
          <div className="flex-1 overflow-y-auto">
            <table className="w-full">
              <thead className="sticky top-0 bg-surface-container-lowest">
                <tr className="text-left text-[10px] uppercase tracking-widest text-on-surface-variant">
                  <th className="py-3 px-4 font-bold">用戶身份</th>
                  <th className="py-3 px-4 font-bold">Email</th>
                  <th className="py-3 px-4 font-bold">註冊日期</th>
                  <th className="py-3 px-4 font-bold">狀態</th>
                  <th className="py-3 px-4 font-bold text-right">Tokens</th>
                  <th className="py-3 px-4 font-bold text-right">檔案</th>
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
                        <div className="w-8 h-8 rounded bg-surface-container-highest flex items-center justify-center text-xs font-bold text-primary">
                          {(user.display_name || user.email)[0].toUpperCase()}
                        </div>
                        <span className="text-[10px] text-on-surface-variant font-mono">{user.id.slice(0, 8)}</span>
                      </div>
                    </td>
                    <td className="py-3 px-4 text-sm text-on-surface">{user.email}</td>
                    <td className="py-3 px-4 text-xs text-on-surface-variant font-mono">
                      {new Date(user.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}
                    </td>
                    <td className="py-3 px-4">
                      <span className={`px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded ${
                        user.status === 'active'
                          ? 'bg-success/15 text-success'
                          : 'bg-error/15 text-error'
                      }`}>
                        {user.status}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right text-sm text-on-surface font-mono">{formatTokens(user.total_tokens)}</td>
                    <td className="py-3 px-4 text-right text-sm text-on-surface-variant">{user.file_count}</td>
                  </tr>
                ))}
                {users.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-12 text-center text-on-surface-variant">未找到用戶</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between pt-4 border-t border-outline-variant/10 mt-4">
              <span className="text-xs text-on-surface-variant">
                第 {(page - 1) * limit + 1}-{Math.min(page * limit, total)} 筆，共 {total} 個身份
              </span>
              <div className="flex gap-1">
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="px-3 py-1.5 text-xs bg-surface-container text-on-surface-variant rounded disabled:opacity-30 cursor-pointer hover:bg-surface-container-high transition-colors"
                >
                  上一頁
                </button>
                {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => i + 1).map(p => (
                  <button
                    key={p}
                    onClick={() => setPage(p)}
                    className={`px-3 py-1.5 text-xs rounded cursor-pointer transition-colors ${
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
                  className="px-3 py-1.5 text-xs bg-surface-container text-on-surface-variant rounded disabled:opacity-30 cursor-pointer hover:bg-surface-container-high transition-colors"
                >
                  下一頁
                </button>
              </div>
            </div>
          )}
        </div>

        {/* User Detail Sidebar */}
        {selectedUser && (
          <div className="w-80 bg-surface-container-low border-l border-outline-variant/10 flex flex-col overflow-y-auto">
            {/* Header */}
            <div className="p-6 border-b border-outline-variant/10">
              <div className="flex items-center justify-between mb-4">
                <div className="w-12 h-12 rounded bg-surface-container-highest flex items-center justify-center text-lg font-bold text-primary">
                  {(selectedUser.display_name || selectedUser.email)[0].toUpperCase()}
                </div>
                <button
                  onClick={() => setSelectedUser(null)}
                  className="w-8 h-8 flex items-center justify-center rounded hover:bg-surface-container-high transition-colors bg-transparent cursor-pointer"
                >
                  <span className="material-symbols-outlined text-on-surface-variant text-sm">close</span>
                </button>
              </div>
              <h3 className="text-sm font-bold text-on-surface">{selectedUser.display_name || selectedUser.email}</h3>
              <p className="text-xs text-on-surface-variant font-mono mt-1">{selectedUser.id.slice(0, 8)}</p>
              <p className="text-xs text-on-surface-variant mt-1">{selectedUser.email}</p>

              <div className="flex items-center gap-2 mt-3">
                <span className={`px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded ${
                  selectedUser.status === 'active' ? 'bg-success/15 text-success' : 'bg-error/15 text-error'
                }`}>
                  {selectedUser.status}
                </span>
                <span className="text-[10px] text-on-surface-variant">
                  註冊於 {new Date(selectedUser.created_at).toLocaleDateString('zh-TW')}
                </span>
              </div>
            </div>

            {/* Token Stats */}
            <div className="p-6 border-b border-outline-variant/10">
              <h4 className="text-[10px] uppercase tracking-widest text-on-surface-variant font-bold mb-3">Token 用量</h4>
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-surface-container p-3 rounded">
                  <p className="text-[9px] uppercase text-on-surface-variant">輸入</p>
                  <p className="text-lg font-bold text-on-surface font-headline">{formatTokens(selectedUser.tokenStats.total_input)}</p>
                </div>
                <div className="bg-surface-container p-3 rounded">
                  <p className="text-[9px] uppercase text-on-surface-variant">輸出</p>
                  <p className="text-lg font-bold text-on-surface font-headline">{formatTokens(selectedUser.tokenStats.total_output)}</p>
                </div>
              </div>
              <p className="text-xs text-on-surface-variant mt-2">{selectedUser.tokenStats.invocation_count} 次調用</p>
            </div>

            {/* Recent Files */}
            <div className="p-6 border-b border-outline-variant/10">
              <h4 className="text-[10px] uppercase tracking-widest text-on-surface-variant font-bold mb-3">最近檔案</h4>
              {selectedUser.recentFiles.length === 0 ? (
                <p className="text-xs text-on-surface-variant">尚無檔案</p>
              ) : (
                <div className="space-y-2">
                  {selectedUser.recentFiles.map(f => (
                    <div key={f.id} className="flex items-center gap-2 text-xs">
                      <span className="material-symbols-outlined text-sm text-on-surface-variant">draft</span>
                      <span className="flex-1 text-on-surface truncate">{f.filename}</span>
                      <span className="text-[10px] text-on-surface-variant">{formatFileSize(f.file_size)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Admin Controls */}
            <div className="p-6 space-y-2">
              <h4 className="text-[10px] uppercase tracking-widest text-on-surface-variant font-bold mb-3">管理操作</h4>
              {selectedUser.status === 'active' ? (
                <button
                  onClick={() => toggleUserStatus(selectedUser.id, 'suspended')}
                  disabled={actionLoading}
                  className="w-full py-2 px-4 bg-error/10 text-error text-xs font-bold uppercase tracking-wider rounded hover:bg-error/20 transition-colors cursor-pointer disabled:opacity-50"
                >
                  停用用戶
                </button>
              ) : (
                <button
                  onClick={() => toggleUserStatus(selectedUser.id, 'active')}
                  disabled={actionLoading}
                  className="w-full py-2 px-4 bg-success/10 text-success text-xs font-bold uppercase tracking-wider rounded hover:bg-success/20 transition-colors cursor-pointer disabled:opacity-50"
                >
                  啟用用戶
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
