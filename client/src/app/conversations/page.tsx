'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { AuthProvider, useAuth } from '../components/AuthProvider';
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

const PAGE_SIZE = 15;

function ConversationsContent() {
  const { user, token, isLoading } = useAuth();
  const router = useRouter();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(1);
  const sidebarMargin = useSidebarMargin();

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  useEffect(() => {
    if (!token) return;
    fetch('/api/conversations', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(setConversations)
      .catch(console.error);
  }, [token]);

  // Reset page on filter/search change
  useEffect(() => { setPage(1); }, [filter, search]);

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

      <main className={`${sidebarMargin} pt-8 pb-12 px-10 transition-all duration-300`}>
        {/* Header Section — matches /files style */}
        <div className="flex justify-between items-end mb-10">
          <div className="max-w-2xl">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-tertiary text-xs font-bold tracking-[0.3em] uppercase">對話歷程</span>
              <div className="h-px w-12 bg-tertiary/30" />
            </div>
            <h2 className="text-4xl font-headline font-bold text-on-surface tracking-tight mb-2">對話記錄</h2>
            <p className="text-on-surface-variant leading-relaxed">
              所有與 AI 代理的對話歷程，點擊可繼續進行對話。
            </p>
          </div>

          {/* Summary Widget */}
          <div className="rounded-lg p-5 w-72 bg-surface-container flex flex-col gap-3 relative overflow-hidden shrink-0">
            <div className="absolute top-0 right-0 p-4 opacity-10">
              <span className="material-symbols-outlined text-4xl">forum</span>
            </div>
            <div className="flex justify-between items-center text-xs font-bold tracking-widest uppercase text-on-surface-variant">
              <span>對話統計</span>
              <span className="text-primary">{conversations.length} 個對話</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {Object.entries(
                conversations.reduce<Record<string, number>>((acc, c) => {
                  const label = c.skill_id ? (SKILL_META[c.skill_id]?.label || 'OTHER') : 'AUTO';
                  acc[label] = (acc[label] || 0) + 1;
                  return acc;
                }, {})
              )
                .sort((a, b) => b[1] - a[1])
                .slice(0, 3)
                .map(([label, count]) => (
                  <div key={label} className="text-center">
                    <p className="text-lg font-headline font-bold text-on-surface">{count}</p>
                    <p className="text-[10px] text-on-surface-variant uppercase tracking-wider">{label}</p>
                  </div>
                ))}
            </div>
          </div>
        </div>

        {/* Filter Tabs + Search — matches /files style */}
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
                  className={`px-4 py-2 rounded text-xs font-bold tracking-widest uppercase transition-colors cursor-pointer ${
                    filter === tab.value
                      ? 'bg-surface-container text-on-surface border-b-2 border-primary'
                      : 'bg-transparent text-on-surface-variant hover:bg-surface-container'
                  }`}
                >
                  {tab.label}
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
              placeholder="搜尋對話標題..."
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

        {/* Conversations Grid — card style matching /files */}
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 border border-dashed border-outline-variant/20 rounded-lg">
            <div className="w-16 h-16 rounded-full bg-surface-container flex items-center justify-center mb-4">
              <span className="material-symbols-outlined text-on-surface-variant text-3xl">
                {search ? 'search_off' : 'chat_bubble_outline'}
              </span>
            </div>
            <p className="text-on-surface-variant font-medium uppercase tracking-[0.2em] text-xs">
              {search ? '找不到符合的對話' : '尚無對話'}
            </p>
            <p className="text-xs text-on-surface-variant/40 mt-1">
              {search ? '請嘗試其他關鍵字' : '從儀表板開始建立新對話'}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
            {paged.map(conv => {
              const config = getSkillConfig(conv.skill_id);
              return (
                <div
                  key={conv.id}
                  className="bg-surface-container hover:bg-surface-container-high transition-colors p-5 flex flex-col gap-4 group cursor-pointer"
                  onClick={() => router.push(`/chat/${conv.id}`)}
                >
                  {/* Top: Icon + Type badge */}
                  <div className="flex justify-between items-start">
                    <div
                      className="w-10 h-10 rounded flex items-center justify-center"
                      style={{ background: config.bgColor }}
                    >
                      <span className="material-symbols-outlined" style={{ color: config.color }}>
                        {config.icon}
                      </span>
                    </div>
                    <span className="text-xs font-bold tracking-widest uppercase" style={{ color: config.color }}>
                      {config.label}
                    </span>
                  </div>

                  {/* Title + date */}
                  <div>
                    <h3 className="font-headline font-bold text-base leading-tight mb-1 truncate text-on-surface">
                      {conv.title}
                    </h3>
                    <p className="text-xs text-on-surface-variant uppercase tracking-widest">
                      {new Date(conv.created_at).toLocaleDateString('zh-TW')}
                    </p>
                  </div>

                  {/* Bottom: Status + Arrow */}
                  <div className="mt-auto pt-3 flex items-center justify-between border-t border-outline-variant/10">
                    <div className="flex items-center gap-1.5">
                      <span className={`w-1.5 h-1.5 rounded-full ${conv.status === 'active' ? 'bg-success' : 'bg-outline-variant'}`} />
                      <span className="text-xs text-on-surface-variant uppercase tracking-widest">
                        {conv.status === 'active' ? '進行中' : '已完成'}
                      </span>
                    </div>
                    <span className="material-symbols-outlined text-sm text-outline-variant group-hover:text-primary transition-colors">
                      arrow_forward
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Pagination — matches /files style */}
        {filtered.length > 0 && (
          <div className="mt-8 flex items-center justify-between">
            <p className="text-on-surface-variant/60 text-xs uppercase tracking-widest">
              共 {filtered.length} 個對話{search && ' (搜尋結果)'}
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
                    className={`w-8 h-8 flex items-center justify-center rounded text-xs font-bold cursor-pointer transition-colors ${
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
      <ConversationsContent />
    </AuthProvider>
  );
}
