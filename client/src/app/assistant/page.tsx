'use client';

import { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { AuthProvider, useAuth } from '../components/AuthProvider';
import { I18nProvider, useTranslation } from '../../i18n';
import Navbar from '../components/Navbar';
import { useSidebarMargin } from '../hooks/useSidebarCollapsed';
import HelpButton from '../components/HelpButton';

const PAGE_SIZE = 6;

interface EmailFolder {
  id: string;
  name: string;
  displayName: string;
  totalCount: number;
  unreadCount: number;
}

interface EmailAttachment {
  id: string;
  filename: string;
  content_type: string;
  size: number;
  is_inline: boolean;
}

interface EmailMessage {
  id: string;
  subject: string;
  from: { name: string; address: string };
  to?: Array<{ name: string; address: string }>;
  cc?: Array<{ name: string; address: string }>;
  received_at: string;
  is_read: boolean;
  has_attachments: boolean;
  preview: string;
  body?: string;
  body_type?: string;
  attachments?: EmailAttachment[];
}

interface AssistantConversation {
  id: string;
  title: string;
  status: string;
  created_at: string;
  category: string;
  summary: string | null;
  skill_id: string | null;
  system_prompt: string | null;
  icon: string | null;
}

interface SkillOption {
  id: string;
  name: string;
  description: string;
  fileType: string;
}

const ICON_OPTIONS = [
  'smart_toy', 'psychology', 'description', 'slideshow', 'table_chart',
  'analytics', 'code', 'science', 'school', 'translate',
  'brush', 'auto_fix_high', 'support_agent', 'travel_explore', 'calculate',
];

const SKILL_ICON_MAP: Record<string, string> = {
  'pptx-gen': 'slideshow',
  'docx-gen': 'description',
  'xlsx-gen': 'table_chart',
  'pdf-gen': 'picture_as_pdf',
  'slides-gen': 'web',
  'webapp-gen': 'code',
  'research': 'travel_explore',
  'planner': 'event_note',
  'reviewer': 'rate_review',
  'data-analyst': 'analytics',
  'rag-analyst': 'search',
};

const DOC_SKILLS = new Set(['pptx-gen', 'docx-gen', 'xlsx-gen', 'pdf-gen', 'slides-gen', 'webapp-gen']);
// Internal-only skills used by orchestrator, not exposed to users
const INTERNAL_SKILLS = new Set(['planner', 'reviewer']);

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

// ── Skill Picker (portal dropdown — floats above modal) ─────────────────────
function SkillPicker({ skills, value, onChange }: { skills: SkillOption[]; value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const available = skills.filter(s => s.id && !INTERNAL_SKILLS.has(s.id));
  const docSkills = available.filter(s => DOC_SKILLS.has(s.id));
  const analysisSkills = available.filter(s => !DOC_SKILLS.has(s.id));
  const selected = available.find(s => s.id === value);

  // Position dropdown below trigger
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
  }, [open]);

  // Close on outside click / scroll
  useEffect(() => {
    if (!open) return;
    function handleClose(e: MouseEvent | Event) {
      if (triggerRef.current?.contains(e.target as Node)) return;
      if (dropRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', handleClose);
    // Close on modal scroll
    const modal = triggerRef.current?.closest('.overflow-y-auto');
    if (modal) modal.addEventListener('scroll', () => setOpen(false));
    return () => {
      document.removeEventListener('mousedown', handleClose);
      if (modal) modal.removeEventListener('scroll', () => setOpen(false));
    };
  }, [open]);

  function localName(id: string, fallback: string): string {
    const key = `skill.${id}`;
    const translated = t(key as any);
    return (translated && translated !== key) ? translated : fallback;
  }

  function pick(id: string) {
    onChange(id);
    setOpen(false);
  }

  const dropdownContent = open && pos && createPortal(
    <div
      ref={dropRef}
      style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width, zIndex: 9999 }}
      className="bg-surface-container-high rounded-xl border border-outline-variant/20 shadow-2xl overflow-hidden max-h-[260px] overflow-y-auto"
    >
      {/* Auto option */}
      <button
        type="button"
        onClick={() => pick('')}
        className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-surface-variant/50 transition-colors cursor-pointer ${!value ? 'bg-primary/5' : ''}`}
      >
        <span className="w-7 h-7 rounded-md bg-surface-container-highest flex items-center justify-center shrink-0">
          <span className="material-symbols-outlined text-on-surface-variant text-base">auto_awesome</span>
        </span>
        <span className={`flex-1 text-left ${!value ? 'text-primary font-medium' : 'text-on-surface'}`}>
          {t('assistant.editModal.skillNone' as any)}
        </span>
        {!value && <span className="material-symbols-outlined text-primary text-sm">check</span>}
      </button>

      {/* Document skills */}
      {docSkills.length > 0 && (
        <>
          <div className="px-3 pt-2 pb-0.5 text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-widest border-t border-outline-variant/10">
            {t('assistant.editModal.skillGroup.document' as any)}
          </div>
          {docSkills.map(s => (
            <button
              key={s.id}
              type="button"
              onClick={() => pick(s.id)}
              className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-sm hover:bg-surface-variant/50 transition-colors cursor-pointer ${value === s.id ? 'bg-primary/5' : ''}`}
            >
              <span className="w-7 h-7 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
                <span className="material-symbols-outlined text-primary text-base">{SKILL_ICON_MAP[s.id] || 'extension'}</span>
              </span>
              <span className={`flex-1 text-left truncate ${value === s.id ? 'text-primary font-medium' : 'text-on-surface'}`}>
                {localName(s.id, s.name)}
              </span>
              {s.fileType && (
                <span className="text-[10px] font-mono font-bold text-on-surface-variant/60 bg-surface-container-highest px-1.5 py-0.5 rounded shrink-0">.{s.fileType}</span>
              )}
              {value === s.id && <span className="material-symbols-outlined text-primary text-sm">check</span>}
            </button>
          ))}
        </>
      )}

      {/* Analysis skills */}
      {analysisSkills.length > 0 && (
        <>
          <div className="px-3 pt-2 pb-0.5 text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-widest border-t border-outline-variant/10">
            {t('assistant.editModal.skillGroup.analysis' as any)}
          </div>
          {analysisSkills.map(s => (
            <button
              key={s.id}
              type="button"
              onClick={() => pick(s.id)}
              className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-sm hover:bg-surface-variant/50 transition-colors cursor-pointer ${value === s.id ? 'bg-primary/5' : ''}`}
            >
              <span className="w-7 h-7 rounded-md bg-tertiary/10 flex items-center justify-center shrink-0">
                <span className="material-symbols-outlined text-tertiary text-base">{SKILL_ICON_MAP[s.id] || 'extension'}</span>
              </span>
              <span className={`flex-1 text-left truncate ${value === s.id ? 'text-primary font-medium' : 'text-on-surface'}`}>
                {localName(s.id, s.name)}
              </span>
              {value === s.id && <span className="material-symbols-outlined text-primary text-sm">check</span>}
            </button>
          ))}
        </>
      )}
    </div>,
    document.body
  );

  return (
    <div>
      {/* Trigger button */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2.5 bg-surface-container-high border border-outline-variant/30 rounded-lg px-3 py-2.5 text-sm text-on-surface hover:border-primary/50 focus:outline-none focus:border-primary transition-colors cursor-pointer"
      >
        {selected ? (
          <>
            <span className="w-7 h-7 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
              <span className="material-symbols-outlined text-primary text-base">{SKILL_ICON_MAP[selected.id] || 'extension'}</span>
            </span>
            <span className="flex-1 text-left truncate font-medium">{localName(selected.id, selected.name)}</span>
            {selected.fileType && (
              <span className="text-[10px] font-mono font-bold text-on-surface-variant bg-surface-container-highest px-1.5 py-0.5 rounded shrink-0">.{selected.fileType}</span>
            )}
          </>
        ) : (
          <>
            <span className="w-7 h-7 rounded-md bg-surface-container-highest flex items-center justify-center shrink-0">
              <span className="material-symbols-outlined text-on-surface-variant text-base">auto_awesome</span>
            </span>
            <span className="flex-1 text-left text-on-surface-variant">{t('assistant.editModal.skillNone' as any)}</span>
          </>
        )}
        <span className={`material-symbols-outlined text-on-surface-variant text-base transition-transform ${open ? 'rotate-180' : ''}`}>expand_more</span>
      </button>
      {dropdownContent}
    </div>
  );
}

// ── Assistant Edit/Create Modal ─────────────────────────────────────────────
function AssistantEditModal({
  conversation,
  skills,
  token,
  locale,
  onSave,
  onCancel,
}: {
  conversation: AssistantConversation | null; // null = create new
  skills: SkillOption[];
  token: string | null;
  locale?: string;
  onSave: (data: { title: string; icon: string; system_prompt: string; skill_id: string }) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const nameRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(conversation?.title || '');
  const [icon, setIcon] = useState(conversation?.icon || 'smart_toy');
  const [systemPrompt, setSystemPrompt] = useState(conversation?.system_prompt || '');
  const [skillId, setSkillId] = useState(conversation?.skill_id || '');
  const [generating, setGenerating] = useState(false);

  useEffect(() => { nameRef.current?.focus(); }, []);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onCancel]);

  async function generateRole() {
    if (!token || generating) return;
    setGenerating(true);
    try {
      const apiBase = process.env.NEXT_PUBLIC_API_URL || '';
      const res = await fetch(`${apiBase}/api/conversations/generate-role`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: title.trim() || 'AI 助手', skillId: skillId || undefined, locale, currentPrompt: systemPrompt.trim() || undefined }),
      });
      if (res.ok) {
        const { text } = await res.json();
        if (text) setSystemPrompt(text);
      } else {
        console.error('generate-role failed:', res.status, await res.text());
      }
    } catch (err) { console.error('generate-role error:', err); }
    finally { setGenerating(false); }
  }

  const isCreate = !conversation;
  const canSave = title.trim().length > 0;

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center" onClick={onCancel}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative bg-surface-container rounded-xl shadow-2xl border border-outline-variant/10 w-full max-w-md mx-4 overflow-hidden max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 bg-surface-container z-10 pt-6 pb-3 px-6 border-b border-outline-variant/10">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">tune</span>
            <h3 className="font-headline font-bold text-base text-on-surface">
              {isCreate ? t('assistant.editModal.createTitle' as any) : t('assistant.editModal.title' as any)}
            </h3>
          </div>
        </div>

        <div className="px-6 py-4 space-y-5">
          {/* Name */}
          <div>
            <label className="block text-sm font-bold text-on-surface mb-1.5">
              {t('assistant.editModal.name' as any)}
            </label>
            <input
              ref={nameRef}
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder={t('assistant.editModal.namePlaceholder' as any)}
              className="w-full bg-surface-container-high border border-outline-variant/30 rounded-lg px-3 py-2 text-sm text-on-surface focus:outline-none focus:border-primary"
              maxLength={80}
            />
          </div>

          {/* Icon picker */}
          <div>
            <label className="block text-sm font-bold text-on-surface mb-1.5">
              {t('assistant.editModal.icon' as any)}
            </label>
            <div className="flex flex-wrap gap-1.5">
              {ICON_OPTIONS.map(ic => (
                <button
                  key={ic}
                  onClick={() => setIcon(ic)}
                  className={`w-9 h-9 flex items-center justify-center rounded-lg transition-all cursor-pointer ${
                    icon === ic
                      ? 'cyber-gradient text-on-primary scale-110'
                      : 'bg-surface-container-high text-on-surface-variant hover:bg-surface-variant border border-outline-variant/10'
                  }`}
                >
                  <span className="material-symbols-outlined text-lg">{ic}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Skill binding */}
          <div>
            <label className="block text-sm font-bold text-on-surface mb-1.5">
              {t('assistant.editModal.skill' as any)}
            </label>
            <SkillPicker skills={skills} value={skillId} onChange={setSkillId} />
            <p className="text-xs text-on-surface-variant/70 mt-1">
              {t('assistant.editModal.skillHint' as any)}
            </p>
          </div>

          {/* Role description */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-sm font-bold text-on-surface">
                {t('assistant.editModal.role' as any)}
              </label>
              <button
                type="button"
                onClick={generateRole}
                disabled={generating}
                className="flex items-center gap-1 px-2.5 py-1 text-xs font-bold text-primary hover:bg-primary/10 rounded-lg transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <span className={`material-symbols-outlined text-sm ${generating ? 'animate-spin' : ''}`}>
                  {generating ? 'progress_activity' : 'auto_awesome'}
                </span>
                {generating ? t('assistant.editModal.roleGenerating' as any) : t('assistant.editModal.roleGenerate' as any)}
              </button>
            </div>
            <textarea
              value={systemPrompt}
              onChange={e => setSystemPrompt(e.target.value)}
              placeholder={t('assistant.editModal.rolePlaceholder' as any)}
              rows={4}
              className="w-full bg-surface-container-high border border-outline-variant/30 rounded-lg px-3 py-2 text-sm text-on-surface focus:outline-none focus:border-primary resize-none"
              maxLength={2000}
            />
          </div>
        </div>

        {/* Actions */}
        <div className="sticky bottom-0 bg-surface-container z-10 flex gap-3 px-6 py-4 border-t border-outline-variant/10">
          <button onClick={onCancel} className="flex-1 py-2.5 px-4 bg-surface-container-highest border border-outline-variant/10 text-on-surface font-bold text-sm rounded cursor-pointer hover:bg-surface-variant transition-colors">
            {t('common.cancel' as any)}
          </button>
          <button
            onClick={() => canSave && onSave({ title: title.trim(), icon, system_prompt: systemPrompt, skill_id: skillId })}
            disabled={!canSave}
            className="flex-1 py-2.5 px-4 bg-primary text-on-primary font-bold text-sm rounded cursor-pointer hover:brightness-110 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {t('common.save' as any)}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Email Modal ─────────────────────────────────────────────────────────────
function EmailModal({ token, onClose }: { token: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [folders, setFolders] = useState<EmailFolder[]>([]);
  const [messages, setMessages] = useState<EmailMessage[]>([]);
  const [activeFolder, setActiveFolder] = useState('Inbox');
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selectedMsg, setSelectedMsg] = useState<EmailMessage | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [cidLoading, setCidLoading] = useState(false);
  const [page, setPage] = useState(0);
  const [fetchingMore, setFetchingMore] = useState(false);
  const PAGE_SIZE = 10;
  const BATCH_SIZE = 50;
  const apiBase = process.env.NEXT_PUBLIC_API_URL || '';

  // Real total from folder metadata
  const activeFolderData = folders.find(f => f.name === activeFolder);
  const folderTotal = activeFolderData?.totalCount || messages.length;

  const fetchBatch = useCallback(async (folder: string, offset: number, replace = false) => {
    if (replace) setLoading(true);
    else setFetchingMore(true);
    try {
      const res = await fetch(`${apiBase}/api/outlook/messages?folder=${encodeURIComponent(folder)}&limit=${BATCH_SIZE}&offset=${offset}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.messages) {
        setMessages(prev => replace ? data.messages : [...prev, ...data.messages]);
      }
    } catch { /* ignore */ }
    finally { replace ? setLoading(false) : setFetchingMore(false); }
  }, [token, apiBase]);

  const switchFolder = useCallback(async (folder: string) => {
    setSelectedMsg(null);
    setPage(0);
    await fetchBatch(folder, 0, true);
  }, [fetchBatch]);

  useEffect(() => {
    (async () => {
      try {
        const [fRes] = await Promise.all([
          fetch(`${apiBase}/api/outlook/folders`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()),
        ]);
        if (fRes.folders) setFolders(fRes.folders);
      } catch { /* ignore */ }
      // Fetch first batch of Inbox
      await fetchBatch('Inbox', 0, true);
      setLoading(false);
    })();
  }, [token, apiBase, fetchBatch]);

  // When page changes, check if we need to fetch more
  const goToPage = useCallback(async (p: number) => {
    setPage(p);
    const needed = (p + 1) * PAGE_SIZE; // how many items we need loaded
    if (needed > messages.length && messages.length < folderTotal) {
      await fetchBatch(activeFolder, messages.length);
    }
  }, [messages.length, folderTotal, activeFolder, fetchBatch]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') { selectedMsg ? setSelectedMsg(null) : onClose(); } };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, selectedMsg]);

  async function openMessage(msg: EmailMessage) {
    setSelectedMsg(msg);
    setCidLoading(false);
    if (!msg.body) {
      setDetailLoading(true);
      try {
        // Phase 1: fetch without CID resolution (fast — text only)
        const res = await fetch(`${apiBase}/api/outlook/messages/${encodeURIComponent(msg.id)}?cid=false`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        if (data.message) {
          const full = { ...msg, ...data.message };
          setSelectedMsg(full);
          setMessages(prev => prev.map(m => m.id === msg.id ? full : m));

          // Phase 2: if email has CID images, resolve them in background
          if (data.has_cid_images) {
            setCidLoading(true);
            fetch(`${apiBase}/api/outlook/messages/${encodeURIComponent(msg.id)}?cid=true`, {
              headers: { Authorization: `Bearer ${token}` },
            }).then(r => r.json()).then(d2 => {
              if (d2.message?.body) {
                const resolved = { ...full, body: d2.message.body };
                setSelectedMsg(prev => prev?.id === msg.id ? resolved : prev);
                setMessages(prev => prev.map(m => m.id === msg.id ? resolved : m));
              }
            }).catch(() => {}).finally(() => setCidLoading(false));
          }
        }
      } catch { /* ignore */ }
      finally { setDetailLoading(false); }
    }
  }

  const isSearching = !!search.trim();
  const allFiltered = isSearching
    ? messages.filter(m =>
        m.subject?.toLowerCase().includes(search.toLowerCase()) ||
        m.from.name?.toLowerCase().includes(search.toLowerCase()) ||
        m.from.address?.toLowerCase().includes(search.toLowerCase()) ||
        m.preview?.toLowerCase().includes(search.toLowerCase())
      )
    : messages;
  // When searching, total = filtered count; otherwise use folder's real total
  const totalCount = isSearching ? allFiltered.length : folderTotal;
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const filtered = allFiltered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const totalUnread = folders.reduce((sum, f) => sum + f.unreadCount, 0);

  return (
    <div className="fixed inset-0 z-[110] flex items-end md:items-center md:justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative bg-surface-container w-full h-full md:h-auto md:rounded-2xl md:shadow-2xl md:border md:border-outline-variant/10 md:max-w-4xl md:mx-4 overflow-hidden flex flex-col md:max-h-[85vh] safe-area-top safe-area-bottom"
        onClick={e => e.stopPropagation()}
      >
        {/* Modal header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-outline-variant/10 shrink-0">
          {selectedMsg ? (
            <>
              <button onClick={() => setSelectedMsg(null)} className="w-8 h-8 flex items-center justify-center rounded-lg active:bg-surface-container-high md:hover:bg-surface-container-high transition-colors cursor-pointer shrink-0">
                <span className="material-symbols-outlined text-on-surface-variant text-lg">arrow_back</span>
              </button>
              <div className="flex-1 min-w-0">
                <h3 className="font-headline font-bold text-base text-on-surface truncate">{selectedMsg.subject || t('assistant.email.noSubject' as any)}</h3>
              </div>
            </>
          ) : (
            <>
              <div className="w-9 h-9 rounded-lg bg-tertiary/15 flex items-center justify-center shrink-0">
                <span className="material-symbols-outlined text-tertiary text-xl">mail</span>
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="font-headline font-bold text-base text-on-surface">{t('assistant.email.title' as any)}</h3>
                {totalUnread > 0 && (
                  <p className="text-xs text-on-surface-variant">{t('assistant.email.unreadCount' as any, { count: totalUnread })}</p>
                )}
              </div>
            </>
          )}
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-lg active:bg-surface-container-high md:hover:bg-surface-container-high transition-colors cursor-pointer shrink-0">
            <span className="material-symbols-outlined text-on-surface-variant text-lg">close</span>
          </button>
        </div>

        {selectedMsg ? (
          /* ── Message Detail View ── */
          <div className="flex-1 overflow-y-auto">
            {/* Sender card */}
            <div className="px-5 py-4 bg-surface-container-high/30 border-b border-outline-variant/10">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-full bg-tertiary/15 flex items-center justify-center shrink-0 mt-0.5">
                  <span className="material-symbols-outlined text-tertiary text-2xl">person</span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-sm font-bold text-on-surface">{selectedMsg.from.name || selectedMsg.from.address}</span>
                    <span className="text-xs text-on-surface-variant/70 truncate max-w-[180px] md:max-w-none">{'<'}{selectedMsg.from.address}{'>'}</span>
                  </div>
                  <p className="text-xs text-on-surface-variant/70 mt-0.5">
                    {new Date(selectedMsg.received_at).toLocaleString(undefined, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' })}
                  </p>
                  {selectedMsg.to && selectedMsg.to.length > 0 && (
                    <div className="flex items-start gap-1.5 mt-2">
                      <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide bg-tertiary/10 text-tertiary px-1.5 py-0.5 rounded mt-px">To</span>
                      <p className="text-xs text-on-surface-variant leading-relaxed line-clamp-2 md:line-clamp-none">
                        {selectedMsg.to.map(r => r.name || r.address).join(', ')}
                      </p>
                    </div>
                  )}
                  {selectedMsg.cc && selectedMsg.cc.length > 0 && (
                    <div className="flex items-start gap-1.5 mt-1">
                      <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide bg-warning/10 text-warning px-1.5 py-0.5 rounded mt-px">CC</span>
                      <p className="text-xs text-on-surface-variant leading-relaxed line-clamp-2 md:line-clamp-none">
                        {selectedMsg.cc.map(r => r.name || r.address).join(', ')}
                      </p>
                    </div>
                  )}
                  {selectedMsg.has_attachments && (
                    <div className="flex items-center gap-1 text-xs text-tertiary mt-1.5">
                      <span className="material-symbols-outlined text-sm">attach_file</span>
                      {t('assistant.email.hasAttachments' as any)}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Attachments (non-inline only) */}
            {selectedMsg.attachments && selectedMsg.attachments.filter(a => !a.is_inline).length > 0 && (
              <div className="px-5 py-3 border-b border-outline-variant/10">
                <div className="flex flex-wrap gap-2">
                  {selectedMsg.attachments.filter(a => !a.is_inline).map(att => (
                    <a
                      key={att.id}
                      href={`${apiBase}/api/outlook/messages/${encodeURIComponent(selectedMsg.id)}/attachments/${encodeURIComponent(att.id)}?filename=${encodeURIComponent(att.filename)}&type=${encodeURIComponent(att.content_type)}`}
                      download={att.filename}
                      onClick={e => {
                        e.preventDefault();
                        fetch(`${apiBase}/api/outlook/messages/${encodeURIComponent(selectedMsg.id)}/attachments/${encodeURIComponent(att.id)}?filename=${encodeURIComponent(att.filename)}&type=${encodeURIComponent(att.content_type)}`, {
                          headers: { Authorization: `Bearer ${token}` },
                        }).then(r => r.blob()).then(blob => {
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement('a');
                          a.href = url; a.download = att.filename; a.click();
                          URL.revokeObjectURL(url);
                        }).catch(() => {});
                      }}
                      className="flex items-center gap-2 px-3 py-2 rounded-lg border border-outline-variant/20 bg-surface-container-high/30 active:bg-surface-container-high/60 md:hover:bg-surface-container-high/60 transition-colors cursor-pointer max-w-[180px] md:max-w-[220px]"
                    >
                      <span className="material-symbols-outlined text-tertiary text-base shrink-0">
                        {att.content_type.startsWith('image/') ? 'image' : att.content_type.includes('pdf') ? 'picture_as_pdf' : att.content_type.includes('sheet') || att.content_type.includes('excel') ? 'table_chart' : 'description'}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium text-on-surface truncate">{att.filename}</p>
                        <p className="text-[10px] text-on-surface-variant/60">{att.size < 1024 ? att.size + ' B' : att.size < 1048576 ? (att.size / 1024).toFixed(0) + ' KB' : (att.size / 1048576).toFixed(1) + ' MB'}</p>
                      </div>
                      <span className="material-symbols-outlined text-on-surface-variant/50 text-sm shrink-0">download</span>
                    </a>
                  ))}
                </div>
              </div>
            )}

            {/* Loading indicator */}
            {detailLoading && (
              <div className="flex items-center justify-center gap-2 text-on-surface-variant py-6">
                <span className="material-symbols-outlined text-sm animate-spin">progress_activity</span>
                <span className="text-sm">{t('common.loading' as any)}</span>
              </div>
            )}

            {/* CID image loading indicator */}
            {cidLoading && (
              <div className="flex items-center gap-2 px-5 py-2 bg-tertiary/5 border-b border-tertiary/10 text-tertiary">
                <span className="material-symbols-outlined text-sm animate-spin">progress_activity</span>
                <span className="text-xs font-medium">正在載入嵌入圖片...</span>
              </div>
            )}

            {/* Body content */}
            <div className="px-5 py-5">
              {selectedMsg.body ? (
                selectedMsg.body_type === 'html' ? (
                  <iframe
                    srcDoc={`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;padding:0;overflow-x:hidden;word-break:break-word;overflow-wrap:break-word;-webkit-text-size-adjust:100%;}img[src^="cid:"]{display:none!important;width:0!important;height:0!important;}img{max-width:100%!important;height:auto!important;}.table-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;max-width:100%;margin:8px 0;}.reply-collapsed{border-left:3px solid #c4c4c4;margin:16px 0;padding:4px 12px;border-radius:4px;background:#f5f5f5;cursor:pointer;font-size:12px;color:#666;}.reply-content{border-left:3px solid #ddd;margin:16px 0;padding:8px 12px;opacity:0.7;font-size:13px;}</style></head><body>${selectedMsg.body}</body></html>`}
                    className="w-full border-0 min-h-[200px] md:min-h-[300px]"
                    sandbox="allow-same-origin"
                    title="Email body"
                    onLoad={e => {
                      const iframe = e.target as HTMLIFrameElement;
                      const doc = iframe.contentDocument;
                      if (!doc?.body) return;
                      // Hide unresolved CID images + collapse broken images
                      doc.querySelectorAll('img').forEach(img => {
                        if (img.src.startsWith('cid:')) {
                          img.style.display = 'none';
                          return;
                        }
                        img.addEventListener('error', () => { img.style.display = 'none'; });
                      });
                      // Handle tables: layout tables reflow to fit; data tables get horizontal scroll
                      doc.querySelectorAll('table').forEach(table => {
                        if (table.closest('.table-scroll')) return;
                        const isDataTable = table.querySelector('th, thead');
                        if (isDataTable) {
                          // Data table — wrap in scroll container, keep natural width
                          table.removeAttribute('width');
                          table.style.width = 'auto';
                          table.style.maxWidth = 'none';
                          table.style.tableLayout = 'auto';
                          table.querySelectorAll('td, th').forEach(cell => {
                            (cell as HTMLElement).style.whiteSpace = 'nowrap';
                          });
                          const wrapper = doc.createElement('div');
                          wrapper.className = 'table-scroll';
                          table.parentElement?.insertBefore(wrapper, table);
                          wrapper.appendChild(table);
                        } else {
                          // Layout table — strip fixed width so content reflows within viewport
                          table.removeAttribute('width');
                          table.style.width = '100%';
                          table.style.maxWidth = '100%';
                          table.style.tableLayout = 'auto';
                          table.querySelectorAll('td').forEach(cell => {
                            (cell as HTMLElement).removeAttribute('width');
                            (cell as HTMLElement).style.width = '';
                          });
                        }
                      });
                      // Collapse quoted reply sections
                      const replySelectors = [
                        'blockquote',
                        '.gmail_quote',
                        '[id^="divRplyFwdMsg"]',
                        '#appendonsend',
                        'div.OutlookMessageHeader',
                      ];
                      const replyEl = doc.querySelector(replySelectors.join(','));
                      if (replyEl) {
                        const wrapper = doc.createElement('div');
                        wrapper.className = 'reply-content';
                        wrapper.style.display = 'none';
                        const toggle = doc.createElement('div');
                        toggle.className = 'reply-collapsed';
                        toggle.textContent = '⋯ 顯示引用內容';
                        toggle.addEventListener('click', () => {
                          const show = wrapper.style.display === 'none';
                          wrapper.style.display = show ? '' : 'none';
                          toggle.textContent = show ? '⋯ 隱藏引用內容' : '⋯ 顯示引用內容';
                          iframe.style.height = doc.body.scrollHeight + 20 + 'px';
                        });
                        replyEl.parentElement?.insertBefore(toggle, replyEl);
                        replyEl.parentElement?.insertBefore(wrapper, replyEl);
                        let node = wrapper.nextSibling;
                        while (node) {
                          const next = node.nextSibling;
                          wrapper.appendChild(node);
                          node = next;
                        }
                      }

                      const updateHeight = () => {
                        iframe.style.height = doc.body.scrollHeight + 20 + 'px';
                      };
                      updateHeight();
                      doc.querySelectorAll('img').forEach(img => {
                        if (!img.complete) img.addEventListener('load', updateHeight);
                      });
                    }}
                  />
                ) : (
                  <pre className="text-sm text-on-surface whitespace-pre-wrap font-sans leading-relaxed break-words">{selectedMsg.body}</pre>
                )
              ) : !detailLoading ? (
                <p className="text-sm text-on-surface leading-relaxed whitespace-pre-wrap break-words">{selectedMsg.preview}</p>
              ) : null}
            </div>
          </div>
        ) : (
          /* ── List View ── */
          <>
            {/* Search + folder tabs */}
            <div className="shrink-0 border-b border-outline-variant/10">
              {/* Search bar */}
              <div className="px-4 pt-3 pb-2">
                <div className="flex items-center gap-2 bg-surface-container-high rounded-lg border border-outline-variant/20 px-3 py-2">
                  <span className="material-symbols-outlined text-on-surface-variant text-base">search</span>
                  <input
                    value={search}
                    onChange={e => { setSearch(e.target.value); setPage(0); }}
                    placeholder={t('assistant.email.searchPlaceholder' as any)}
                    className="flex-1 bg-transparent text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none"
                  />
                  {search && (
                    <button onClick={() => setSearch('')} className="cursor-pointer">
                      <span className="material-symbols-outlined text-on-surface-variant text-base">close</span>
                    </button>
                  )}
                </div>
              </div>
              {/* Folder tabs */}
              {folders.length > 0 && (
                <div className="flex gap-1 px-4 pb-2 overflow-x-auto scrollbar-none">
                  {folders.map(f => (
                    <button
                      key={f.id}
                      onClick={() => { setActiveFolder(f.name); setSearch(''); switchFolder(f.name); }}
                      className={`shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                        activeFolder === f.name
                          ? 'bg-tertiary/15 text-tertiary'
                          : 'bg-surface-container-highest/50 text-on-surface-variant active:bg-surface-container-highest md:hover:bg-surface-container-highest'
                      }`}
                    >
                      <span>{f.displayName}</span>
                      {f.unreadCount > 0 && (
                        <span className="bg-tertiary text-on-primary text-[10px] font-bold px-1.5 py-0.5 rounded-full min-w-[18px] text-center">
                          {f.unreadCount}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Message list */}
            <div className="flex-1 overflow-y-auto">
              {loading ? (
                <div className="flex items-center justify-center py-12 gap-2 text-on-surface-variant">
                  <span className="material-symbols-outlined text-base animate-spin">progress_activity</span>
                  <span className="text-sm">{t('common.loading' as any)}</span>
                </div>
              ) : filtered.length === 0 ? (
                <div className="py-12 text-center text-sm text-on-surface-variant/60">
                  {search ? t('assistant.email.noSearchResults' as any) : t('assistant.email.noMessages' as any)}
                </div>
              ) : (
                <div className="divide-y divide-outline-variant/10">
                  {filtered.map(msg => (
                    <button
                      key={msg.id}
                      onClick={() => openMessage(msg)}
                      className={`group w-full text-left px-4 py-3 transition-all cursor-pointer border-l-3 active:bg-surface-container-high/60 md:hover:bg-surface-container-high/60 md:hover:border-l-tertiary ${!msg.is_read ? 'bg-tertiary/[0.03] border-l-tertiary/30' : 'border-l-transparent'}`}
                    >
                      <div className="flex items-start gap-3">
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${
                          !msg.is_read ? 'bg-tertiary/15' : 'bg-surface-container-highest'
                        }`}>
                          <span className={`material-symbols-outlined text-sm ${!msg.is_read ? 'text-tertiary' : 'text-on-surface-variant/60'}`}>
                            {msg.has_attachments ? 'attach_file' : 'person'}
                          </span>
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-0.5">
                            <span className={`text-sm truncate ${!msg.is_read ? 'font-bold text-on-surface' : 'font-medium text-on-surface/80'}`}>
                              {msg.from.name || msg.from.address}
                            </span>
                            {!msg.is_read && <span className="w-2 h-2 rounded-full bg-tertiary shrink-0" />}
                            <span className="ml-auto text-[11px] text-on-surface-variant/60 shrink-0">
                              {new Date(msg.received_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                            </span>
                          </div>
                          <p className={`text-sm truncate mb-0.5 ${!msg.is_read ? 'text-on-surface' : 'text-on-surface-variant'}`}>
                            {msg.subject || t('assistant.email.noSubject' as any)}
                          </p>
                          {msg.preview && (
                            <p className="text-xs text-on-surface-variant/60 truncate">{msg.preview}</p>
                          )}
                        </div>
                        <span className="material-symbols-outlined text-on-surface-variant/30 text-base mt-1 shrink-0 group-hover:text-tertiary transition-colors">chevron_right</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="shrink-0 flex items-center justify-between px-4 py-2.5 border-t border-outline-variant/10 bg-surface-container-high/20">
                <span className="text-xs text-on-surface-variant/70">
                  {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, totalCount)} / {totalCount}
                  {fetchingMore && <span className="ml-1.5 material-symbols-outlined text-[11px] animate-spin align-middle">progress_activity</span>}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    disabled={page === 0 || fetchingMore}
                    onClick={() => goToPage(page - 1)}
                    className="w-8 h-8 flex items-center justify-center rounded-lg active:bg-surface-container-high md:hover:bg-surface-container-high transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <span className="material-symbols-outlined text-on-surface-variant text-base">chevron_left</span>
                  </button>
                  <span className="text-xs font-medium text-on-surface-variant min-w-[3rem] text-center">
                    {page + 1} / {totalPages}
                  </span>
                  <button
                    disabled={page + 1 >= totalPages || fetchingMore}
                    onClick={() => goToPage(page + 1)}
                    className="w-8 h-8 flex items-center justify-center rounded-lg active:bg-surface-container-high md:hover:bg-surface-container-high transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <span className="material-symbols-outlined text-on-surface-variant text-base">chevron_right</span>
                  </button>
                </div>
              </div>
            )}
          </>
        )}
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
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AssistantConversation | null>(null);
  const [editTarget, setEditTarget] = useState<AssistantConversation | 'new' | null>(null); // null=closed, 'new'=create, conv=edit
  const [memoryCount, setMemoryCount] = useState(0);
  const [workLogCount, setWorkLogCount] = useState(0);
  const [processingIds, setProcessingIds] = useState<Set<string>>(new Set());
  const [currentPage, setCurrentPage] = useState(1);
  const [skills, setSkills] = useState<SkillOption[]>([]);
  const [emailConnected, setEmailConnected] = useState<boolean | null>(null); // null = loading/not available
  const [deployMode, setDeployMode] = useState<string>('');
  const [emailModalOpen, setEmailModalOpen] = useState(false);

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

    // Load available skills for binding
    fetch('/api/generate/skills', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(data => { if (Array.isArray(data)) setSkills(data); })
      .catch(() => {});

    // Check deploy mode + Outlook email status
    const apiBase = process.env.NEXT_PUBLIC_API_URL || '';
    fetch(`${apiBase}/api/health`)
      .then(r => r.json())
      .then(data => {
        if (data.deployMode) setDeployMode(data.deployMode);
        if (data.deployMode === 'pro-panjit') {
          fetch(`${apiBase}/api/outlook/status`, { headers: { Authorization: `Bearer ${token}` } })
            .then(r => r.json())
            .then(d => setEmailConnected(!!d.connected))
            .catch(() => setEmailConnected(false));
        }
      })
      .catch(() => {});
  }, [token]);

  const handleCreateOrEdit = useCallback(async (data: { title: string; icon: string; system_prompt: string; skill_id: string }) => {
    if (!token) return;

    if (editTarget === 'new') {
      // Create new assistant
      setCreating(true);
      try {
        const res = await fetch('/api/conversations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            title: data.title,
            category: 'assistant',
            skillId: data.skill_id || undefined,
            system_prompt: data.system_prompt || undefined,
            icon: data.icon || undefined,
          }),
        });
        const conv = await res.json();
        setEditTarget(null);
        router.push(`/chat/${conv.id}`);
      } finally {
        setCreating(false);
      }
    } else if (editTarget) {
      // Update existing assistant
      const conv = editTarget as AssistantConversation;
      await fetch(`/api/conversations/${conv.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          title: data.title,
          system_prompt: data.system_prompt,
          icon: data.icon,
          skill_id: data.skill_id,
        }),
      });
      setConversations(prev => prev.map(c =>
        c.id === conv.id
          ? { ...c, title: data.title, system_prompt: data.system_prompt, icon: data.icon, skill_id: data.skill_id || null }
          : c
      ));
      setEditTarget(null);
    }
  }, [editTarget, token, router]);

  async function handleDelete() {
    if (!token || !deleteTarget) return;
    await fetch(`/api/conversations/${deleteTarget.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    setConversations(prev => prev.filter(c => c.id !== deleteTarget.id));
    setDeleteTarget(null);
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

  function getSkillName(sid: string): string {
    const key = `skill.${sid}`;
    const translated = t(key as any);
    if (translated && translated !== key) return translated;
    const skill = skills.find(s => s.id === sid);
    return skill?.name || sid;
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
      {editTarget && (
        <AssistantEditModal
          conversation={editTarget === 'new' ? null : editTarget}
          skills={skills}
          token={token}
          locale={user?.locale}
          onSave={handleCreateOrEdit}
          onCancel={() => setEditTarget(null)}
        />
      )}
      {emailModalOpen && token && (
        <EmailModal token={token} onClose={() => setEmailModalOpen(false)} />
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
                      ? t('assistant.memoryPrefs' as any, { prefs: memoryCount - workLogCount, logs: workLogCount })
                      : t('assistant.memoryItems' as any, { count: memoryCount })}
                  </span>
                </div>
              )}
            </div>

            {/* Header buttons */}
            <div className="shrink-0 flex items-center gap-2 mt-1 md:mt-2">
              {/* Email button — pro-panjit only */}
              {deployMode === 'pro-panjit' && (
                <button
                  onClick={() => setEmailModalOpen(true)}
                  className="relative w-10 h-10 flex items-center justify-center rounded-xl border border-tertiary/20 bg-tertiary/5 text-tertiary hover:bg-tertiary/15 active:scale-95 transition-all cursor-pointer"
                  title={t('assistant.email.title' as any)}
                >
                  <span className="material-symbols-outlined text-xl">mail</span>
                  {emailConnected && <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-success rounded-full border-2 border-surface-container-lowest" />}
                </button>
              )}
              {/* New assistant button */}
              <button
                onClick={() => setEditTarget('new')}
                disabled={creating}
                className="flex items-center gap-2 px-4 py-2.5 cyber-gradient text-on-primary rounded-xl font-bold text-sm hover:brightness-110 active:scale-95 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
              >
                <span className={`material-symbols-outlined text-base ${creating ? 'animate-spin' : ''}`}>
                  {creating ? 'progress_activity' : 'add'}
                </span>
                <span className="hidden sm:inline">{t('assistant.newButton' as any)}</span>
              </button>
            </div>
          </div>
        </div>

        {/* Grid */}
        {conversations.length === 0 ? (
          /* Empty state */
          <button
            onClick={() => setEditTarget('new')}
            disabled={creating}
            className="w-full group flex flex-col items-center justify-center gap-4 bg-surface-container/40 rounded-2xl border-2 border-dashed border-outline-variant/25 hover:border-primary/40 hover:bg-surface-container/70 transition-all min-h-[260px] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed p-8"
          >
            <div className="w-16 h-16 rounded-2xl border-2 border-dashed border-outline-variant/40 flex items-center justify-center group-hover:border-primary/50 group-hover:bg-primary/5 transition-colors">
              <span className="material-symbols-outlined text-outline-variant group-hover:text-primary transition-colors text-3xl">add</span>
            </div>
            <div className="text-center">
              <p className="text-base font-bold font-headline text-on-surface-variant group-hover:text-primary transition-colors">
                {t('assistant.newChat' as any) || '建立第一個 AI 助手'}
              </p>
              <p className="text-sm text-outline mt-1">{t('assistant.emptyClickHint' as any)}</p>
            </div>
          </button>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-6">
            {pageConvs.map((conv, idx) => {
              const globalIdx = (currentPage - 1) * PAGE_SIZE + idx;
              const cardIcon = conv.icon || 'smart_toy';
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
                          <span className="material-symbols-outlined text-on-primary text-2xl">{cardIcon}</span>
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

                    <div className="flex items-center gap-2 text-xs text-on-surface-variant mb-3 flex-wrap">
                      {processingIds.has(conv.id) ? (
                        <span className="flex items-center gap-1 text-primary">
                          <span className="material-symbols-outlined text-[13px] animate-spin">progress_activity</span>
                          {t('assistant.processing' as any)}
                        </span>
                      ) : (
                        <span className="flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-success inline-block" />
                          {t('conversations.status.active' as any) || '進行中'}
                        </span>
                      )}
                      <span className="text-outline-variant/40">·</span>
                      <span>{formatDate(conv.created_at)}</span>
                      {conv.skill_id ? (
                        <>
                          <span className="text-outline-variant/40">·</span>
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-primary/10 rounded text-primary font-medium">
                            <span className="material-symbols-outlined text-[12px]">{SKILL_ICON_MAP[conv.skill_id] || 'bolt'}</span>
                            {getSkillName(conv.skill_id)}
                          </span>
                        </>
                      ) : (
                        <>
                          <span className="text-outline-variant/40">·</span>
                          <span className="flex items-center gap-1 text-tertiary">
                            <span className="material-symbols-outlined text-[13px]">psychology</span>
                            {t('assistant.memoryActive' as any) || '記憶中'}
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
                        onClick={() => setEditTarget(conv)}
                        className="w-9 h-9 flex items-center justify-center rounded-lg text-on-surface-variant hover:text-primary hover:bg-primary/10 transition-colors cursor-pointer border border-outline-variant/10"
                        title={t('assistant.settings' as any) || '設定'}
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
            <span>{t('assistant.totalInfo' as any, { count: conversations.length })}</span>
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
