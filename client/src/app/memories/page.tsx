'use client';

import { useState, useEffect, useCallback } from 'react';
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

const deployMode = process.env.NEXT_PUBLIC_DEPLOY_MODE || 'pro-panjit';

function MemoriesContent() {
  const { user, token, isLoading } = useAuth();
  const { t } = useTranslation();
  const router = useRouter();
  const sidebarMargin = useSidebarMargin();
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
    if (!isLoading && user && deployMode !== 'pro-out') router.replace('/dashboard');
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
    setMemories(prev => prev.filter(m => m.id !== id));
  }

  async function clearAll() {
    if (!token || !confirm(t('userMenu.memory.clearConfirm' as any))) return;
    await fetch('/api/auth/memories', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    setMemories([]);
  }

  if (isLoading || !user) return null;

  return (
    <>
      <Navbar />
      <main className={`${sidebarMargin} pt-16 md:pt-10 pb-12 px-4 md:px-10 transition-all duration-300`}>
        {/* Page Header */}
        <header className="mt-4 md:mt-0 mb-6 md:mb-10 flex flex-col md:flex-row md:justify-between md:items-end gap-4">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-tertiary text-xs md:text-sm font-bold tracking-[0.3em] uppercase">{t('memories.header.subtitle' as any)}</span>
              <div className="h-px w-8 md:w-12 bg-tertiary/30" />
            </div>
            <h2 className="text-2xl md:text-4xl font-headline font-bold text-on-surface tracking-tight mb-1 md:mb-2">{t('userMenu.memory' as any)}</h2>
            <p className="text-sm md:text-base text-on-surface-variant leading-relaxed max-w-xl">
              {t('userMenu.memory.description' as any)}
            </p>
          </div>
          {memories.length > 0 && (
            <button
              onClick={clearAll}
              className="flex items-center gap-1.5 px-3 md:px-4 py-2 md:py-2.5 rounded-xl text-xs md:text-sm font-headline font-bold text-error/60 hover:text-error hover:bg-error/10 border border-error/20 transition-all cursor-pointer"
            >
              <span className="material-symbols-outlined text-lg">delete_sweep</span>
              {t('userMenu.memory.clearAll' as any)}
            </button>
          )}
        </header>

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
        ) : (
          <div className="space-y-2">
            {memories.map(m => (
              <div
                key={m.id}
                className="flex items-start gap-3 bg-surface-container rounded-lg px-4 py-3 border border-outline-variant/10 hover:border-outline-variant/20 transition-colors group"
              >
                <span className={`inline-block text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 mt-0.5 ${CAT_COLORS[m.category] || CAT_COLORS.general}`}>
                  {t(`userMenu.memory.category.${m.category}` as any)}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-on-surface">{m.content}</p>
                  <p className="text-[11px] text-on-surface-variant/50 mt-1">
                    {new Date(m.created_at).toLocaleDateString()}
                  </p>
                </div>
                <button
                  onClick={() => deleteMemory(m.id)}
                  className="w-8 h-8 flex items-center justify-center rounded-lg text-on-surface-variant/40 hover:text-error hover:bg-error/10 transition-colors cursor-pointer opacity-0 group-hover:opacity-100 shrink-0"
                >
                  <span className="material-symbols-outlined text-lg">close</span>
                </button>
              </div>
            ))}
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
