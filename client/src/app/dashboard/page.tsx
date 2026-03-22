'use client';

import { useState, useEffect, useRef } from 'react';
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
  { id: 'pptx-gen', labelKey: 'nav.docTypes.pptx.label' as const, descKey: 'nav.docTypes.pptx.desc' as const, icon: 'present_to_all', colorClass: 'text-warning' },
  { id: 'docx-gen', labelKey: 'nav.docTypes.docx.label' as const, descKey: 'nav.docTypes.docx.desc' as const, icon: 'description', colorClass: 'text-tertiary' },
  { id: 'xlsx-gen', labelKey: 'nav.docTypes.xlsx.label' as const, descKey: 'nav.docTypes.xlsx.desc' as const, icon: 'table_chart', colorClass: 'text-success' },
  { id: 'pdf-gen', labelKey: 'nav.docTypes.pdf.label' as const, descKey: 'nav.docTypes.pdf.desc' as const, icon: 'picture_as_pdf', colorClass: 'text-error' },
  { id: 'data-analyst', labelKey: 'nav.docTypes.dataAnalyst.label' as const, descKey: 'nav.docTypes.dataAnalyst.desc' as const, icon: 'analytics', colorClass: 'text-primary' },
  { id: 'research', labelKey: 'nav.docTypes.research.label' as const, descKey: 'nav.docTypes.research.desc' as const, icon: 'travel_explore', colorClass: 'text-on-surface-variant' },
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
  const { t } = useTranslation();
  const router = useRouter();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [usage, setUsage] = useState<UsageTotal | null>(null);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [smartInput, setSmartInput] = useState('');
  const [creating, setCreating] = useState(false);
  const [smartAttached, setSmartAttached] = useState<Array<{ id: string; name: string; uploading?: boolean }>>([]);
  const smartFileRef = useRef<HTMLInputElement>(null);
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
        ? `New ${docType ? t(docType.labelKey) : ''} Document`
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
    setSmartAttached([]);
  }

  async function handleSmartFileAttach(fileList: FileList | null) {
    if (!fileList || fileList.length === 0 || !token) return;
    const filesArr = Array.from(fileList);

    const placeholders = filesArr.map(f => ({
      id: `tmp-${Date.now()}-${f.name}`,
      name: f.name,
      uploading: true,
    }));
    setSmartAttached(prev => [...prev, ...placeholders]);

    try {
      const formData = new FormData();
      for (const f of filesArr) formData.append('files', f);
      const resp = await fetch('/api/uploads', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      const data = await resp.json();
      if (!resp.ok) {
        alert(data.error || '上傳失敗');
        setSmartAttached(prev => prev.filter(f => !f.uploading));
        return;
      }
      const uploaded = (data.uploads || [])
        .filter((u: any) => u.scanStatus !== 'rejected')
        .map((u: any) => ({ id: u.id, name: u.originalName, uploading: false }));
      const rejected = (data.uploads || []).filter((u: any) => u.scanStatus === 'rejected');
      if (rejected.length > 0) alert(`安全掃描攔截了 ${rejected.length} 個檔案`);
      setSmartAttached(prev => [...prev.filter(f => !f.uploading), ...uploaded]);
    } catch {
      setSmartAttached(prev => prev.filter(f => !f.uploading));
      alert('上傳失敗');
    }
  }

  if (isLoading || !user) return null;

  return (
    <div className="min-h-screen bg-surface-container-lowest">
      <Navbar />

      <main className={`${sidebarMargin} transition-all duration-300`}>
        {/* Top Header */}
        <header className="sticky top-0 h-16 bg-surface/80 backdrop-blur-xl flex justify-between items-center px-8 z-40 shadow-[0_1px_0_0_rgba(255,255,255,0.05)]">
          <div className="flex items-center gap-8">
            <span className="text-lg font-black text-on-surface font-headline">{t('dashboard.title')}</span>
            <div className="flex items-center gap-6 font-headline font-medium text-sm uppercase tracking-widest">
              <span className="text-tertiary font-bold">Workspace: /workspace/{user.email?.split('@')[0]}</span>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm font-bold uppercase tracking-widest text-on-surface-variant">{t('dashboard.engineLabel')}</span>
            <div className="w-px h-3 bg-outline-variant/30" />
            <span className="text-sm font-bold uppercase tracking-widest text-on-surface-variant">{t('dashboard.modeLabel')}</span>
            <div className="w-px h-3 bg-outline-variant/30" />
            <div className="flex items-center gap-1.5 px-3 py-1 bg-primary/10 rounded-full">
              <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
              <span className="text-sm text-primary font-bold tracking-widest uppercase">{t('dashboard.statusRunning')}</span>
            </div>
          </div>
        </header>

        {/* Content Canvas */}
        <div className="p-8 grid grid-cols-12 gap-6">
          {/* ===== Left Column (8 cols) ===== */}
          <div className="col-span-8 flex flex-col gap-6">
            {/* Bento Stats Row */}
            <div className="grid grid-cols-3 gap-6">
              <div className="bg-surface-container p-6 rounded-lg">
                <p className="text-sm uppercase tracking-widest text-on-surface-variant mb-1">{t('dashboard.stats.invocationsTitle')}</p>
                <div className="flex items-end gap-2">
                  <span className="text-3xl font-headline font-bold text-on-surface">
                    {usage?.totalInvocations ?? 0}
                  </span>
                  <span className="text-sm text-primary mb-1">{t('dashboard.stats.invocationsUnit')}</span>
                </div>
                <p className="text-sm text-on-surface-variant mt-3 font-mono">
                  {t('dashboard.stats.invocationsFormats')}
                </p>
              </div>
              <div className="bg-surface-container p-6 rounded-lg">
                <p className="text-sm uppercase tracking-widest text-on-surface-variant mb-1">{t('dashboard.stats.tokenTitle')}</p>
                <div className="flex items-end gap-3">
                  <span className="text-3xl font-headline font-bold text-on-surface">
                    {usage ? ((usage.totalInput + usage.totalOutput) / 1000).toFixed(1) + 'k' : '0'}
                  </span>
                  <span className="text-lg font-headline font-bold text-success mb-0.5">
                    ${usage ? (((usage.totalInput * 3 + usage.totalOutput * 15) / 1_000_000) * 10).toFixed(2) : '0.00'}
                    <span className="text-sm text-on-surface-variant font-normal ml-1">(USD)</span>
                  </span>
                </div>
                <p className="text-sm text-on-surface-variant mt-3 font-mono">
                  {t('dashboard.stats.tokenInputLabel')}: {usage ? (usage.totalInput / 1000).toFixed(1) + 'k' : '0'} | {t('dashboard.stats.tokenOutputLabel')}: {usage ? (usage.totalOutput / 1000).toFixed(1) + 'k' : '0'}
                </p>
              </div>
              <div className="bg-surface-container p-6 rounded-lg">
                <p className="text-sm uppercase tracking-widest text-on-surface-variant mb-1">{t('dashboard.stats.conversationsTitle')}</p>
                <div className="flex items-center gap-2">
                  <span className="text-3xl font-headline font-bold text-on-surface">
                    {conversations.length}
                  </span>
                  <span className="material-symbols-outlined text-on-surface-variant">chat</span>
                </div>
                <p className="text-sm text-on-surface-variant mt-3 font-mono">
                  {t('dashboard.stats.conversationsActive')}: {conversations.filter(c => c.status === 'active').length} | {t('dashboard.stats.conversationsMode')}
                </p>
              </div>
            </div>

            {/* Smart Input */}
            <div className="bg-surface-container rounded-lg overflow-hidden flex flex-col flex-1">
              <div className="px-6 py-4 bg-surface-container-high flex items-center gap-3">
                <span className="material-symbols-outlined text-primary">forum</span>
                <span className="text-sm font-bold uppercase tracking-widest">{t('dashboard.smartInput.title')}</span>
                <span className="ml-auto text-sm px-2 py-0.5 bg-primary/10 text-primary rounded font-bold tracking-widest uppercase">
                  {t('dashboard.smartInput.badge')}
                </span>
              </div>
              <div className="p-6 flex flex-col flex-1">
                <p className="text-sm text-on-surface-variant mb-4">
                  {t('dashboard.smartInput.description')}
                </p>
                {/* Attached files chips */}
                {smartAttached.length > 0 && (
                  <div className="flex flex-wrap gap-2 mb-3">
                    {smartAttached.map(file => (
                      <div key={file.id} className="flex items-center gap-1.5 px-2.5 py-1 rounded text-sm bg-primary/10 border border-primary/20 text-primary">
                        {file.uploading ? (
                          <span className="material-symbols-outlined text-sm animate-spin">progress_activity</span>
                        ) : (
                          <span className="material-symbols-outlined text-sm">attach_file</span>
                        )}
                        <span className="max-w-[120px] truncate">{file.name}</span>
                        {!file.uploading && (
                          <button
                            onClick={() => setSmartAttached(prev => prev.filter(f => f.id !== file.id))}
                            className="hover:text-error transition-colors cursor-pointer ml-0.5"
                          >
                            <span className="material-symbols-outlined text-sm">close</span>
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                <div className="relative flex-1 flex flex-col">
                  <input
                    ref={smartFileRef}
                    type="file"
                    multiple
                    accept=".csv,.xlsx,.xls,.pdf,.txt,.md,.json,.docx,.doc"
                    className="hidden"
                    onChange={e => { handleSmartFileAttach(e.target.files); e.target.value = ''; }}
                  />
                  <textarea
                    className="w-full flex-1 bg-surface-container-highest border-none focus:ring-1 focus:ring-primary/40 rounded py-4 pl-12 pr-16 text-sm text-on-surface placeholder:text-outline font-body resize-none"
                    value={smartInput}
                    onChange={e => setSmartInput(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault();
                        handleSmartSubmit();
                      }
                    }}
                    placeholder={t('dashboard.smartInput.placeholder')}
                    disabled={creating}
                  />
                  <button
                    className="absolute left-3 bottom-3 w-9 h-9 flex items-center justify-center rounded hover:bg-surface-container text-on-surface-variant hover:text-primary transition-colors cursor-pointer"
                    onClick={() => smartFileRef.current?.click()}
                    title={t('dashboard.smartInput.uploadTooltip')}
                  >
                    <span className="material-symbols-outlined text-lg">attach_file</span>
                  </button>
                  <button
                    className="absolute right-3 bottom-3 w-10 h-10 cyber-gradient rounded flex items-center justify-center text-on-primary disabled:opacity-50 disabled:cursor-not-allowed hover:brightness-110 active:scale-95 transition-all"
                    onClick={handleSmartSubmit}
                    disabled={!smartInput.trim() || creating}
                  >
                    <span className="material-symbols-outlined">send</span>
                  </button>
                </div>
                {/* Sample prompts / templates */}
                {!smartInput.trim() && (
                  <div className="flex flex-wrap gap-2 mt-4">
                    {[
                      {
                        icon: 'present_to_all',
                        labelKey: 'dashboard.samples.pptx' as const,
                        template: `幫我製作一份 10 頁的 AI 趨勢簡報（PPT），包含以下內容：
1. 封面：標題「2026 AI 產業趨勢報告」
2. 目錄頁
3. AI 產業整體市場規模與成長預測
4. 生成式 AI 技術發展現況（LLM、多模態）
5. 企業 AI 導入案例與成效分析
6. AI Agent 與自動化工作流趨勢
7. AI 安全與法規治理最新動態
8. 台灣 AI 產業機會與挑戰
9. 未來 3 年關鍵預測
10. 總結與建議

風格：專業商務風格，使用圖表與數據視覺化`,
                      },
                      {
                        icon: 'description',
                        labelKey: 'dashboard.samples.docx' as const,
                        template: `幫我撰寫一份產品需求規格文件（PRD），使用 Word 格式，包含以下章節：

1. 產品概述：產品名稱、目標用戶、核心價值主張
2. 專案背景：市場痛點、競品分析、商業目標
3. 功能需求清單：依優先級（P0/P1/P2）列出主要功能
4. 使用者故事：至少 5 個核心使用情境
5. 非功能性需求：效能、安全性、可用性要求
6. 技術架構建議：前後端技術選型
7. 時程規劃：里程碑與交付時間表
8. 風險評估：潛在風險與應對方案

請使用繁體中文，格式清晰、具專業感`,
                      },
                      {
                        icon: 'table_chart',
                        labelKey: 'dashboard.samples.xlsx' as const,
                        template: `幫我建立一份銷售數據分析 Excel 報表，包含以下工作表：

【Sheet 1 - 月度銷售總覽】
- 欄位：月份、營收、成本、毛利、毛利率、訂單數、客單價
- 產生 12 個月的模擬數據（2025/01 ~ 2025/12）
- 加入合計列與平均值

【Sheet 2 - 產品分類分析】
- 欄位：產品類別、銷售額、佔比、同期比較、成長率
- 至少 5 個產品類別

【Sheet 3 - 區域業績排行】
- 欄位：區域、業務員、目標額、實際額、達成率
- 依達成率排序

請加入適當的格式設定（數字格式、粗體標題、顏色區分）`,
                      },
                      {
                        icon: 'travel_explore',
                        labelKey: 'dashboard.samples.research' as const,
                        template: `請幫我研究 2026 年 AI 產業最新趨勢，並整理成一份完整的研究報告，涵蓋以下面向：

1. 全球 AI 市場規模與投資趨勢
2. 大型語言模型（LLM）技術突破與新進展
3. AI Agent 生態系發展現況
4. 企業 AI 導入率與 ROI 分析
5. AI 對各產業的影響（製造、金融、醫療、教育）
6. AI 監管法規最新動態（歐盟 AI Act、美國行政令）
7. 台灣 AI 產業政策與機會
8. 值得關注的 AI 新創公司

請提供具體數據與來源，使用繁體中文撰寫`,
                      },
                    ].map(sample => (
                      <button
                        key={sample.labelKey}
                        onClick={() => setSmartInput(sample.template)}
                        className="flex items-center gap-2 px-3 py-2 bg-surface-container-highest/50 border border-outline-variant/10 rounded-lg text-sm text-on-surface-variant hover:text-on-surface hover:bg-surface-container-highest hover:border-primary/20 transition-all cursor-pointer"
                      >
                        <span className="material-symbols-outlined text-sm text-primary/60">{sample.icon}</span>
                        {t(sample.labelKey)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

          </div>

          {/* ===== Right Column (4 cols) ===== */}
          <div className="col-span-4 flex flex-col gap-6">
            {/* Recent Files */}
            <div className="bg-surface-container-high p-6 rounded-lg overflow-hidden flex flex-col">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-sm font-bold uppercase tracking-widest">{t('dashboard.recentFiles.title')}</h3>
                <span className="text-sm font-mono text-primary bg-primary/10 px-2 py-0.5 rounded-full">{t('dashboard.recentFiles.count', { count: files.length })}</span>
              </div>
              <div className="space-y-2 font-mono text-sm">
                {files.length === 0 ? (
                  <p className="text-on-surface-variant text-center py-4">{t('dashboard.recentFiles.empty')}</p>
                ) : (
                  files.slice(0, 4).map(file => {
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
                        <span className="text-sm text-on-surface-variant shrink-0">{formatFileSize(file.file_size)}</span>
                      </div>
                    );
                  })
                )}
              </div>
              <div className="mt-4 pt-4 border-t border-outline-variant/10">
                <button
                  onClick={() => router.push('/files')}
                  className="w-full py-2 text-sm font-bold text-on-surface-variant hover:text-on-surface bg-surface-container-highest/50 rounded transition-all flex items-center justify-center gap-2"
                >
                  <span className="material-symbols-outlined text-sm">folder_open</span>
                  {t('dashboard.recentFiles.browseAll')}
                </button>
              </div>
            </div>

            {/* Recent Conversations */}
            <div className="bg-surface-container rounded-lg overflow-hidden flex flex-col">
              <div className="px-6 py-4 bg-surface-container-high flex items-center gap-3">
                <span className="material-symbols-outlined text-on-surface-variant">history</span>
                <span className="text-sm font-bold uppercase tracking-widest">{t('dashboard.recentConversations.title')}</span>
                <span className="ml-auto text-sm font-mono text-primary bg-primary/10 px-2 py-0.5 rounded-full">
                  {t('dashboard.recentConversations.count', { count: conversations.length })}
                </span>
              </div>

              {conversations.length === 0 ? (
                <div className="p-8 text-center">
                  <span className="material-symbols-outlined text-4xl text-outline-variant block mb-2">chat_bubble_outline</span>
                  <p className="text-sm text-on-surface-variant">{t('dashboard.recentConversations.empty')}</p>
                </div>
              ) : (
                <div className="divide-y divide-outline-variant/10">
                  {conversations.slice(0, 4).map(conv => (
                    <div
                      key={conv.id}
                      className="flex items-center gap-3 px-5 py-3 hover:bg-surface-container-high/50 cursor-pointer transition-colors group"
                      onClick={() => router.push(`/chat/${conv.id}`)}
                    >
                      <div className="w-7 h-7 rounded bg-surface-container-highest flex items-center justify-center shrink-0">
                        <span className="material-symbols-outlined text-sm text-on-surface-variant">
                          {conv.skill_id ? (SKILL_ICONS[conv.skill_id] || 'smart_toy') : 'smart_toy'}
                        </span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-on-surface truncate">{conv.title}</p>
                        <p className="text-sm text-on-surface-variant mt-0.5">
                          {new Date(conv.created_at).toLocaleDateString('zh-TW')}
                        </p>
                      </div>
                      {conv.skill_id && (
                        <span className="text-sm px-1.5 py-0.5 bg-primary/10 text-primary rounded font-bold tracking-wider uppercase">
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
        </div>
      </main>

    </div>
  );
}

function DashboardWithI18n() {
  const { user } = useAuth();
  return (
    <I18nProvider initialLocale={user?.locale} initialTheme={user?.theme}>
      <DashboardContent />
    </I18nProvider>
  );
}

export default function DashboardPage() {
  return (
    <AuthProvider>
      <DashboardWithI18n />
    </AuthProvider>
  );
}
