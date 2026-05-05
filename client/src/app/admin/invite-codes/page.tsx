'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAdminAuth } from '../components/AdminAuthProvider';
import { useTranslation } from '../../../i18n';

interface InviteCode {
  id: string;
  code: string;
  label: string;
  is_active: number;
  used_count: number;
  created_at: string;
}

export default function AdminInviteCodes() {
  return <InviteCodesContent />;
}

function InviteCodesContent() {
  const { token, isReadonly } = useAdminAuth();
  const { t } = useTranslation();
  const [codes, setCodes] = useState<InviteCode[]>([]);
  const [loading, setLoading] = useState(true);

  // Modal state
  const [showForm, setShowForm] = useState(false);
  const [editTarget, setEditTarget] = useState<InviteCode | null>(null);
  const [formCode, setFormCode] = useState('');
  const [formLabel, setFormLabel] = useState('');
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  // Delete modal
  const [deleteTarget, setDeleteTarget] = useState<InviteCode | null>(null);

  const fetchCodes = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/invite-codes', { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setCodes(await res.json());
    } catch { /* */ }
    setLoading(false);
  }, [token]);

  useEffect(() => { fetchCodes(); }, [fetchCodes]);

  function openCreate() {
    setEditTarget(null);
    setFormCode('');
    setFormLabel('');
    setFormError('');
    setShowForm(true);
  }

  function openEdit(c: InviteCode) {
    setEditTarget(c);
    setFormCode(c.code);
    setFormLabel(c.label);
    setFormError('');
    setShowForm(true);
  }

  async function handleSave() {
    if (!formCode.trim() || !formLabel.trim()) { setFormError(t('admin.inviteCodes.errorRequired' as any)); return; }
    setSaving(true);
    setFormError('');
    try {
      if (editTarget) {
        const res = await fetch(`/api/admin/invite-codes/${editTarget.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ label: formLabel.trim() }),
        });
        if (!res.ok) { const d = await res.json(); setFormError(d.error || 'Error'); setSaving(false); return; }
      } else {
        const res = await fetch('/api/admin/invite-codes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ code: formCode.trim(), label: formLabel.trim() }),
        });
        if (!res.ok) { const d = await res.json(); setFormError(d.error || 'Error'); setSaving(false); return; }
      }
      setShowForm(false);
      fetchCodes();
    } catch { setFormError('Network error'); }
    setSaving(false);
  }

  async function handleToggle(c: InviteCode) {
    await fetch(`/api/admin/invite-codes/${c.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ is_active: c.is_active ? 0 : 1 }),
    });
    fetchCodes();
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    await fetch(`/api/admin/invite-codes/${deleteTarget.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    setDeleteTarget(null);
    fetchCodes();
  }

  return (
    <>
      <header className="sticky top-0 z-30 bg-surface-dim/95 backdrop-blur-sm border-b border-outline-variant/10 px-4 md:px-8 py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <span className="material-symbols-outlined text-primary" style={{ fontSize: 22 }}>card_membership</span>
          <h1 className="font-headline text-lg md:text-xl font-bold tracking-tight truncate">{t('admin.inviteCodes.title' as any)}</h1>
        </div>
        {!isReadonly && (
          <button
            onClick={openCreate}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold bg-primary text-on-primary rounded-lg hover:brightness-110 transition-all cursor-pointer shrink-0"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add</span>
            {t('admin.inviteCodes.create' as any)}
          </button>
        )}
      </header>

      <div className="flex-1 p-4 md:p-8 space-y-4 md:space-y-6 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <span className="material-symbols-outlined animate-spin text-primary text-3xl">progress_activity</span>
          </div>
        ) : codes.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-on-surface-variant">
            <span className="material-symbols-outlined text-5xl mb-3 opacity-30">card_membership</span>
            <p className="text-sm">{t('admin.inviteCodes.empty' as any)}</p>
          </div>
        ) : (
          <div className="grid gap-2 md:gap-3">
            {codes.map(c => (
              <div
                key={c.id}
                className="bg-surface-container rounded-xl px-3 py-2.5 md:px-5 md:py-4 flex items-center gap-2 md:gap-4"
              >
                {/* Code + Label + Stats */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm md:text-base font-bold text-on-surface tracking-wider truncate">{c.code}</span>
                    <span className={`text-[10px] uppercase tracking-widest font-bold px-1.5 py-0.5 rounded-full shrink-0 ${c.is_active ? 'bg-green-500/15 text-green-600' : 'bg-red-500/15 text-red-500'}`}>
                      {c.is_active ? t('admin.inviteCodes.active' as any) : t('admin.inviteCodes.inactive' as any)}
                    </span>
                  </div>
                  <p className="text-xs md:text-sm text-on-surface-variant truncate mt-0.5">{c.label}</p>
                  <div className="flex items-center gap-3 mt-1 text-[11px] text-outline">
                    <span>{c.used_count} {t('admin.inviteCodes.used' as any)}</span>
                    <span>{new Date(c.created_at).toLocaleDateString()}</span>
                  </div>
                </div>

                {/* Actions — compact row */}
                {!isReadonly && (
                  <div className="flex items-center shrink-0">
                    <button
                      onClick={() => handleToggle(c)}
                      className={`p-2 rounded-lg transition-colors cursor-pointer ${c.is_active ? 'hover:bg-amber-500/10 text-amber-600' : 'hover:bg-green-500/10 text-green-600'}`}
                      title={c.is_active ? t('admin.inviteCodes.deactivate' as any) : t('admin.inviteCodes.activate' as any)}
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 22 }}>
                        {c.is_active ? 'toggle_on' : 'toggle_off'}
                      </span>
                    </button>
                    <button
                      onClick={() => openEdit(c)}
                      className="p-2 rounded-lg hover:bg-surface-container-high text-on-surface-variant transition-colors cursor-pointer"
                      title={t('admin.inviteCodes.edit' as any)}
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 22 }}>edit</span>
                    </button>
                    <button
                      onClick={() => setDeleteTarget(c)}
                      className="p-2 rounded-lg hover:bg-error/10 text-error transition-colors cursor-pointer"
                      title={t('admin.inviteCodes.delete' as any)}
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 22 }}>delete</span>
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Create / Edit Modal */}
      {showForm && (
        <div className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-surface rounded-2xl shadow-2xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
            <h3 className="font-headline text-lg font-bold mb-4">
              {editTarget ? t('admin.inviteCodes.editTitle' as any) : t('admin.inviteCodes.createTitle' as any)}
            </h3>

            {formError && (
              <div className="bg-error-container/30 border border-error/20 text-on-error-container px-3 py-2 rounded text-sm mb-4">{formError}</div>
            )}

            <div className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-sm font-bold text-on-surface-variant">{t('admin.inviteCodes.codeLabel' as any)}</label>
                <input
                  className="w-full bg-surface-container-highest border-none focus:ring-1 focus:ring-primary/40 text-on-surface py-2.5 px-3 text-sm font-mono tracking-wider rounded placeholder:text-outline placeholder:font-body placeholder:tracking-normal"
                  value={formCode}
                  onChange={e => setFormCode(e.target.value.toUpperCase())}
                  placeholder="VIP2024"
                  maxLength={50}
                  disabled={!!editTarget}
                  autoFocus={!editTarget}
                />
                {editTarget && <p className="text-xs text-on-surface-variant">{t('admin.inviteCodes.codeReadonly' as any)}</p>}
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-bold text-on-surface-variant">{t('admin.inviteCodes.labelLabel' as any)}</label>
                <input
                  className="w-full bg-surface-container-highest border-none focus:ring-1 focus:ring-primary/40 text-on-surface py-2.5 px-3 text-sm rounded placeholder:text-outline"
                  value={formLabel}
                  onChange={e => setFormLabel(e.target.value)}
                  placeholder={t('admin.inviteCodes.labelPlaceholder' as any)}
                  maxLength={100}
                  autoFocus={!!editTarget}
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <button
                onClick={() => setShowForm(false)}
                className="px-4 py-2 text-sm font-bold text-on-surface-variant hover:bg-surface-container rounded-lg cursor-pointer transition-colors"
              >
                {t('admin.inviteCodes.cancel' as any)}
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-4 py-2 text-sm font-bold bg-primary text-on-primary rounded-lg hover:brightness-110 disabled:opacity-50 cursor-pointer transition-all"
              >
                {saving ? '...' : editTarget ? t('admin.inviteCodes.save' as any) : t('admin.inviteCodes.create' as any)}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation */}
      {deleteTarget && (
        <div className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setDeleteTarget(null)}>
          <div className="bg-surface rounded-2xl shadow-2xl w-full max-w-sm p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-error/10 flex items-center justify-center rounded-full">
                <span className="material-symbols-outlined text-error">warning</span>
              </div>
              <h3 className="font-headline text-lg font-bold">{t('admin.inviteCodes.confirmDelete' as any)}</h3>
            </div>
            <p className="text-sm text-on-surface-variant mb-1">
              {t('admin.inviteCodes.deleteMessage' as any)}
            </p>
            <p className="text-sm font-mono font-bold text-on-surface mb-6">{deleteTarget.code}</p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeleteTarget(null)}
                className="px-4 py-2 text-sm font-bold text-on-surface-variant hover:bg-surface-container rounded-lg cursor-pointer transition-colors"
              >
                {t('admin.inviteCodes.cancel' as any)}
              </button>
              <button
                onClick={handleDelete}
                className="px-4 py-2 text-sm font-bold bg-error text-on-error rounded-lg hover:brightness-110 cursor-pointer transition-all"
              >
                {t('admin.inviteCodes.delete' as any)}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
