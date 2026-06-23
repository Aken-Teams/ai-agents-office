'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useAdminAuth } from '../components/AdminAuthProvider';
import { useTranslation } from '../../../i18n';

interface QuotaRequest {
  id: string;
  user_id: string;
  email: string;
  display_name: string | null;
  current_limit: number;
  current_cost: number;
  reason: string;
  status: 'pending' | 'approved' | 'denied';
  new_limit: number | null;
  admin_notes: string | null;
  created_at: string;
  reviewed_at: string | null;
}

interface QuotaGroup {
  id: string;
  name: string;
  limit_usd: number;
}

export default function AdminQuotaRequests() {
  return <QuotaRequestsContent />;
}

function QuotaRequestsContent() {
  const { token, isReadonly, canOperate } = useAdminAuth();
  const canEdit = !isReadonly || canOperate('quota-requests');
  const { t } = useTranslation();
  const [requests, setRequests] = useState<QuotaRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'pending' | 'all'>('pending');

  // Approve modal — approve by assigning the user to a quota group
  const [approveTarget, setApproveTarget] = useState<QuotaRequest | null>(null);
  const [approveGroupId, setApproveGroupId] = useState('');
  const [approveNotes, setApproveNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [groups, setGroups] = useState<QuotaGroup[]>([]);
  // Searchable group dropdown
  const [groupOpen, setGroupOpen] = useState(false);
  const [groupSearch, setGroupSearch] = useState('');
  const groupBoxRef = useRef<HTMLDivElement>(null);

  // Deny modal
  const [denyTarget, setDenyTarget] = useState<QuotaRequest | null>(null);
  const [denyReason, setDenyReason] = useState('');

  const fetchRequests = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const statusParam = tab === 'pending' ? '?status=pending' : '';
      const res = await fetch(`/api/admin/quota-requests${statusParam}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setRequests(await res.json());
    } finally {
      setLoading(false);
    }
  }, [token, tab]);

  useEffect(() => { fetchRequests(); }, [fetchRequests]);

  // Load quota groups for the approve selector
  useEffect(() => {
    if (!token) return;
    fetch('/api/admin/quota-groups', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : [])
      .then((data: QuotaGroup[]) => setGroups((data || []).slice().sort((a, b) => a.limit_usd - b.limit_usd)))
      .catch(() => { /* ignore */ });
  }, [token]);

  // Close the group dropdown when clicking outside it
  useEffect(() => {
    if (!groupOpen) return;
    const onDown = (e: MouseEvent) => {
      if (groupBoxRef.current && !groupBoxRef.current.contains(e.target as Node)) setGroupOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [groupOpen]);

  async function handleApprove() {
    if (!token || !approveTarget || submitting || !approveGroupId) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/admin/quota-requests/${approveTarget.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'approve', group_id: approveGroupId, admin_notes: approveNotes.trim() || undefined }),
      });
      if (res.ok) {
        setApproveTarget(null);
        setApproveGroupId('');
        setApproveNotes('');
        fetchRequests();
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDeny() {
    if (!token || !denyTarget || submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/admin/quota-requests/${denyTarget.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'deny', admin_notes: denyReason.trim() || undefined }),
      });
      if (res.ok) {
        setDenyTarget(null);
        setDenyReason('');
        fetchRequests();
      }
    } finally {
      setSubmitting(false);
    }
  }

  function formatDate(d: string) {
    return new Date(d).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  const statusColor = (s: string) => {
    if (s === 'pending') return 'text-warning bg-warning/10';
    if (s === 'approved') return 'text-success bg-success/10';
    return 'text-error bg-error/10';
  };

  return (
    <>
      {/* Sticky Header */}
      <header className="sticky top-0 h-14 md:h-16 bg-surface/80 backdrop-blur-xl flex justify-between items-center px-4 md:px-8 z-40 shadow-[0_1px_0_0_rgba(255,255,255,0.05)]">
        <div className="flex items-center gap-2 md:gap-4 min-w-0">
          <span className="material-symbols-outlined text-primary text-xl md:text-2xl">request_quote</span>
          <div className="min-w-0">
            <h1 className="text-base md:text-xl font-headline font-bold text-on-surface truncate">{t('admin.quotaRequests.title' as any)}</h1>
            <p className="text-xs text-on-surface-variant hidden md:block">{t('admin.quotaRequests.description' as any)}</p>
          </div>
        </div>
        <div className="flex gap-1.5">
          {(['pending', 'all'] as const).map(tabKey => (
            <button
              key={tabKey}
              onClick={() => setTab(tabKey)}
              className={`px-3 md:px-4 py-1.5 md:py-2 rounded-lg text-xs md:text-sm font-bold transition-colors cursor-pointer ${
                tab === tabKey
                  ? 'bg-primary/10 text-primary'
                  : 'text-on-surface-variant hover:bg-surface-container'
              }`}
            >
              {t(`admin.quotaRequests.tab.${tabKey}` as any)}
            </button>
          ))}
        </div>
      </header>

      <div className="flex-1 p-4 md:p-8 space-y-4 md:space-y-6 overflow-y-auto">
      {/* List */}
      {loading ? (
        <div className="text-center py-12 text-on-surface-variant">{t('common.loading')}</div>
      ) : requests.length === 0 ? (
        <div className="text-center py-12 text-on-surface-variant">
          <span className="material-symbols-outlined text-4xl mb-2 block">inbox</span>
          <p>{t('admin.quotaRequests.empty' as any)}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {requests.map(req => (
            <div key={req.id} className="bg-surface-container rounded-xl p-4 border border-outline-variant/10">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-on-surface">{req.display_name || req.email}</span>
                    {req.display_name && <span className="text-xs text-on-surface-variant">{req.email}</span>}
                    <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${statusColor(req.status)}`}>
                      {t(`quotaRequest.status.${req.status}` as any)}
                    </span>
                  </div>
                  <div className="flex items-center gap-4 mt-1.5 text-xs text-on-surface-variant">
                    <span>{t('admin.quotaRequests.currentQuota' as any)}: ${req.current_limit.toFixed(0)}</span>
                    <span>{t('admin.quotaRequests.usedQuota' as any)}: ${req.current_cost.toFixed(2)}</span>
                    <span>{formatDate(req.created_at)}</span>
                  </div>
                  <p className="mt-2 text-sm text-on-surface bg-surface-container-high rounded-lg p-3">{req.reason}</p>
                  {req.status !== 'pending' && (
                    <div className="mt-2 text-xs text-on-surface-variant flex items-center gap-3">
                      {req.status === 'approved' && req.new_limit != null && (
                        <span className="text-success font-bold">{t('quotaRequest.newLimit' as any)}: ${req.new_limit.toFixed(0)}</span>
                      )}
                      {req.admin_notes && (
                        <span>{t('quotaRequest.adminNotes' as any)}: {req.admin_notes}</span>
                      )}
                      {req.reviewed_at && (
                        <span>{t('admin.quotaRequests.reviewed' as any)}: {formatDate(req.reviewed_at)}</span>
                      )}
                    </div>
                  )}
                </div>
                {req.status === 'pending' && canEdit && (
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => { setApproveTarget(req); setApproveGroupId(''); setApproveNotes(''); setGroupOpen(false); setGroupSearch(''); }}
                      className="px-3 py-1.5 text-xs font-bold bg-success/10 text-success hover:bg-success/20 rounded-lg transition-colors cursor-pointer"
                    >
                      {t('admin.quotaRequests.approve' as any)}
                    </button>
                    <button
                      onClick={() => setDenyTarget(req)}
                      className="px-3 py-1.5 text-xs font-bold bg-error/10 text-error hover:bg-error/20 rounded-lg transition-colors cursor-pointer"
                    >
                      {t('admin.quotaRequests.deny' as any)}
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Approve Modal */}
      {approveTarget && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => setApproveTarget(null)}>
          <div className="bg-surface-container-lowest rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-headline font-bold text-on-surface mb-1">{t('admin.quotaRequests.approveModal.title' as any)}</h3>
            <p className="text-sm text-on-surface-variant mb-4">
              {approveTarget.display_name || approveTarget.email} — {t('admin.quotaRequests.currentQuota' as any)}: ${approveTarget.current_limit.toFixed(0)}
            </p>

            <div className="mb-3">
              <label className="block text-sm font-bold text-on-surface mb-2">指派額度群組</label>
              {groups.length > 0 ? (
                <div ref={groupBoxRef} className="relative">
                  {(() => {
                    const selected = groups.find(g => g.id === approveGroupId);
                    return (
                      <button
                        type="button"
                        onClick={() => setGroupOpen(o => !o)}
                        className="w-full flex items-center justify-between gap-2 bg-surface-container border border-outline-variant/20 hover:border-success/40 rounded-lg px-3 py-2 text-sm text-on-surface cursor-pointer transition-colors"
                      >
                        <span className={selected ? 'font-medium' : 'text-on-surface-variant'}>
                          {selected ? `${selected.name}（$${selected.limit_usd}）` : '— 請選擇群組 —'}
                        </span>
                        <span className={`material-symbols-outlined text-on-surface-variant text-[20px] transition-transform ${groupOpen ? 'rotate-180' : ''}`}>expand_more</span>
                      </button>
                    );
                  })()}
                  {groupOpen && (
                    <div className="absolute z-10 mt-1 w-full bg-surface-container-lowest border border-outline-variant/20 rounded-lg shadow-xl overflow-hidden">
                      <div className="p-2 border-b border-outline-variant/10">
                        <input
                          value={groupSearch}
                          onChange={e => setGroupSearch(e.target.value)}
                          placeholder="搜尋群組或金額…"
                          autoFocus
                          className="w-full bg-surface-container border border-outline-variant/20 focus:border-primary rounded-md px-2.5 py-1.5 text-sm text-on-surface"
                        />
                      </div>
                      <div className="max-h-48 overflow-y-auto py-1">
                        {(() => {
                          const q = groupSearch.trim().toLowerCase();
                          const filtered = q
                            ? groups.filter(g => g.name.toLowerCase().includes(q) || String(g.limit_usd).includes(q))
                            : groups;
                          if (filtered.length === 0) {
                            return <p className="px-3 py-3 text-xs text-on-surface-variant text-center">找不到符合的群組</p>;
                          }
                          return filtered.map(g => {
                            const sel = approveGroupId === g.id;
                            return (
                              <button
                                key={g.id}
                                type="button"
                                onClick={() => { setApproveGroupId(g.id); setGroupOpen(false); setGroupSearch(''); }}
                                className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-left transition-colors cursor-pointer ${sel ? 'bg-success/10 text-success font-bold' : 'text-on-surface hover:bg-success/5'}`}
                              >
                                <span className="truncate">{g.name}</span>
                                <span className={`shrink-0 tabular-nums ${sel ? 'text-success' : 'text-on-surface-variant'}`}>${g.limit_usd}</span>
                              </button>
                            );
                          });
                        })()}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-xs text-warning bg-warning/10 rounded-lg px-3 py-2">
                  目前沒有額度群組。請先到「額度群組」建立對應額度的群組，再回來核准。
                </p>
              )}
              <p className="text-[11px] text-on-surface-variant/70 mt-1.5">核准後會將此用戶加入該群組，並清除其個人額度覆寫（讓群組生效、方便日後調整）。</p>
            </div>

            <div className="mb-4">
              <label className="block text-sm font-bold text-on-surface mb-1">{t('admin.quotaRequests.approveModal.notes' as any)}</label>
              <textarea
                value={approveNotes}
                onChange={e => setApproveNotes(e.target.value)}
                className="w-full bg-surface-container border border-outline-variant/20 focus:border-primary rounded-lg px-3 py-2 text-sm text-on-surface resize-none"
                rows={2}
              />
            </div>

            <div className="flex gap-3">
              <button onClick={() => setApproveTarget(null)} className="flex-1 py-2.5 rounded-xl text-sm font-bold text-on-surface-variant bg-surface-container hover:bg-surface-container-high transition-colors cursor-pointer">
                {t('common.cancel')}
              </button>
              <button
                onClick={handleApprove}
                disabled={!approveGroupId || submitting}
                className="flex-1 py-2.5 rounded-xl text-sm font-bold text-on-primary bg-success disabled:opacity-40 disabled:cursor-not-allowed transition-all cursor-pointer"
              >
                {t('admin.quotaRequests.approve' as any)}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Deny Modal */}
      {denyTarget && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => setDenyTarget(null)}>
          <div className="bg-surface-container-lowest rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-headline font-bold text-on-surface mb-1">{t('admin.quotaRequests.denyModal.title' as any)}</h3>
            <p className="text-sm text-on-surface-variant mb-4">
              {denyTarget.display_name || denyTarget.email}
            </p>

            <div className="mb-4">
              <label className="block text-sm font-bold text-on-surface mb-1">{t('admin.quotaRequests.denyModal.reason' as any)}</label>
              <textarea
                value={denyReason}
                onChange={e => setDenyReason(e.target.value)}
                className="w-full bg-surface-container border border-outline-variant/20 focus:border-primary rounded-lg px-3 py-2 text-sm text-on-surface resize-none"
                rows={3}
              />
            </div>

            <div className="flex gap-3">
              <button onClick={() => setDenyTarget(null)} className="flex-1 py-2.5 rounded-xl text-sm font-bold text-on-surface-variant bg-surface-container hover:bg-surface-container-high transition-colors cursor-pointer">
                {t('common.cancel')}
              </button>
              <button
                onClick={handleDeny}
                disabled={submitting}
                className="flex-1 py-2.5 rounded-xl text-sm font-bold text-on-primary bg-error disabled:opacity-40 disabled:cursor-not-allowed transition-all cursor-pointer"
              >
                {t('admin.quotaRequests.deny' as any)}
              </button>
            </div>
          </div>
        </div>
      )}
      </div>
    </>
  );
}
