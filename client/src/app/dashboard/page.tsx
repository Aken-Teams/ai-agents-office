'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { AuthProvider, useAuth } from '../components/AuthProvider';
import UploadAlertModal, { type UploadAlertItem } from '../components/UploadAlertModal';
import GreetingPopup from '../components/GreetingPopup';
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
  { id: 'slides-gen', labelKey: 'nav.docTypes.slides.label' as const, descKey: 'nav.docTypes.slides.desc' as const, icon: 'slideshow', colorClass: 'text-secondary' },
  { id: 'webapp-gen', labelKey: 'nav.docTypes.webapp.label' as const, descKey: 'nav.docTypes.webapp.desc' as const, icon: 'dashboard', colorClass: 'text-primary' },
  { id: 'data-analyst', labelKey: 'nav.docTypes.dataAnalyst.label' as const, descKey: 'nav.docTypes.dataAnalyst.desc' as const, icon: 'analytics', colorClass: 'text-primary' },
  { id: 'rag-analyst', labelKey: 'nav.docTypes.ragAnalyst.label' as const, descKey: 'nav.docTypes.ragAnalyst.desc' as const, icon: 'hub', colorClass: 'text-tertiary' },
  { id: 'research', labelKey: 'nav.docTypes.research.label' as const, descKey: 'nav.docTypes.research.desc' as const, icon: 'travel_explore', colorClass: 'text-on-surface-variant' },
];

const SKILL_ICONS: Record<string, string> = {
  'pptx-gen': 'present_to_all',
  'docx-gen': 'description',
  'xlsx-gen': 'table_chart',
  'pdf-gen': 'picture_as_pdf',
  'slides-gen': 'slideshow',
  'webapp-gen': 'dashboard',
  'rag-analyst': 'hub',
};

