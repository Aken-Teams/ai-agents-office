'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { AuthProvider, useAuth } from '../components/AuthProvider';
import { I18nProvider, useTranslation } from '../../i18n';
import Navbar from '../components/Navbar';
import { useSidebarMargin } from '../hooks/useSidebarCollapsed';

interface Conversation {
  id: string;
  title: string;
  skill_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

const SKILL_META: Record<string, { icon: string; color: string; bgColor: string; label: string }> = {
  'pptx-gen': { icon: 'present_to_all', color: '#FF8A65', bgColor: 'rgba(255,138,101,0.1)', label: 'PPTX' },
  'docx-gen': { icon: 'description', color: '#2196F3', bgColor: 'rgba(33,150,243,0.1)', label: 'DOCX' },
  'xlsx-gen': { icon: 'table_chart', color: '#4CAF50', bgColor: 'rgba(76,175,80,0.1)', label: 'XLSX' },
  'pdf-gen': { icon: 'picture_as_pdf', color: '#FF5252', bgColor: 'rgba(255,82,82,0.1)', label: 'PDF' },
  'data-analyst': { icon: 'analytics', color: '#00dbe9', bgColor: 'rgba(0,219,233,0.1)', label: 'DATA' },
  'research': { icon: 'travel_explore', color: '#8f9097', bgColor: 'rgba(143,144,151,0.1)', label: 'RESEARCH' },
};

const FILTER_TABS = [
  { value: 'all', label: '全部' },
  { value: 'pptx-gen', label: 'PPT' },
  { value: 'docx-gen', label: 'Word' },
  { value: 'xlsx-gen', label: 'Excel' },
  { value: 'pdf-gen', label: 'PDF' },
  { value: 'data-analyst', label: '數據分析' },
  { value: 'research', label: '研究' },
];

const PAGE_SIZE = 12;

/* ============================================================
   Delete Confirmation Modal
   ============================================================ */
function DeleteConfirmModal({
  title, onConfirm, onCancel,
}: {
  title: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter') onConfirm();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onConfirm, onCancel]);

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center" onClick={onCancel}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative bg-surface-container rounded-xl shadow-2xl border border-outline-variant/10 w-full max-w-sm mx-4 overflow-hidden animate-in"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex flex-col items-center pt-8 pb-4 px-6">
          <div className="w-14 h-14 rounded-full bg-error/10 flex items-center justify-center mb-4">
            <span className="material-symbols-outlined text-error text-3xl">delete_forever</span>
          </div>
          <h3 className="font-headline font-bold text-lg text-on-surface mb-2">{t('conversations.deleteModal.title')}</h3>
          <p className="text-sm text-on-surface-variant text-center leading-relaxed">
            {t('conversations.deleteModal.message', { title })}
          </p>
        </div>
        <div className="flex gap-3 p-6 pt-2">
          <button
            onClick={onCancel}
            className="flex-1 py-2.5 px-4 bg-surface-container-highest border border-outline-variant/10 text-on-surface font-bold text-sm uppercase tracking-widest rounded cursor-pointer hover:bg-surface-variant transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 py-2.5 px-4 bg-error text-on-error font-bold text-sm uppercase tracking-widest rounded cursor-pointer hover:bg-error/80 transition-colors"
          >
            {t('common.delete')}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   Rename Modal
   ============================================================ */
function RenameModal({
  currentTitle, onConfirm, onCancel,
}: {
  currentTitle: string;
  onConfirm: (newTitle: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(currentTitle);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.select();
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center" onClick={onCancel}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative bg-surface-container rounded-xl shadow-2xl border border-outline-variant/10 w-full max-w-sm mx-4 overflow-hidden animate-in"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex flex-col pt-8 pb-4 px-6">
          <div className="flex items-center gap-3 mb-5">
            <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
              <span className="material-symbols-outlined text-primary">edit</span>
            </div>
            <h3 className="font-headline font-bold text-lg text-on-surface">{t('conversations.renameModal.title')}</h3>
          </div>
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={e => setValue(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && value.trim()) onConfirm(value.trim()); }}
            className="w-full bg-surface-container-highest border border-outline-variant/20 rounded-lg py-3 px-4 text-sm text-on-surface placeholder:text-outline focus:ring-1 focus:ring-primary/40 focus:border-primary/40 outline-none"
            placeholder={t('conversations.renameModal.placeholder')}
          />
        </div>
        <div className="flex gap-3 p-6 pt-2">
          <button
            onClick={onCancel}
            className="flex-1 py-2.5 px-4 bg-surface-container-highest border border-outline-variant/10 text-on-surface font-bold text-sm uppercase tracking-widest rounded cursor-pointer hover:bg-surface-variant transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={() => value.trim() && onConfirm(value.trim())}
            disabled={!value.trim() || value.trim() === currentTitle}
            className="flex-1 py-2.5 px-4 cyber-gradient text-on-primary font-bold text-sm uppercase tracking-widest rounded cursor-pointer hover:brightness-110 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   Main Content
   ============================================================ */
function ConversationsContent() {
  const { user, token, isLoading } = useAuth();
  const { t } = useTranslation();
  const router = useRouter();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [deleteTarget, setDeleteTarget] = useState<Conversation | null>(null);
  const [renameTarget, setRenameTarget] = useState<Conversation | null>(null);
  const sidebarMargin = useSidebarMargin();

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  const fetchConversations = useCallback(() => {
    if (!token) return;
    fetch('/api/conversations', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(setConversations)
      .catch(console.error);
  }, [token]);

  useEffect(() => { fetchConversations(); }, [fetchConversations]);

  // Reset page on filter/search change
  useEffect(() => { setPage(1); }, [filter, search]);

  async function handleDelete() {
    if (!token || !deleteTarget) return;
    await fetch(`/api/conversations/${deleteTarget.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    setConversations(prev => prev.filter(c => c.id !== deleteTarget.id));
    setDeleteTarget(null);
  }

  async function handleRename(newTitle: string) {
    if (!token || !renameTarget) return;
    await fetch(`/api/conversations/${renameTarget.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: newTitle }),
    });
    setConversations(prev => prev.map(c =>
      c.id === renameTarget.id ? { ...c, title: newTitle } : c
    ));
    setRenameTarget(null);
  }

  if (isLoading || !user) return null;

  const filtered = conversations.filter(c => {
    if (search && !c.title.toLowerCase().includes(search.toLowerCase())) return false;
    if (filter !== 'all') {
      if (filter === 'none') return !c.skill_id;
      return c.skill_id === filter;
    }
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  function getSkillConfig(skillId: string | null) {
    if (!skillId) return { icon: 'smart_toy', color: '#8f9097', bgColor: 'rgba(143,144,151,0.1)', label: 'AUTO' };
    return SKILL_META[skillId] || { icon: 'smart_toy', color: '#8f9097', bgColor: 'rgba(143,144,151,0.1)', label: 'AUTO' };
  }

  return (
    <div className="min-h-screen bg-surface-container-lowest">
      <Navbar />

      {/* Modals */}
      {deleteTarget && (
        <DeleteConfirmModal
          title={deleteTarget.title}
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
      {renameTarget && (
        <RenameModal
          currentTitle={renameTarget.title}
          onConfirm={handleRename}
          onCancel={() => setRenameTarget(null)}
        />
      )}

      <main className={`${sidebarMargin} pt-8 pb-12 px-10 transition-all duration-300`}>
        {/* Header Section — matches /files style */}
        <div className="mb-10">
          <div className="max-w-2xl">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-tertiary text-sm font-bold tracking-[0.3em] uppercase">{t('conversations.header.subtitle')}</span>
              <div className="h-px w-12 bg-tertiary/30" />
            </div>
            <h2 className="text-4xl font-headline font-bold text-on-surface tracking-tight mb-2">{t('conversations.header.title')}</h2>
            <p className="text-on-surface-variant leading-relaxed">
              {t('conversations.header.description')}
            </p>
          </div>
        </div>

        {/* Filter Tabs + Search */}
        <div className="flex items-center justify-between gap-4 mb-8">
          <div className="flex items-center gap-3">
            {FILTER_TABS.map(tab => {
              const count = tab.value === 'all'
                ? conversations.length
                : conversations.filter(c => c.skill_id === tab.value).length;
              if (tab.value !== 'all' && count === 0) return null;
              return (
                <button
                  key={tab.value}
                  onClick={() => setFilter(tab.value)}
                  className={`px-4 py-2 rounded text-sm font-bold tracking-widest uppercase transition-colors cursor-pointer ${
                    filter === tab.value
                      ? 'bg-surface-container text-on-surface border-b-2 border-primary'
                      : 'bg-transparent text-on-surface-variant hover:bg-surface-container'
                  }`}
                >
                  {tab.value === 'all' ? t('conversations.filter.all') : tab.label}
                  <span className="ml-1 text-sm opacity-60">{count}</span>
                </button>
              );
            })}
          </div>
          <div className="relative">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-sm">search</span>
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={t('conversations.search.placeholder')}
              className="pl-9 pr-4 py-2 bg-surface-container border border-outline-variant/20 rounded text-sm text-on-surface placeholder:text-on-surface-variant/40 focus:outline-none focus:border-primary/40 w-64 transition-colors"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface cursor-pointer"
              >
                <span className="material-symbols-outlined text-sm">close</span>
              </button>
            )}
          </div>
        </div>

        {/* Conversations Table */}
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 border border-dashed border-outline-variant/20 rounded-lg">
            <div className="w-16 h-16 rounded-full bg-surface-container flex items-center justify-center mb-4">
              <span className="material-symbols-outlined text-on-surface-variant text-3xl">
                {search ? 'search_off' : 'chat_bubble_outline'}
              </span>
            </div>
            <p className="text-on-surface-variant font-medium uppercase tracking-[0.2em] text-sm">
              {search ? t('conversations.empty.noSearchResults') : t('conversations.empty.noConversations')}
            </p>
            <p className="text-sm text-on-surface-variant/40 mt-1">
              {search ? t('conversations.empty.tryOtherKeyword') : t('conversations.empty.startNew')}
            </p>
          </div>
        ) : (
          <div className="bg-surface-container rounded-lg overflow-hidden">
            {/* Table Header */}
            <div className="grid grid-cols-[auto_1fr_100px_120px_140px_80px] gap-4 px-6 py-3 bg-surface-container-high text-sm font-bold uppercase tracking-widest text-on-surface-variant">
              <span className="w-9" />
              <span>{t('conversations.table.title')}</span>
              <span>{t('conversations.table.type')}</span>
              <span>{t('conversations.table.status')}</span>
              <span>{t('conversations.table.createdAt')}</span>
              <span className="text-right">{t('conversations.table.actions')}</span>
            </div>
            {/* Table Rows */}
            <div className="divide-y divide-outline-variant/10">
              {paged.map(conv => {
                const config = getSkillConfig(conv.skill_id);
                return (
                  <div
                    key={conv.id}
                    className="grid grid-cols-[auto_1fr_100px_120px_140px_80px] gap-4 px-6 py-3.5 items-center hover:bg-surface-container-high/50 cursor-pointer transition-colors group"
                    onClick={() => router.push(`/chat/${conv.id}`)}
                  >
                    {/* Icon */}
                    <div
                      className="w-9 h-9 rounded flex items-center justify-center shrink-0"
                      style={{ background: config.bgColor }}
                    >
                      <span className="material-symbols-outlined text-sm" style={{ color: config.color }}>
                        {config.icon}
                      </span>
                    </div>
                    {/* Title */}
                    <p className="text-sm text-on-surface truncate font-medium">{conv.title}</p>
                    {/* Type */}
                    <span className="text-sm font-bold tracking-widest uppercase" style={{ color: config.color }}>
                      {config.label}
                    </span>
                    {/* Status */}
                    <div className="flex items-center gap-1.5">
                      <span className={`w-1.5 h-1.5 rounded-full ${conv.status === 'active' ? 'bg-success' : 'bg-outline-variant'}`} />
                      <span className="text-sm text-on-surface-variant">
                        {conv.status === 'active' ? t('conversations.status.active') : t('conversations.status.completed')}
                      </span>
                    </div>
                    {/* Date */}
                    <span className="text-sm text-on-surface-variant">
                      {new Date(conv.created_at).toLocaleString('zh-TW', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </span>
                    {/* Actions */}
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={e => { e.stopPropagation(); setRenameTarget(conv); }}
                        className="w-7 h-7 flex items-center justify-center rounded bg-transparent hover:bg-primary/10 text-on-surface-variant hover:text-primary cursor-pointer transition-colors opacity-0 group-hover:opacity-100"
                        title={t('conversations.tooltip.rename')}
                      >
                        <span className="material-symbols-outlined text-sm">edit</span>
                      </button>
                      <button
                        onClick={e => { e.stopPropagation(); setDeleteTarget(conv); }}
                        className="w-7 h-7 flex items-center justify-center rounded bg-transparent hover:bg-error/10 text-on-surface-variant hover:text-error cursor-pointer transition-colors opacity-0 group-hover:opacity-100"
                        title={t('conversations.tooltip.delete')}
                      >
                        <span className="material-symbols-outlined text-sm">delete</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Pagination */}
        {filtered.length > 0 && (
          <div className="mt-8 flex items-center justify-between">
            <p className="text-on-surface-variant/60 text-sm uppercase tracking-widest">
              {t('conversations.pagination.totalConversations', { count: filtered.length })}
            </p>
            {totalPages > 1 && (
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="w-8 h-8 flex items-center justify-center rounded bg-surface-container hover:bg-surface-container-high text-on-surface-variant disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition-colors"
                >
                  <span className="material-symbols-outlined text-sm">chevron_left</span>
                </button>
                {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
                  <button
                    key={p}
                    onClick={() => setPage(p)}
                    className={`w-8 h-8 flex items-center justify-center rounded text-sm font-bold cursor-pointer transition-colors ${
                      p === page
                        ? 'bg-primary text-on-primary'
                        : 'bg-surface-container hover:bg-surface-container-high text-on-surface-variant'
                    }`}
                  >
                    {p}
                  </button>
                ))}
                <button
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  className="w-8 h-8 flex items-center justify-center rounded bg-surface-container hover:bg-surface-container-high text-on-surface-variant disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition-colors"
                >
                  <span className="material-symbols-outlined text-sm">chevron_right</span>
                </button>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

export default function ConversationsPage() {
  return (
    <AuthProvider>
      <ConversationsWithI18n />
    </AuthProvider>
  );
}

function ConversationsWithI18n() {
  const { user } = useAuth();
  return (
    <I18nProvider initialLocale={user?.locale} initialTheme={user?.theme}>
      <ConversationsContent />
    </I18nProvider>
  );
}
