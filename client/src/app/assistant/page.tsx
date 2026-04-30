'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { AuthProvider, useAuth } from '../components/AuthProvider';
import { I18nProvider, useTranslation } from '../../i18n';
import Navbar from '../components/Navbar';
import { useSidebarMargin } from '../hooks/useSidebarCollapsed';
import HelpButton from '../components/HelpButton';

const MAX_ASSISTANTS = 3;

interface AssistantConversation {
  id: string;
  title: string;
  status: string;
  created_at: string;
  category: string;
  summary: string | null;
}

function DeleteConfirmModal({ title, onConfirm, onCancel }: { title: string; onConfirm: () => void; onCancel: () => void }) {
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
        className="relative bg-surface-container rounded-xl shadow-2xl border border-outline-variant/10 w-full max-w-sm mx-4 overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex flex-col items-center pt-8 pb-4 px-6">
          <div className="w-14 h-14 rounded-full bg-error/10 flex items-center justify-center mb-4">
            <span className="material-symbols-outlined text-error text-3xl">delete_forever</span>
          </div>
          <h3 className="font-headline font-bold text-lg text-on-surface mb-2">
            {t('assistant.deleteConfirm.title' as any)}
          </h3>
          <p className="text-sm text-on-surface-variant text-center leading-relaxed">{title}</p>
        </div>
        <div className="flex gap-3 px-6 pb-6 pt-2">
          <button onClick={onCancel} className="flex-1 py-2.5 px-4 bg-surface-container-highest border border-outline-variant/10 text-on-surface font-bold text-sm uppercase tracking-widest rounded cursor-pointer hover:bg-surface-variant transition-colors">
            {t('common.cancel' as any)}
          </button>
          <button onClick={onConfirm} className="flex-1 py-2.5 px-4 bg-error text-on-error font-bold text-sm uppercase tracking-widest rounded cursor-pointer hover:bg-error/80 transition-colors">
            {t('common.delete' as any)}
          </button>
        </div>
      </div>
    </div>
  );
}

