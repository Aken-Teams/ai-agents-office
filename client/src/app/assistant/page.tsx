'use client';

import { useState, useEffect, useRef, useCallback, useLayoutEffect, type ReactNode } from 'react';
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
  team_id: string | null;
}

interface Team {
  id: string;
  title: string;
  topic: string | null;
  template_id: string | null;
  icon: string | null;
  member_count: number;
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

// Distinct per-role colours so team members are visually distinguishable at a
// glance (they were all the same teal before). Still a tasteful, on-brand set.
const ROLE_PALETTE = ['#0e7c72', '#2b6cb0', '#7c3aed', '#e08700', '#12805c', '#d1495b', '#0891b2', '#c026d3'];
const roleColor = (index: number) => ROLE_PALETTE[((index % ROLE_PALETTE.length) + ROLE_PALETTE.length) % ROLE_PALETTE.length];

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
  hideSkill,
}: {
  conversation: AssistantConversation | null; // null = create new
  skills: SkillOption[];
  token: string | null;
  locale?: string;
  onSave: (data: { title: string; icon: string; system_prompt: string; skill_id: string }) => void;
  onCancel: () => void;
  hideSkill?: boolean; // team members are role-only — hide the skill binding
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

          {/* Skill binding — hidden for team members (they are role-only) */}
          {!hideSkill && (
            <div>
              <label className="block text-sm font-bold text-on-surface mb-1.5">
                {t('assistant.editModal.skill' as any)}
              </label>
              <SkillPicker skills={skills} value={skillId} onChange={setSkillId} />
              <p className="text-xs text-on-surface-variant/70 mt-1">
                {t('assistant.editModal.skillHint' as any)}
              </p>
            </div>
          )}

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
                (selectedMsg.body_type === 'html' || /<(?:div|table|html|head|body|span|p|br|a|img|style|td|tr|th)\b/i.test(selectedMsg.body)) ? (
                  <iframe
                    srcDoc={`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;padding:0;overflow-x:hidden;word-break:break-word;overflow-wrap:break-word;-webkit-text-size-adjust:100%;}img[src^="cid:"]{display:none!important;width:0!important;height:0!important;}img{max-width:100%!important;height:auto!important;}.table-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;max-width:100%;margin:8px 0;}.reply-collapsed{border-left:3px solid #c4c4c4;margin:16px 0;padding:4px 12px;border-radius:4px;background:#f5f5f5;cursor:pointer;font-size:12px;color:#666;}.reply-content{border-left:3px solid #ddd;margin:16px 0;padding:8px 12px;opacity:0.7;font-size:13px;}</style></head><body>${selectedMsg.body}</body></html>`}
                    className="w-full border-0 min-h-[200px] md:min-h-[300px]"
                    sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
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

// ── Team Create Modal ───────────────────────────────────────────────────────
interface TeamTemplate {
  id: string;
  title: string;
  icon: string;
  description: string;
  agents: { name: string; icon: string; skillId: string | null }[];
}

function TeamCreateModal({ token, onCreated, onCancel }: { token: string | null; onCreated: () => void; onCancel: () => void }) {
  const [templates, setTemplates] = useState<TeamTemplate[]>([]);
  const [selected, setSelected] = useState<TeamTemplate | null>(null);
  const [customMode, setCustomMode] = useState(false);
  const [topic, setTopic] = useState('');
  const [aiTune, setAiTune] = useState(false);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/teams/templates', { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(r => r.json())
      .then(d => { setTemplates(Array.isArray(d.templates) ? d.templates : []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [token]);

  const handleCreate = async () => {
    if (creating || !token) return;
    if (customMode ? !topic.trim() : !selected) return;
    const body = customMode
      ? { custom: true, topic: topic.trim() }
      : { templateId: selected!.id, topic: topic.trim() || undefined, aiTune };
    setCreating(true);
    setError(null);
    try {
      const res = await fetch('/api/teams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (res.ok) { onCreated(); onCancel(); return; }
      // Surface server errors (e.g. content-safety refusal on a 403).
      const data = await res.json().catch(() => null);
      setError(data?.error || '建立失敗，請稍後再試。');
    } catch {
      setError('連線發生問題，請稍後再試。');
    } finally { setCreating(false); }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={onCancel}>
      <div className="bg-surface-container-lowest rounded-2xl shadow-2xl w-full max-w-5xl max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="px-5 md:px-7 pt-5 md:pt-6 pb-3 shrink-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="material-symbols-outlined text-primary">groups</span>
            <h3 className="text-lg font-headline font-bold text-on-surface">建立 AI 助手團隊</h3>
          </div>
          <p className="text-sm text-on-surface-variant">選一個領域，系統會自動建立一組分工合作的 AI 助手。</p>
        </div>

        <div className="flex-1 overflow-y-auto px-5 md:px-7 min-h-0 pt-1 pb-3">
          {loading ? (
            <div className="flex justify-center py-10"><span className="material-symbols-outlined animate-spin text-primary text-3xl">progress_activity</span></div>
          ) : (
            <>
              {/* AI custom team — prominent full-width toggle above the templates */}
              <button onClick={() => { const next = !customMode; setCustomMode(next); if (next) setSelected(null); }}
                className={`w-full flex items-center gap-3 p-4 mb-4 rounded-xl border transition-all cursor-pointer text-left ${customMode ? 'border-tertiary bg-tertiary/5 ring-1 ring-tertiary/30' : 'border-outline-variant/20 bg-surface-container hover:border-tertiary/50'}`}>
                <div className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 transition-colors ${customMode ? 'bg-tertiary text-on-primary' : 'bg-surface-container-high text-tertiary'}`}>
                  <span className="material-symbols-outlined text-xl">auto_awesome</span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-bold text-on-surface text-sm">AI 自訂團隊</div>
                  <div className="text-xs text-on-surface-variant">描述你的情境，AI 依需求自動組成 3–5 位分工互補的助手</div>
                </div>
                {customMode && <span className="material-symbols-outlined text-tertiary shrink-0">check_circle</span>}
              </button>

              {/* Template picker — hidden when AI custom mode is on */}
              {!customMode && (
                <div className="animate-in fade-in duration-200">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-on-surface-variant/70 mb-2 px-1">或從範本領域選擇</p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2.5 mb-4">
                    {templates.map(tpl => {
                      const isSel = selected?.id === tpl.id;
                      return (
                        <button key={tpl.id} onClick={() => { setSelected(tpl); setCustomMode(false); }}
                          className={`relative flex flex-col items-center text-center p-3 md:p-4 rounded-xl border transition-all cursor-pointer ${isSel ? 'border-primary bg-primary/5 ring-1 ring-primary/30' : 'border-outline-variant/20 bg-surface-container hover:border-primary/40'}`}>
                          {isSel && <span className="material-symbols-outlined absolute top-1.5 right-1.5 text-primary text-lg">check_circle</span>}
                          <div className={`w-9 h-9 md:w-11 md:h-11 rounded-xl flex items-center justify-center mb-1.5 md:mb-2 transition-colors ${isSel ? 'cyber-gradient text-on-primary' : 'bg-surface-container-high text-primary'}`}>
                            <span className="material-symbols-outlined text-lg md:text-xl">{tpl.icon}</span>
                          </div>
                          <div className="font-bold text-on-surface text-sm leading-tight">{tpl.title}</div>
                          <div className="text-[11px] text-on-surface-variant mt-0.5">{tpl.agents.length} 位助手</div>
                        </button>
                      );
                    })}
                  </div>
                  {selected && (
                    <div className="flex flex-wrap items-center gap-1.5 mb-5 px-1">
                      <span className="text-xs text-on-surface-variant mr-1">團隊成員：</span>
                      {selected.agents.map(a => (
                        <span key={a.name} className="text-[11px] px-2 py-0.5 rounded-full bg-primary/10 text-primary">{a.name}</span>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Scenario (custom) or topic (template) */}
              {customMode ? (
                <div className="animate-in fade-in slide-in-from-top-2 duration-200 mb-6">
                  <label className="block text-xs font-bold uppercase tracking-wider text-on-surface-variant mb-1.5">描述你的情境 / 問題（必填）</label>
                  <p className="text-xs text-tertiary mb-2 flex items-center gap-1">
                    <span className="material-symbols-outlined text-[15px]">auto_awesome</span>
                    AI 會依此情境，自動組成 3–5 位分工互補的助手
                  </p>
                  <textarea value={topic} onChange={e => setTopic(e.target.value)} autoFocus
                    placeholder="例如：跟戀愛相關的問題，希望能幫我分析星座、解讀對方心理、給我行動建議…"
                    className="w-full bg-surface-container border border-outline-variant/30 rounded-2xl px-4 py-3.5 text-base text-on-surface placeholder:text-outline focus:outline-none focus:border-primary resize-none min-h-[180px] leading-relaxed" />
                </div>
              ) : (
                <div className="mb-6">
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-xs font-bold uppercase tracking-wider text-on-surface-variant">議題（選填，讓團隊更聚焦）</label>
                    <button type="button" onClick={() => setAiTune(v => !v)} title="開啟後會多花一次輕量 AI 呼叫，依議題微調每位助手的角色"
                      className="flex items-center gap-1.5 text-xs font-medium text-on-surface-variant hover:text-primary transition-colors cursor-pointer">
                      <span className="material-symbols-outlined text-sm text-primary">auto_awesome</span>
                      AI 依議題微調角色
                      <span className={`relative w-9 h-5 rounded-full transition-colors ${aiTune ? 'bg-primary' : 'bg-outline-variant/40'}`}>
                        <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${aiTune ? 'translate-x-4' : ''}`} />
                      </span>
                    </button>
                  </div>
                  <input value={topic} onChange={e => setTopic(e.target.value)}
                    placeholder="例如：2025 下半年台股佈局、新產品上市行銷…"
                    className="w-full bg-surface-container border border-outline-variant/30 rounded-xl px-4 py-2.5 text-sm text-on-surface focus:outline-none focus:border-primary" />
                </div>
              )}

            </>
          )}
        </div>

        {error && (
          <div className="shrink-0 mx-5 md:mx-7 mb-1 flex items-start gap-2 rounded-xl border border-error/30 bg-error/10 px-4 py-3 text-sm text-error">
            <span className="material-symbols-outlined text-base shrink-0 mt-0.5">block</span>
            <span className="leading-relaxed">{error}</span>
          </div>
        )}

        <div className="shrink-0 flex items-center justify-end gap-2 px-5 md:px-7 py-3.5 border-t border-outline-variant/15">
          <button onClick={onCancel} className="px-5 py-2.5 rounded-xl text-sm font-bold text-on-surface-variant hover:bg-surface-container-high transition-colors cursor-pointer">取消</button>
          <button onClick={handleCreate} disabled={creating || (customMode ? !topic.trim() : !selected)}
            className="flex-1 sm:flex-none justify-center px-6 py-2.5 rounded-xl text-sm font-bold text-on-primary cyber-gradient disabled:opacity-40 disabled:cursor-not-allowed transition-all cursor-pointer flex items-center gap-2">
            <span className={`material-symbols-outlined text-base ${creating ? 'animate-spin' : ''}`}>{creating ? 'progress_activity' : (customMode ? 'auto_awesome' : 'group_add')}</span>
            <span className="truncate">{creating && customMode ? 'AI 建立中…' : customMode ? '讓 AI 建立團隊' : selected ? `建立團隊（${selected.agents.length} 位）` : '請先選領域或描述'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Team Delete Modal ───────────────────────────────────────────────────────
function TeamDeleteModal({ team, onDelete, onDisband, onCancel }: { team: Team; onDelete: () => void; onDisband: () => void; onCancel: () => void }) {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={onCancel}>
      <div className="bg-surface-container-lowest rounded-2xl shadow-2xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-xl bg-error/10 flex items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-error">delete</span>
          </div>
          <div className="min-w-0">
            <h3 className="text-lg font-headline font-bold text-on-surface truncate">刪除團隊「{team.title}」？</h3>
            <p className="text-xs text-on-surface-variant">這個團隊有 {team.member_count} 位助手</p>
          </div>
        </div>
        <p className="text-sm text-on-surface-variant mb-4">你想怎麼處理團隊裡的助手？</p>
        <div className="space-y-2.5">
          <button onClick={onDelete} className="w-full flex items-center gap-3 p-3.5 rounded-xl border border-error/30 bg-error/5 hover:bg-error/10 transition-colors cursor-pointer text-left">
            <span className="material-symbols-outlined text-error shrink-0">delete_forever</span>
            <span className="min-w-0">
              <span className="block text-sm font-bold text-on-surface">刪除團隊與所有助手</span>
              <span className="block text-xs text-on-surface-variant">助手與其對話一併刪除（無法復原）</span>
            </span>
          </button>
          <button onClick={onDisband} className="w-full flex items-center gap-3 p-3.5 rounded-xl border border-outline-variant/20 bg-surface-container hover:bg-surface-container-high transition-colors cursor-pointer text-left">
            <span className="material-symbols-outlined text-on-surface-variant shrink-0">group_remove</span>
            <span className="min-w-0">
              <span className="block text-sm font-bold text-on-surface">只解散團隊</span>
              <span className="block text-xs text-on-surface-variant">保留助手，移為「獨立助手」</span>
            </span>
          </button>
        </div>
        <div className="flex justify-end mt-5">
          <button onClick={onCancel} className="px-5 py-2.5 rounded-xl text-sm font-bold text-on-surface-variant hover:bg-surface-container-high transition-colors cursor-pointer">取消</button>
        </div>
      </div>
    </div>
  );
}

// ── Team Add-Member Modal ───────────────────────────────────────────────────
function TeamAddMemberModal({ team, token, standalone, onCreateNew, onDone, onCancel }: {
  team: Team; token: string | null; standalone: AssistantConversation[];
  onCreateNew: () => void; onDone: () => void; onCancel: () => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const toggle = (id: string) => setPicked(p => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const addPicked = async () => {
    if (!picked.size || !token) return;
    setSaving(true);
    try {
      await Promise.all([...picked].map(id =>
        fetch(`/api/conversations/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ team_id: team.id }),
        }),
      ));
      onDone();
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={onCancel}>
      <div className="bg-surface-container-lowest rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col p-6" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-headline font-bold text-on-surface mb-1">加入助手到「{team.title}」</h3>
        <p className="text-sm text-on-surface-variant mb-4">建立一個新助手，或把現有的獨立助手加進來。</p>

        <button onClick={onCreateNew} className="w-full flex items-center gap-3 p-3.5 mb-4 rounded-xl border border-primary/30 bg-primary/5 hover:bg-primary/10 transition-colors cursor-pointer text-left">
          <span className="material-symbols-outlined text-primary">add_circle</span>
          <span className="min-w-0">
            <span className="block text-sm font-bold text-on-surface">建立新助手</span>
            <span className="block text-xs text-on-surface-variant">自訂名稱、角色與技能</span>
          </span>
        </button>

        <p className="text-[11px] font-bold uppercase tracking-wider text-on-surface-variant/70 mb-2">或加入現有的獨立助手</p>
        {standalone.length === 0 ? (
          <p className="text-sm text-on-surface-variant/70 italic py-4 text-center">目前沒有獨立助手可加入</p>
        ) : (
          <div className="flex-1 overflow-y-auto space-y-1.5 -mx-1 px-1 min-h-0">
            {standalone.map(c => {
              const sel = picked.has(c.id);
              return (
                <button key={c.id} onClick={() => toggle(c.id)} className={`w-full flex items-center gap-3 p-2.5 rounded-xl border transition-colors cursor-pointer text-left ${sel ? 'border-primary bg-primary/5' : 'border-outline-variant/15 bg-surface-container hover:border-primary/30'}`}>
                  <div className="w-8 h-8 rounded-lg cyber-gradient flex items-center justify-center shrink-0"><span className="material-symbols-outlined text-on-primary text-base">{c.icon || 'smart_toy'}</span></div>
                  <span className="flex-1 text-sm text-on-surface truncate">{c.title}</span>
                  <span className={`material-symbols-outlined ${sel ? 'text-primary' : 'text-outline-variant'}`}>{sel ? 'check_circle' : 'radio_button_unchecked'}</span>
                </button>
              );
            })}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-4 mt-3 border-t border-outline-variant/15">
          <button onClick={onCancel} className="px-4 py-2 rounded-xl text-sm font-bold text-on-surface-variant hover:bg-surface-container-high transition-colors cursor-pointer">取消</button>
          <button onClick={addPicked} disabled={!picked.size || saving} className="px-5 py-2 rounded-xl text-sm font-bold text-on-primary cyber-gradient disabled:opacity-40 disabled:cursor-not-allowed transition-all cursor-pointer flex items-center gap-2">
            {saving && <span className="material-symbols-outlined animate-spin text-base">progress_activity</span>}
            加入所選{picked.size ? `（${picked.size}）` : ''}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Custom tooltip (replaces the ugly native title="" bubble) ────────────────
function Tip({ text, children }: { text: string; children: ReactNode }) {
  return (
    <span className="relative inline-flex shrink-0 group/tip">
      {children}
      <span className="pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-full mb-2 z-[60] whitespace-nowrap rounded-lg bg-on-surface text-surface text-xs font-medium px-2.5 py-1.5 opacity-0 translate-y-1 group-hover/tip:opacity-100 group-hover/tip:translate-y-0 transition-all duration-150 shadow-xl">
        {text}
        <span className="absolute left-1/2 -translate-x-1/2 top-full -mt-1 w-2 h-2 rotate-45 bg-on-surface" />
      </span>
    </span>
  );
}

// ── Card overflow menu (⋯) — keeps cards clean: primary = open chat, rest here ──
function CardActions({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', h);
    return () => window.removeEventListener('mousedown', h);
  }, [open]);
  return (
    <div className="relative shrink-0" ref={ref}>
      <Tip text={t('assistant.more' as any) || '更多'}>
        <button onClick={() => setOpen(o => !o)}
          className="w-9 h-9 flex items-center justify-center rounded-lg text-on-surface-variant hover:text-primary hover:bg-primary/10 transition-colors cursor-pointer border border-outline-variant/10">
          <span className="material-symbols-outlined text-[18px]">more_horiz</span>
        </button>
      </Tip>
      {open && (
        <div className="absolute right-0 top-11 z-40 w-32 bg-surface-container-high border border-outline-variant/20 rounded-xl shadow-xl py-1 overflow-hidden">
          <button onClick={() => { setOpen(false); onEdit(); }}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-on-surface hover:bg-primary/10 transition-colors text-left cursor-pointer">
            <span className="material-symbols-outlined text-[18px]">tune</span>{t('assistant.settings' as any) || '設定'}
          </button>
          <button onClick={() => { setOpen(false); onDelete(); }}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-error hover:bg-error/10 transition-colors text-left cursor-pointer">
            <span className="material-symbols-outlined text-[18px]">delete</span>{t('assistant.delete' as any) || '刪除'}
          </button>
        </div>
      )}
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
  const [teamModalOpen, setTeamModalOpen] = useState(false);

  const [teams, setTeams] = useState<Team[]>([]);
  const [collapsedTeams, setCollapsedTeams] = useState<Set<string>>(new Set());
  const [teamDeleteTarget, setTeamDeleteTarget] = useState<Team | null>(null);
  const [addMemberTeam, setAddMemberTeam] = useState<Team | null>(null);
  const [addToTeamId, setAddToTeamId] = useState<string | null>(null);
  // Workspace view controls (scale to many teams/assistants)
  const [filterMode, setFilterMode] = useState<'all' | 'teams' | 'solo'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const didInitCollapse = useRef(false);

  const loadConversations = useCallback(() => {
    if (!token) return;
    fetch('/api/conversations?category=assistant', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(data => setConversations(Array.isArray(data) ? data : []))
      .catch(console.error);
  }, [token]);

  const loadTeams = useCallback(() => {
    if (!token) return;
    fetch('/api/teams', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => setTeams(Array.isArray(d.teams) ? d.teams : []))
      .catch(() => {});
  }, [token]);

  const refreshAll = useCallback(() => { loadConversations(); loadTeams(); }, [loadConversations, loadTeams]);

  const toggleTeam = (id: string) => setCollapsedTeams(prev => {
    const n = new Set(prev);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  // Default every team COLLAPSED on first load — keeps the page clean when there
  // are many teams (user expands the one they want). Runs once; later user toggles
  // and newly-created teams (which expand) are preserved.
  useEffect(() => {
    if (didInitCollapse.current || teams.length === 0) return;
    didInitCollapse.current = true;
    setCollapsedTeams(new Set(teams.map(t => t.id)));
  }, [teams]);

  const handleTeamDelete = useCallback(async (withAgents: boolean) => {
    if (!teamDeleteTarget || !token) return;
    const q = withAgents ? '?withAgents=1' : '';
    await fetch(`/api/teams/${teamDeleteTarget.id}${q}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    setTeamDeleteTarget(null);
    refreshAll();
  }, [teamDeleteTarget, token, refreshAll]);

  useEffect(() => { loadTeams(); }, [loadTeams]);

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
            team_id: addToTeamId || undefined,
          }),
        });
        const conv = await res.json();
        setEditTarget(null);
        if (addToTeamId) {
          // Added into a team — stay on this page and refresh the group view.
          setAddToTeamId(null);
          refreshAll();
        } else {
          router.push(`/chat/${conv.id}`);
        }
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
  }, [editTarget, token, router, addToTeamId, refreshAll]);

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

  const standaloneConvs = conversations.filter(c => !c.team_id);
  const teamsWithMembers = teams
    .map(team => ({ team, members: conversations.filter(c => c.team_id === team.id) }))
    .filter(g => g.members.length > 0);

  // Filter (all/teams/solo) + search — so the page stays usable at high volume.
  const q = searchQuery.trim().toLowerCase();
  const matchConv = (c: AssistantConversation) =>
    !q || c.title.toLowerCase().includes(q) || (c.summary || '').toLowerCase().includes(q);
  const visibleTeams = filterMode === 'solo' ? [] : teamsWithMembers.filter(({ team, members }) =>
    !q || team.title.toLowerCase().includes(q) || (team.topic || '').toLowerCase().includes(q) || members.some(matchConv));
  const visibleSolo = filterMode === 'teams' ? [] : standaloneConvs.filter(matchConv);
  const hasResults = visibleTeams.length > 0 || visibleSolo.length > 0;

  // Compact card for a team member: emphasises role + "open chat", drops the
  // summary / status noise so 4 members sit comfortably in a row.
  // muted = standalone assistant (no team) → stays GREY (colour is reserved for
  // team roles, so a coloured card always means "belongs to a team").
  const renderMemberCard = (conv: AssistantConversation, index: number, muted = false) => {
    const cardIcon = conv.icon || 'smart_toy';
    const color = roleColor(index);
    const skillIcon = conv.skill_id ? (SKILL_ICON_MAP[conv.skill_id] || 'bolt') : 'psychology';
    const skillLabel = conv.skill_id ? getSkillName(conv.skill_id) : (t('assistant.memoryActive' as any) || '自由對話');
    return (
      <div key={conv.id} className="group relative flex flex-col rounded-xl border border-outline-variant/10 bg-surface-container hover:border-primary/30 transition-all">
        <div className={`h-1 w-full rounded-t-xl ${muted ? 'bg-outline-variant/30' : ''}`} style={muted ? undefined : { background: color + '80' }} />
        <div className="p-3.5 flex flex-col flex-1">
          {/* one compact band: icon + name + role */}
          <div className="flex items-center gap-2.5 mb-3">
            <div className="relative shrink-0">
              <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${muted ? 'bg-surface-container-high text-on-surface-variant' : ''}`} style={muted ? undefined : { backgroundColor: color + '1F', color }}>
                <span className="material-symbols-outlined text-lg">{cardIcon}</span>
              </div>
              {!muted && <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-success rounded-full border-2 border-surface-container" />}
            </div>
            <div className="min-w-0 flex-1">
              <h3 title={conv.title} className="font-bold text-on-surface text-sm leading-tight line-clamp-1 group-hover:text-primary transition-colors">{conv.title}</h3>
              <span className="text-[11px] text-on-surface-variant flex items-center gap-1 mt-0.5">
                <span className="material-symbols-outlined text-[13px] shrink-0">{skillIcon}</span>
                <span className="truncate">{skillLabel}</span>
              </span>
            </div>
            <span className="text-[10px] font-mono text-outline shrink-0 self-start">#{index + 1}</span>
          </div>
          <div className="mt-auto flex items-center gap-2">
            <Link href={`/chat/${conv.id}`} className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-bold font-headline active:scale-95 transition-all no-underline ${muted ? 'bg-surface-container-high text-on-surface hover:bg-surface-variant/50 border border-outline-variant/15' : 'cyber-gradient text-on-primary hover:brightness-110'}`}>
              <span className="material-symbols-outlined text-base">chat</span>
              {t('assistant.openChat' as any) || '開啟對話'}
            </Link>
            <CardActions onEdit={() => setEditTarget(conv)} onDelete={() => setDeleteTarget(conv)} />
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-surface-container-lowest">
      <Navbar />
      {deleteTarget && (
        <DeleteConfirmModal title={deleteTarget.title} onConfirm={handleDelete} onCancel={() => setDeleteTarget(null)} />
      )}
      {editTarget && (
        <AssistantEditModal
          conversation={editTarget === 'new' ? null : editTarget}
          // pro-panjit: 資訊圖表(infographic-gen) 暫不開放，從綁定技能清單隱藏
          skills={deployMode === 'pro-panjit' ? skills.filter(s => s.id !== 'infographic-gen') : skills}
          // team members are role-only → hide skill binding (adding to a team, or editing an existing member)
          hideSkill={!!addToTeamId || (editTarget !== 'new' && !!editTarget?.team_id)}
          token={token}
          locale={user?.locale}
          onSave={handleCreateOrEdit}
          onCancel={() => setEditTarget(null)}
        />
      )}
      {emailModalOpen && token && (
        <EmailModal token={token} onClose={() => setEmailModalOpen(false)} />
      )}
      {teamModalOpen && (
        <TeamCreateModal token={token} onCreated={refreshAll} onCancel={() => setTeamModalOpen(false)} />
      )}
      {teamDeleteTarget && (
        <TeamDeleteModal
          team={teamDeleteTarget}
          onDelete={() => handleTeamDelete(true)}
          onDisband={() => handleTeamDelete(false)}
          onCancel={() => setTeamDeleteTarget(null)}
        />
      )}
      {addMemberTeam && (
        <TeamAddMemberModal
          team={addMemberTeam}
          token={token}
          standalone={conversations.filter(c => !c.team_id)}
          onCreateNew={() => { setAddToTeamId(addMemberTeam.id); setEditTarget('new'); setAddMemberTeam(null); }}
          onDone={() => { setAddMemberTeam(null); refreshAll(); }}
          onCancel={() => setAddMemberTeam(null)}
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
                <div className="mt-4 inline-flex items-center gap-2 px-3 py-1.5 bg-tertiary/10 border border-tertiary/20 rounded-xl text-sm text-tertiary max-w-full">
                  <span className="material-symbols-outlined text-base shrink-0">psychology</span>
                  <span className="font-medium">{t('assistant.memoryBadge' as any)}</span>
                  <span className="text-tertiary/70 whitespace-nowrap">
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
                <Tip text={t('assistant.email.title' as any)}>
                  <button
                    onClick={() => setEmailModalOpen(true)}
                    className="relative w-10 h-10 flex items-center justify-center rounded-xl border border-tertiary/20 bg-tertiary/5 text-tertiary hover:bg-tertiary/15 active:scale-95 transition-all cursor-pointer"
                  >
                    <span className="material-symbols-outlined text-xl">mail</span>
                    {emailConnected && <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-success rounded-full border-2 border-surface-container-lowest" />}
                  </button>
                </Tip>
              )}
              {/* Create team button */}
              <button
                onClick={() => setTeamModalOpen(true)}
                className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-primary/30 bg-primary/5 text-primary font-bold text-sm hover:bg-primary/10 active:scale-95 transition-all cursor-pointer shadow-sm"
              >
                <span className="material-symbols-outlined text-base">groups</span>
                <span className="hidden sm:inline">建立團隊</span>
              </button>
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

        {/* Controls: filter + search (scale to many teams/assistants) */}
        {conversations.length > 0 && (
          <div className="mb-6 flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="inline-flex bg-surface-container border border-outline-variant/15 rounded-xl p-1 gap-1 self-start">
              {([['all', t('assistant.filter.all' as any) || '全部', teamsWithMembers.length + standaloneConvs.length],
                 ['teams', t('assistant.filter.teams' as any) || '團隊', teamsWithMembers.length],
                 ['solo', t('assistant.filter.solo' as any) || '獨立助手', standaloneConvs.length]] as const).map(([mode, label, count]) => (
                <button key={mode} onClick={() => setFilterMode(mode as 'all' | 'teams' | 'solo')}
                  className={`px-3.5 py-1.5 rounded-lg text-sm font-bold transition-colors cursor-pointer ${filterMode === mode ? 'bg-surface text-primary shadow-sm' : 'text-on-surface-variant hover:text-on-surface'}`}>
                  {label}<span className="ml-1.5 text-xs opacity-60 font-mono">{count}</span>
                </button>
              ))}
            </div>
            <div className="sm:ml-auto sm:w-72 flex items-center gap-2 bg-surface-container border border-outline-variant/15 rounded-xl px-3 py-2">
              <span className="material-symbols-outlined text-outline text-lg">search</span>
              <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                placeholder={t('assistant.searchPlaceholder' as any) || '搜尋團隊或助手名稱…'}
                className="flex-1 bg-transparent border-none outline-none text-sm text-on-surface placeholder:text-outline" />
              {searchQuery && (
                <button onClick={() => setSearchQuery('')} className="text-outline hover:text-on-surface cursor-pointer">
                  <span className="material-symbols-outlined text-base">close</span>
                </button>
              )}
            </div>
          </div>
        )}

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
          <div className="space-y-10">
            {/* Team sections */}
            {visibleTeams.map(({ team, members }) => {
              const collapsed = collapsedTeams.has(team.id);
              return (
                <section key={team.id} className="rounded-2xl border border-primary/20 bg-primary/[0.04] p-4 md:p-5">
                  <div className={`flex flex-col sm:flex-row sm:items-center gap-3 ${collapsed ? '' : 'mb-4'}`}>
                    <button onClick={() => toggleTeam(team.id)} className="group flex items-center gap-3 flex-1 min-w-0 text-left cursor-pointer w-full">
                      <div className="w-11 h-11 rounded-xl cyber-gradient flex items-center justify-center shrink-0">
                        <span className="material-symbols-outlined text-on-primary text-xl">{team.icon || 'groups'}</span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-bold uppercase tracking-wider text-primary bg-primary/15 px-1.5 py-0.5 rounded shrink-0">團隊</span>
                          <h3 className="font-headline font-bold text-on-surface text-base md:text-lg truncate group-hover:text-primary transition-colors">{team.title}</h3>
                          <span className="text-xs text-on-surface-variant bg-surface-container-high px-2 py-0.5 rounded-full shrink-0">{members.length} 位</span>
                        </div>
                        {!collapsed && team.topic && <p className="text-xs text-on-surface-variant truncate mt-0.5">議題：{team.topic}</p>}
                      </div>
                      {/* member avatars — glance at who's in the team even when collapsed */}
                      <div className="hidden md:flex items-center shrink-0 mr-1">
                        {members.slice(0, 5).map((m, mi) => (
                          <div key={m.id} title={m.title}
                            className={`w-7 h-7 rounded-full border-2 border-surface-container flex items-center justify-center ${mi === 0 ? '' : '-ml-2'}`}
                            style={{ backgroundColor: roleColor(mi) + '29', color: roleColor(mi) }}>
                            <span className="material-symbols-outlined" style={{ fontSize: 13 }}>{m.icon || 'smart_toy'}</span>
                          </div>
                        ))}
                        {members.length > 5 && <span className="ml-1.5 text-xs text-on-surface-variant font-mono">+{members.length - 5}</span>}
                      </div>
                      <span className="material-symbols-outlined text-on-surface-variant ml-1 transition-transform shrink-0" style={{ transform: collapsed ? 'rotate(-90deg)' : 'none' }}>expand_more</span>
                    </button>
                    <div className="flex items-center gap-2 shrink-0">
                      <Link href={`/team/${team.id}`} className="flex-1 sm:flex-none flex items-center justify-center gap-1.5 px-3.5 h-9 rounded-lg text-sm font-bold text-on-primary cyber-gradient hover:brightness-110 active:scale-95 transition-all cursor-pointer no-underline">
                        <span className="material-symbols-outlined text-[18px]">bolt</span>
                        跑團隊分析
                      </Link>
                      <Tip text="新增助手到團隊">
                        <button onClick={() => setAddMemberTeam(team)}
                          className="w-9 h-9 flex items-center justify-center rounded-lg text-on-surface-variant hover:text-primary hover:bg-primary/10 transition-colors cursor-pointer">
                          <span className="material-symbols-outlined text-[18px]">person_add</span>
                        </button>
                      </Tip>
                      <Tip text="刪除團隊">
                        <button onClick={() => setTeamDeleteTarget(team)} className="w-9 h-9 flex items-center justify-center rounded-lg text-on-surface-variant hover:text-error hover:bg-error/10 transition-colors cursor-pointer">
                          <span className="material-symbols-outlined text-[18px]">delete</span>
                        </button>
                      </Tip>
                    </div>
                  </div>
                  {!collapsed && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-4 gap-3 md:gap-4">
                      {members.map((conv, i) => renderMemberCard(conv, i))}
                      {/* inline add-member card — discoverable way to grow the team */}
                      <button onClick={() => setAddMemberTeam(team)}
                        className="rounded-xl border-2 border-dashed border-primary/30 bg-primary/[0.03] hover:bg-primary/[0.07] flex flex-col items-center justify-center gap-1.5 text-primary text-sm font-bold cursor-pointer min-h-[104px] transition-colors">
                        <span className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center"><span className="material-symbols-outlined">add</span></span>
                        {t('assistant.addMember' as any) || '加成員 / 助手'}
                      </button>
                    </div>
                  )}
                </section>
              );
            })}

            {/* Standalone assistants */}
            {visibleSolo.length > 0 && (
              <section>
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-11 h-11 rounded-xl bg-surface-container-high flex items-center justify-center shrink-0">
                    <span className="material-symbols-outlined text-on-surface-variant text-xl">person</span>
                  </div>
                  <div>
                    <h3 className="font-headline font-bold text-on-surface text-lg">獨立助手</h3>
                    <p className="text-xs text-on-surface-variant">不屬於任何團隊</p>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  {visibleSolo.map((conv, i) => renderMemberCard(conv, i, true))}
                </div>
              </section>
            )}

            {/* No results after filter/search */}
            {!hasResults && (
              <div className="text-center py-16 text-on-surface-variant">
                <span className="material-symbols-outlined text-4xl text-outline/50">search_off</span>
                <p className="mt-2 text-sm">{t('assistant.noResults' as any) || '找不到符合的團隊或助手'}</p>
              </div>
            )}
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
