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
}

interface UsageTotal {
  totalInput: number;
  totalOutput: number;
  totalInvocations: number;
}

interface FileItem {
  id: string;
  filename: string;
  file_type: string;
  file_size: number;
  created_at: string;
}

const DOC_TYPES = [
  { id: 'pptx-gen', label: '簡報', desc: '投影片製作', icon: 'present_to_all', colorClass: 'text-warning' },
  { id: 'docx-gen', label: '文件', desc: '文書撰寫', icon: 'description', colorClass: 'text-tertiary' },
  { id: 'xlsx-gen', label: '試算表', desc: '數據分析', icon: 'table_chart', colorClass: 'text-success' },
  { id: 'pdf-gen', label: 'PDF', desc: '文件輸出', icon: 'picture_as_pdf', colorClass: 'text-error' },
];

const SKILL_ICONS: Record<string, string> = {
  'pptx-gen': 'present_to_all',
  'docx-gen': 'description',
  'xlsx-gen': 'table_chart',
  'pdf-gen': 'picture_as_pdf',
};

const FILE_TYPE_ICONS: Record<string, { icon: string; color: string }> = {
  pptx: { icon: 'present_to_all', color: 'text-warning' },
  docx: { icon: 'description', color: 'text-tertiary' },
  xlsx: { icon: 'table_chart', color: 'text-success' },
  pdf:  { icon: 'picture_as_pdf', color: 'text-error' },
};

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function DashboardContent() {
  const { user, token, isLoading } = useAuth();
  const router = useRouter();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [usage, setUsage] = useState<UsageTotal | null>(null);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [smartInput, setSmartInput] = useState('');
  const [creating, setCreating] = useState(false);
  const sidebarMargin = useSidebarMargin();

  useEffect(() => {
    if (!isLoading && !user) {
      router.replace('/login');
    }
  }, [user, isLoading, router]);

  useEffect(() => {
    if (!token) return;

    fetch('/api/conversations', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(setConversations)
      .catch(console.error);

    fetch('/api/usage', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(data => setUsage(data.total))
      .catch(console.error);

    fetch('/api/files', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(setFiles)
      .catch(console.error);
  }, [token]);

  async function createConversation(skillId?: string, initialMessage?: string) {
    if (!token || creating) return;
    setCreating(true);
    try {
      const docType = DOC_TYPES.find(s => s.id === skillId);
      const title = skillId
        ? `New ${docType?.label || ''} Document`
        : (initialMessage || 'New Conversation').substring(0, 60);
      const res = await fetch('/api/conversations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ title, skillId: skillId || undefined }),
      });
      const conv = await res.json();
      if (initialMessage) {
        sessionStorage.setItem(`pending_message_${conv.id}`, initialMessage);
      }
      router.push(`/chat/${conv.id}`);
    } finally {
      setCreating(false);
    }
  }

  async function handleSmartSubmit() {
    if (!smartInput.trim()) return;
    await createConversation(undefined, smartInput.trim());
  }

  if (isLoading || !user) return null;

  return (
    <div className="min-h-screen bg-surface-container-lowest">
      <Navbar />

      <main className={`${sidebarMargin} min-h-screen flex flex-col transition-all duration-300`}>
        {/* Top Header */}
        <header className="sticky top-0 h-16 bg-surface/80 backdrop-blur-xl flex justify-between items-center px-8 z-40 shadow-[0_1px_0_0_rgba(255,255,255,0.05)]">
          <div className="flex items-center gap-8">
            <span className="text-lg font-black text-on-surface font-headline">儀表板</span>
            <div className="flex items-center gap-6 font-headline font-medium text-xs uppercase tracking-widest">
              <span className="text-tertiary font-bold">Workspace: /workspace/{user.email?.split('@')[0]}</span>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-xs font-bold uppercase tracking-widest text-on-surface-variant">AI 引擎: Claude</span>
            <div className="w-px h-3 bg-outline-variant/30" />
            <span className="text-xs font-bold uppercase tracking-widest text-on-surface-variant">模式: 多代理協作</span>
            <div className="w-px h-3 bg-outline-variant/30" />
            <div className="flex items-center gap-1.5 px-3 py-1 bg-primary/10 rounded-full">
              <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
              <span className="text-xs text-primary font-bold tracking-widest uppercase">運行中</span>
            </div>
          </div>
        </header>

        {/* Content Canvas */}
        <div className="p-8 flex-1 grid grid-cols-12 gap-6 overflow-y-auto">
          {/* ===== Left Column (8 cols) ===== */}
          <div className="col-span-8 flex flex-col gap-6">
            {/* Bento Stats Row */}
            <div className="grid grid-cols-3 gap-6">
              <div className="bg-surface-container p-6 rounded-lg">
                <p className="text-xs uppercase tracking-widest text-on-surface-variant mb-1">本月生成次數</p>
                <div className="flex items-end gap-2">
                  <span className="text-3xl font-headline font-bold text-on-surface">
                    {usage?.totalInvocations ?? 0}
                  </span>
                  <span className="text-xs text-primary mb-1">次</span>
                </div>
                <p className="text-xs text-on-surface-variant mt-3 font-mono">
                  支援: PPTX / DOCX / XLSX / PDF
                </p>
              </div>
              <div className="bg-surface-container p-6 rounded-lg">
                <p className="text-xs uppercase tracking-widest text-on-surface-variant mb-1">Token 用量</p>
                <div className="flex items-center gap-2">
                  <span className="text-3xl font-headline font-bold text-on-surface">
                    {usage ? ((usage.totalInput + usage.totalOutput) / 1000).toFixed(1) + 'k' : '0'}
                  </span>
                  <span className="material-symbols-outlined text-tertiary">check_circle</span>
                </div>
                <p className="text-xs text-on-surface-variant mt-3 font-mono">
                  輸入: {usage ? (usage.totalInput / 1000).toFixed(1) + 'k' : '0'} | 輸出: {usage ? (usage.totalOutput / 1000).toFixed(1) + 'k' : '0'}
                </p>
              </div>
              <div className="bg-surface-container p-6 rounded-lg">
                <p className="text-xs uppercase tracking-widest text-on-surface-variant mb-1">工作區</p>
                <div className="flex items-center gap-2">
                  <span className="text-3xl font-headline font-bold text-on-surface">
                    {conversations.length}
                  </span>
                  <span className="material-symbols-outlined text-on-surface-variant">storage</span>
                </div>
                <p className="text-xs text-on-surface-variant mt-3 font-mono">
                  對話: {conversations.length} | 模式: 多代理協作
                </p>
              </div>
            </div>

            {/* Smart Input */}
            <div className="bg-surface-container rounded-lg overflow-hidden">
              <div className="px-6 py-4 bg-surface-container-high flex items-center gap-3">
                <span className="material-symbols-outlined text-primary">forum</span>
                <span className="text-xs font-bold uppercase tracking-widest">智能指令</span>
                <span className="ml-auto text-xs px-2 py-0.5 bg-primary/10 text-primary rounded font-bold tracking-widest uppercase">
                  AI 自動判斷
                </span>
              </div>
              <div className="p-6">
                <p className="text-sm text-on-surface-variant mb-4">
                  描述你的需求，AI 代理會自動規劃並生成對應的文件
                </p>
                <div className="relative">
                  <textarea
                    className="w-full bg-surface-container-highest border-none focus:ring-1 focus:ring-primary/40 rounded py-4 px-4 pr-16 text-sm text-on-surface placeholder:text-outline font-body resize-none"
                    value={smartInput}
                    onChange={e => setSmartInput(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleSmartSubmit();
                      }
                    }}
                    placeholder="例如：幫我製作一份 10 頁的 AI 趨勢簡報..."
                    rows={2}
                    disabled={creating}
                  />
                  <button
                    className="absolute right-3 bottom-3 w-10 h-10 cyber-gradient rounded flex items-center justify-center text-on-primary disabled:opacity-50 disabled:cursor-not-allowed hover:brightness-110 active:scale-95 transition-all"
                    onClick={handleSmartSubmit}
                    disabled={!smartInput.trim() || creating}
                  >
                    <span className="material-symbols-outlined">send</span>
                  </button>
                </div>
              </div>
            </div>

            {/* Recent Conversations */}
            <div className="bg-surface-container rounded-lg overflow-hidden flex-1">
              <div className="px-6 py-4 bg-surface-container-high flex items-center gap-3">
                <span className="material-symbols-outlined text-on-surface-variant">history</span>
                <span className="text-xs font-bold uppercase tracking-widest">最近對話</span>
                <span className="ml-auto text-xs text-on-surface-variant">
                  {conversations.length} 個對話
                </span>
              </div>

              {conversations.length === 0 ? (
                <div className="p-8 text-center">
                  <span className="material-symbols-outlined text-4xl text-outline-variant block mb-2">chat_bubble_outline</span>
                  <p className="text-sm text-on-surface-variant">還沒有對話紀錄，開始建立你的第一份文件吧！</p>
                </div>
              ) : (
                <div className="divide-y divide-outline-variant/10">
                  {conversations.slice(0, 8).map(conv => (
                    <div
                      key={conv.id}
                      className="flex items-center gap-4 px-6 py-3.5 hover:bg-surface-container-high/50 cursor-pointer transition-colors group"
                      onClick={() => router.push(`/chat/${conv.id}`)}
                    >
                      <div className="w-8 h-8 rounded bg-surface-container-highest flex items-center justify-center shrink-0">
                        <span className="material-symbols-outlined text-sm text-on-surface-variant">
                          {conv.skill_id ? (SKILL_ICONS[conv.skill_id] || 'smart_toy') : 'smart_toy'}
                        </span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-on-surface truncate">{conv.title}</p>
                        <p className="text-xs text-on-surface-variant mt-0.5">
                          {new Date(conv.created_at).toLocaleDateString('zh-TW')}
                        </p>
                      </div>
                      {conv.skill_id && (
                        <span className="text-xs px-2 py-0.5 bg-primary/10 text-primary rounded font-bold tracking-wider uppercase">
                          {conv.skill_id.replace('-gen', '')}
                        </span>
                      )}
                      <span className="material-symbols-outlined text-sm text-outline-variant group-hover:text-primary transition-colors">
                        arrow_forward
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* ===== Right Column (4 cols) ===== */}
          <div className="col-span-4 flex flex-col gap-6">
            {/* Agent Capabilities / Quick Create */}
            <div className="bg-surface-container p-6 rounded-lg">
              <h3 className="text-xs font-bold uppercase tracking-widest mb-6">代理能力</h3>
              <div className="grid grid-cols-2 gap-3">
                {DOC_TYPES.map(doc => (
                  <button
                    key={doc.id}
                    onClick={() => createConversation(doc.id)}
                    disabled={creating}
                    className="bg-surface-container-high p-4 rounded flex flex-col gap-3 hover:bg-surface-variant transition-colors text-left disabled:opacity-50 cursor-pointer"
                  >
                    <span className={`material-symbols-outlined ${doc.colorClass}`}>{doc.icon}</span>
                    <span className="text-xs font-bold text-on-surface">{doc.label}</span>
                    <span className="text-xs text-on-surface-variant">{doc.desc}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Workspace Explorer — shows real generated files */}
            <div className="bg-surface-container-high p-6 rounded-lg flex-1 overflow-hidden flex flex-col">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-xs font-bold uppercase tracking-widest">最近文件</h3>
                <span className="text-xs text-on-surface-variant">{files.length} 個檔案</span>
              </div>
              <div className="flex-1 space-y-2 font-mono text-xs overflow-y-auto">
                {files.length === 0 ? (
                  <p className="text-on-surface-variant text-center py-4">尚無檔案</p>
                ) : (
                  files.slice(0, 10).map(file => {
                    const ext = file.file_type?.toLowerCase() || '';
                    const meta = FILE_TYPE_ICONS[ext] || { icon: 'draft', color: 'text-on-surface-variant' };
                    return (
                      <div
                        key={file.id}
                        className="flex items-center gap-3 p-2 bg-surface-container/50 rounded group cursor-pointer hover:bg-surface-container-highest transition-colors"
                        onClick={() => {
                          window.open(`/api/files/${file.id}/download`, '_blank');
                        }}
                      >
                        <span className={`material-symbols-outlined text-sm ${meta.color}`}>{meta.icon}</span>
                        <span className="flex-1 text-on-surface truncate">{file.filename}</span>
                        <span className="text-[10px] text-on-surface-variant shrink-0">{formatFileSize(file.file_size)}</span>
                      </div>
                    );
                  })
                )}
              </div>
              <div className="mt-4 pt-4 border-t border-outline-variant/10">
                <button
                  onClick={() => router.push('/files')}
                  className="w-full py-2 text-xs font-bold text-on-surface-variant hover:text-on-surface bg-surface-container-highest/50 rounded transition-all flex items-center justify-center gap-2"
                >
                  <span className="material-symbols-outlined text-xs">folder_open</span>
                  瀏覽所有檔案
                </button>
              </div>
            </div>
          </div>
        </div>
      </main>

    </div>
  );
}

export default function DashboardPage() {
  return (
    <AuthProvider>
      <DashboardContent />
    </AuthProvider>
  );
}
