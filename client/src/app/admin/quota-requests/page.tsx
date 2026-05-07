'use client';

import { useState, useEffect, useCallback } from 'react';
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

export default function AdminQuotaRequests() {
  return <QuotaRequestsContent />;
}

function QuotaRequestsContent() {
  const { token, isReadonly } = useAdminAuth();
  const { t } = useTranslation();
  const [requests, setRequests] = useState<QuotaRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'pending' | 'all'>('pending');

  // Approve modal
  const [approveTarget, setApproveTarget] = useState<QuotaRequest | null>(null);
  const [approveLimit, setApproveLimit] = useState('');
  const [approveNotes, setApproveNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

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

  async function handleApprove() {
    if (!token || !approveTarget || submitting) return;
    const limitVal = parseFloat(approveLimit);
    if (isNaN(limitVal) || limitVal <= 0) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/admin/quota-requests/${approveTarget.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'approve', new_limit: limitVal, admin_notes: approveNotes.trim() || undefined }),
      });
      if (res.ok) {
        setApproveTarget(null);
        setApproveLimit('');
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
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-headline font-bold text-on-surface">{t('admin.quotaRequests.title' as any)}</h1>
        <p className="text-sm text-on-surface-variant mt-1">{t('admin.quotaRequests.description' as any)}</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-2">
        {(['pending', 'all'] as const).map(tabKey => (
          <button
            key={tabKey}
            onClick={() => setTab(tabKey)}
            className={`px-4 py-2 rounded-lg text-sm font-bold transition-colors cursor-pointer ${
              tab === tabKey
                ? 'bg-primary/10 text-primary'
                : 'text-on-surface-variant hover:bg-surface-container'
            }`}
          >
            {t(`admin.quotaRequests.tab.${tabKey}` as any)}
          </button>
        ))}
      </div>

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
                {req.status === 'pending' && !isReadonly && (
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => { setApproveTarget(req); setApproveLimit(String(Math.ceil(req.current_limit * 1.5))); }}
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
              <label className="block text-sm font-bold text-on-surface mb-1">{t('admin.quotaRequests.approveModal.newLimit' as any)}</label>
              <div className="flex items-center gap-2">
                <span className="text-on-surface-variant font-bold">$</span>
                <input
                  type="number"
                  value={approveLimit}
                  onChange={e => setApproveLimit(e.target.value)}
                  className="flex-1 bg-surface-container border border-outline-variant/20 focus:border-primary rounded-lg px-3 py-2 text-sm text-on-surface"
                  min={1}
                />
              </div>
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
                disabled={!approveLimit || parseFloat(approveLimit) <= 0 || submitting}
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
  );
}