function AssistantContent() {
  const { user, token, isLoading } = useAuth();
  const { t } = useTranslation();
  const router = useRouter();
  const sidebarMargin = useSidebarMargin();
  const [conversations, setConversations] = useState<AssistantConversation[]>([]);
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AssistantConversation | null>(null);
  const [memoryCount, setMemoryCount] = useState(0);
  const [workLogCount, setWorkLogCount] = useState(0);
  const [processingIds, setProcessingIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  useEffect(() => {
    if (!token) return;
    fetch('/api/conversations?category=assistant', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(data => {
        const convs = Array.isArray(data) ? data : [];
        setConversations(convs);
        // Check processing status for each conversation
        Promise.all(convs.map((c: AssistantConversation) =>
          fetch(`/api/generate/${c.id}/status`, { headers: { Authorization: `Bearer ${token}` } })
            .then(r => r.json())
            .then(({ processing }: { processing: boolean }) => processing ? c.id : null)
            .catch(() => null)
        )).then(results => {
          const ids = new Set<string>(results.filter(Boolean) as string[]);
          setProcessingIds(ids);
        });
      })
      .catch(console.error);

    fetch('/api/auth/memories', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data)) {
          setMemoryCount(data.length);
          setWorkLogCount(data.filter((m: any) => m.memory_type === 'work_log').length);
        }
      })
      .catch(() => {});
  }, [token]);

  async function createAssistant() {
    if (!token || creating || conversations.length >= MAX_ASSISTANTS) return;
    setCreating(true);
    try {
      const res = await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          title: `${t('assistant.defaultTitle' as any) || 'AI 助手'} ${conversations.length + 1}`,
          category: 'assistant',
        }),
      });
      const conv = await res.json();
      router.push(`/chat/${conv.id}`);
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete() {
    if (!token || !deleteTarget) return;
    await fetch(`/api/conversations/${deleteTarget.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    setConversations(prev => prev.filter(c => c.id !== deleteTarget.id));
    setDeleteTarget(null);
  }

  function formatDate(dateStr: string) {
    const d = new Date(dateStr);
    const now = new Date();
    const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
    if (diffDays === 0) return t('assistant.today' as any) || '今天';
    if (diffDays === 1) return t('assistant.yesterday' as any) || '昨天';
    if (diffDays < 7) return `${diffDays} ${t('assistant.daysAgo' as any) || '天前'}`;
    return d.toLocaleDateString();
  }

  if (isLoading || !user) return null;

  // Build 3-slot array: filled conversations + empty slots
  const slots: (AssistantConversation | null)[] = [
    ...conversations,
    ...Array(MAX_ASSISTANTS - conversations.length).fill(null),
  ];

  return (
    <div className="min-h-screen bg-surface-container-lowest">
      <Navbar />
      {deleteTarget && (
        <DeleteConfirmModal title={deleteTarget.title} onConfirm={handleDelete} onCancel={() => setDeleteTarget(null)} />
      )}

      <main className={`${sidebarMargin} md:pt-10 pb-12 px-4 md:px-10 transition-all duration-300`}>
        {/* Header */}
        <div className="mt-4 md:mt-0 mb-8 md:mb-12">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-tertiary text-xs md:text-sm font-bold tracking-[0.3em] uppercase">
              {t('assistant.header.subtitle' as any) || 'AI WORKSPACE'}
            </span>
            <div className="h-px w-8 md:w-12 bg-tertiary/30" />
          </div>
          <div className="flex items-center gap-2 mb-2 md:mb-3">
            <h2 className="text-2xl md:text-4xl font-headline font-bold text-on-surface tracking-tight leading-none">
              {t('nav.assistant' as any)}
            </h2>
            <HelpButton pageId="assistant" />
          </div>
          <p className="text-sm md:text-base text-on-surface-variant leading-relaxed max-w-2xl">
            {t('assistant.description' as any)}
          </p>

          {/* Memory badge */}
          {memoryCount > 0 && (
            <div className="mt-4 inline-flex items-center gap-2 px-3 py-1.5 bg-tertiary/10 border border-tertiary/20 rounded-full text-sm text-tertiary">
              <span className="material-symbols-outlined text-base">psychology</span>
              <span className="font-medium">
                {t('assistant.memoryBadge' as any) || `AI 已累積跨對話記憶`}
              </span>
              <span className="text-tertiary/70">
                {workLogCount > 0
                  ? `偏好 ${memoryCount - workLogCount} · 工作紀錄 ${workLogCount}`
                  : `${memoryCount} 條`
                }
              </span>
            </div>
          )}
        </div>

        {/* 3-slot workspace grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-6">
          {slots.map((conv, idx) =>
            conv ? (
              /* Occupied slot */
              <div
                key={conv.id}
                className="group relative flex flex-col bg-surface-container rounded-2xl border border-outline-variant/10 hover:border-primary/30 transition-all overflow-hidden"
              >
                {/* Top accent bar */}
                <div className="h-1 cyber-gradient w-full" />

                <div className="p-5 flex flex-col flex-1">
                  {/* Avatar + index */}
                  <div className="flex items-start justify-between mb-4">
                    <div className="relative">
                      <div className="w-12 h-12 rounded-xl cyber-gradient flex items-center justify-center">
                        <span className="material-symbols-outlined text-on-primary text-2xl">smart_toy</span>
                      </div>
                      {/* Online pulse */}
                      <span className="absolute -top-0.5 -right-0.5 w-3 h-3 bg-success rounded-full border-2 border-surface-container">
                        <span className="absolute inset-0 rounded-full bg-success animate-ping opacity-60" />
                      </span>
                    </div>
                    <span className="text-xs font-mono font-bold text-on-surface-variant bg-surface-container-high px-2 py-0.5 rounded-full">
                      #{idx + 1}
                    </span>
                  </div>

                  {/* Title */}
                  <h3 className="font-headline font-bold text-on-surface text-base mb-1 group-hover:text-primary transition-colors line-clamp-1">
                    {conv.title}
                  </h3>

                  {/* Summary snippet */}
                  {conv.summary ? (
                    <p className="text-xs text-on-surface-variant/80 line-clamp-2 mb-2 leading-relaxed">
                      {conv.summary}
                    </p>
                  ) : (
                    <p className="text-xs text-outline/50 mb-2 italic">
                      {t('assistant.noSummary' as any) || '對話中...'}
                    </p>
                  )}

                  {/* Meta — single line */}
                  <div className="flex items-center gap-2 text-xs text-on-surface-variant mb-5 flex-wrap">
                    {processingIds.has(conv.id) ? (
                      <span className="flex items-center gap-1 text-primary">
                        <span className="material-symbols-outlined text-[13px] animate-spin">progress_activity</span>
                        AI 處理中
                      </span>
                    ) : (
                      <span className="flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-success inline-block" />
                        {t('conversations.status.active' as any) || '進行中'}
                      </span>
                    )}
                    <span className="text-outline-variant/40">·</span>
                    <span>{formatDate(conv.created_at)}</span>
                    <span className="text-outline-variant/40">·</span>
                    <span className="flex items-center gap-1 text-tertiary">
                      <span className="material-symbols-outlined text-[13px]">psychology</span>
                      {t('assistant.memoryActive' as any) || '記憶中'}
                    </span>
                  </div>

                  {/* Actions */}
                  <div className="mt-auto flex items-center gap-2">
                    <Link
                      href={`/chat/${conv.id}`}
                      className="flex-1 flex items-center justify-center gap-1.5 py-2 cyber-gradient text-on-primary rounded-lg text-sm font-bold font-headline hover:brightness-110 active:scale-95 transition-all no-underline"
                    >
                      <span className="material-symbols-outlined text-base">chat</span>
                      {t('assistant.openChat' as any) || '開啟對話'}
                    </Link>
                    <button
                      onClick={() => setDeleteTarget(conv)}
                      className="w-9 h-9 flex items-center justify-center rounded-lg text-on-surface-variant hover:text-error hover:bg-error/10 transition-colors cursor-pointer border border-outline-variant/10"
                      title={t('assistant.delete' as any) || '刪除'}
                    >
                      <span className="material-symbols-outlined text-[18px]">delete</span>
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              /* Empty slot */
              <button
                key={`slot-${idx}`}
                onClick={createAssistant}
                disabled={creating}
                className="group flex flex-col items-center justify-center gap-3 bg-surface-container/40 rounded-2xl border-2 border-dashed border-outline-variant/25 hover:border-primary/40 hover:bg-surface-container/70 transition-all min-h-[220px] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed p-6"
              >
                <div className="w-12 h-12 rounded-xl border-2 border-dashed border-outline-variant/40 flex items-center justify-center group-hover:border-primary/50 group-hover:bg-primary/5 transition-colors">
                  <span className="material-symbols-outlined text-outline-variant group-hover:text-primary transition-colors text-2xl">add</span>
                </div>
                <div className="text-center">
                  <p className="text-sm font-bold font-headline text-on-surface-variant group-hover:text-primary transition-colors">
                    {t('assistant.newChat' as any) || '啟用新助手'}
                  </p>
                  <p className="text-xs text-outline mt-1">{t('assistant.slotDesc' as any) || '席位 ' + (idx + 1)}</p>
                </div>
              </button>
            )
          )}
        </div>

        {/* Bottom info */}
        <div className="mt-8 flex flex-wrap items-center gap-4 text-xs text-on-surface-variant">
          <div className="flex items-center gap-1.5">
            <span className="material-symbols-outlined text-sm text-primary">info</span>
            <span>{t('assistant.slotsInfo' as any) || `最多 ${MAX_ASSISTANTS} 個助手席位，對話永久保留直到你刪除`}</span>
          </div>
          {memoryCount > 0 && (
            <>
              <span>·</span>
              <Link href="/memories" className="flex items-center gap-1 text-tertiary hover:text-primary transition-colors no-underline">
                <span className="material-symbols-outlined text-sm">psychology</span>
                {t('assistant.viewMemories' as any) || `查看 ${memoryCount} 條記憶`}
              </Link>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function AssistantWithI18n() {
  const { user } = useAuth();
  return (
    <I18nProvider initialLocale={user?.locale} initialTheme={user?.theme}>
      <AssistantContent />
    </I18nProvider>
  );
}

export default function AssistantPage() {
  return (
    <AuthProvider>
      <AssistantWithI18n />
    </AuthProvider>
  );
}
