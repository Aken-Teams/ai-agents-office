'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAdminAuth } from '../components/AdminAuthProvider';
import { useTranslation } from '../../../i18n';

interface Announcement {
  id: string;
  title: string;
  content: string;
  created_by: string;
  author_name: string | null;
  active_days: number;
  is_active: number;
  created_at: string;
  updated_at: string;
}

function getStatus(a: Announcement): 'active' | 'expired' | 'disabled' {
  if (!a.is_active) return 'disabled';
  const createdAt = new Date(a.created_at).getTime();
  const expiresAt = createdAt + a.active_days * 86400000;
  return Date.now() < expiresAt ? 'active' : 'expired';
}

export default function AdminAnnouncements() {
  return <AnnouncementsContent />;
}

function AnnouncementsContent() {
  const { token } = useAdminAuth();
  const { t } = useTranslation();
  const [items, setItems] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({ title: '', content: '', active_days: '2' });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const fetchList = useCallback(() => {
    if (!token) return;
    fetch('/api/admin/announcements', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(data => { setItems(data); setLoading(false); })
      .catch(console.error);
  }, [token]);

  useEffect(() => { fetchList(); }, [fetchList]);

  function openCreate() {
    setEditId(null);
    setForm({ title: '', content: '', active_days: '2' });
    setShowForm(true);
  }

  function openEdit(a: Announcement) {
    setEditId(a.id);
    setForm({ title: a.title, content: a.content, active_days: String(a.active_days) });
    setShowForm(true);
  }

  async function handleSave() {
    if (!token || saving || !form.title.trim() || !form.content.trim()) return;
    setSaving(true);
    try {
      const body = { title: form.title, content: form.content, active_days: parseInt(form.active_days) || 2 };
      if (editId) {
        await fetch(`/api/admin/announcements/${editId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });
      } else {
        await fetch('/api/admin/announcements', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });
      }
      setShowForm(false);
      fetchList();
    } finally { setSaving(false); }
  }

  async function toggleActive(a: Announcement) {
    if (!token) return;
    await fetch(`/api/admin/announcements/${a.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ is_active: !a.is_active }),
    });
    fetchList();
  }

  async function handleDelete(id: string) {
    if (!token) return;
    setDeleting(id);
    await fetch(`/api/admin/announcements/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    setDeleting(null);
    fetchList();
  }

  const statusColors = {
    active: 'bg-success/15 text-success',
    expired: 'bg-on-surface-variant/10 text-on-surface-variant',
    disabled: 'bg-error/15 text-error',
  };

  return (
    <>
      {/* Header */}
      <header className="sticky top-0 h-14 md:h-16 bg-surface/80 backdrop-blur-xl flex justify-between items-center px-4 md:px-8 z-40 shadow-[0_1px_0_0_rgba(255,255,255,0.05)]">
        <div className="flex items-center gap-2 md:gap-4 min-w-0">
          <span className="text-base md:text-lg font-black text-on-surface font-headline shrink-0">{t('admin.announcements.title' as any)}</span>
          <span className="hidden md:inline text-sm text-on-surface-variant font-mono truncate">{t('admin.announcements.description' as any)}</span>
        </div>
        <button
          onClick={openCreate}
          className="flex items-center gap-1.5 ml-3 px-3 md:px-4 py-2 md:py-2.5 cyber-gradient rounded-xl text-on-primary text-xs md:text-sm font-headline font-bold hover:brightness-110 active:scale-95 transition-all cursor-pointer shrink-0"
        >
          <span className="material-symbols-outlined text-lg">add</span>
          <span className="hidden sm:inline">{t('admin.announcements.create' as any)}</span>
        </button>
      </header>

      <div className="p-4 md:p-8 flex-1 space-y-4 md:space-y-6 flex flex-col">

      {/* Modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center" onClick={() => setShowForm(false)}>
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
          <div
            className="relative bg-surface-container rounded-t-2xl md:rounded-2xl p-5 md:p-7 border border-outline-variant/20 shadow-2xl w-full md:w-[90vw] md:max-w-lg animate-[slideUp_0.25s_ease-out] md:animate-in"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-base font-headline font-bold text-on-surface">
                {editId ? t('admin.announcements.edit' as any) : t('admin.announcements.create' as any)}
              </h3>
              <button
                onClick={() => setShowForm(false)}
                className="w-8 h-8 flex items-center justify-center rounded-lg text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-colors cursor-pointer"
              >
                <span className="material-symbols-outlined text-lg">close</span>
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="text-xs font-bold text-on-surface-variant mb-1.5 block">{t('admin.announcements.titleLabel' as any)}</label>
                <input
                  className="w-full bg-surface-container-highest rounded-lg px-3 py-2.5 text-sm text-on-surface border border-outline-variant/20 focus:border-primary/40 focus:ring-1 focus:ring-primary/20 outline-none"
                  value={form.title}
                  onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                  placeholder={t('admin.announcements.titlePlaceholder' as any)}
                  autoFocus
                />
              </div>
              <div>
                <label className="text-xs font-bold text-on-surface-variant mb-1.5 block">{t('admin.announcements.contentLabel' as any)}</label>
                <textarea
                  className="w-full bg-surface-container-highest rounded-lg px-3 py-2.5 text-sm text-on-surface border border-outline-variant/20 focus:border-primary/40 focus:ring-1 focus:ring-primary/20 outline-none resize-none min-h-[100px]"
                  value={form.content}
                  onChange={e => setForm(f => ({ ...f, content: e.target.value }))}
                  placeholder={t('admin.announcements.contentPlaceholder' as any)}
                />
              </div>
              <div className="flex items-center gap-3">
                <label className="text-xs font-bold text-on-surface-variant">{t('admin.announcements.activeDays' as any)}</label>
                <input
                  type="text"
                  inputMode="numeric"
                  className="w-16 bg-surface-container-highest rounded-lg px-3 py-2.5 text-sm text-on-surface text-center border border-outline-variant/20 focus:border-primary/40 outline-none"
                  value={form.active_days}
                  onChange={e => { const v = e.target.value.replace(/\D/g, ''); setForm(f => ({ ...f, active_days: v })); }}
                />
                <span className="text-xs text-on-surface-variant">{t('admin.announcements.daysUnit' as any)}</span>
              </div>
            </div>
            <div className="flex gap-2 mt-6 justify-end">
              <button
                onClick={() => setShowForm(false)}
                className="px-5 py-2.5 bg-surface-container-high rounded-lg text-sm text-on-surface-variant hover:text-on-surface transition-colors cursor-pointer"
              >
                {t('admin.announcements.cancel' as any)}
              </button>
              <button
                onClick={handleSave}
                disabled={saving || !form.title.trim() || !form.content.trim()}
                className="px-5 py-2.5 cyber-gradient rounded-lg text-on-primary text-sm font-bold disabled:opacity-50 hover:brightness-110 active:scale-95 transition-all cursor-pointer"
              >
                {saving ? t('admin.announcements.saving' as any) : t('admin.announcements.save' as any)}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* List */}
      {loading ? (
        <div className="flex items-center justify-center py-16 text-on-surface-variant">
          <span className="material-symbols-outlined animate-spin mr-2">progress_activity</span>
          Loading...
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-16 text-on-surface-variant">
          <span className="material-symbols-outlined text-4xl mb-2 block">campaign</span>
          <p className="text-sm">{t('admin.announcements.empty' as any)}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {items.map(a => {
            const status = getStatus(a);
            return (
              <div key={a.id} className="bg-surface-container rounded-lg p-3.5 md:p-4 border border-outline-variant/10 hover:border-outline-variant/20 transition-colors">
                {/* Title + Status */}
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="text-sm font-headline font-bold text-on-surface truncate">{a.title}</h3>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 ${statusColors[status]}`}>
                    {t(`admin.announcements.status.${status}` as any)}
                  </span>
                </div>
                {/* Content */}
                <p className="text-xs text-on-surface-variant line-clamp-2 mb-2">{a.content}</p>
                {/* Meta + Actions */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 md:gap-3 text-[11px] text-on-surface-variant/70 min-w-0">
                    <span className="truncate">{a.author_name || '—'}</span>
                    <span>·</span>
                    <span className="shrink-0">{new Date(a.created_at).toLocaleDateString()}</span>
                    <span>·</span>
                    <span className="shrink-0">{a.active_days} {t('admin.announcements.daysUnit' as any)}</span>
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0 ml-2">
                    <button
                      onClick={() => toggleActive(a)}
                      className={`w-9 h-9 flex items-center justify-center rounded-lg hover:bg-surface-container-high transition-colors cursor-pointer ${a.is_active ? 'text-success' : 'text-on-surface-variant/50'}`}
                      title={a.is_active ? 'Disable' : 'Enable'}
                    >
                      <span className="material-symbols-outlined text-2xl">
                        {a.is_active ? 'toggle_on' : 'toggle_off'}
                      </span>
                    </button>
                    <button
                      onClick={() => openEdit(a)}
                      className="w-8 h-8 flex items-center justify-center rounded-lg text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-colors cursor-pointer"
                    >
                      <span className="material-symbols-outlined text-lg">edit</span>
                    </button>
                    <button
                      onClick={() => { if (confirm(t('admin.announcements.deleteConfirm' as any))) handleDelete(a.id); }}
                      disabled={deleting === a.id}
                      className="w-8 h-8 flex items-center justify-center rounded-lg text-on-surface-variant hover:bg-error/10 hover:text-error transition-colors cursor-pointer disabled:opacity-50"
                    >
                      <span className="material-symbols-outlined text-lg">delete</span>
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      </div>
    </>
  );
}
