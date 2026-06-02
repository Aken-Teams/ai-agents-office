'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { AuthProvider, useAuth } from '../components/AuthProvider';
import { I18nProvider, useTranslation } from '../../i18n';
import Navbar from '../components/Navbar';
import { useSidebarMargin } from '../hooks/useSidebarCollapsed';
import HelpButton from '../components/HelpButton';

const PAGE_SIZE = 6;

interface AssistantConversation {
  id: string;
  title: string;
  status: string;
  created_at: string;
  category: string;
  summary: string | null;
  agent_instructions: string | null;
}

// Preset assistant templates — prefill name + persona instructions on create.
interface AssistantTemplate {
  id: string;
  icon: string;
  name: string;
  desc: string;
  instructions: string;
}

const ASSISTANT_TEMPLATES: AssistantTemplate[] = [
  {
    id: 'blank', icon: 'add_circle', name: '自訂空白助手', desc: '從零開始,自己寫專長設定。',
    instructions: '',
  },
  {
    id: 'slides', icon: 'slideshow', name: '簡報製作助手', desc: '把主題整理成結構清楚的投影片。',
    instructions: '你是一位專業的簡報製作助手。當使用者給你主題或資料時,先釐清目的與受眾,規劃投影片大綱(封面、目錄、各章節重點、結論),再製作成 PPT。重點:標題精煉、每頁聚焦一個訊息、善用圖表與條列、視覺風格一致專業。',
  },
  {
    id: 'data', icon: 'monitoring', name: '財報/數據分析助手', desc: '解讀數據、算指標、做圖表。',
    instructions: '你是一位數據與財務分析助手。擅長解讀 CSV/Excel/財報數據,計算關鍵指標(成長率、毛利、趨勢),找出洞察並用圖表呈現。回應時先給結論與重點發現,再附上佐證數據與視覺化。需要時產出分析報告或 Excel。',
  },
  {
    id: 'writer', icon: 'edit_document', name: '文件撰寫助手', desc: '公文、報告、商業文件。',
    instructions: '你是一位專業文件撰寫助手。擅長撰寫商業報告、公文、企劃書、說明文件。文字精準、結構清楚、語氣專業得體。完成後可輸出成 Word 文件。撰寫前先確認文件類型、目的與讀者。',
  },
  {
    id: 'cs', icon: 'support_agent', name: '客服文案助手', desc: '客服回覆與行銷文案。',
    instructions: '你是一位客服與行銷文案助手。語氣親切、專業、同理。擅長撰寫客服回覆範本、FAQ、行銷活動文案、社群貼文。回應簡潔有溫度,並依情境提供多個版本供選擇。',
  },
  {
    id: 'research', icon: 'travel_explore', name: '研究調查助手', desc: '蒐集、查證、整理成報告。',
    instructions: '你是一位研究調查助手。擅長針對主題蒐集資料、交叉查證、整理成有條理的研究報告,並附上圖表與來源。回應時區分「已查證事實」與「推論」,避免臆測,必要時主動指出資訊不足之處。',
  },
  {
    id: 'review', icon: 'rule', name: '程式碼審查助手', desc: '審查程式碼、找問題、給建議。',
    instructions: '你是一位資深程式碼審查助手。審查使用者提供的程式碼,聚焦正確性、安全性、可讀性與效能問題。指出具體行數與風險,並給出可行的修正建議與範例。語氣務實、直接、有建設性。',
  },
];

// ── Delete Confirm Modal ────────────────────────────────────────────────────
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

