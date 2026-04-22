'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { AuthProvider, useAuth } from '../components/AuthProvider';
import { I18nProvider, useTranslation } from '../../i18n';
import Navbar from '../components/Navbar';
import { useSidebarMargin } from '../hooks/useSidebarCollapsed';

interface Memory {
  id: string;
  content: string;
  category: string;
  source_conversation_id: string | null;
  created_at: string;
}

const CAT_COLORS: Record<string, string> = {
  preference: 'bg-blue-500/15 text-blue-400',
  company: 'bg-green-500/15 text-green-400',
  project: 'bg-purple-500/15 text-purple-400',
  style: 'bg-orange-500/15 text-orange-400',
  general: 'bg-surface-container-high text-on-surface-variant',
};

const CATEGORIES = ['preference', 'company', 'project', 'style', 'general'];

function MemoriesContent() {
  const { user, token, isLoading } = useAuth();
  const { t } = useTranslation();
  const router = useRouter();
  const sidebarMargin = useSidebarMargin();
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState('');
  const [catOpen, setCatOpen] = useState(false);
  const catRef = useRef<HTMLDivElement>(null);
  const [detail, setDetail] = useState<Memory | null>(null);
  const perPage = 10;

  // Filtered list
  const filtered = useMemo(() => {
    let list = memories;
    if (catFilter) list = list.filter(m => m.category === catFilter);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(m => m.content.toLowerCase().includes(q));
    }
    return list;
  }, [memories, catFilter, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const paged = filtered.slice((page - 1) * perPage, page * perPage);

  // Reset page when filter changes
  useEffect(() => { setPage(1); }, [search, catFilter]);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (catRef.current && !catRef.current.contains(e.target as Node)) setCatOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  const fetchMemories = useCallback(() => {
    if (!token) return;
    fetch('/api/auth/memories', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(data => { setMemories(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, [token]);

  useEffect(() => { fetchMemories(); }, [fetchMemories]);

  async function deleteMemory(id: string) {
    if (!token) return;
    await fetch(`/api/auth/memories/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    setMemories(prev => {
      const next = prev.filter(m => m.id !== id);
      const maxPage = Math.max(1, Math.ceil(next.length / perPage));
      if (page > maxPage) setPage(maxPage);
      return next;
    });
    if (detail?.id === id) setDetail(null);
  }

  async function clearAll() {
    if (!token || !confirm(t('userMenu.memory.clearConfirm' as any))) return;
    await fetch('/api/auth/memories', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    setMemories([]);
    setDetail(null);
  }

  if (isLoading || !user) return null;

  return (
    <>
      <Navbar />
      <main className={`${sidebarMargin} pt-16 md:pt-10 pb-12 px-4 md:px-10 transition-all duration-300`}>
        {/* Page Header */}
        <header className="mt-4 md:mt-0 mb-4 md:mb-10">
          <div className="flex items-center gap-2 mb-1 md:mb-2">
            <span className="text-tertiary text-xs md:text-sm font-bold tracking-[0.3em] uppercase">{t('memories.header.subtitle' as any)}</span>
            <div className="h-px w-8 md:w-12 bg-tertiary/30" />
          </div>
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-xl md:text-4xl font-headline font-bold text-on-surface tracking-tight">{t('userMenu.memory' as any)}</h2>
            {memories.length > 0 && (
              <button
                onClick={clearAll}
                className="flex items-center gap-1.5 px-2.5 md:px-4 py-1.5 md:py-2.5 rounded-xl text-xs md:text-sm font-headline font-bold text-error/60 hover:text-error hover:bg-error/10 border border-error/20 transition-all cursor-pointer shrink-0"
              >
                <span className="material-symbols-outlined text-lg">delete_sweep</span>
                <span className="hidden sm:inline">{t('userMenu.memory.clearAll' as any)}</span>
              </button>
            )}
          </div>
          <p className="hidden md:block text-base text-on-surface-variant leading-relaxed max-w-xl mt-2">
            {t('userMenu.memory.description' as any)}
          </p>
        </header>

        {/* Search & Filter Bar */}
        {!loading && memories.length > 0 && (
          <div className="flex items-center gap-2 mb-3 md:mb-4">
            <div className="relative flex-1 min-w-0">
              <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant/50 text-lg">search</span>
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder={t('memories.search.placeholder' as any)}
                className="w-full bg-surface-container rounded-lg pl-9 pr-3 py-2 md:py-2.5 text-sm text-on-surface border border-outline-variant/20 focus:border-primary/40 focus:ring-1 focus:ring-primary/20 outline-none placeholder:text-on-surface-variant/40"
              />
            </div>
            <div className="relative shrink-0" ref={catRef}>
              <button
                onClick={() => setCatOpen(o => !o)}
                className="flex items-center gap-1.5 bg-surface-container rounded-lg px-2.5 md:px-3 py-2 md:py-2.5 text-xs md:text-sm text-on-surface border border-outline-variant/20 hover:border-outline-variant/40 transition-colors cursor-pointer"
              >
                {catFilter ? (
                  <span className={`inline-block text-[10px] font-bold px-1.5 py-0.5 rounded-full ${CAT_COLORS[catFilter] || CAT_COLORS.general}`}>
                    {t(`userMenu.memory.category.${catFilter}` as any)}
                  </span>
                ) : (
                  <span>{t('memories.filter.all' as any)}</span>
                )}
                <span className={`material-symbols-outlined text-sm text-on-surface-variant/60 transition-transform ${catOpen ? 'rotate-180' : ''}`}>expand_more</span>
              </button>
              {catOpen && (
                <div className="absolute right-0 top-full mt-1 bg-surface-container-high rounded-lg border border-outline-variant/20 shadow-xl z-20 min-w-[120px] py-1">
                  <button
                    onClick={() => { setCatFilter(''); setCatOpen(false); }}
                    className={`w-full text-left px-3 py-2.5 text-sm transition-colors cursor-pointer hover:bg-surface-container-highest ${!catFilter ? 'text-primary font-bold' : 'text-on-surface'}`}
                  >
                    {t('memories.filter.all' as any)}
                  </button>
                  {CATEGORIES.map(c => (
                    <button
                      key={c}
                      onClick={() => { setCatFilter(c); setCatOpen(false); }}
                      className={`w-full text-left px-3 py-2.5 text-sm transition-colors cursor-pointer hover:bg-surface-container-highest ${catFilter === c ? 'text-primary font-bold' : 'text-on-surface-variant'}`}
                    >
                      {t(`userMenu.memory.category.${c}` as any)}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <span className="hidden sm:inline text-xs text-on-surface-variant/60 whitespace-nowrap">
              {(t('memories.count' as any) as string).replace('{count}', String(filtered.length))}
            </span>
          </div>
        )}

        {/* Content */}
        {loading ? (
          <div className="flex items-center justify-center py-16 text-on-surface-variant">
            <span className="material-symbols-outlined animate-spin mr-2">progress_activity</span>
          </div>
        ) : memories.length === 0 ? (
          <div className="text-center py-16 text-on-surface-variant">
            <span className="material-symbols-outlined text-4xl mb-2 block">psychology</span>
            <p className="text-sm">{t('userMenu.memory.empty' as any)}</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16 text-on-surface-variant">
            <span className="material-symbols-outlined text-4xl mb-2 block">search_off</span>
            <p className="text-sm">{t('userMenu.memory.empty' as any)}</p>
          </div>
        ) : (
          <>
          <div className="space-y-2">
            {paged.map(m => (
              <div
                key={m.id}
                onClick={() => setDetail(m)}
                className="flex items-start gap-3 bg-surface-container rounded-lg px-4 py-3 border border-outline-variant/10 hover:border-outline-variant/20 transition-colors group cursor-pointer"
              >
                <span className={`inline-block text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 mt-0.5 ${CAT_COLORS[m.category] || CAT_COLORS.general}`}>
                  {t(`userMenu.memory.category.${m.category}` as any)}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-on-surface line-clamp-2">{m.content}</p>
                  <p className="text-[11px] text-on-surface-variant/50 mt-1">
                    {new Date(m.created_at).toLocaleDateString()}
                  </p>
                </div>
                <button
                  onClick={e => { e.stopPropagation(); deleteMemory(m.id); }}
                  className="w-8 h-8 flex items-center justify-center rounded-lg text-on-surface-variant/40 hover:text-error hover:bg-error/10 transition-colors cursor-pointer md:opacity-0 md:group-hover:opacity-100 shrink-0"
                >
                  <span className="material-symbols-outlined text-lg">close</span>
                </button>
              </div>
            ))}
          </div>
          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 pt-4">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="w-8 h-8 flex items-center justify-center rounded-lg text-on-surface-variant hover:bg-surface-container-high transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default"
              >
                <span className="material-symbols-outlined text-lg">chevron_left</span>
              </button>
              {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
                <button
                  key={p}
                  onClick={() => setPage(p)}
                  className={`w-8 h-8 flex items-center justify-center rounded-lg text-xs font-bold transition-colors cursor-pointer ${
                    p === page
                      ? 'cyber-gradient text-on-primary'
                      : 'text-on-surface-variant hover:bg-surface-container-high'
                  }`}
                >
                  {p}
                </button>
              ))}
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="w-8 h-8 flex items-center justify-center rounded-lg text-on-surface-variant hover:bg-surface-container-high transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default"
              >
                <span className="material-symbols-outlined text-lg">chevron_right</span>
              </button>
            </div>
          )}
          </>
        )}

        {/* Detail Modal */}
        {detail && (
          <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center" onClick={() => setDetail(null)}>
            <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
            <div
              className="relative bg-surface-container rounded-t-2xl md:rounded-2xl p-5 md:p-7 border border-outline-variant/20 shadow-2xl w-full md:w-[90vw] md:max-w-lg animate-[slideUp_0.25s_ease-out] md:animate-in"
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-base font-headline font-bold text-on-surface">{t('memories.detail.title' as any)}</h3>
                <button
                  onClick={() => setDetail(null)}
                  className="w-8 h-8 flex items-center justify-center rounded-lg text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-colors cursor-pointer"
                >
                  <span className="material-symbols-outlined text-lg">close</span>
                </button>
              </div>
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-on-surface-variant">{t('memories.detail.category' as any)}</span>
                  <span className={`inline-block text-[10px] font-bold px-2 py-0.5 rounded-full ${CAT_COLORS[detail.category] || CAT_COLORS.general}`}>
                    {t(`userMenu.memory.category.${detail.category}` as any)}
                  </span>
                </div>
                <div>
                  <span className="text-xs text-on-surface-variant block mb-1">{t('memories.detail.createdAt' as any)}</span>
                  <span className="text-sm text-on-surface">{new Date(detail.created_at).toLocaleString()}</span>
                </div>
                <div>
                  <span className="text-xs text-on-surface-variant block mb-1">{t('memories.detail.content' as any)}</span>
                  <p className="text-sm text-on-surface bg-surface-container-highest rounded-lg p-3 leading-relaxed whitespace-pre-wrap">{detail.content}</p>
                </div>
              </div>
              <div className="flex justify-end mt-5">
                <button
                  onClick={() => {
                    if (confirm(t('memories.detail.deleteConfirm' as any))) deleteMemory(detail.id);
                  }}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm text-error/70 hover:text-error hover:bg-error/10 border border-error/20 transition-colors cursor-pointer"
                >
                  <span className="material-symbols-outlined text-lg">delete</span>
                  {t('memories.detail.delete' as any)}
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </>
  );
}

export default function MemoriesPage() {
  return (
    <AuthProvider>
      <MemoriesWithI18n />
    </AuthProvider>
  );
}

function MemoriesWithI18n() {
  const { user } = useAuth();
  return (
    <I18nProvider initialLocale={user?.locale} initialTheme={user?.theme}>
      <MemoriesContent />
    </I18nProvider>
  );
}
