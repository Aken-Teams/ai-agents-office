'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import dynamic from 'next/dynamic';
import { useAdminAuth } from '../components/AdminAuthProvider';
import { useTranslation } from '../../../i18n';

const ChatChart = dynamic(() => import('../../components/charts/ChatChart'), { ssr: false });
const ChatMermaid = dynamic(() => import('../../components/charts/ChatMermaid'), { ssr: false });
const ChatMindmap = dynamic(() => import('../../components/charts/ChatMindmap'), { ssr: false });
const ChatMap = dynamic(() => import('../../components/charts/ChatMap'), { ssr: false });

function convertMermaidMindmapToMarkdown(mermaidCode: string): string {
  const lines = mermaidCode.split('\n');
  const result: string[] = [];
  let baseIndent = -1;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || /^mindmap\b/i.test(trimmed)) continue;
    const match = line.match(/^(\s*)/);
    const indent = match ? match[1].length : 0;
    if (baseIndent < 0) baseIndent = indent;
    const level = Math.max(1, Math.floor((indent - baseIndent) / 2) + 1);
    let text = trimmed
      .replace(/^root\(\((.+?)\)\)$/, '$1')
      .replace(/^\(\((.+?)\)\)$/, '$1')
      .replace(/^\((.+?)\)$/, '$1')
      .replace(/^\[(.+?)\]$/, '$1')
      .replace(/^"(.+?)"$/, '$1');
    if (!text) continue;
    result.push(`${'#'.repeat(Math.min(level, 6))} ${text}`);
  }
  return result.join('\n');
}

const SKILL_META: Record<string, { icon: string; color: string; bgColor: string; label: string }> = {
  'pptx-gen': { icon: 'present_to_all', color: '#FF8A65', bgColor: 'rgba(255,138,101,0.1)', label: 'PPTX' },
  'slides-gen': { icon: 'slideshow', color: '#FF8A65', bgColor: 'rgba(255,138,101,0.1)', label: 'SLIDES' },
  'docx-gen': { icon: 'description', color: '#2196F3', bgColor: 'rgba(33,150,243,0.1)', label: 'DOCX' },
  'xlsx-gen': { icon: 'table_chart', color: '#4CAF50', bgColor: 'rgba(76,175,80,0.1)', label: 'XLSX' },
  'pdf-gen': { icon: 'picture_as_pdf', color: '#FF5252', bgColor: 'rgba(255,82,82,0.1)', label: 'PDF' },
  'webapp-gen': { icon: 'web', color: '#7C4DFF', bgColor: 'rgba(124,77,255,0.1)', label: 'WEB' },
  'data-analyst': { icon: 'analytics', color: '#00dbe9', bgColor: 'rgba(0,219,233,0.1)', label: 'DATA' },
  'research': { icon: 'travel_explore', color: '#8f9097', bgColor: 'rgba(143,144,151,0.1)', label: 'RESEARCH' },
};

function getSkillConfig(skillId: string | null) {
  if (!skillId) return { icon: 'smart_toy', color: '#8f9097', bgColor: 'rgba(143,144,151,0.1)', label: 'AUTO' };
  return SKILL_META[skillId] || { icon: 'smart_toy', color: '#8f9097', bgColor: 'rgba(143,144,151,0.1)', label: skillId.toUpperCase() };
}

function formatTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatDate(d: string) {
  return new Date(d).toLocaleString('zh-TW', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatSize(bytes: number) {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

const PAGE_SIZE = 15;

/* ============================================================
   Detail Panel
   ============================================================ */
function ConversationDetail({
  convId, token, onBack, t,
}: {
  convId: string;
  token: string;
  onBack: () => void;
  t: (key: any, params?: any) => string;
}) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'messages' | 'files' | 'uploads' | 'tasks'>('messages');

  // Markdown components — render chart/mermaid/mindmap/map code blocks + table wrapper
  const mdComponents = useMemo(() => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pre({ children, node, ...props }: any) {
      const codeEl = node?.children?.[0];
      const cls = codeEl?.properties?.className?.[0] || '';
      if (cls === 'language-chart' || cls === 'language-mermaid' || cls === 'language-mindmap' || cls === 'language-map') {
        return <>{children}</>;
      }
      return <pre {...props}>{children}</pre>;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    code({ className, children, ...props }: any) {
      const text = String(children).trim();
      if (className === 'language-chart') return <ChatChart rawJson={text} />;
      if (className === 'language-mermaid') {
        if (/^\s*mindmap\b/i.test(text)) return <ChatMindmap code={convertMermaidMindmapToMarkdown(text)} />;
        return <ChatMermaid code={text} />;
      }
      if (className === 'language-mindmap') return <ChatMindmap code={text} />;
      if (className === 'language-map') return <ChatMap rawJson={text} />;
      return <code className={className} {...props}>{children}</code>;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    table({ children, ...props }: any) {
      return <div className="table-wrapper"><table {...props}>{children}</table></div>;
    },
  }), []);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/admin/conversations/${convId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [convId, token]);

  if (loading) return (
    <div className="flex items-center justify-center py-20">
      <div className="w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
    </div>
  );

  if (!data) return (
    <div className="text-center py-20 text-on-surface-variant">Failed to load conversation.</div>
  );

  const config = getSkillConfig(data.skill_id);
  const totalTokens = (data.tokenUsage?.total_input ?? 0) + (data.tokenUsage?.total_output ?? 0);

  const tabs = [
    { key: 'messages' as const, label: t('admin.conversations.detail.messages'), count: data.messages?.length ?? 0, icon: 'chat' },
    { key: 'files' as const, label: t('admin.conversations.detail.files'), count: data.files?.length ?? 0, icon: 'folder' },
    { key: 'uploads' as const, label: t('admin.conversations.detail.uploads'), count: data.uploads?.length ?? 0, icon: 'upload_file' },
    { key: 'tasks' as const, label: t('admin.conversations.detail.tasks'), count: data.tasks?.length ?? 0, icon: 'task_alt' },
  ];

  return (
    <div>
      {/* Back Button + Title */}
      <div className="flex items-center gap-3 mb-6">
        <button
          onClick={onBack}
          className="w-9 h-9 flex items-center justify-center rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface-variant cursor-pointer transition-colors"
        >
          <span className="material-symbols-outlined text-sm">arrow_back</span>
        </button>
        <div className="flex-1 min-w-0">
          <h3 className="text-lg font-headline font-bold text-on-surface truncate">{data.title}</h3>
          <p className="text-xs text-on-surface-variant">{t('admin.conversations.detail.title')}</p>
        </div>
      </div>

      {/* Info Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <div className="bg-surface-container rounded-lg p-3">
          <p className="text-[10px] uppercase tracking-widest text-on-surface-variant mb-1">{t('admin.conversations.detail.user')}</p>
          <p className="text-sm font-bold text-on-surface truncate">{data.user_display_name || data.user_email}</p>
          <p className="text-xs text-on-surface-variant truncate">{data.user_email}</p>
        </div>
        <div className="bg-surface-container rounded-lg p-3">
          <p className="text-[10px] uppercase tracking-widest text-on-surface-variant mb-1">{t('admin.conversations.detail.skill')}</p>
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-sm" style={{ color: config.color }}>{config.icon}</span>
            <span className="text-sm font-bold" style={{ color: config.color }}>{config.label}</span>
          </div>
          <p className="text-xs text-on-surface-variant mt-0.5">{data.mode || 'auto'}</p>
        </div>
        <div className="bg-surface-container rounded-lg p-3">
          <p className="text-[10px] uppercase tracking-widest text-on-surface-variant mb-1">{t('admin.conversations.detail.tokenUsage')}</p>
          <p className="text-sm font-bold text-on-surface">{formatTokens(totalTokens)}</p>
          <p className="text-xs text-on-surface-variant">
            <span className="text-primary">{formatTokens(data.tokenUsage?.total_input ?? 0)}</span> in / <span className="text-tertiary">{formatTokens(data.tokenUsage?.total_output ?? 0)}</span> out
          </p>
        </div>
        <div className="bg-surface-container rounded-lg p-3">
          <p className="text-[10px] uppercase tracking-widest text-on-surface-variant mb-1">{t('admin.conversations.detail.created')}</p>
          <p className="text-sm font-bold text-on-surface">{formatDate(data.created_at)}</p>
          <div className="flex items-center gap-1 mt-0.5">
            <span className={`w-1.5 h-1.5 rounded-full ${data.status === 'active' ? 'bg-success' : 'bg-outline-variant'}`} />
            <span className="text-xs text-on-surface-variant">{data.status}</span>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 mb-4 border-b border-outline-variant/10 overflow-x-auto no-scrollbar">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex items-center gap-1.5 px-3 py-2.5 text-sm font-bold tracking-wider uppercase transition-colors cursor-pointer whitespace-nowrap ${
              activeTab === tab.key
                ? 'text-primary border-b-2 border-primary'
                : 'text-on-surface-variant hover:text-on-surface'
            }`}
          >
            <span className="material-symbols-outlined text-sm">{tab.icon}</span>
            {tab.label}
            <span className="text-xs opacity-60 ml-0.5">{tab.count}</span>
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {activeTab === 'messages' && (
        <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
          {data.messages?.length === 0 && (
            <p className="text-center py-8 text-on-surface-variant text-sm">{t('admin.conversations.detail.noMessages')}</p>
          )}
          {data.messages?.map((msg: any) => {
            const isUser = msg.role === 'user';
            const isSystem = msg.role === 'system';
            return (
              <div key={msg.id} className={`flex gap-3 ${isUser ? 'justify-start' : 'justify-start'}`}>
                <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 mt-1 ${
                  isUser ? 'bg-primary/15' : isSystem ? 'bg-outline-variant/20' : 'bg-tertiary/15'
                }`}>
                  <span className={`material-symbols-outlined text-sm ${
                    isUser ? 'text-primary' : isSystem ? 'text-outline' : 'text-tertiary'
                  }`}>
                    {isUser ? 'person' : isSystem ? 'settings' : 'smart_toy'}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className={`text-xs font-bold uppercase tracking-widest ${
                      isUser ? 'text-primary' : isSystem ? 'text-outline' : 'text-tertiary'
                    }`}>
                      {t(`admin.conversations.role.${msg.role}` as any)}
                    </span>
                    <span className="text-[10px] text-on-surface-variant">{formatDate(msg.created_at)}</span>
                  </div>
                  <div className={`rounded-xl px-4 py-3 text-sm leading-relaxed break-words ${
                    isUser
                      ? 'bg-primary/8 border border-primary/15 text-on-surface whitespace-pre-wrap'
                      : isSystem
                        ? 'bg-surface-container-high/50 border border-outline-variant/10 text-on-surface-variant text-xs opacity-60 whitespace-pre-wrap'
                        : 'bg-surface-container border border-outline-variant/10 text-on-surface chat-markdown'
                  }`}>
                    {isUser || isSystem
                      ? (msg.content?.length > 3000 ? msg.content.slice(0, 3000) + '...' : msg.content)
                      : <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                          {msg.content?.length > 3000 ? msg.content.slice(0, 3000) + '...' : msg.content}
                        </ReactMarkdown>
                    }
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {activeTab === 'files' && (
        <div className="space-y-2">
          {data.files?.length === 0 && (
            <p className="text-center py-8 text-on-surface-variant text-sm">{t('admin.conversations.detail.noFiles')}</p>
          )}
          {data.files?.map((file: any) => (
            <div key={file.id} className="flex items-center gap-3 bg-surface-container rounded-lg px-4 py-3 hover:bg-surface-container-high transition-colors">
              <div className="w-9 h-9 rounded flex items-center justify-center shrink-0"
                style={{ background: getSkillConfig(file.file_type === 'html' ? 'webapp-gen' : `${file.file_type}-gen`).bgColor }}>
                <span className="material-symbols-outlined text-sm"
                  style={{ color: getSkillConfig(file.file_type === 'html' ? 'webapp-gen' : `${file.file_type}-gen`).color }}>
                  {file.file_type === 'html' ? 'web' : 'insert_drive_file'}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-on-surface truncate">{file.filename}</p>
                <p className="text-xs text-on-surface-variant">
                  {file.file_type?.toUpperCase()} &middot; {formatSize(file.file_size)} &middot; v{file.version}
                </p>
              </div>
              <span className="text-xs text-on-surface-variant shrink-0">{formatDate(file.created_at)}</span>
            </div>
          ))}
        </div>
      )}

      {activeTab === 'uploads' && (
        <div className="space-y-2">
          {data.uploads?.length === 0 && (
            <p className="text-center py-8 text-on-surface-variant text-sm">{t('admin.conversations.detail.noUploads')}</p>
          )}
          {data.uploads?.map((upload: any) => (
            <div key={upload.id} className="flex items-center gap-3 bg-surface-container rounded-lg px-4 py-3">
              <div className="w-9 h-9 rounded flex items-center justify-center bg-surface-container-high shrink-0">
                <span className="material-symbols-outlined text-sm text-on-surface-variant">upload_file</span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-on-surface truncate">{upload.original_name || upload.filename}</p>
                <p className="text-xs text-on-surface-variant">
                  {upload.file_type?.toUpperCase()} &middot; {formatSize(upload.file_size)}
                </p>
              </div>
              <span className="text-xs text-on-surface-variant shrink-0">{formatDate(upload.created_at)}</span>
            </div>
          ))}
        </div>
      )}

      {activeTab === 'tasks' && (
        <div className="space-y-2">
          {data.tasks?.length === 0 && (
            <p className="text-center py-8 text-on-surface-variant text-sm">{t('admin.conversations.detail.noTasks')}</p>
          )}
          {data.tasks?.map((task: any) => {
            const taskConfig = getSkillConfig(task.skill_id);
            const statusColor = task.status === 'completed' ? 'text-success' : task.status === 'failed' ? 'text-error' : 'text-warning';
            return (
              <div key={task.id} className="flex items-center gap-3 bg-surface-container rounded-lg px-4 py-3">
                <div className="w-9 h-9 rounded flex items-center justify-center shrink-0" style={{ background: taskConfig.bgColor }}>
                  <span className="material-symbols-outlined text-sm" style={{ color: taskConfig.color }}>{taskConfig.icon}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-on-surface truncate">{task.description || task.skill_id}</p>
                  <p className="text-xs text-on-surface-variant">
                    <span className={`font-bold ${statusColor}`}>{task.status}</span>
                    {task.input_tokens ? ` · ${formatTokens(task.input_tokens + (task.output_tokens || 0))} tokens` : ''}
                  </p>
                </div>
                <span className="text-xs text-on-surface-variant shrink-0">
                  {task.completed_at ? formatDate(task.completed_at) : task.started_at ? formatDate(task.started_at) : ''}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ============================================================
   Main Page
   ============================================================ */
export default function AdminConversationsPage() {
  const { token } = useAdminAuth();
  const { t } = useTranslation();
  const [conversations, setConversations] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const fetchConversations = useCallback(() => {
    if (!token) return;
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    if (search) params.set('search', search);
    fetch(`/api/admin/conversations?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(data => {
        setConversations(data.conversations || []);
        setTotal(data.total || 0);
        setTotalPages(data.totalPages || 1);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [token, page, search]);

  useEffect(() => { fetchConversations(); }, [fetchConversations]);

  // Reset page on search change
  useEffect(() => { setPage(1); }, [search]);

  // Detail view
  if (selectedId && token) {
    return (
      <main className="pb-12 px-4 md:px-10 pt-4 md:pt-10">
        <ConversationDetail
          convId={selectedId}
          token={token}
          onBack={() => setSelectedId(null)}
          t={t}
        />
      </main>
    );
  }

  return (
    <main className="pb-12 px-4 md:px-10 pt-4 md:pt-10">
      {/* Header */}
      <div className="mb-6 md:mb-10">
        <div className="max-w-2xl">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-tertiary text-xs md:text-sm font-bold tracking-[0.3em] uppercase">{t('admin.conversations.subtitle' as any)}</span>
            <div className="h-px w-8 md:w-12 bg-tertiary/30" />
          </div>
          <h2 className="text-2xl md:text-4xl font-headline font-bold text-on-surface tracking-tight mb-1 md:mb-2">
            {t('admin.conversations.title' as any)}
          </h2>
          <p className="text-sm md:text-base text-on-surface-variant leading-relaxed">
            {t('admin.conversations.description' as any)}
          </p>
        </div>
      </div>

      {/* Search */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-6 md:mb-8">
        <p className="text-on-surface-variant/60 text-xs md:text-sm uppercase tracking-widest">
          {t('admin.conversations.total' as any, { count: total })}
        </p>
        <div className="relative">
          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-sm">search</span>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t('admin.conversations.search' as any)}
            className="pl-9 pr-4 py-2 bg-surface-container border border-outline-variant/20 rounded text-sm text-on-surface placeholder:text-on-surface-variant/40 focus:outline-none focus:border-primary/40 w-full md:w-72 transition-colors"
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

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-20">
          <div className="w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
        </div>
      )}

      {/* Empty State */}
      {!loading && conversations.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 md:py-20 border border-dashed border-outline-variant/20 rounded-lg">
          <div className="w-14 h-14 md:w-16 md:h-16 rounded-full bg-surface-container flex items-center justify-center mb-4">
            <span className="material-symbols-outlined text-on-surface-variant text-2xl md:text-3xl">
              {search ? 'search_off' : 'forum'}
            </span>
          </div>
          <p className="text-on-surface-variant font-medium uppercase tracking-[0.2em] text-xs md:text-sm">
            {search ? t('admin.conversations.emptySearch' as any) : t('admin.conversations.empty' as any)}
          </p>
        </div>
      )}

      {/* Table */}
      {!loading && conversations.length > 0 && (
        <>
          {/* Desktop Table */}
          <div className="hidden md:block bg-surface-container rounded-lg overflow-hidden">
            <div className="grid grid-cols-[1fr_1.5fr_80px_70px_90px_70px_110px] gap-3 px-6 py-3 bg-surface-container-high text-[11px] font-bold uppercase tracking-widest text-on-surface-variant">
              <span>{t('admin.conversations.table.user' as any)}</span>
              <span>{t('admin.conversations.table.title' as any)}</span>
              <span>{t('admin.conversations.table.type' as any)}</span>
              <span className="text-center">{t('admin.conversations.table.messages' as any)}</span>
              <span className="text-right">{t('admin.conversations.table.tokens' as any)}</span>
              <span className="text-center">{t('admin.conversations.table.files' as any)}</span>
              <span>{t('admin.conversations.table.createdAt' as any)}</span>
            </div>
            <div className="divide-y divide-outline-variant/10">
              {conversations.map(conv => {
                const config = getSkillConfig(conv.skill_id);
                const totalTk = (conv.total_input_tokens || 0) + (conv.total_output_tokens || 0);
                return (
                  <div
                    key={conv.id}
                    className="grid grid-cols-[1fr_1.5fr_80px_70px_90px_70px_110px] gap-3 px-6 py-3 items-center hover:bg-surface-container-high/50 cursor-pointer transition-colors group"
                    onClick={() => setSelectedId(conv.id)}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="w-7 h-7 bg-primary/10 rounded-full flex items-center justify-center shrink-0">
                        <span className="material-symbols-outlined text-primary text-xs">person</span>
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm text-on-surface font-medium truncate">{conv.user_display_name || conv.user_email?.split('@')[0]}</p>
                        <p className="text-[10px] text-on-surface-variant truncate">{conv.user_email}</p>
                      </div>
                    </div>
                    <p className="text-sm text-on-surface truncate">{conv.title}</p>
                    <span className="text-xs font-bold tracking-widest uppercase" style={{ color: config.color }}>{config.label}</span>
                    <span className="text-sm text-on-surface-variant text-center">{conv.message_count || 0}</span>
                    <span className="text-sm text-on-surface-variant text-right font-mono">{totalTk > 0 ? formatTokens(totalTk) : '-'}</span>
                    <span className="text-sm text-on-surface-variant text-center">{conv.file_count || 0}</span>
                    <span className="text-xs text-on-surface-variant">{formatDate(conv.created_at)}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Mobile Card List */}
          <div className="md:hidden flex flex-col gap-2.5">
            {conversations.map(conv => {
              const config = getSkillConfig(conv.skill_id);
              const totalTk = (conv.total_input_tokens || 0) + (conv.total_output_tokens || 0);
              return (
                <div
                  key={conv.id}
                  className="bg-surface-container rounded-lg px-4 py-3.5 active:bg-surface-container-high transition-colors cursor-pointer"
                  onClick={() => setSelectedId(conv.id)}
                >
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded flex items-center justify-center shrink-0" style={{ background: config.bgColor }}>
                      <span className="material-symbols-outlined text-sm" style={{ color: config.color }}>{config.icon}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-on-surface font-medium truncate">{conv.title}</p>
                      <p className="text-xs text-on-surface-variant truncate">{conv.user_display_name || conv.user_email}</p>
                    </div>
                  </div>
                  <div className="flex items-center justify-between mt-2.5 pl-12">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold tracking-wider uppercase" style={{ color: config.color }}>{config.label}</span>
                      <span className="text-on-surface-variant/20">|</span>
                      <span className="text-xs text-on-surface-variant/60">{formatDate(conv.created_at)}</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-on-surface-variant shrink-0">
                      {totalTk > 0 && <span className="font-mono">{formatTokens(totalTk)}</span>}
                      {(conv.file_count || 0) > 0 && (
                        <span className="flex items-center gap-0.5">
                          <span className="material-symbols-outlined" style={{ fontSize: 12 }}>folder</span>
                          {conv.file_count}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="mt-6 md:mt-8 flex items-center justify-center gap-1">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="w-8 h-8 flex items-center justify-center rounded bg-surface-container hover:bg-surface-container-high text-on-surface-variant disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition-colors"
              >
                <span className="material-symbols-outlined text-sm">chevron_left</span>
              </button>
              {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                let p: number;
                if (totalPages <= 7) {
                  p = i + 1;
                } else if (page <= 4) {
                  p = i + 1;
                } else if (page >= totalPages - 3) {
                  p = totalPages - 6 + i;
                } else {
                  p = page - 3 + i;
                }
                return (
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
                );
              })}
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="w-8 h-8 flex items-center justify-center rounded bg-surface-container hover:bg-surface-container-high text-on-surface-variant disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition-colors"
              >
                <span className="material-symbols-outlined text-sm">chevron_right</span>
              </button>
            </div>
          )}
        </>
      )}
    </main>
  );
}