// ── Create / Edit Assistant Modal ────────────────────────────────────────────
function AssistantEditorModal({
  mode, initialTitle, initialInstructions, saving, onSubmit, onCancel,
}: {
  mode: 'create' | 'edit';
  initialTitle: string;
  initialInstructions: string;
  saving: boolean;
  onSubmit: (v: { title: string; instructions: string }) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [instructions, setInstructions] = useState(initialInstructions);
  const [templateId, setTemplateId] = useState<string | null>(mode === 'create' ? 'blank' : null);

  function applyTemplate(tpl: AssistantTemplate) {
    setTemplateId(tpl.id);
    setInstructions(tpl.instructions);
    if (tpl.id !== 'blank') setTitle(tpl.name);
  }

  const canSubmit = title.trim().length > 0 && !saving;

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center p-4" onClick={onCancel}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative bg-surface-container rounded-xl shadow-2xl border border-outline-variant/10 w-full max-w-lg max-h-[88vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="p-6">
          <div className="flex items-center gap-2 mb-5">
            <span className="material-symbols-outlined text-primary">smart_toy</span>
            <h3 className="font-headline font-bold text-lg text-on-surface">
              {mode === 'create' ? '建立 AI 助手' : '助手設定'}
            </h3>
          </div>

          {mode === 'create' && (
            <div className="mb-5">
              <label className="text-xs font-bold text-on-surface-variant uppercase tracking-wider block mb-2">選擇範本</label>
              <div className="grid grid-cols-2 gap-2">
                {ASSISTANT_TEMPLATES.map(tpl => (
                  <button
                    key={tpl.id}
                    onClick={() => applyTemplate(tpl)}
                    className={`flex items-start gap-2 p-2.5 rounded-lg border text-left transition-colors cursor-pointer ${
                      templateId === tpl.id
                        ? 'border-primary bg-primary/10'
                        : 'border-outline-variant/15 bg-surface-container-high hover:border-primary/30'
                    }`}
                  >
                    <span className={`material-symbols-outlined text-lg shrink-0 ${templateId === tpl.id ? 'text-primary' : 'text-on-surface-variant'}`}>{tpl.icon}</span>
                    <span className="min-w-0">
                      <span className="block text-xs font-bold text-on-surface truncate">{tpl.name}</span>
                      <span className="block text-[11px] text-on-surface-variant/70 leading-tight line-clamp-2">{tpl.desc}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <label className="text-xs font-bold text-on-surface-variant uppercase tracking-wider block mb-1.5">助手名稱</label>
          <input
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="例如:簡報製作助手"
            maxLength={80}
            className="w-full bg-surface-container-high border border-outline-variant/30 rounded-lg px-3 py-2 text-sm text-on-surface focus:outline-none focus:border-primary mb-4"
          />

          <label className="text-xs font-bold text-on-surface-variant uppercase tracking-wider block mb-1.5">
            專長 / 任務指令 <span className="text-on-surface-variant/50 normal-case font-normal">(可留空 = 通用助手)</span>
          </label>
          <textarea
            value={instructions}
            onChange={e => setInstructions(e.target.value)}
            placeholder="描述這個助手的專長、語氣、處理任務的方式…例如:你是一位專業簡報助手,擅長把主題整理成結構清楚的投影片。"
            maxLength={4000}
            rows={6}
            className="w-full bg-surface-container-high border border-outline-variant/30 rounded-lg px-3 py-2 text-sm text-on-surface focus:outline-none focus:border-primary resize-none leading-relaxed"
          />
          <p className="text-[11px] text-on-surface-variant/60 mt-1.5">這段指令會成為此助手的設定,影響它如何回應與處理每個任務。</p>
        </div>

        <div className="flex gap-3 px-6 pb-6">
          <button onClick={onCancel} className="flex-1 py-2.5 px-4 bg-surface-container-highest border border-outline-variant/10 text-on-surface font-bold text-sm rounded cursor-pointer hover:bg-surface-variant transition-colors">取消</button>
          <button
            onClick={() => canSubmit && onSubmit({ title: title.trim(), instructions: instructions.trim() })}
            disabled={!canSubmit}
            className="flex-1 py-2.5 px-4 cyber-gradient text-on-primary font-bold text-sm rounded cursor-pointer hover:brightness-110 transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
          >
            {saving && <span className="material-symbols-outlined text-base animate-spin">progress_activity</span>}
            {mode === 'create' ? '建立並開始' : '儲存設定'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Content ───────────────────────────────────────────────────────────
function AssistantContent() {
  const { user, token, isLoading } = useAuth();
  const { t } = useTranslation();
  const router = useRouter();
  const sidebarMargin = useSidebarMargin();
  const [conversations, setConversations] = useState<AssistantConversation[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<AssistantConversation | null>(null);
  const [editor, setEditor] = useState<{ mode: 'create' | 'edit'; conv?: AssistantConversation } | null>(null);
  const [editorSaving, setEditorSaving] = useState(false);
  const [memoryCount, setMemoryCount] = useState(0);
  const [workLogCount, setWorkLogCount] = useState(0);
  const [processingIds, setProcessingIds] = useState<Set<string>>(new Set());
  const [currentPage, setCurrentPage] = useState(1);

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
        Promise.all(convs.map((c: AssistantConversation) =>
          fetch(`/api/generate/${c.id}/status`, { headers: { Authorization: `Bearer ${token}` } })
            .then(r => r.json())
            .then(({ processing }: { processing: boolean }) => processing ? c.id : null)
            .catch(() => null)
        )).then(results => {
          setProcessingIds(new Set<string>(results.filter(Boolean) as string[]));
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

  async function handleEditorSubmit({ title, instructions }: { title: string; instructions: string }) {
    if (!token || editorSaving || !editor) return;
    setEditorSaving(true);
    try {
      if (editor.mode === 'create') {
        const res = await fetch('/api/conversations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ title, category: 'assistant', instructions }),
        });
        const conv = await res.json();
        router.push(`/chat/${conv.id}`);
      } else if (editor.conv) {
        const targetId = editor.conv.id;
        await fetch(`/api/conversations/${targetId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ title, instructions }),
        });
        setConversations(prev => prev.map(c => c.id === targetId ? { ...c, title, agent_instructions: instructions || null } : c));
        setEditor(null);
      }
    } finally {
      setEditorSaving(false);
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
    // Adjust page if last item on page was deleted
    const remaining = conversations.length - 1;
    const maxPage = Math.max(1, Math.ceil(remaining / PAGE_SIZE));
    if (currentPage > maxPage) setCurrentPage(maxPage);
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

  const totalPages = Math.max(1, Math.ceil(conversations.length / PAGE_SIZE));
  const pageConvs = conversations.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  return (
    <div className="min-h-screen bg-surface-container-lowest">
      <Navbar />
      {deleteTarget && (
        <DeleteConfirmModal title={deleteTarget.title} onConfirm={handleDelete} onCancel={() => setDeleteTarget(null)} />
      )}
      {editor && (
        <AssistantEditorModal
          mode={editor.mode}
          initialTitle={editor.mode === 'edit' ? (editor.conv?.title ?? '') : ''}
          initialInstructions={editor.mode === 'edit' ? (editor.conv?.agent_instructions ?? '') : ''}
          saving={editorSaving}
          onSubmit={handleEditorSubmit}
          onCancel={() => setEditor(null)}
        />
      )}

      <main className={`${sidebarMargin} md:pt-10 pb-12 px-4 md:px-10 transition-all duration-300`}>
        {/* Header */}
        <div className="mt-4 md:mt-0 mb-8 md:mb-12">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
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
              {memoryCount > 0 && (
                <div className="mt-4 inline-flex items-center gap-2 px-3 py-1.5 bg-tertiary/10 border border-tertiary/20 rounded-full text-sm text-tertiary">
                  <span className="material-symbols-outlined text-base">psychology</span>
                  <span className="font-medium">{t('assistant.memoryBadge' as any)}</span>
                  <span className="text-tertiary/70">
                    {workLogCount > 0
                      ? `偏好 ${memoryCount - workLogCount} · 工作紀錄 ${workLogCount}`
                      : `${memoryCount} 條`}
                  </span>
                </div>
              )}
            </div>

            {/* New assistant button */}
            <button
              onClick={() => setEditor({ mode: 'create' })}
              className="shrink-0 flex items-center gap-2 px-4 py-2.5 cyber-gradient text-on-primary rounded-xl font-bold text-sm hover:brightness-110 active:scale-95 transition-all cursor-pointer shadow-sm mt-1 md:mt-2"
            >
              <span className="material-symbols-outlined text-base">add</span>
              <span className="hidden sm:inline">新增助手</span>
            </button>
          </div>
        </div>

        {/* Grid */}
        {conversations.length === 0 ? (
          /* Empty state */
          <button
            onClick={() => setEditor({ mode: 'create' })}
            className="w-full group flex flex-col items-center justify-center gap-4 bg-surface-container/40 rounded-2xl border-2 border-dashed border-outline-variant/25 hover:border-primary/40 hover:bg-surface-container/70 transition-all min-h-[260px] cursor-pointer p-8"
          >
            <div className="w-16 h-16 rounded-2xl border-2 border-dashed border-outline-variant/40 flex items-center justify-center group-hover:border-primary/50 group-hover:bg-primary/5 transition-colors">
              <span className="material-symbols-outlined text-outline-variant group-hover:text-primary transition-colors text-3xl">add</span>
            </div>
            <div className="text-center">
              <p className="text-base font-bold font-headline text-on-surface-variant group-hover:text-primary transition-colors">
                {t('assistant.newChat' as any) || '建立第一個 AI 助手'}
              </p>
              <p className="text-sm text-outline mt-1">點擊開始與 AI 助手對話</p>
            </div>
          </button>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-6">
            {pageConvs.map((conv, idx) => {
              const globalIdx = (currentPage - 1) * PAGE_SIZE + idx;
              return (
                <div
                  key={conv.id}
                  className="group relative flex flex-col bg-surface-container rounded-2xl border border-outline-variant/10 hover:border-primary/30 transition-all overflow-hidden"
                >
                  <div className="h-1 cyber-gradient w-full" />
                  <div className="p-5 flex flex-col flex-1">
                    <div className="flex items-start justify-between mb-4">
                      <div className="relative">
                        <div className="w-12 h-12 rounded-xl cyber-gradient flex items-center justify-center">
                          <span className="material-symbols-outlined text-on-primary text-2xl">smart_toy</span>
                        </div>
                        <span className="absolute -top-0.5 -right-0.5 w-3 h-3 bg-success rounded-full border-2 border-surface-container">
                          <span className="absolute inset-0 rounded-full bg-success animate-ping opacity-60" />
                        </span>
                      </div>
                      <span className="text-xs font-mono font-bold text-on-surface-variant bg-surface-container-high px-2 py-0.5 rounded-full">
                        #{globalIdx + 1}
                      </span>
                    </div>

                    <h3 className="font-headline font-bold text-on-surface text-base mb-1 group-hover:text-primary transition-colors line-clamp-1">
                      {conv.title}
                    </h3>

                    {conv.summary ? (
                      <p className="text-xs text-on-surface-variant/80 line-clamp-2 mb-2 leading-relaxed">{conv.summary}</p>
                    ) : (
                      <p className="text-xs text-outline/50 mb-2 italic">{t('assistant.noSummary' as any) || '對話中...'}</p>
                    )}

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
                      {conv.agent_instructions && (
                        <>
                          <span className="text-outline-variant/40">·</span>
                          <span className="flex items-center gap-1 text-primary">
                            <span className="material-symbols-outlined text-[13px]">tune</span>
                            專長助手
                          </span>
                        </>
                      )}
                    </div>

                    <div className="mt-auto flex items-center gap-2">
                      <Link
                        href={`/chat/${conv.id}`}
                        className="flex-1 flex items-center justify-center gap-1.5 py-2 cyber-gradient text-on-primary rounded-lg text-sm font-bold font-headline hover:brightness-110 active:scale-95 transition-all no-underline"
                      >
                        <span className="material-symbols-outlined text-base">chat</span>
                        {t('assistant.openChat' as any) || '開啟對話'}
                      </Link>
                      <button
                        onClick={() => setEditor({ mode: 'edit', conv })}
                        className="w-9 h-9 flex items-center justify-center rounded-lg text-on-surface-variant hover:text-primary hover:bg-primary/10 transition-colors cursor-pointer border border-outline-variant/10"
                        title="助手設定"
                      >
                        <span className="material-symbols-outlined text-[18px]">tune</span>
                      </button>
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
              );
            })}
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-2 mt-8">
            <button
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              className="w-9 h-9 flex items-center justify-center rounded-lg border border-outline-variant/20 text-on-surface-variant hover:bg-surface-container hover:text-on-surface transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <span className="material-symbols-outlined text-base">chevron_left</span>
            </button>
            {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
              <button
                key={p}
                onClick={() => setCurrentPage(p)}
                className={`w-9 h-9 flex items-center justify-center rounded-lg text-sm font-bold transition-colors cursor-pointer ${
                  p === currentPage
                    ? 'cyber-gradient text-on-primary'
                    : 'border border-outline-variant/20 text-on-surface-variant hover:bg-surface-container hover:text-on-surface'
                }`}
              >
                {p}
              </button>
            ))}
            <button
              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
              className="w-9 h-9 flex items-center justify-center rounded-lg border border-outline-variant/20 text-on-surface-variant hover:bg-surface-container hover:text-on-surface transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <span className="material-symbols-outlined text-base">chevron_right</span>
            </button>
          </div>
        )}

        {/* Bottom info */}
        <div className="mt-6 flex flex-wrap items-center gap-4 text-xs text-on-surface-variant">
          <div className="flex items-center gap-1.5">
            <span className="material-symbols-outlined text-sm text-primary">info</span>
            <span>共 {conversations.length} 個助手，對話永久保留直到你刪除</span>
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
