'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { AuthProvider, useAuth } from '../components/AuthProvider';
import UploadAlertModal, { type UploadAlertItem } from '../components/UploadAlertModal';
import { LineQrPanel } from '../components/LineQrPanel';
import GreetingPopup from '../components/GreetingPopup';
import FeatureSpotlightModal, { hasSeenSpotlight } from '../components/FeatureSpotlightModal';
import { I18nProvider, useTranslation } from '../../i18n';
import Navbar from '../components/Navbar';
import { useSidebarMargin } from '../hooks/useSidebarCollapsed';
import HelpButton from '../components/HelpButton';

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
  cost: number;   // boundary-exact (server-computed)
}

interface FileItem {
  id: string;
  filename: string;
  file_type: string;
  file_size: number;
  created_at: string;
}

// LINE features are hidden in pro-panjit for now (may be opened later). Mirrors
// the NEXT_PUBLIC_DEPLOY_MODE convention used in Navbar/login.
const deployMode = process.env.NEXT_PUBLIC_DEPLOY_MODE || 'pro-panjit';
const isPanjit = deployMode === 'pro-panjit';

const DOC_TYPES = [
  { id: 'pptx-gen', labelKey: 'nav.docTypes.pptx.label' as const, descKey: 'nav.docTypes.pptx.desc' as const, icon: 'present_to_all', colorClass: 'text-warning' },
  { id: 'docx-gen', labelKey: 'nav.docTypes.docx.label' as const, descKey: 'nav.docTypes.docx.desc' as const, icon: 'description', colorClass: 'text-tertiary' },
  { id: 'xlsx-gen', labelKey: 'nav.docTypes.xlsx.label' as const, descKey: 'nav.docTypes.xlsx.desc' as const, icon: 'table_chart', colorClass: 'text-success' },
  { id: 'pdf-gen', labelKey: 'nav.docTypes.pdf.label' as const, descKey: 'nav.docTypes.pdf.desc' as const, icon: 'picture_as_pdf', colorClass: 'text-error' },
  { id: 'slides-gen', labelKey: 'nav.docTypes.slides.label' as const, descKey: 'nav.docTypes.slides.desc' as const, icon: 'slideshow', colorClass: 'text-secondary' },
  { id: 'infographic-gen', labelKey: 'nav.docTypes.infographic.label' as const, descKey: 'nav.docTypes.infographic.desc' as const, icon: 'auto_awesome', colorClass: 'text-secondary' },
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
  'infographic-gen': 'auto_awesome',
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

// Data sources the agent can be granted read access to for a run (Gemini-style
// multi-select). Kept in sync with the chat page's DATA_SOURCES. The selection
// travels to the new conversation via sessionStorage and is applied to its first
// generation. 'email' only resolves in pro-panjit; elsewhere it degrades to a no-op.
const DATA_SOURCES: { id: string; label: string; desc: string; icon: string }[] = [
  { id: 'email', label: '我的信件', desc: 'Outlook 信箱（只讀自己的）', icon: 'mail' },
];

/** The 資料源 dropdown button (used by both the mobile and desktop input bars). */
function DataSourceSelector({ selected, onToggle, disabled }: { selected: string[]; onToggle: (id: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        disabled={disabled}
        className={`w-9 h-9 flex items-center justify-center rounded transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${open || selected.length > 0 ? 'bg-primary/15 text-primary' : 'hover:bg-surface-container-high text-on-surface-variant hover:text-primary'}`}
        title="資料源"
      >
        <span className="material-symbols-outlined text-lg">database</span>
      </button>
      {open && (
        <div className="absolute bottom-full left-0 mb-1 w-60 bg-surface-container border border-outline-variant/20 rounded-xl shadow-xl overflow-hidden z-50">
          <div className="px-3 py-2 border-b border-outline-variant/10">
            <p className="text-xs font-medium text-on-surface-variant">資料源（可多選）</p>
            <p className="text-[10px] text-on-surface-variant/60 mt-0.5">勾選後，AI 產文件時可讀取這些來源</p>
          </div>
          <div className="max-h-48 overflow-y-auto">
            {DATA_SOURCES.map(ds => {
              const isSel = selected.includes(ds.id);
              return (
                <button
                  key={ds.id}
                  type="button"
                  onClick={() => onToggle(ds.id)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-left transition-colors cursor-pointer ${isSel ? 'bg-primary/10' : 'hover:bg-surface-container-high'}`}
                >
                  <span className={`material-symbols-outlined text-sm shrink-0 ${isSel ? 'text-primary' : 'text-on-surface-variant'}`}>{ds.icon}</span>
                  <div className="min-w-0 flex-1">
                    <p className={`text-xs font-medium ${isSel ? 'text-primary' : 'text-on-surface'}`}>{ds.label}</p>
                    <p className="text-[10px] text-on-surface-variant/60 truncate">{ds.desc}</p>
                  </div>
                  {isSel && <span className="material-symbols-outlined text-sm text-primary shrink-0">check</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function DashboardContent() {
  const { user, token, isLoading } = useAuth();
  const { t } = useTranslation();
  const router = useRouter();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [usage, setUsage] = useState<UsageTotal | null>(null);
  const [catCounts, setCatCounts] = useState<{ document: number; team: number; email: number }>({ document: 0, team: 0, email: 0 });
  const [usageLimit, setUsageLimit] = useState<number | null>(null);
  const [isBeta, setIsBeta] = useState(true);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [smartInput, setSmartInput] = useState('');
  const [selectedDataSources, setSelectedDataSources] = useState<string[]>([]);
  const toggleDataSource = (id: string) => setSelectedDataSources(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  const [creating, setCreating] = useState(false);
  const [smartAttached, setSmartAttached] = useState<Array<{ id: string; name: string; uploading?: boolean }>>([]);
  const [uploadAlerts, setUploadAlerts] = useState<UploadAlertItem[]>([]);
  const smartFileRef = useRef<HTMLInputElement>(null);
  const mobileFileRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragCounter = useRef(0);
  const sidebarMargin = useSidebarMargin();
  const [showGreeting, setShowGreeting] = useState(false);
  const [showSpotlight, setShowSpotlight] = useState(false);
  const [quotaHasPending, setQuotaHasPending] = useState(false);
  const [showQuotaModal, setShowQuotaModal] = useState(false);
  const [showLineModal, setShowLineModal] = useState(false);
  // True when the LINE modal was auto-opened as the post-login gate, so closing
  // it should hand off to the greeting (vs. a manual open from a dashboard button).
  const [lineGateActive, setLineGateActive] = useState(false);
  const [quotaReason, setQuotaReason] = useState('');
  const [quotaSubmitting, setQuotaSubmitting] = useState(false);
  // Smart quota reminder: pops up once per page-load when usage hits ~90%.
  const [showQuotaReminder, setShowQuotaReminder] = useState(false);
  const reminderShownRef = useRef(false);

  // Trigger the near-limit reminder when usage data is ready and nothing else is
  // gating the screen. Suppressed for the day if the user clicked "don't show today";
  // skipped entirely if a quota request is already pending.
  useEffect(() => {
    if (reminderShownRef.current) return;
    if (!user || !usage || usageLimit == null || usageLimit <= 0 || quotaHasPending) return;
    if (showGreeting || showLineModal || showSpotlight || showQuotaModal) return;
    const ratio = (usage.cost ?? 0) / usageLimit;
    if (ratio < 0.9) return; // only when ~10% or less remains
    const today = new Date().toISOString().slice(0, 10);
    if (localStorage.getItem(`quota_reminder_muted_${user.id}`) === today) return;
    reminderShownRef.current = true;
    setShowQuotaReminder(true);
  }, [user, usage, usageLimit, quotaHasPending, showGreeting, showLineModal, showSpotlight, showQuotaModal]);

  // "Thanks, don't show again today" — mute the reminder until tomorrow.
  function muteQuotaReminderToday() {
    if (user) localStorage.setItem(`quota_reminder_muted_${user.id}`, new Date().toISOString().slice(0, 10));
    setShowQuotaReminder(false);
  }

  useEffect(() => {
    if (!isLoading && !user) {
      router.replace('/login');
    }
  }, [user, isLoading, router]);

  // After login: optionally gate the greeting behind a one-time LINE bind prompt
  // for users who haven't linked yet. Binding lives here rather than in the
  // onboarding wizard, where adding the LINE friend mid-flow jumped out of the
  // app and could fail before login finished. Shows at most once per login; once
  // the account is bound (or LINE is unavailable) it goes straight to greeting.
  useEffect(() => {
    if (!token || !user) return;
    // First-login users land here briefly before AuthProvider redirects them to
    // /onboarding. Don't fire the LINE prompt / greeting during that flash —
    // they'll fire properly when onboarding completes and routes back here.
    if (user.onboardingRequired || user.termsRequired) return;
    const today = new Date().toISOString().slice(0, 10);
    if (localStorage.getItem(`greeting_muted_${user.id}`) === today) return;
    const loginId = localStorage.getItem('greeting_login_id');
    if (!loginId) return;
    if (localStorage.getItem('greeting_shown_for') === loginId) return;

    let cancelled = false;
    (async () => {
      let gateLine = false;
      if (!isPanjit && localStorage.getItem('line_prompt_shown_for') !== loginId) {
        try {
          const res = await fetch('/api/auth/line-link-status', { headers: { Authorization: `Bearer ${token}` } });
          if (res.ok) {
            const s = await res.json();
            gateLine = !!s.available && !s.linked;
          }
        } catch { /* network hiccup — just fall through to the greeting */ }
      }
      if (cancelled) return;
      if (gateLine) {
        localStorage.setItem('line_prompt_shown_for', loginId);
        setLineGateActive(true);
        setShowLineModal(true);
      } else {
        setTimeout(() => { if (!cancelled && !lineGateActive) setShowGreeting(true); }, 600);
      }
    })();
    return () => { cancelled = true; };
  }, [token, user]); // eslint-disable-line react-hooks/exhaustive-deps

  // Closing the post-login LINE prompt hands off to the greeting (only when it
  // was the auto gate — a manual open from a dashboard button leaves it false).
  const closeLineModal = () => {
    setShowLineModal(false);
    if (lineGateActive) {
      setLineGateActive(false);
      setTimeout(() => setShowGreeting(true), 250);
    }
  };

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
      .then(data => { setUsage(data.total); setCatCounts(data.categoryCounts ?? { document: 0, team: 0, email: 0 }); if (data.limit != null) setUsageLimit(data.limit); setIsBeta(data.isBeta ?? true); })
      .catch(console.error);

    fetch('/api/files', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(setFiles)
      .catch(console.error);

    fetch('/api/quota-request', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(data => setQuotaHasPending(data.hasPending))
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
      // Carry the selected data sources so the chat page applies them to the first run.
      if (!skillId && selectedDataSources.length > 0) {
        sessionStorage.setItem(`pending_datasources_${conv.id}`, JSON.stringify(selectedDataSources));
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

  async function handleQuotaRequest() {
    if (!token || quotaSubmitting || !quotaReason.trim()) return;
    setQuotaSubmitting(true);
    try {
      const res = await fetch('/api/quota-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ reason: quotaReason.trim() }),
      });
      if (res.ok) {
        setQuotaHasPending(true);
        setShowQuotaModal(false);
        setQuotaReason('');
      }
    } finally {
      setQuotaSubmitting(false);
    }
  }

  // Feature spotlight ("what's new") — show once per user, AFTER the greeting
  // popup has closed so the two never overlap. (Must stay above the early return
  // below to keep hook order stable.)
  useEffect(() => {
    if (!user || showGreeting || showSpotlight) return;
    if (hasSeenSpotlight()) return;
    const t = setTimeout(() => setShowSpotlight(true), 500);
    return () => clearTimeout(t);
  }, [user, showGreeting, showSpotlight]);

  const costExceeded = usage && usageLimit != null && ((usage.cost ?? 0)) >= usageLimit;

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

      {/* Feature spotlight — "what's new" modal (once per user, after greeting) */}
      {showSpotlight && <FeatureSpotlightModal onClose={() => setShowSpotlight(false)} />}

      {/* Quota Request Modal */}
      {/* Smart near-limit reminder */}
      {showQuotaReminder && usage && usageLimit != null && (() => {
        const used = (usage.cost ?? 0);
        const pct = Math.max(0, Math.round((1 - used / usageLimit) * 100));
        return (
          <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={() => setShowQuotaReminder(false)}>
            <div className="bg-surface-container-lowest rounded-2xl shadow-2xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-xl bg-warning/15 flex items-center justify-center shrink-0">
                  <span className="material-symbols-outlined text-warning">warning</span>
                </div>
                <h3 className="text-lg font-headline font-bold text-on-surface">{t('quotaReminder.title' as any)}</h3>
              </div>
              <p className="text-sm text-on-surface-variant leading-relaxed mb-4">
                {t('quotaReminder.body', { used: `$${used.toFixed(2)}`, limit: `$${usageLimit.toFixed(0)}`, pct: String(pct) } as any)}
              </p>
              {/* Usage bar */}
              <div className="h-2 w-full rounded-full bg-surface-container-high overflow-hidden mb-5">
                <div className="h-full rounded-full bg-warning" style={{ width: `${Math.min(100, Math.round((used / usageLimit) * 100))}%` }} />
              </div>
              <div className="flex flex-col gap-2">
                <button
                  onClick={() => { setShowQuotaReminder(false); setShowQuotaModal(true); }}
                  className="w-full py-2.5 rounded-xl text-sm font-bold text-on-primary cyber-gradient hover:opacity-90 transition-all cursor-pointer"
                >
                  {t('quotaReminder.apply' as any)}
                </button>
                <button
                  onClick={muteQuotaReminderToday}
                  className="w-full py-2.5 rounded-xl text-sm font-medium text-on-surface-variant bg-surface-container hover:bg-surface-container-high transition-colors cursor-pointer"
                >
                  {t('quotaReminder.muteToday' as any)}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {showQuotaModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => setShowQuotaModal(false)}>
          <div className="bg-surface-container-lowest rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-error/10 flex items-center justify-center">
                <span className="material-symbols-outlined text-error">request_quote</span>
              </div>
              <div>
                <h3 className="text-lg font-headline font-bold text-on-surface">{t('quotaRequest.modalTitle' as any)}</h3>
                <p className="text-xs text-on-surface-variant">{t('quotaRequest.limitReached' as any)}</p>
              </div>
            </div>

            <div className="flex gap-4 mb-4 text-sm">
              <div className="flex-1 bg-surface-container rounded-xl p-3">
                <div className="text-on-surface-variant text-xs">{t('quotaRequest.currentUsage' as any)}</div>
                <div className="font-bold text-on-surface mt-0.5">${usage ? ((usage.cost ?? 0)).toFixed(2) : '0.00'}</div>
              </div>
              <div className="flex-1 bg-surface-container rounded-xl p-3">
                <div className="text-on-surface-variant text-xs">{t('quotaRequest.currentLimit' as any)}</div>
                <div className="font-bold text-on-surface mt-0.5">${usageLimit?.toFixed(0) ?? '-'}</div>
              </div>
            </div>

            <div className="mb-4">
              <label className="block text-sm font-bold text-on-surface mb-1.5">{t('quotaRequest.reason' as any)}</label>
              <textarea
                className="w-full bg-surface-container border border-outline-variant/20 focus:border-primary focus:ring-1 focus:ring-primary/30 rounded-xl py-3 px-4 text-sm text-on-surface placeholder:text-outline font-body resize-none"
                value={quotaReason}
                onChange={e => setQuotaReason(e.target.value)}
                placeholder={t('quotaRequest.reasonPlaceholder' as any)}
                rows={3}
              />
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setShowQuotaModal(false)}
                className="flex-1 py-2.5 rounded-xl text-sm font-bold text-on-surface-variant bg-surface-container hover:bg-surface-container-high transition-colors cursor-pointer"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleQuotaRequest}
                disabled={!quotaReason.trim() || quotaSubmitting}
                className="flex-1 py-2.5 rounded-xl text-sm font-bold text-on-primary cyber-gradient disabled:opacity-40 disabled:cursor-not-allowed transition-all cursor-pointer"
              >
                {quotaSubmitting ? t('quotaRequest.submitting' as any) : t('quotaRequest.submit' as any)}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* LINE Bind Modal */}
      {!isPanjit && showLineModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={closeLineModal}>
          <div className="bg-surface-container-lowest rounded-2xl shadow-2xl w-full max-w-2xl mx-4 p-6 md:p-8 relative" onClick={e => e.stopPropagation()}>
            <button
              onClick={closeLineModal}
              className="absolute top-4 right-4 w-8 h-8 rounded-full flex items-center justify-center text-on-surface-variant hover:bg-surface-container-high transition-colors cursor-pointer z-10"
              aria-label="關閉"
            >
              <span className="material-symbols-outlined text-xl">close</span>
            </button>
            <LineQrPanel title="綁定 LINE" caption="連結你的帳號" />
          </div>
        </div>
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
          <div className="flex items-center gap-3">
            {/* Guest demo tag (desktop) — compact, no banner */}
            {user.isDemo && (() => {
              const exp = user.demoExpiresAt ? new Date(user.demoExpiresAt).getTime() : 0;
              const hrsLeft = exp ? Math.max(0, Math.ceil((exp - Date.now()) / 3600000)) : null;
              return (
                <span
                  className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-100 text-amber-700 text-sm font-bold"
                  title={`訪客體驗帳號 · 額度上限 US$30${hrsLeft != null ? ` · 約 ${hrsLeft} 小時後到期` : ''}，逾期後將無法使用`}
                >
                  <span className="material-symbols-outlined text-[16px]">science</span>
                  訪客{hrsLeft != null ? ` · ${hrsLeft}h` : ''}
                </span>
              );
            })()}
            {!isPanjit && (
              <button
                onClick={() => setShowLineModal(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[#06C755]/10 text-[#06C755] hover:bg-[#06C755]/20 transition-colors cursor-pointer"
              >
                <span className="material-symbols-outlined text-[18px]">qr_code_2</span>
                <span className="text-sm font-bold">綁定 LINE</span>
              </button>
            )}
            <div className="flex items-center gap-1.5 px-3 py-1 bg-primary/10 rounded-full">
              <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
              <span className="text-sm text-primary font-bold tracking-widest uppercase">{t('dashboard.statusRunning')}</span>
            </div>
            <HelpButton pageId="dashboard" />
          </div>
        </header>

        {/* ===== Mobile Dashboard (md:hidden) ===== */}
        <div className="md:hidden px-4 pt-5 pb-36 space-y-5">
          {/* Greeting */}
          <div className="px-1">
            {user.isDemo && (() => {
              const exp = user.demoExpiresAt ? new Date(user.demoExpiresAt).getTime() : 0;
              const hrsLeft = exp ? Math.max(0, Math.ceil((exp - Date.now()) / 3600000)) : null;
              return (
                <span
                  className="inline-flex items-center gap-1 mb-2 px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-xs font-bold"
                  title={`訪客體驗帳號 · 額度上限 US$30${hrsLeft != null ? ` · 約 ${hrsLeft} 小時後到期` : ''}，逾期後將無法使用`}
                >
                  <span className="material-symbols-outlined text-[14px]">science</span>
                  訪客{hrsLeft != null ? ` · ${hrsLeft}h` : ''}
                </span>
              );
            })()}
            <h2 className="text-2xl font-headline font-bold text-on-surface leading-tight">
              {t('dashboard.mobile.greeting', { name: user.displayName || user.email?.split('@')[0] || '' })}
            </h2>
            <p className="text-sm text-on-surface-variant mt-1">
              {t('dashboard.mobile.guidance')}
            </p>
          </div>

          {/* Mobile quota request banner */}
          {costExceeded && (
            <div className="flex items-center gap-3 p-3.5 bg-error/5 border border-error/15 rounded-2xl">
              <div className="w-9 h-9 rounded-xl bg-error/10 flex items-center justify-center shrink-0">
                <span className="material-symbols-outlined text-error text-lg">warning</span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold text-on-surface">{t('quotaRequest.limitReached' as any)}</p>
                <p className="text-xs text-on-surface-variant mt-0.5">
                  ${usage ? ((usage.cost ?? 0)).toFixed(2) : '0'} / ${usageLimit?.toFixed(0)}
                </p>
              </div>
              {quotaHasPending ? (
                <span className="px-3 py-1.5 text-xs bg-warning/10 text-warning rounded-full font-bold shrink-0">{t('quotaRequest.pending' as any)}</span>
              ) : (
                <button
                  onClick={() => setShowQuotaModal(true)}
                  className="px-3 py-1.5 text-xs bg-error/10 text-error active:bg-error/20 rounded-full font-bold transition-colors cursor-pointer shrink-0"
                >
                  {t('quotaRequest.button' as any)}
                </button>
              )}
            </div>
          )}

          {/* LINE bind card */}
          {!isPanjit && (
          <button
            onClick={() => setShowLineModal(true)}
            className="flex items-center gap-3 w-full px-4 py-3.5 bg-surface-container rounded-2xl active:bg-surface-container-high transition-colors cursor-pointer"
          >
            <div className="w-10 h-10 rounded-xl bg-[#06C755] flex items-center justify-center shrink-0">
              <span className="material-symbols-outlined text-white text-xl">qr_code_2</span>
            </div>
            <div className="text-left">
              <span className="text-sm font-headline font-bold text-on-surface">綁定 LINE 機器人</span>
              <p className="text-xs text-on-surface-variant mt-0.5">在 LINE 直接使用 AI 助理</p>
            </div>
            <span className="material-symbols-outlined text-on-surface-variant ml-auto">chevron_right</span>
          </button>
          )}

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
              // pro-panjit 隱藏「資訊圖表」（客戶擔心 token 用量），改放「上傳檔案智能分析」補位；其他部署模式顯示資訊圖表
              ...(isPanjit
                ? [{ icon: 'upload_file', color: 'text-primary', labelKey: 'dashboard.samples.data' as const, templateKey: 'dashboard.samples.data.template' as const }]
                : [{ icon: 'auto_awesome', color: 'text-secondary', labelKey: 'dashboard.samples.infographic' as const, templateKey: 'dashboard.samples.infographic.template' as const }]),
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
            <div className="mb-px">
              <DataSourceSelector selected={selectedDataSources} onToggle={toggleDataSource} disabled={creating} />
            </div>
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
            <div className="flex items-center gap-1.5 relative group/gen cursor-default">
              <span className="material-symbols-outlined text-primary text-base">description</span>
              <span className="font-medium">{t('dashboard.stats.invocationsTitle')}</span>
              <span className="font-headline font-bold text-on-surface">{catCounts.document}</span>
              <span className="text-primary font-bold">{t('dashboard.stats.invocationsUnit')}</span>
              {/* Hover breakdown: 文件 / AI 團隊 / 信件 counts */}
              <div className="pointer-events-none absolute top-full left-0 mt-2 z-30 w-max min-w-[140px] rounded-lg bg-inverse-surface text-inverse-on-surface text-xs shadow-lg opacity-0 scale-95 origin-top-left transition-all duration-150 group-hover/gen:opacity-100 group-hover/gen:scale-100 p-2.5">
                <div className="flex items-center justify-between gap-4 py-0.5"><span className="flex items-center gap-1.5"><span className="material-symbols-outlined text-[14px]">description</span>文件</span><span className="font-mono font-bold">{catCounts.document}</span></div>
                <div className="flex items-center justify-between gap-4 py-0.5"><span className="flex items-center gap-1.5"><span className="material-symbols-outlined text-[14px]">groups</span>AI 團隊</span><span className="font-mono font-bold">{catCounts.team}</span></div>
                <div className="flex items-center justify-between gap-4 py-0.5"><span className="flex items-center gap-1.5"><span className="material-symbols-outlined text-[14px]">mail</span>信件</span><span className="font-mono font-bold">{catCounts.email}</span></div>
              </div>
            </div>
            <div className="w-px h-4 bg-outline-variant/20" />
            <div className="flex items-center gap-1.5">
              <span className="material-symbols-outlined text-success text-base">token</span>
              <span className="font-medium">{t('dashboard.stats.tokenTitle')}</span>
              <span className="font-headline font-bold text-on-surface">{usage ? ((usage.totalInput + usage.totalOutput) / 1000).toFixed(1) + 'k' : '0'}</span>
              <span className="text-outline-variant/40 mx-0.5">·</span>
              <span className="font-medium text-on-surface-variant text-xs">{t('dashboard.stats.costLabel' as any)}</span>
              {!isBeta && <span className="text-[10px] px-1 py-0.5 rounded bg-primary/10 text-primary font-bold uppercase tracking-wider">本月</span>}
              <span className="font-bold text-success">${usage ? ((usage.cost ?? 0)).toFixed(2) : '0.00'}{usageLimit != null ? <span className="text-warning font-bold"> / ${usageLimit.toFixed(0)}</span> : null}</span>
              {costExceeded && (
                quotaHasPending ? (
                  <span className="ml-2 px-2 py-0.5 text-xs bg-warning/10 text-warning rounded-full font-bold">{t('quotaRequest.pending' as any)}</span>
                ) : (
                  <button
                    onClick={() => setShowQuotaModal(true)}
                    className="ml-2 px-2.5 py-0.5 text-xs bg-error/10 text-error hover:bg-error/20 rounded-full font-bold transition-colors cursor-pointer"
                  >
                    {t('quotaRequest.button' as any)}
                  </button>
                )
              )}
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
                // pro-panjit 隱藏「資訊圖表」（客戶擔心 token 用量），改放「上傳檔案智能分析」補位；其他部署模式顯示資訊圖表
                ...(isPanjit
                  ? [{ icon: 'upload_file', color: 'text-primary', bg: 'bg-primary/10', labelKey: 'dashboard.samples.data' as const, templateKey: 'dashboard.samples.data.template' as const }]
                  : [{ icon: 'auto_awesome', color: 'text-secondary', bg: 'bg-secondary/10', labelKey: 'dashboard.samples.infographic' as const, templateKey: 'dashboard.samples.infographic.template' as const }]),
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
              <div
                className={`relative bg-surface-container rounded-xl border transition-all ${
                  isDragging ? 'border-primary border-dashed bg-primary/5' : 'border-outline-variant/20 focus-within:border-primary/40'
                }`}
                onDragEnter={e => { e.preventDefault(); e.stopPropagation(); dragCounter.current++; setIsDragging(true); }}
                onDragOver={e => { e.preventDefault(); e.stopPropagation(); }}
                onDragLeave={e => { e.preventDefault(); e.stopPropagation(); dragCounter.current--; if (dragCounter.current <= 0) { dragCounter.current = 0; setIsDragging(false); } }}
                onDrop={e => { e.preventDefault(); e.stopPropagation(); dragCounter.current = 0; setIsDragging(false); if (!creating && e.dataTransfer.files.length > 0) handleSmartFileAttach(e.dataTransfer.files); }}
              >
                {isDragging && (
                  <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 rounded-xl bg-primary/5 text-primary pointer-events-none">
                    <span className="material-symbols-outlined text-xl">upload_file</span>
                    <span className="text-sm font-medium">放開以上傳檔案</span>
                  </div>
                )}
                <input
                  ref={smartFileRef}
                  type="file"
                  multiple
                  accept=".csv,.xlsx,.xls,.pdf,.txt,.md,.json,.docx,.doc,.pptx,.ppt,.png,.jpg,.jpeg,.gif,.webp,.bmp,.svg,.tiff,.tif,.ico,.xml,.yaml,.yml,.html,.htm"
                  className="hidden"
                  onChange={e => { handleSmartFileAttach(e.target.files); e.target.value = ''; }}
                />
                <textarea
                  className="w-full bg-transparent border-none focus:ring-0 py-3 pl-[5.5rem] pr-14 text-sm text-on-surface placeholder:text-outline font-body resize-none min-h-[80px] max-h-[160px] min-[1920px]:min-h-[140px] min-[1920px]:max-h-[240px]"
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
                <div className="absolute left-3 bottom-3 flex items-center gap-1">
                  <button
                    type="button"
                    className="w-9 h-9 flex items-center justify-center rounded hover:bg-surface-container-high text-on-surface-variant hover:text-primary transition-colors cursor-pointer"
                    onClick={() => smartFileRef.current?.click()}
                    title={t('dashboard.smartInput.uploadTooltip')}
                  >
                    <span className="material-symbols-outlined text-lg">attach_file</span>
                  </button>
                  <DataSourceSelector selected={selectedDataSources} onToggle={toggleDataSource} disabled={creating} />
                </div>
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