const FILE_TYPE_ICONS: Record<string, { icon: string; color: string }> = {
  pptx: { icon: 'present_to_all', color: 'text-warning' },
  docx: { icon: 'description', color: 'text-tertiary' },
  xlsx: { icon: 'table_chart', color: 'text-success' },
  pdf:  { icon: 'picture_as_pdf', color: 'text-error' },
  html: { icon: 'slideshow', color: 'text-secondary' },
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
  const [uploadAlerts, setUploadAlerts] = useState<UploadAlertItem[]>([]);
  const smartFileRef = useRef<HTMLInputElement>(null);
  const mobileFileRef = useRef<HTMLInputElement>(null);
  const sidebarMargin = useSidebarMargin();
  const [showGreeting, setShowGreeting] = useState(false);

  useEffect(() => {
    if (!isLoading && !user) {
      router.replace('/login');
    }
  }, [user, isLoading, router]);

  // Show greeting popup once per login (skip if muted today)
  useEffect(() => {
    if (!token || !user) return;
    const today = new Date().toISOString().slice(0, 10);
    if (localStorage.getItem(`greeting_muted_${user.id}`) === today) return;
    const loginId = localStorage.getItem('greeting_login_id');
    if (!loginId) return;
    if (localStorage.getItem('greeting_shown_for') === loginId) return;
    const timer = setTimeout(() => setShowGreeting(true), 600);
    return () => clearTimeout(timer);
  }, [token, user]);

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
      // Pass upload IDs from smart input to chat page
      if (smartAttached.length > 0) {
        const validFiles = smartAttached.filter(f => !f.uploading);
        if (validFiles.length > 0) {
          sessionStorage.setItem(`pending_uploads_${conv.id}`, JSON.stringify(validFiles));
        }
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
        setUploadAlerts([{
          fileName: '',
          status: data.code === 'UPLOAD_QUOTA_EXCEEDED' ? 'quota' : 'error',
          detail: data.error || t('chat.error.uploadFailed'),
        }]);
        setSmartAttached(prev => prev.filter(f => !f.uploading));
        return;
      }
      const allUploads = data.uploads || [];
      const uploaded = allUploads
        .filter((u: any) => u.scanStatus !== 'rejected')
        .map((u: any) => ({ id: u.id, name: u.originalName, uploading: false }));
      // Show modal for rejected/suspicious files
      const alertItems: UploadAlertItem[] = allUploads
        .filter((u: any) => u.scanStatus === 'rejected' || u.scanStatus === 'suspicious')
        .map((u: any) => ({
          fileName: u.originalName,
          status: u.scanStatus as 'rejected' | 'suspicious',
          detail: u.scanDetail || '',
        }));
      if (alertItems.length > 0) setUploadAlerts(alertItems);
      setSmartAttached(prev => [...prev.filter(f => !f.uploading), ...uploaded]);
    } catch {
      setSmartAttached(prev => prev.filter(f => !f.uploading));
      setUploadAlerts([{ fileName: '', status: 'error', detail: t('chat.error.uploadRetry') }]);
    }
  }

  if (isLoading || !user) return null;

  return (
    <div className="min-h-screen bg-surface-container-lowest">
      <Navbar />

      {/* Upload Security Alert Modal */}
      {uploadAlerts.length > 0 && (
        <UploadAlertModal items={uploadAlerts} onClose={() => setUploadAlerts([])} />
      )}

      {/* AI Greeting Popup (once per session) */}
      {showGreeting && (
        <GreetingPopup
          userName={user.displayName || user.email?.split('@')[0] || ''}
          userId={user.id}
          onClose={() => setShowGreeting(false)}
        />
      )}

      <main className={`${sidebarMargin} transition-all duration-300`}>
        {/* Top Header — desktop only as sticky bar, mobile as simple inline header */}
        <header className="sticky top-0 h-16 bg-surface/80 backdrop-blur-xl hidden md:flex justify-between items-center px-8 z-40 shadow-[0_1px_0_0_rgba(255,255,255,0.05)]">
          <div className="flex items-center gap-8">
            <span className="text-lg font-black text-on-surface font-headline">{t('dashboard.title')}</span>
            <div className="flex items-center gap-6 font-headline font-medium text-sm uppercase tracking-widest">
              <span className="text-tertiary font-bold">Workspace: /workspace/{user.email?.split('@')[0]}</span>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1.5 px-3 py-1 bg-primary/10 rounded-full">
              <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
              <span className="text-sm text-primary font-bold tracking-widest uppercase">{t('dashboard.statusRunning')}</span>
            </div>
          </div>
        </header>

        {/* ===== Mobile Dashboard (md:hidden) ===== */}
        <div className="md:hidden px-4 pt-5 pb-36 space-y-5">
          {/* Greeting */}
          <div className="px-1">
            <h2 className="text-2xl font-headline font-bold text-on-surface leading-tight">
              {t('dashboard.mobile.greeting', { name: user.displayName || user.email?.split('@')[0] || '' })}
            </h2>
            <p className="text-sm text-on-surface-variant mt-1">
              {t('dashboard.mobile.guidance')}
            </p>
          </div>

          {/* Template Wizard button */}
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('open-template-wizard'))}
            className="flex items-center gap-3 w-full px-4 py-3.5 bg-surface-container rounded-2xl active:bg-surface-container-high transition-colors cursor-pointer"
          >
            <div className="w-10 h-10 rounded-xl cyber-gradient flex items-center justify-center shrink-0">
              <span className="material-symbols-outlined text-on-primary text-xl">auto_fix_high</span>
            </div>
            <div className="text-left">
              <span className="text-sm font-headline font-bold text-on-surface">{t('dashboard.templateWizard' as any)}</span>
              <p className="text-xs text-on-surface-variant mt-0.5">{t('dashboard.templateWizard.desc' as any)}</p>
            </div>
            <span className="material-symbols-outlined text-on-surface-variant ml-auto">chevron_right</span>
          </button>

          {/* Sample Prompt Cards — 2 per row, fills input on tap */}
          <div className="grid grid-cols-2 gap-3">
            {[
              { icon: 'present_to_all', color: 'text-warning', labelKey: 'dashboard.samples.pptx' as const, templateKey: 'dashboard.samples.pptx.template' as const },
              { icon: 'description', color: 'text-tertiary', labelKey: 'dashboard.samples.docx' as const, templateKey: 'dashboard.samples.docx.template' as const },
              { icon: 'table_chart', color: 'text-success', labelKey: 'dashboard.samples.xlsx' as const, templateKey: 'dashboard.samples.xlsx.template' as const },
              { icon: 'picture_as_pdf', color: 'text-error', labelKey: 'dashboard.samples.pdf' as const, templateKey: 'dashboard.samples.pdf.template' as const },
              { icon: 'slideshow', color: 'text-secondary', labelKey: 'dashboard.samples.slides' as const, templateKey: 'dashboard.samples.slides.template' as const },
              { icon: 'bar_chart', color: 'text-primary', labelKey: 'dashboard.samples.chart' as const, templateKey: 'dashboard.samples.chart.template' as const },
              { icon: 'upload_file', color: 'text-tertiary', labelKey: 'dashboard.samples.data' as const, templateKey: 'dashboard.samples.data.template' as const },
              { icon: 'travel_explore', color: 'text-on-surface-variant', labelKey: 'dashboard.samples.research' as const, templateKey: 'dashboard.samples.research.template' as const },
            ].map(sample => (
              <button
                key={sample.labelKey}
                onClick={() => setSmartInput(t(sample.templateKey))}
                className="flex flex-col gap-2.5 p-4 bg-surface-container rounded-2xl text-left active:bg-surface-container-high transition-colors cursor-pointer"
              >
                <span className={`material-symbols-outlined text-2xl ${sample.color}`}>{sample.icon}</span>
                <span className="text-[13px] font-headline font-bold text-on-surface leading-snug">{t(sample.labelKey)}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Mobile fixed bottom input bar */}
        <div className="md:hidden fixed bottom-0 left-0 right-0 z-40 border-t border-outline-variant/10 bg-surface-container-lowest px-3 pt-2.5 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <input
            ref={mobileFileRef}
            type="file"
            multiple
            accept=".csv,.xlsx,.xls,.pdf,.txt,.md,.json,.docx,.doc,.pptx,.ppt,.png,.jpg,.jpeg,.gif,.webp,.bmp,.svg,.tiff,.tif,.ico,.xml,.yaml,.yml,.html,.htm"
            className="hidden"
            onChange={e => { handleSmartFileAttach(e.target.files); e.target.value = ''; }}
          />
          {/* Attached files */}
          {smartAttached.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {smartAttached.map(file => (
                <div key={file.id} className="flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-primary/10 border border-primary/20 text-primary">
                  {file.uploading ? (
                    <span className="material-symbols-outlined text-xs animate-spin">progress_activity</span>
                  ) : (
                    <span className="material-symbols-outlined text-xs">attach_file</span>
                  )}
                  <span className="max-w-[100px] truncate">{file.name}</span>
                  {!file.uploading && (
                    <button
                      onClick={() => setSmartAttached(prev => prev.filter(f => f.id !== file.id))}
                      className="cursor-pointer"
                    >
                      <span className="material-symbols-outlined text-xs">close</span>
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="flex items-end gap-2">
            <button
              className="shrink-0 w-9 h-9 flex items-center justify-center rounded-full text-on-surface-variant active:bg-surface-container transition-colors cursor-pointer mb-px"
              onClick={() => mobileFileRef.current?.click()}
            >
              <span className="material-symbols-outlined text-[20px]">attach_file</span>
            </button>
            <div className="flex-1">
              <textarea
                className="w-full bg-surface-container border-none focus:ring-1 focus:ring-primary/30 rounded-2xl py-3 px-4 text-sm text-on-surface placeholder:text-outline font-body resize-none min-h-[90px] max-h-[120px] leading-snug"
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
                rows={2}
                style={{ fieldSizing: 'content' } as React.CSSProperties}
              />
            </div>
            <button
              className="shrink-0 w-9 h-9 cyber-gradient rounded-full flex items-center justify-center text-on-primary disabled:opacity-40 disabled:cursor-not-allowed active:scale-95 transition-all mb-px"
              onClick={handleSmartSubmit}
              disabled={!smartInput.trim() || creating}
            >
              <span className="material-symbols-outlined text-[20px]">arrow_upward</span>
            </button>
          </div>
        </div>

        {/* ===== Desktop Dashboard ===== */}
        <div className="hidden md:flex flex-col h-[calc(100vh-3.5rem)]">
          {/* Stats bar — flat inline strip */}
          <div className="flex items-center gap-6 px-8 py-3 shrink-0 text-sm text-on-surface-variant border-b border-outline-variant/10">
            <div className="flex items-center gap-1.5">
              <span className="material-symbols-outlined text-primary text-base">description</span>
              <span className="font-medium">{t('dashboard.stats.invocationsTitle')}</span>
              <span className="font-headline font-bold text-on-surface">{usage?.totalInvocations ?? 0}</span>
              <span className="text-primary font-bold">{t('dashboard.stats.invocationsUnit')}</span>
            </div>
            <div className="w-px h-4 bg-outline-variant/20" />
            <div className="flex items-center gap-1.5">
              <span className="material-symbols-outlined text-success text-base">token</span>
              <span className="font-medium">{t('dashboard.stats.tokenTitle')}</span>
              <span className="font-headline font-bold text-on-surface">{usage ? ((usage.totalInput + usage.totalOutput) / 1000).toFixed(1) + 'k' : '0'}</span>
              <span className="font-bold text-success">${usage ? (((usage.totalInput * 3 + usage.totalOutput * 15) / 1_000_000) * 10).toFixed(2) : '0.00'}</span>
              <span className="text-xs text-on-surface-variant/60 font-mono">{t('dashboard.stats.tokenInputLabel')}: {usage ? (usage.totalInput / 1000).toFixed(1) + 'k' : '0'} / {t('dashboard.stats.tokenOutputLabel')}: {usage ? (usage.totalOutput / 1000).toFixed(1) + 'k' : '0'}</span>
            </div>
            <div className="w-px h-4 bg-outline-variant/20" />
            <div className="flex items-center gap-1.5">
              <span className="material-symbols-outlined text-tertiary text-base">chat</span>
              <span className="font-medium">{t('dashboard.stats.conversationsTitle')}</span>
              <span className="font-headline font-bold text-on-surface">{conversations.length}</span>
              <span className="text-xs bg-surface-container-high px-2 py-0.5 rounded-full">{t('dashboard.stats.conversationsMode')}</span>
            </div>
          </div>

          {/* Center content — greeting + template cards */}
          <div className="flex-1 flex flex-col items-center justify-center px-8 gap-5">
            <div className="text-center">
              <h2 className="text-2xl font-headline font-bold text-on-surface">
                {t('dashboard.mobile.greeting', { name: user.displayName || user.email?.split('@')[0] || '' })}
              </h2>
              <p className="text-[13px] text-on-surface-variant mt-1.5">
                {t('dashboard.mobile.guidance')}
              </p>
            </div>

            {/* Template Wizard button */}
            <button
              onClick={() => window.dispatchEvent(new CustomEvent('open-template-wizard'))}
              className="flex items-center gap-3 px-4 py-3 bg-surface-container rounded-xl hover:bg-surface-container-high border border-transparent hover:border-primary/20 transition-all cursor-pointer group max-w-4xl w-full"
            >
              <div className="w-10 h-10 rounded-xl cyber-gradient flex items-center justify-center shrink-0 group-hover:scale-105 transition-transform">
                <span className="material-symbols-outlined text-on-primary text-xl">auto_fix_high</span>
              </div>
              <div className="text-left">
                <span className="text-sm font-headline font-bold text-on-surface group-hover:text-primary transition-colors">{t('dashboard.templateWizard' as any)}</span>
                <p className="text-xs text-on-surface-variant mt-0.5">{t('dashboard.templateWizard.desc' as any)}</p>
              </div>
              <span className="material-symbols-outlined text-on-surface-variant ml-auto group-hover:text-primary transition-colors">chevron_right</span>
            </button>

            {/* 4x2 Template cards */}
            <div className="grid grid-cols-4 gap-3 w-full max-w-4xl">
              {[
                { icon: 'present_to_all', color: 'text-warning', bg: 'bg-warning/10', labelKey: 'dashboard.samples.pptx' as const, templateKey: 'dashboard.samples.pptx.template' as const },
                { icon: 'description', color: 'text-tertiary', bg: 'bg-tertiary/10', labelKey: 'dashboard.samples.docx' as const, templateKey: 'dashboard.samples.docx.template' as const },
                { icon: 'table_chart', color: 'text-success', bg: 'bg-success/10', labelKey: 'dashboard.samples.xlsx' as const, templateKey: 'dashboard.samples.xlsx.template' as const },
                { icon: 'picture_as_pdf', color: 'text-error', bg: 'bg-error/10', labelKey: 'dashboard.samples.pdf' as const, templateKey: 'dashboard.samples.pdf.template' as const },
                { icon: 'slideshow', color: 'text-secondary', bg: 'bg-secondary/10', labelKey: 'dashboard.samples.slides' as const, templateKey: 'dashboard.samples.slides.template' as const },
                { icon: 'bar_chart', color: 'text-primary', bg: 'bg-primary/10', labelKey: 'dashboard.samples.chart' as const, templateKey: 'dashboard.samples.chart.template' as const },
                { icon: 'upload_file', color: 'text-tertiary', bg: 'bg-tertiary/10', labelKey: 'dashboard.samples.data' as const, templateKey: 'dashboard.samples.data.template' as const },
                { icon: 'travel_explore', color: 'text-on-surface-variant', bg: 'bg-on-surface-variant/10', labelKey: 'dashboard.samples.research' as const, templateKey: 'dashboard.samples.research.template' as const },
              ].map(sample => (
                <button
                  key={sample.labelKey}
                  onClick={() => setSmartInput(t(sample.templateKey))}
                  className="flex flex-col gap-2 p-4 bg-surface-container rounded-xl text-left hover:bg-surface-container-high hover:border-primary/20 border border-transparent transition-all cursor-pointer group"
                >
                  <span className={`material-symbols-outlined text-xl ${sample.color}`}>{sample.icon}</span>
                  <span className="text-[13px] font-headline font-bold text-on-surface leading-snug group-hover:text-primary transition-colors">{t(sample.labelKey)}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Bottom input bar */}
          <div className="shrink-0 px-8 pb-6 pt-4">
            <div className="w-full max-w-4xl mx-auto">
              {/* Attached files chips */}
              {smartAttached.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-2">
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
              <div className="relative bg-surface-container rounded-xl border border-outline-variant/20 focus-within:border-primary/40 transition-all">
                <input
                  ref={smartFileRef}
                  type="file"
                  multiple
                  accept=".csv,.xlsx,.xls,.pdf,.txt,.md,.json,.docx,.doc,.pptx,.ppt,.png,.jpg,.jpeg,.gif,.webp,.bmp,.svg,.tiff,.tif,.ico,.xml,.yaml,.yml,.html,.htm"
                  className="hidden"
                  onChange={e => { handleSmartFileAttach(e.target.files); e.target.value = ''; }}
                />
                <textarea
                  className="w-full bg-transparent border-none focus:ring-0 py-3 pl-12 pr-14 text-sm text-on-surface placeholder:text-outline font-body resize-none min-h-[80px] max-h-[160px] min-[1920px]:min-h-[140px] min-[1920px]:max-h-[240px]"
                  value={smartInput}
                  onChange={e => setSmartInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault();
                      handleSmartSubmit();
                    }
                  }}
                  rows={1}
                  placeholder={t('dashboard.smartInput.placeholder')}
                  disabled={creating}
                />
                <button
                  className="absolute left-3 bottom-3 w-9 h-9 flex items-center justify-center rounded hover:bg-surface-container-high text-on-surface-variant hover:text-primary transition-colors cursor-pointer"
                  onClick={() => smartFileRef.current?.click()}
                  title={t('dashboard.smartInput.uploadTooltip')}
                >
                  <span className="material-symbols-outlined text-lg">attach_file</span>
                </button>
                <button
                  className="absolute right-3 bottom-3 w-10 h-10 cyber-gradient rounded-lg flex items-center justify-center text-on-primary disabled:opacity-50 disabled:cursor-not-allowed hover:brightness-110 active:scale-95 transition-all"
                  onClick={handleSmartSubmit}
                  disabled={!smartInput.trim() || creating}
                >
                  <span className="material-symbols-outlined">send</span>
                </button>
              </div>
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
