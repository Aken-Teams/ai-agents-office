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

/** Parse [CHOICES]...[/CHOICES] blocks from assistant messages */
function parseChoices(content: string): { text: string; choices: string[] } {
  const match = content.match(/\[CHOICES\]\s*([\s\S]*?)\s*\[\/CHOICES\]/);
  if (!match) return { text: content, choices: [] };
  const choices = match[1]
    .split('\n')
    .map(line => line.replace(/^[-•*]\s*/, '').trim())
    .filter(Boolean);
  const text = content.replace(/\[CHOICES\][\s\S]*?\[\/CHOICES\]/, '').trim();
  return { text, choices };
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
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function calcCost(input: number, output: number): number {
  return ((input / 1_000_000 * 3) + (output / 1_000_000 * 15)) * 10;
}

function formatCost(cost: number): string {
  if (cost < 0.01) return '-';
  return '$' + cost.toFixed(2);
}

function toUTC(dateStr: string): Date {
  if (!dateStr) return new Date(0);
  const s = dateStr.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(dateStr) ? dateStr : dateStr.replace(' ', 'T') + 'Z';
  return new Date(s);
}

function formatDate(d: string) {
  return toUTC(d).toLocaleString('zh-TW', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatSize(bytes: number) {
  if (bytes >= 1_048_576) return (bytes / 1_048_576).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}

const PAGE_SIZE = 15;

/* ============================================================
   Detail Panel (shared between desktop sidebar & mobile overlay)
   ============================================================ */
function ConversationDetailPanel({
  convId, token, onClose, t,
}: {
  convId: string;
  token: string;
  onClose: () => void;
  t: (key: any, params?: any) => string;
}) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'messages' | 'files' | 'uploads' | 'tasks'>('messages');
  const [toast, setToast] = useState<string | null>(null);
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());
  const [expandedMessages, setExpandedMessages] = useState<Set<string>>(new Set());

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
    setActiveTab('messages');
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
    <div className="text-center py-20 text-on-surface-variant">Failed to load.</div>
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
    <>
      {/* Header: Title + User + Skill */}
      <div className="flex flex-col md:flex-row md:items-center gap-2 md:gap-3 px-4 md:px-8 py-4 border-b border-outline-variant/10">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0" style={{ background: config.bgColor }}>
            <span className="material-symbols-outlined" style={{ color: config.color, fontSize: 20 }}>{config.icon}</span>
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-bold text-on-surface truncate">{data.title}</h3>
            <div className="flex items-center gap-2 mt-0.5 overflow-hidden">
              <span className="text-sm text-on-surface-variant truncate">{data.user_display_name || data.user_email}</span>
              <span className="text-on-surface-variant/30 shrink-0">·</span>
              <span className="text-xs font-mono text-on-surface-variant truncate">{data.user_email}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 ml-[52px] md:ml-0 shrink-0">
          <span className="px-2 py-0.5 text-xs font-bold uppercase tracking-wider rounded" style={{ background: config.bgColor, color: config.color }}>{config.label}</span>
          <span className={`px-2 py-0.5 text-xs font-bold uppercase tracking-wider rounded ${data.status === 'active' ? 'bg-success/15 text-success' : 'bg-surface-container text-on-surface-variant'}`}>
            {data.status || 'active'}
          </span>
          <span className="text-xs text-on-surface-variant ml-2">{formatDate(data.created_at)}</span>
        </div>
      </div>

      {/* Stats Row — right-aligned on desktop, compact grid on mobile */}
      <div className="px-4 md:px-8 py-3 border-b border-outline-variant/10 grid grid-cols-3 gap-2 md:flex md:items-center md:justify-end md:gap-5">
        <div className="flex items-center gap-1.5">
          <span className="material-symbols-outlined text-on-surface-variant" style={{ fontSize: 16 }}>chat</span>
          <span className="text-xs md:text-sm font-bold text-on-surface">{data.messages?.length ?? 0}</span>
          <span className="text-xs md:text-sm text-on-surface-variant">{t('admin.conversations.detail.messages')}</span>
        </div>
        <span className="text-outline-variant/30 hidden md:inline">|</span>
        <div className="flex items-center gap-1 md:gap-1.5 col-span-2 md:col-span-1 justify-end md:justify-start">
          <span className="material-symbols-outlined text-on-surface-variant" style={{ fontSize: 16 }}>token</span>
          <span className="text-xs md:text-sm text-on-surface-variant">{t('admin.conversations.detail.inputTokens' as any)}</span>
          <span className="text-xs md:text-sm font-bold text-on-surface font-mono">{formatTokens(data.tokenUsage?.total_input ?? 0)}</span>
          <span className="text-xs md:text-sm text-on-surface-variant">{t('admin.conversations.detail.outputTokens' as any)}</span>
          <span className="text-xs md:text-sm font-bold text-on-surface font-mono">{formatTokens(data.tokenUsage?.total_output ?? 0)}</span>
          {calcCost(data.tokenUsage?.total_input ?? 0, data.tokenUsage?.total_output ?? 0) >= 0.01 && (
            <span className="text-xs md:text-sm font-bold text-success font-mono">
              ({formatCost(calcCost(data.tokenUsage?.total_input ?? 0, data.tokenUsage?.total_output ?? 0))})
            </span>
          )}
        </div>
        <span className="text-outline-variant/30 hidden md:inline">|</span>
        <div className="flex items-center gap-1.5 col-start-1 md:col-start-auto">
          <span className="material-symbols-outlined text-on-surface-variant" style={{ fontSize: 16 }}>folder</span>
          <span className="text-xs md:text-sm font-bold text-on-surface">{data.files?.length ?? 0}</span>
          <span className="text-xs md:text-sm text-on-surface-variant">{t('admin.conversations.detail.files')}</span>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center border-b border-outline-variant/10 px-2 md:px-4">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex-1 md:flex-none flex flex-col md:flex-row items-center gap-0.5 md:gap-1.5 px-1 md:px-4 py-2 md:py-3 text-[10px] md:text-sm font-bold transition-colors cursor-pointer ${
              activeTab === tab.key
                ? 'text-primary border-b-2 border-primary'
                : 'text-on-surface-variant hover:text-on-surface'
            }`}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>{tab.icon}</span>
            <span className="truncate max-w-full">{tab.label}<span className="ml-0.5 md:ml-1 opacity-60">{tab.count}</span></span>
          </button>
        ))}
      </div>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 left-4 right-4 md:left-1/2 md:right-auto md:-translate-x-1/2 z-50 flex items-center gap-2 px-4 py-3 rounded-xl bg-error text-on-error text-sm font-medium shadow-lg animate-[slideUp_0.2s_ease-out]">
          <span className="material-symbols-outlined" style={{ fontSize: 18 }}>error</span>
          {toast}
          <button onClick={() => setToast(null)} className="ml-2 w-6 h-6 flex items-center justify-center rounded-full hover:bg-on-error/20 cursor-pointer">
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>close</span>
          </button>
        </div>
      )}

      {/* Tab Content */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {activeTab === 'messages' && (
          <div className="p-4 md:p-6 space-y-4">
            {data.messages?.length === 0 && (
              <p className="text-center py-8 text-on-surface-variant text-sm">{t('admin.conversations.detail.noMessages')}</p>
            )}
            {data.messages?.map((msg: any) => {
              const isUser = msg.role === 'user';
              const isSystem = msg.role === 'system';
              const isLong = msg.content?.length > 3000;
              const isMsgExpanded = expandedMessages.has(msg.id);
              const displayContent = isLong && !isMsgExpanded ? msg.content.slice(0, 3000) : msg.content;
              return (
                <div key={msg.id} className={`flex gap-2.5 ${isUser ? 'flex-row-reverse' : ''}`}>
                  <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${
                    isUser ? 'bg-primary/15' : isSystem ? 'bg-outline-variant/20' : 'bg-tertiary/15'
                  }`}>
                    <span className={`material-symbols-outlined ${
                      isUser ? 'text-primary' : isSystem ? 'text-outline' : 'text-tertiary'
                    }`} style={{ fontSize: 14 }}>
                      {isUser ? 'person' : isSystem ? 'settings' : 'smart_toy'}
                    </span>
                  </div>
                  <div className={`min-w-0 ${isUser ? '' : 'max-w-3xl'}`}>
                    <div className={`flex items-center gap-2 mb-1 ${isUser ? 'justify-end' : ''}`}>
                      <span className={`text-xs font-bold uppercase tracking-widest ${
                        isUser ? 'text-primary' : isSystem ? 'text-outline' : 'text-tertiary'
                      }`}>
                        {t(`admin.conversations.role.${msg.role}` as any)}
                      </span>
                      <span className="text-[11px] text-on-surface-variant">{formatDate(msg.created_at)}</span>
                      {isLong && (
                        <span className="text-[10px] text-on-surface-variant">({Math.round(msg.content.length / 1000)}k chars)</span>
                      )}
                    </div>
                    <div className={`rounded-xl px-3 py-2.5 text-sm leading-relaxed break-words ${
                      isUser
                        ? 'bg-primary/8 border border-primary/15 text-on-surface whitespace-pre-wrap'
                        : isSystem
                          ? 'bg-surface-container-high/50 border border-outline-variant/10 text-on-surface-variant text-xs opacity-60 whitespace-pre-wrap'
                          : 'bg-surface-container border border-outline-variant/10 text-on-surface chat-markdown'
                    }`}>
                      {isUser || isSystem
                        ? displayContent
                        : (() => {
                            const { text: msgText, choices } = parseChoices(displayContent);
                            return (
                              <>
                                <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{msgText}</ReactMarkdown>
                                {choices.length > 0 && (
                                  <div className="flex flex-wrap gap-1.5 mt-2 pt-2 border-t border-outline-variant/10">
                                    {choices.map((choice, ci) => (
                                      <span key={ci} className="px-2.5 py-1.5 text-xs rounded-lg border border-primary/20 bg-primary/5 text-primary">
                                        {choice}
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </>
                            );
                          })()
                      }
                      {isLong && (
                        <button
                          onClick={() => setExpandedMessages(prev => {
                            const next = new Set(prev);
                            if (next.has(msg.id)) next.delete(msg.id); else next.add(msg.id);
                            return next;
                          })}
                          className="mt-2 flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition-colors cursor-pointer"
                        >
                          <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
                            {isMsgExpanded ? 'expand_less' : 'expand_more'}
                          </span>
                          {isMsgExpanded ? t('admin.conversations.detail.collapse' as any) : t('admin.conversations.detail.expand' as any)}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {activeTab === 'files' && (
          <div className="p-4 md:p-6 space-y-2">
            {data.files?.length === 0 && (
              <p className="text-center py-8 text-on-surface-variant text-sm">{t('admin.conversations.detail.noFiles')}</p>
            )}
            {data.files?.map((file: any) => {
              const fc = getSkillConfig(file.file_type === 'html' ? 'webapp-gen' : `${file.file_type}-gen`);
              return (
                <div key={file.id} className="flex items-center gap-3 py-2.5 px-3 rounded-lg hover:bg-surface-container/50 transition-colors group">
                  <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: fc.bgColor }}>
                    <span className="material-symbols-outlined" style={{ fontSize: 18, color: fc.color }}>draft</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-on-surface font-medium truncate">{file.filename}</p>
                    <p className="text-xs text-on-surface-variant">{formatSize(file.file_size)} · v{file.version || 1}</p>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      fetch(`/api/admin/files/${file.id}/download`, {
                        headers: { Authorization: `Bearer ${token}` },
                      })
                        .then(r => {
                          if (!r.ok) throw new Error(r.status === 404 ? '檔案不存在或已被刪除' : `下載失敗 (${r.status})`);
                          return r.blob();
                        })
                        .then(blob => {
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement('a');
                          a.href = url;
                          a.download = file.filename;
                          document.body.appendChild(a);
                          a.click();
                          a.remove();
                          URL.revokeObjectURL(url);
                        })
                        .catch(err => {
                          setToast(err instanceof Error ? err.message : '下載失敗');
                          setTimeout(() => setToast(null), 4000);
                        });
                    }}
                    className="md:opacity-0 md:group-hover:opacity-100 w-8 h-8 flex items-center justify-center rounded-lg hover:bg-primary/10 text-primary cursor-pointer transition-all shrink-0"
                    title="Download"
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 18 }}>download</span>
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {activeTab === 'uploads' && (
          <div className="p-4 md:p-6 space-y-2">
            {data.uploads?.length === 0 && (
              <p className="text-center py-8 text-on-surface-variant text-sm">{t('admin.conversations.detail.noUploads')}</p>
            )}
            {data.uploads?.map((upload: any) => (
              <div key={upload.id} className="flex items-center gap-3 py-2.5 px-3 rounded-lg hover:bg-surface-container/50 transition-colors">
                <div className="w-9 h-9 rounded-lg bg-surface-container flex items-center justify-center shrink-0">
                  <span className="material-symbols-outlined text-on-surface-variant" style={{ fontSize: 18 }}>upload_file</span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-on-surface font-medium truncate">{upload.original_name || upload.filename}</p>
                  <p className="text-xs text-on-surface-variant">{formatSize(upload.file_size)}</p>
                </div>
              </div>
            ))}
          </div>
        )}

        {activeTab === 'tasks' && (
          <div className="p-3 md:p-6 space-y-2 md:space-y-3">
            {data.tasks?.length === 0 && (
              <p className="text-center py-8 text-on-surface-variant text-sm">{t('admin.conversations.detail.noTasks')}</p>
            )}
            {data.tasks?.map((task: any) => {
              const taskConfig = getSkillConfig(task.skill_id);
              const statusIcon = task.status === 'completed' ? 'check_circle' : task.status === 'failed' ? 'error' : 'pending';
              const statusColor = task.status === 'completed' ? 'text-success' : task.status === 'failed' ? 'text-error' : 'text-warning';
              const isExpanded = expandedTasks.has(task.id);
              return (
                <div key={task.id} className="rounded-xl border border-outline-variant/10 bg-surface-container/30 overflow-hidden">
                  <button
                    onClick={() => setExpandedTasks(prev => {
                      const next = new Set(prev);
                      if (next.has(task.id)) next.delete(task.id); else next.add(task.id);
                      return next;
                    })}
                    className="w-full flex items-center gap-2 md:gap-3 px-3 md:px-4 py-2.5 md:py-3 cursor-pointer hover:bg-surface-container/50 transition-colors"
                  >
                    <div className="w-7 h-7 md:w-8 md:h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: taskConfig.bgColor }}>
                      <span className="material-symbols-outlined" style={{ fontSize: 14, color: taskConfig.color }}>{taskConfig.icon}</span>
                    </div>
                    <span className="text-xs font-bold uppercase tracking-wider" style={{ color: taskConfig.color }}>{taskConfig.label}</span>
                    <span className={`ml-auto flex items-center gap-1 text-xs font-bold ${statusColor}`}>
                      <span className="material-symbols-outlined" style={{ fontSize: 14 }}>{statusIcon}</span>
                      {task.status}
                    </span>
                    {task.description && (
                      <span className="material-symbols-outlined text-on-surface-variant transition-transform" style={{ fontSize: 18, transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }}>expand_more</span>
                    )}
                  </button>
                  {task.description && isExpanded && (
                    <div className="px-3 md:px-4 py-2.5 md:py-3 text-sm text-on-surface leading-relaxed chat-markdown border-t border-outline-variant/10">
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{task.description}</ReactMarkdown>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
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
  const limit = PAGE_SIZE;

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

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setPage(1);
    fetchConversations();
  }

  /* ---- Detail full-page view ---- */
  if (selectedId && token) {
    return (
      <>
        {/* Header with back button */}
        <header className="sticky top-0 h-14 md:h-16 bg-surface/80 backdrop-blur-xl flex items-center gap-3 px-4 md:px-8 z-40 shadow-[0_1px_0_0_rgba(255,255,255,0.05)]">
          <button
            onClick={() => setSelectedId(null)}
            className="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-surface-container text-on-surface-variant cursor-pointer"
          >
            <span className="material-symbols-outlined">arrow_back</span>
          </button>
          <span className="text-base md:text-lg font-black text-on-surface font-headline">{t('admin.conversations.detail.title' as any)}</span>
        </header>

        <div className="flex-1 overflow-y-auto flex flex-col">
          <ConversationDetailPanel
            convId={selectedId}
            token={token}
            onClose={() => setSelectedId(null)}
            t={t}
          />
        </div>
      </>
    );
  }

  /* ---- List view ---- */
  return (
    <>
      {/* Header — matches users page sticky top bar */}
      <header className="sticky top-0 h-14 md:h-16 bg-surface/80 backdrop-blur-xl flex justify-between items-center px-4 md:px-8 z-40 shadow-[0_1px_0_0_rgba(255,255,255,0.05)]">
        <div className="flex items-center gap-2 md:gap-4">
          <span className="text-base md:text-lg font-black text-on-surface font-headline">{t('admin.conversations.title' as any)}</span>
          <span className="text-xs md:text-sm text-on-surface-variant font-mono">{t('admin.conversations.total' as any, { count: total })}</span>
        </div>
      </header>

      <div className="flex-1 flex flex-col p-4 md:p-8 overflow-hidden">
        {/* Search */}
        <div className="flex flex-col md:flex-row md:items-center gap-3 md:gap-4 mb-4 md:mb-6">
          <form onSubmit={handleSearch} className="flex-1 relative">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline text-sm">search</span>
            <input
              className="w-full bg-surface-container-highest border-none focus:ring-1 focus:ring-primary/40 rounded py-2.5 pl-10 pr-4 text-sm text-on-surface placeholder:text-outline font-body"
              placeholder={t('admin.conversations.search' as any)}
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(1); }}
            />
          </form>
        </div>

        {/* Desktop Table */}
        <div className="hidden md:block flex-1 overflow-y-auto">
          <table className="w-full">
            <thead className="sticky top-0 bg-surface-container-lowest">
              <tr className="text-left text-sm uppercase tracking-widest text-on-surface-variant">
                <th className="py-3 px-4 font-bold">{t('admin.conversations.table.user' as any)}</th>
                <th className="py-3 px-4 font-bold">{t('admin.conversations.table.title' as any)}</th>
                <th className="py-3 px-4 font-bold">{t('admin.conversations.table.type' as any)}</th>
                <th className="py-3 px-4 font-bold text-center">{t('admin.conversations.table.messages' as any)}</th>
                <th className="py-3 px-4 font-bold text-right">{t('admin.conversations.table.tokens' as any)}</th>
                <th className="py-3 px-4 font-bold text-right">{t('admin.conversations.table.files' as any)}</th>
                <th className="py-3 px-4 font-bold">{t('admin.conversations.table.createdAt' as any)}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/10">
              {conversations.map(conv => {
                const config = getSkillConfig(conv.skill_id);
                const totalTk = (conv.total_input_tokens || 0) + (conv.total_output_tokens || 0);
                return (
                  <tr
                    key={conv.id}
                    className="hover:bg-surface-container/50 cursor-pointer transition-colors"
                    onClick={() => setSelectedId(conv.id)}
                  >
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded bg-primary/15 flex items-center justify-center text-sm font-bold text-primary shrink-0">
                          {(conv.user_display_name || conv.user_email || 'U')[0].toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm text-on-surface font-medium truncate">{conv.user_display_name || conv.user_email?.split('@')[0]}</p>
                          <p className="text-sm text-on-surface-variant font-mono truncate">{conv.user_email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="py-3 px-4 text-sm text-on-surface truncate max-w-[300px]">{conv.title}</td>
                    <td className="py-3 px-4">
                      <span className="text-xs font-bold uppercase tracking-wider" style={{ color: config.color }}>{config.label}</span>
                    </td>
                    <td className="py-3 px-4 text-center text-sm text-on-surface-variant">{conv.message_count || 0}</td>
                    <td className="py-3 px-4 text-right text-sm font-mono">
                      <span className="text-on-surface">{totalTk > 0 ? formatTokens(totalTk) : '-'}</span>
                      {calcCost(conv.total_input_tokens || 0, conv.total_output_tokens || 0) >= 0.01 && (
                        <span className="text-xs text-success ml-1">({formatCost(calcCost(conv.total_input_tokens || 0, conv.total_output_tokens || 0))})</span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right text-sm text-on-surface-variant">{conv.file_count || 0}</td>
                    <td className="py-3 px-4 text-sm text-on-surface-variant font-mono">
                      {toUTC(conv.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}
                    </td>
                  </tr>
                );
              })}
              {!loading && conversations.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-on-surface-variant">
                    {search ? t('admin.conversations.emptySearch' as any) : t('admin.conversations.empty' as any)}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Mobile Card List */}
        <div className="md:hidden flex-1 overflow-y-auto -mx-4 px-4 space-y-2">
          {conversations.map(conv => {
            const config = getSkillConfig(conv.skill_id);
            const totalTk = (conv.total_input_tokens || 0) + (conv.total_output_tokens || 0);
            return (
              <div
                key={conv.id}
                className="bg-surface-container rounded-lg p-3 active:bg-surface-container-high transition-colors cursor-pointer"
                onClick={() => setSelectedId(conv.id)}
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg flex items-center justify-center text-sm font-black shrink-0" style={{ background: config.bgColor, color: config.color }}>
                    <span className="material-symbols-outlined text-sm">{config.icon}</span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-bold text-on-surface truncate">{conv.title}</p>
                      <span className="text-[10px] font-bold uppercase tracking-wider shrink-0" style={{ color: config.color }}>{config.label}</span>
                    </div>
                    <p className="text-xs text-on-surface-variant font-mono truncate">{conv.user_display_name || conv.user_email}</p>
                  </div>
                </div>
                <div className="flex items-center gap-4 mt-2 ml-[52px] text-[11px] text-on-surface-variant">
                  <span className="font-mono">
                    {totalTk > 0 ? formatTokens(totalTk) : '-'}
                    {calcCost(conv.total_input_tokens || 0, conv.total_output_tokens || 0) >= 0.01 && (
                      <span className="text-success ml-1">({formatCost(calcCost(conv.total_input_tokens || 0, conv.total_output_tokens || 0))})</span>
                    )}
                  </span>
                  <span>{conv.message_count || 0} msg</span>
                  <span>{conv.file_count || 0} {t('admin.conversations.table.files' as any)}</span>
                  <span className="ml-auto font-mono">{toUTC(conv.created_at).toLocaleDateString('zh-TW')}</span>
                </div>
              </div>
            );
          })}
          {!loading && conversations.length === 0 && (
            <div className="py-12 text-center text-on-surface-variant text-sm">
              {search ? t('admin.conversations.emptySearch' as any) : t('admin.conversations.empty' as any)}
            </div>
          )}
        </div>

        {/* Loading */}
        {loading && conversations.length === 0 && (
          <div className="flex items-center justify-center py-20">
            <div className="w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
          </div>
        )}

        {/* Pagination — matches users page style */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between pt-4 border-t border-outline-variant/10 mt-4">
            <span className="text-xs md:text-sm text-on-surface-variant hidden md:block">
              {t('admin.conversations.pagination.summary' as any, { start: (page - 1) * limit + 1, end: Math.min(page * limit, total), total })}
            </span>
            <span className="text-xs text-on-surface-variant md:hidden">{page}/{totalPages}</span>
            <div className="flex gap-1">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="px-2.5 md:px-3 py-1.5 text-xs md:text-sm bg-surface-container text-on-surface-variant rounded disabled:opacity-30 cursor-pointer hover:bg-surface-container-high transition-colors"
              >
                {t('common.prev')}
              </button>
              {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
                let p: number;
                if (totalPages <= 5) {
                  p = i + 1;
                } else if (page <= 3) {
                  p = i + 1;
                } else if (page >= totalPages - 2) {
                  p = totalPages - 4 + i;
                } else {
                  p = page - 2 + i;
                }
                return (
                  <button
                    key={p}
                    onClick={() => setPage(p)}
                    className={`px-2.5 md:px-3 py-1.5 text-xs md:text-sm rounded cursor-pointer transition-colors ${
                      page === p
                        ? 'bg-primary/15 text-primary font-bold'
                        : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high'
                    }`}
                  >
                    {p}
                  </button>
                );
              })}
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="px-2.5 md:px-3 py-1.5 text-xs md:text-sm bg-surface-container text-on-surface-variant rounded disabled:opacity-30 cursor-pointer hover:bg-surface-container-high transition-colors"
              >
                {t('common.next')}
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
