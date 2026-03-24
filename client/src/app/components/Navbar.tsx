'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from './AuthProvider';
import { useTranslation } from '../../i18n';
import type { Locale, Theme } from '../../i18n/types';

const SIDEBAR_KEY = 'sidebar-collapsed';

const NAV_LINKS = [
  { href: '/dashboard', labelKey: 'nav.dashboard' as const, icon: 'dashboard' },
  { href: '/conversations', labelKey: 'nav.conversations' as const, icon: 'chat' },
  { href: '/files', labelKey: 'nav.files' as const, icon: 'folder_open' },
  { href: '/usage', labelKey: 'nav.usage' as const, icon: 'bar_chart' },
];

const DOC_TYPES = [
  { id: 'pptx-gen', labelKey: 'nav.docTypes.pptx.label' as const, descKey: 'nav.docTypes.pptx.desc' as const, icon: 'present_to_all', colorClass: 'text-warning' },
  { id: 'docx-gen', labelKey: 'nav.docTypes.docx.label' as const, descKey: 'nav.docTypes.docx.desc' as const, icon: 'description', colorClass: 'text-tertiary' },
  { id: 'xlsx-gen', labelKey: 'nav.docTypes.xlsx.label' as const, descKey: 'nav.docTypes.xlsx.desc' as const, icon: 'table_chart', colorClass: 'text-success' },
  { id: 'pdf-gen', labelKey: 'nav.docTypes.pdf.label' as const, descKey: 'nav.docTypes.pdf.desc' as const, icon: 'picture_as_pdf', colorClass: 'text-error' },
  { id: 'slides-gen', labelKey: 'nav.docTypes.slides.label' as const, descKey: 'nav.docTypes.slides.desc' as const, icon: 'slideshow', colorClass: 'text-secondary' },
  { id: 'data-analyst', labelKey: 'nav.docTypes.dataAnalyst.label' as const, descKey: 'nav.docTypes.dataAnalyst.desc' as const, icon: 'analytics', colorClass: 'text-primary' },
  { id: 'rag-analyst', labelKey: 'nav.docTypes.ragAnalyst.label' as const, descKey: 'nav.docTypes.ragAnalyst.desc' as const, icon: 'hub', colorClass: 'text-tertiary' },
  { id: 'research', labelKey: 'nav.docTypes.research.label' as const, descKey: 'nav.docTypes.research.desc' as const, icon: 'travel_explore', colorClass: 'text-on-surface-variant' },
];

const SKILL_TEMPLATES: Record<string, Array<{ id: string; icon: string; labelKey: string; promptKey: string; descKey: string }>> = {
  'pptx-gen': [
    { id: 'minimal-pro', icon: 'tune', labelKey: 'templates.pptx.minimalPro' as any, descKey: 'templates.pptx.minimalPro.desc' as any, promptKey: 'templates.pptx.minimalPro.prompt' as any },
    { id: 'tech-dark', icon: 'dark_mode', labelKey: 'templates.pptx.techDark' as any, descKey: 'templates.pptx.techDark.desc' as any, promptKey: 'templates.pptx.techDark.prompt' as any },
    { id: 'corporate', icon: 'business_center', labelKey: 'templates.pptx.corporate' as any, descKey: 'templates.pptx.corporate.desc' as any, promptKey: 'templates.pptx.corporate.prompt' as any },
    { id: 'creative', icon: 'palette', labelKey: 'templates.pptx.creative' as any, descKey: 'templates.pptx.creative.desc' as any, promptKey: 'templates.pptx.creative.prompt' as any },
  ],
  'docx-gen': [
    { id: 'formal', icon: 'verified', labelKey: 'templates.docx.formal' as any, descKey: 'templates.docx.formal.desc' as any, promptKey: 'templates.docx.formal.prompt' as any },
    { id: 'modern', icon: 'auto_awesome', labelKey: 'templates.docx.modern' as any, descKey: 'templates.docx.modern.desc' as any, promptKey: 'templates.docx.modern.prompt' as any },
    { id: 'academic', icon: 'school', labelKey: 'templates.docx.academic' as any, descKey: 'templates.docx.academic.desc' as any, promptKey: 'templates.docx.academic.prompt' as any },
    { id: 'compact', icon: 'density_small', labelKey: 'templates.docx.compact' as any, descKey: 'templates.docx.compact.desc' as any, promptKey: 'templates.docx.compact.prompt' as any },
  ],
  'xlsx-gen': [
    { id: 'dashboard', icon: 'dashboard', labelKey: 'templates.xlsx.dashboard' as any, descKey: 'templates.xlsx.dashboard.desc' as any, promptKey: 'templates.xlsx.dashboard.prompt' as any },
    { id: 'clean', icon: 'filter_none', labelKey: 'templates.xlsx.clean' as any, descKey: 'templates.xlsx.clean.desc' as any, promptKey: 'templates.xlsx.clean.prompt' as any },
    { id: 'financial', icon: 'account_balance', labelKey: 'templates.xlsx.financial' as any, descKey: 'templates.xlsx.financial.desc' as any, promptKey: 'templates.xlsx.financial.prompt' as any },
    { id: 'colorful', icon: 'format_color_fill', labelKey: 'templates.xlsx.colorful' as any, descKey: 'templates.xlsx.colorful.desc' as any, promptKey: 'templates.xlsx.colorful.prompt' as any },
  ],
  'pdf-gen': [
    { id: 'formal', icon: 'verified', labelKey: 'templates.pdf.formal' as any, descKey: 'templates.pdf.formal.desc' as any, promptKey: 'templates.pdf.formal.prompt' as any },
    { id: 'modern', icon: 'auto_awesome', labelKey: 'templates.pdf.modern' as any, descKey: 'templates.pdf.modern.desc' as any, promptKey: 'templates.pdf.modern.prompt' as any },
    { id: 'magazine', icon: 'menu_book', labelKey: 'templates.pdf.magazine' as any, descKey: 'templates.pdf.magazine.desc' as any, promptKey: 'templates.pdf.magazine.prompt' as any },
    { id: 'technical', icon: 'code', labelKey: 'templates.pdf.technical' as any, descKey: 'templates.pdf.technical.desc' as any, promptKey: 'templates.pdf.technical.prompt' as any },
  ],
  'slides-gen': [
    { id: 'minimal', icon: 'tune', labelKey: 'templates.slides.minimal' as any, descKey: 'templates.slides.minimal.desc' as any, promptKey: 'templates.slides.minimal.prompt' as any },
    { id: 'dark', icon: 'dark_mode', labelKey: 'templates.slides.dark' as any, descKey: 'templates.slides.dark.desc' as any, promptKey: 'templates.slides.dark.prompt' as any },
    { id: 'gradient', icon: 'gradient', labelKey: 'templates.slides.gradient' as any, descKey: 'templates.slides.gradient.desc' as any, promptKey: 'templates.slides.gradient.prompt' as any },
    { id: 'neon', icon: 'flare', labelKey: 'templates.slides.neon' as any, descKey: 'templates.slides.neon.desc' as any, promptKey: 'templates.slides.neon.prompt' as any },
    { id: 'corporate', icon: 'business', labelKey: 'templates.slides.corporate' as any, descKey: 'templates.slides.corporate.desc' as any, promptKey: 'templates.slides.corporate.prompt' as any },
    { id: 'creative', icon: 'palette', labelKey: 'templates.slides.creative' as any, descKey: 'templates.slides.creative.desc' as any, promptKey: 'templates.slides.creative.prompt' as any },
    { id: 'elegant', icon: 'diamond', labelKey: 'templates.slides.elegant' as any, descKey: 'templates.slides.elegant.desc' as any, promptKey: 'templates.slides.elegant.prompt' as any },
    { id: 'tech', icon: 'terminal', labelKey: 'templates.slides.tech' as any, descKey: 'templates.slides.tech.desc' as any, promptKey: 'templates.slides.tech.prompt' as any },
  ],
};

// Style preview colors for template hover preview
const TEMPLATE_PREVIEW: Record<string, { bg: string; accent: string; text: string; card: string }> = {
  // PPTX
  'pptx-gen:minimal-pro': { bg: '#ffffff', accent: '#6b7280', text: '#1f2937', card: '#f3f4f6' },
  'pptx-gen:tech-dark': { bg: '#0f172a', accent: '#22d3ee', text: '#f1f5f9', card: '#1e293b' },
  'pptx-gen:corporate': { bg: '#ffffff', accent: '#2563eb', text: '#1e3a5f', card: '#eff6ff' },
  'pptx-gen:creative': { bg: '#fef3c7', accent: '#f59e0b', text: '#78350f', card: '#fffbeb' },
  // DOCX
  'docx-gen:formal': { bg: '#ffffff', accent: '#1e40af', text: '#111827', card: '#f9fafb' },
  'docx-gen:modern': { bg: '#ffffff', accent: '#7c3aed', text: '#1f2937', card: '#f5f3ff' },
  'docx-gen:academic': { bg: '#fffbeb', accent: '#92400e', text: '#1c1917', card: '#fef3c7' },
  'docx-gen:compact': { bg: '#f8fafc', accent: '#475569', text: '#0f172a', card: '#e2e8f0' },
  // XLSX
  'xlsx-gen:dashboard': { bg: '#0f172a', accent: '#3b82f6', text: '#f1f5f9', card: '#1e293b' },
  'xlsx-gen:clean': { bg: '#ffffff', accent: '#64748b', text: '#334155', card: '#f1f5f9' },
  'xlsx-gen:financial': { bg: '#ffffff', accent: '#166534', text: '#14532d', card: '#f0fdf4' },
  'xlsx-gen:colorful': { bg: '#fdf4ff', accent: '#c026d3', text: '#581c87', card: '#fae8ff' },
  // PDF
  'pdf-gen:formal': { bg: '#ffffff', accent: '#1e40af', text: '#111827', card: '#eff6ff' },
  'pdf-gen:modern': { bg: '#ffffff', accent: '#8b5cf6', text: '#1f2937', card: '#ede9fe' },
  'pdf-gen:magazine': { bg: '#fef2f2', accent: '#dc2626', text: '#1f2937', card: '#fee2e2' },
  'pdf-gen:technical': { bg: '#1e293b', accent: '#22d3ee', text: '#e2e8f0', card: '#0f172a' },
  // Slides
  'slides-gen:minimal': { bg: '#ffffff', accent: '#9ca3af', text: '#1f2937', card: '#f9fafb' },
  'slides-gen:dark': { bg: '#0a0a0a', accent: '#a855f7', text: '#fafafa', card: '#1a1a2e' },
  'slides-gen:gradient': { bg: 'linear-gradient(135deg, #667eea, #764ba2)', accent: '#a78bfa', text: '#ffffff', card: 'rgba(255,255,255,0.1)' },
  'slides-gen:neon': { bg: '#000000', accent: '#00ff88', text: '#ffffff', card: '#0a0a0a' },
  'slides-gen:corporate': { bg: '#ffffff', accent: '#2563eb', text: '#1e3a5f', card: '#f0f7ff' },
  'slides-gen:creative': { bg: '#fff7ed', accent: '#f97316', text: '#431407', card: '#ffedd5' },
  'slides-gen:elegant': { bg: '#faf5ef', accent: '#b8860b', text: '#2d2006', card: '#f5ead6' },
  'slides-gen:tech': { bg: '#0d1117', accent: '#3fb950', text: '#c9d1d9', card: '#161b22' },
};

const LOCALE_OPTIONS: { value: Locale; label: string }[] = [
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en', label: 'English' },
];

export default function Navbar() {
  const { user, token, logout, updateUser } = useAuth();
  const { locale, theme, setLocale, setTheme, t } = useTranslation();
  const pathname = usePathname();
  const router = useRouter();
  const [showModal, setShowModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
  const [hoveredTemplate, setHoveredTemplate] = useState<string | null>(null);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window !== 'undefined') return localStorage.getItem(SIDEBAR_KEY) === '1';
    return false;
  });

  // Display name edit state
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState('');

  // Password change state
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [passwordSuccess, setPasswordSuccess] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);

  const [saved, setSaved] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [mobileUserExpanded, setMobileUserExpanded] = useState(false);

  const userMenuRef = useRef<HTMLDivElement>(null);

  // Close user menu on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setShowUserMenu(false);
      }
    }
    if (showUserMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showUserMenu]);

  // Close mobile menu on route change
  useEffect(() => {
    setMobileMenuOpen(false);
    setMobileUserExpanded(false);
  }, [pathname]);

  // Listen for open-template-wizard event from other components (e.g. dashboard)
  useEffect(() => {
    const handler = () => setShowModal(true);
    window.addEventListener('open-template-wizard', handler);
    return () => window.removeEventListener('open-template-wizard', handler);
  }, []);

  // Sync to localStorage + dispatch event for other components
  useEffect(() => {
    localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0');
    window.dispatchEvent(new CustomEvent('sidebar-toggle', { detail: collapsed }));
  }, [collapsed]);

  if (!user) return null;

  async function handleCreate(skillId: string, templatePrompt?: string) {
    if (!token || creating) return;
    setCreating(true);
    try {
      const docType = DOC_TYPES.find(s => s.id === skillId);
      const title = docType?.labelKey ? t('nav.newDocTitle', { type: t(docType.labelKey) } as any) : t('nav.newConversation');
      const res = await fetch('/api/conversations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ title, skillId }),
      });
      const conv = await res.json();
      if (templatePrompt) {
        sessionStorage.setItem(`pending_template_${conv.id}`, templatePrompt);
      }
      setShowModal(false);
      setSelectedSkill(null);
      setHoveredTemplate(null);
      router.push(`/chat/${conv.id}`);
    } finally {
      setCreating(false);
    }
  }

  function handleSkillClick(skillId: string) {
    // data-analyst and research have no templates — go directly
    if (SKILL_TEMPLATES[skillId]) {
      setSelectedSkill(skillId);
    } else {
      handleCreate(skillId);
    }
  }

  async function handleLocaleChange(newLocale: Locale) {
    await setLocale(newLocale);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function handleThemeChange(newTheme: Theme) {
    await setTheme(newTheme);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  const isOAuthOnly = user.oauthProvider && user.hasPassword === false;

  async function handlePasswordChange() {
    setPasswordError('');
    if (newPassword.length < 8) {
      setPasswordError(t('userMenu.changePassword.tooShort'));
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError(t('userMenu.changePassword.mismatch'));
      return;
    }
    setChangingPassword(true);
    try {
      const body: Record<string, string> = { newPassword };
      if (!isOAuthOnly) body.currentPassword = currentPassword;
      const res = await fetch('/api/auth/password', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json();
        if (res.status === 401) {
          setPasswordError(t('userMenu.changePassword.wrongCurrent'));
        } else {
          setPasswordError(err.error || t('userMenu.changePassword.failed'));
        }
        return;
      }
      setPasswordSuccess(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setTimeout(() => {
        setPasswordSuccess(false);
        setShowPasswordForm(false);
      }, 2000);
    } catch {
      setPasswordError(t('userMenu.changePassword.failed'));
    } finally {
      setChangingPassword(false);
    }
  }

  async function handleNameSave() {
    const trimmed = nameInput.trim();
    if (trimmed.length > 50) {
      setNameError(t('userMenu.changeName.tooLong' as any));
      return;
    }
    setSavingName(true);
    setNameError('');
    try {
      const res = await fetch('/api/auth/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ displayName: trimmed }),
      });
      if (!res.ok) {
        const err = await res.json();
        setNameError(err.error || t('userMenu.changeName.failed' as any));
        return;
      }
      updateUser({ displayName: trimmed || null });
      setEditingName(false);
    } catch {
      setNameError(t('userMenu.changeName.failed' as any));
    } finally {
      setSavingName(false);
    }
  }

  return (
    <>
      {/* Mobile Top Bar */}
      <header className="md:hidden fixed top-0 left-0 right-0 h-14 bg-surface-dim border-b border-outline-variant/10 flex items-center justify-between px-4 z-50">
        <Link href="/dashboard" className="flex items-center gap-2 no-underline">
          <div className="w-8 h-8 bg-primary/20 flex items-center justify-center rounded-lg">
            <span className="material-symbols-outlined text-primary" style={{ fontSize: 18 }}>terminal</span>
          </div>
          <span className="font-headline text-base font-bold tracking-tighter text-on-surface">AI Agents Office</span>
        </Link>
        <button
          onClick={() => { setMobileMenuOpen(v => !v); if (!mobileMenuOpen) setMobileUserExpanded(false); }}
          className="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-surface-container text-on-surface-variant cursor-pointer"
        >
          <span className="material-symbols-outlined">{mobileMenuOpen ? 'close' : 'menu'}</span>
        </button>
      </header>

      {/* Mobile Dropdown Nav */}
      {mobileMenuOpen && (
        <div className="md:hidden fixed inset-0 z-40" onClick={() => setMobileMenuOpen(false)}>
          <div
            className="absolute top-14 left-0 right-0 bg-surface-dim border-b border-outline-variant/10 shadow-lg animate-[slideDown_0.2s_ease-out] max-h-[calc(100svh-3.5rem)] overflow-y-auto"
            onClick={e => e.stopPropagation()}
          >
            {/* User Row: avatar + name | expand chevron | logout */}
            <div>
              <div className="flex items-center px-4 py-2.5 gap-2">
                {/* Avatar + Name + edit */}
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <div className="w-9 h-9 bg-primary/15 flex items-center justify-center rounded-full shrink-0">
                    <span className="material-symbols-outlined text-primary text-sm">person</span>
                  </div>
                  <div className="min-w-0 flex-1 text-left">
                    {editingName ? (
                      <div className="flex items-center gap-1.5">
                        <input
                          type="text"
                          value={nameInput}
                          onChange={e => setNameInput(e.target.value)}
                          maxLength={50}
                          placeholder={t('userMenu.changeName.placeholder' as any)}
                          className="flex-1 min-w-0 px-2 py-1 bg-surface-container-high border border-primary/40 rounded text-base text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:border-primary"
                          autoFocus
                          onKeyDown={e => { if (e.key === 'Enter') handleNameSave(); if (e.key === 'Escape') setEditingName(false); }}
                        />
                        <button onClick={handleNameSave} disabled={savingName} className="w-7 h-7 flex items-center justify-center rounded-md bg-primary text-on-primary cursor-pointer disabled:opacity-50">
                          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>check</span>
                        </button>
                        <button onClick={() => { setEditingName(false); setNameError(''); }} className="w-7 h-7 flex items-center justify-center rounded-md bg-surface-container-high text-on-surface-variant cursor-pointer">
                          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>close</span>
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => { setEditingName(true); setNameInput(user.displayName || ''); setNameError(''); }}
                        className="group flex items-center gap-1 bg-transparent cursor-pointer p-0 text-left"
                      >
                        <span className="text-sm font-bold text-on-surface truncate">{user.displayName || '—'}</span>
                        <span className="material-symbols-outlined text-on-surface-variant/40 group-active:text-primary transition-colors" style={{ fontSize: 14 }}>edit</span>
                      </button>
                    )}
                    {nameError && <p className="text-xs text-error mt-0.5">{nameError}</p>}
                    {!editingName && <p className="text-[11px] text-on-surface-variant truncate">{user.email}</p>}
                  </div>
                </div>
                {/* Expand chevron */}
                <button
                  onClick={() => setMobileUserExpanded(v => !v)}
                  className="w-9 h-9 flex items-center justify-center rounded-lg text-on-surface-variant active:bg-surface-container transition-colors cursor-pointer shrink-0"
                >
                  <span className={`material-symbols-outlined text-lg transition-transform duration-200 ${mobileUserExpanded ? 'rotate-180' : ''}`}>
                    expand_more
                  </span>
                </button>
                {/* Logout button */}
                <button
                  onClick={() => { setMobileMenuOpen(false); logout(); }}
                  className="w-9 h-9 flex items-center justify-center rounded-lg text-on-surface-variant active:text-error active:bg-error/10 transition-colors cursor-pointer shrink-0"
                  title={t('userMenu.logout')}
                >
                  <span className="material-symbols-outlined text-xl">logout</span>
                </button>
              </div>

              {/* Expandable Settings */}
              <div className={`grid transition-[grid-template-rows] duration-200 ease-in-out ${mobileUserExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
                <div className="overflow-hidden">
                  <div className="border-t border-outline-variant/10">
                    {/* Change Password */}
                    <div className="px-5 py-2.5 border-b border-outline-variant/10">
                      {!showPasswordForm ? (
                        <button
                          onClick={() => setShowPasswordForm(true)}
                          className="flex items-center gap-2 text-sm text-on-surface-variant active:text-on-surface transition-colors w-full bg-transparent cursor-pointer py-1"
                        >
                          <span className="material-symbols-outlined text-sm">lock</span>
                          {isOAuthOnly ? t('userMenu.setPassword') : t('userMenu.changePassword')}
                        </button>
                      ) : (
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between mb-1">
                            <p className="text-xs font-bold text-on-surface">
                              {isOAuthOnly ? t('userMenu.setPassword') : t('userMenu.changePassword')}
                            </p>
                            <button onClick={() => { setShowPasswordForm(false); setPasswordError(''); setCurrentPassword(''); setNewPassword(''); setConfirmPassword(''); }} className="text-on-surface-variant active:text-on-surface cursor-pointer bg-transparent p-0">
                              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>close</span>
                            </button>
                          </div>
                          {!isOAuthOnly && (
                            <input
                              type="password"
                              placeholder={t('userMenu.changePassword.current')}
                              value={currentPassword}
                              onChange={e => setCurrentPassword(e.target.value)}
                              className="w-full px-2.5 py-1.5 bg-surface-container-high border border-outline-variant/20 rounded text-[13px] text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:border-primary"
                            />
                          )}
                          <input type="password" placeholder={t('userMenu.changePassword.new')} value={newPassword} onChange={e => setNewPassword(e.target.value)} className="w-full px-2.5 py-1.5 bg-surface-container-high border border-outline-variant/20 rounded text-[13px] text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:border-primary" />
                          <input type="password" placeholder={t('userMenu.changePassword.confirm')} value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} className="w-full px-2.5 py-1.5 bg-surface-container-high border border-outline-variant/20 rounded text-[13px] text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:border-primary" />
                          {passwordError && <p className="text-xs text-error">{passwordError}</p>}
                          {passwordSuccess && <p className="text-xs text-success">{t('userMenu.changePassword.success')}</p>}
                          <button onClick={handlePasswordChange} disabled={changingPassword || (!isOAuthOnly && !currentPassword) || !newPassword || !confirmPassword} className="w-full px-3 py-1.5 bg-primary text-on-primary text-xs font-medium rounded cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">
                            {t('userMenu.changePassword.submit')}
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Language */}
                    <div className="px-5 py-3 border-b border-outline-variant/10">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="material-symbols-outlined text-sm text-on-surface-variant">language</span>
                        <span className="text-sm font-medium text-on-surface">{t('userMenu.language')}</span>
                      </div>
                      <div className="flex gap-1.5">
                        {LOCALE_OPTIONS.map(opt => (
                          <button
                            key={opt.value}
                            onClick={() => handleLocaleChange(opt.value)}
                            className={`flex-1 px-2 py-1.5 rounded text-xs font-medium transition-all cursor-pointer ${
                              locale === opt.value
                                ? 'bg-primary/15 text-primary border border-primary/30'
                                : 'bg-surface-container-high text-on-surface-variant active:text-on-surface border border-transparent'
                            }`}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Theme */}
                    <div className="px-5 py-3">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="material-symbols-outlined text-sm text-on-surface-variant">palette</span>
                        <span className="text-sm font-medium text-on-surface">{t('userMenu.theme')}</span>
                      </div>
                      <div className="flex gap-1.5">
                        <button
                          onClick={() => handleThemeChange('light')}
                          className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-xs font-medium transition-all cursor-pointer ${
                            theme === 'light'
                              ? 'bg-primary/15 text-primary border border-primary/30'
                              : 'bg-surface-container-high text-on-surface-variant active:text-on-surface border border-transparent'
                          }`}
                        >
                          <span className="material-symbols-outlined text-sm">light_mode</span>
                          {t('userMenu.theme.light')}
                        </button>
                        <button
                          onClick={() => handleThemeChange('dark')}
                          className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-xs font-medium transition-all cursor-pointer ${
                            theme === 'dark'
                              ? 'bg-primary/15 text-primary border border-primary/30'
                              : 'bg-surface-container-high text-on-surface-variant active:text-on-surface border border-transparent'
                          }`}
                        >
                          <span className="material-symbols-outlined text-sm">dark_mode</span>
                          {t('userMenu.theme.dark')}
                        </button>
                      </div>
                    </div>

                    {/* Saved toast */}
                    {saved && (
                      <div className="px-5 py-2 bg-success/10 text-success text-xs font-medium text-center">
                        {t('userMenu.saved')}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Nav Links — collapses when user settings expanded */}
            <div className={`grid transition-[grid-template-rows] duration-200 ease-in-out ${mobileUserExpanded ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]'}`}>
              <div className="overflow-hidden">
                <nav className="py-1 border-t border-outline-variant/10">
                  {NAV_LINKS.map(link => {
                    const isActive = pathname === link.href;
                    return (
                      <Link
                        key={link.href}
                        href={link.href}
                        onClick={() => setMobileMenuOpen(false)}
                        className={`flex items-center gap-3 px-5 py-3.5 no-underline transition-colors ${
                          isActive
                            ? 'text-primary bg-primary/5'
                            : 'text-on-surface-variant active:bg-surface-container'
                        }`}
                      >
                        <span className="material-symbols-outlined text-xl">{link.icon}</span>
                        <span className="text-sm font-headline font-bold">{t(link.labelKey)}</span>
                      </Link>
                    );
                  })}
                  {user.role === 'admin' && (
                    <Link
                      href="/admin/overview"
                      onClick={() => setMobileMenuOpen(false)}
                      className="flex items-center gap-3 px-5 py-3.5 no-underline text-primary active:bg-primary/10 transition-colors"
                    >
                      <span className="material-symbols-outlined text-xl">admin_panel_settings</span>
                      <span className="text-sm font-headline font-bold">{t('nav.switchToAdmin' as any)}</span>
                    </Link>
                  )}
                </nav>
              </div>
            </div>

            {/* Developer Footer */}
            <div className="py-3 border-t border-outline-variant/10">
              <a href="https://www.zh-aoi.com/" target="_blank" rel="noopener noreferrer" className="text-[11px] text-outline hover:text-on-surface-variant transition-colors no-underline block text-center">
                {t('nav.poweredBy')} &copy; 2026
              </a>
            </div>
          </div>
        </div>
      )}

      <aside className={`hidden md:flex h-screen fixed left-0 top-0 bg-surface-dim flex-col py-6 font-headline text-sm tracking-tight z-50 border-r border-outline-variant/10 transition-all duration-300 ${collapsed ? 'w-[68px]' : 'w-64'}`}>
        {/* Logo */}
        <div className={`mb-8 ${collapsed ? 'px-3' : 'px-6'}`}>
          <Link href="/dashboard" className="flex items-center gap-3 no-underline">
            <div className="w-8 h-8 bg-primary/20 flex items-center justify-center rounded-lg shrink-0">
              <span className="material-symbols-outlined text-primary">terminal</span>
            </div>
            {!collapsed && (
              <div>
                <h1 className="text-xl font-bold tracking-tighter text-on-surface">AI Agents</h1>
                <p className="text-sm uppercase tracking-[0.2em] text-primary">Office</p>
              </div>
            )}
          </Link>
        </div>

        {/* Navigation */}
        <nav className={`flex-1 space-y-1 ${collapsed ? 'px-2' : 'px-4'}`}>
          {NAV_LINKS.map(link => {
            const isActive = pathname === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`relative group flex items-center gap-3 py-2.5 no-underline transition-all duration-200 ${collapsed ? 'justify-center px-0' : 'px-3'} ${
                  isActive
                    ? 'text-primary bg-surface-container border-l-2 border-primary'
                    : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container/50'
                }`}
              >
                <span className="material-symbols-outlined">{link.icon}</span>
                {!collapsed && <span>{t(link.labelKey)}</span>}
                {collapsed && (
                  <span className="absolute left-full ml-3 px-3 py-1.5 bg-surface-container-highest text-on-surface text-sm font-bold whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-200 z-[60] shadow-lg border border-outline-variant/10">
                    {t(link.labelKey)}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>


        {/* Bottom */}
        <div className={`mt-auto pt-6 space-y-1 ${collapsed ? 'px-2' : 'px-4'}`}>
          {/* Switch to Admin (admin only) */}
          {user.role === 'admin' && (
            <Link
              href="/admin/overview"
              className={`relative group flex items-center gap-3 py-2.5 no-underline text-primary hover:bg-primary/10 transition-all rounded-lg mb-1 ${collapsed ? 'justify-center px-0' : 'px-3'}`}
            >
              <span className="material-symbols-outlined text-[20px]">admin_panel_settings</span>
              {!collapsed && <span className="text-sm font-bold">{t('nav.switchToAdmin' as any)}</span>}
              {collapsed && (
                <span className="absolute left-full ml-3 px-3 py-1.5 bg-surface-container-highest text-on-surface text-sm font-bold whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-200 z-[60] shadow-lg border border-outline-variant/10">
                  {t('nav.switchToAdmin' as any)}
                </span>
              )}
            </Link>
          )}

          {/* Collapse Toggle */}
          <button
            onClick={() => setCollapsed(v => !v)}
            className={`relative group flex items-center gap-3 py-2 text-on-surface-variant hover:text-on-surface transition-all w-full bg-transparent cursor-pointer ${collapsed ? 'justify-center px-0' : 'px-3'}`}
          >
            <span className={`material-symbols-outlined text-sm transition-transform duration-300 ${collapsed ? 'rotate-180' : ''}`}>
              chevron_left
            </span>
            {!collapsed && <span className="text-sm">{t('nav.collapse')}</span>}
            {collapsed && (
              <span className="absolute left-full ml-3 px-3 py-1.5 bg-surface-container-highest text-on-surface text-sm font-bold whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-200 z-[60] shadow-lg border border-outline-variant/10">
                {t('nav.expandSidebar')}
              </span>
            )}
          </button>

          {/* User — clickable to open menu */}
          <div className="relative" ref={userMenuRef}>
            <button
              onClick={() => setShowUserMenu(v => !v)}
              className={`relative group flex items-center gap-3 py-2.5 transition-all w-full cursor-pointer rounded-lg border ${
                showUserMenu
                  ? 'bg-surface-container border-primary/30 text-on-surface'
                  : 'bg-surface-container/0 border-transparent text-on-surface-variant hover:text-on-surface hover:bg-surface-container hover:border-outline-variant/20'
              } ${collapsed ? 'justify-center px-0' : 'px-3'}`}
            >
              <div className="w-7 h-7 bg-primary/15 flex items-center justify-center rounded-full shrink-0">
                <span className="material-symbols-outlined text-primary text-sm">person</span>
              </div>
              {!collapsed && (
                <>
                  <span className="text-sm truncate flex-1 text-left">{user.displayName || user.email}</span>
                  <span className={`material-symbols-outlined text-sm text-on-surface-variant transition-transform duration-200 ${showUserMenu ? 'rotate-180' : ''}`}>
                    expand_less
                  </span>
                </>
              )}
              {collapsed && (
                <span className="absolute left-full ml-3 px-3 py-1.5 bg-surface-container-highest text-on-surface text-sm font-bold whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-200 z-[60] shadow-lg border border-outline-variant/10">
                  {user.displayName || user.email}
                </span>
              )}
            </button>

            {/* User Menu Popup */}
            {showUserMenu && (
              <div className={`absolute bottom-full mb-2 bg-surface-container border border-outline-variant/10 rounded-xl shadow-2xl overflow-hidden animate-in z-[60] ${collapsed ? 'left-full ml-2 w-80' : 'left-0 w-full min-w-[300px]'}`}>
                {/* Profile Info — click name to edit inline */}
                <div className="px-5 py-4 border-b border-outline-variant/10">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-10 h-10 bg-primary/20 flex items-center justify-center rounded-full">
                      <span className="material-symbols-outlined text-primary">person</span>
                    </div>
                    <div className="min-w-0 flex-1">
                      {editingName ? (
                        <div className="flex items-center gap-1.5">
                          <input
                            type="text"
                            value={nameInput}
                            onChange={e => setNameInput(e.target.value)}
                            maxLength={50}
                            placeholder={t('userMenu.changeName.placeholder' as any)}
                            className="flex-1 min-w-0 px-2 py-1 bg-surface-container-high border border-primary/40 rounded text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:border-primary"
                            autoFocus
                            onKeyDown={e => { if (e.key === 'Enter') handleNameSave(); if (e.key === 'Escape') setEditingName(false); }}
                          />
                          <button
                            onClick={handleNameSave}
                            disabled={savingName}
                            className="w-7 h-7 flex items-center justify-center rounded-md bg-primary text-on-primary hover:bg-primary-hover transition-colors cursor-pointer disabled:opacity-50"
                            title={t('common.save' as any)}
                          >
                            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>check</span>
                          </button>
                          <button
                            onClick={() => { setEditingName(false); setNameError(''); }}
                            className="w-7 h-7 flex items-center justify-center rounded-md bg-surface-container-high text-on-surface-variant hover:bg-surface-variant transition-colors cursor-pointer"
                            title={t('common.cancel')}
                          >
                            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>close</span>
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => { setEditingName(true); setNameInput(user.displayName || ''); setNameError(''); }}
                          className="group flex items-center gap-1 bg-transparent cursor-pointer p-0 text-left"
                          title={t('userMenu.changeName' as any)}
                        >
                          <span className="text-sm font-bold text-on-surface truncate">{user.displayName || '—'}</span>
                          <span className="material-symbols-outlined text-on-surface-variant/40 group-hover:text-primary transition-colors" style={{ fontSize: 14 }}>edit</span>
                        </button>
                      )}
                      {nameError && <p className="text-xs text-error mt-1">{nameError}</p>}
                      <p className="text-xs text-on-surface-variant truncate">{user.email}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${user.role === 'admin' ? 'bg-warning/20 text-warning' : 'bg-primary/10 text-primary'}`}>
                      {user.role === 'admin' ? t('userMenu.role.admin') : t('userMenu.role.user')}
                    </span>
                    {user.oauthProvider === 'google' && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-surface-container-high text-on-surface-variant">
                        Google
                      </span>
                    )}
                  </div>
                </div>

                {/* Change Password */}
                <div className="px-5 py-3 border-b border-outline-variant/10">
                  {!showPasswordForm ? (
                    <button
                      onClick={() => setShowPasswordForm(true)}
                      className="flex items-center gap-2 text-sm text-on-surface-variant hover:text-on-surface transition-colors w-full bg-transparent cursor-pointer py-1"
                    >
                      <span className="material-symbols-outlined text-sm">lock</span>
                      {isOAuthOnly ? t('userMenu.setPassword') : t('userMenu.changePassword')}
                    </button>
                  ) : (
                    <div className="space-y-2">
                      <p className="text-sm font-bold text-on-surface mb-2">
                        {isOAuthOnly ? t('userMenu.setPassword') : t('userMenu.changePassword')}
                      </p>
                      {!isOAuthOnly && (
                        <input
                          type="password"
                          placeholder={t('userMenu.changePassword.current')}
                          value={currentPassword}
                          onChange={e => setCurrentPassword(e.target.value)}
                          className="w-full px-3 py-2 bg-surface-container-high border border-outline-variant/20 rounded text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:border-primary"
                        />
                      )}
                      <input
                        type="password"
                        placeholder={t('userMenu.changePassword.new')}
                        value={newPassword}
                        onChange={e => setNewPassword(e.target.value)}
                        className="w-full px-3 py-2 bg-surface-container-high border border-outline-variant/20 rounded text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:border-primary"
                      />
                      <input
                        type="password"
                        placeholder={t('userMenu.changePassword.confirm')}
                        value={confirmPassword}
                        onChange={e => setConfirmPassword(e.target.value)}
                        className="w-full px-3 py-2 bg-surface-container-high border border-outline-variant/20 rounded text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:border-primary"
                      />
                      {passwordError && (
                        <p className="text-xs text-error">{passwordError}</p>
                      )}
                      {passwordSuccess && (
                        <p className="text-xs text-success">{t('userMenu.changePassword.success')}</p>
                      )}
                      <div className="flex gap-2 pt-1">
                        <button
                          onClick={handlePasswordChange}
                          disabled={changingPassword || (!isOAuthOnly && !currentPassword) || !newPassword || !confirmPassword}
                          className="flex-1 px-3 py-1.5 bg-primary text-on-primary text-xs font-medium rounded hover:bg-primary-hover transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {t('userMenu.changePassword.submit')}
                        </button>
                        <button
                          onClick={() => {
                            setShowPasswordForm(false);
                            setPasswordError('');
                            setCurrentPassword('');
                            setNewPassword('');
                            setConfirmPassword('');
                          }}
                          className="px-3 py-1.5 bg-surface-container-high text-on-surface-variant text-xs font-medium rounded hover:bg-surface-variant transition-colors cursor-pointer border border-outline-variant/20"
                        >
                          {t('common.cancel')}
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Language */}
                <div className="px-5 py-3 border-b border-outline-variant/10">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="material-symbols-outlined text-sm text-on-surface-variant">language</span>
                    <span className="text-sm font-medium text-on-surface">{t('userMenu.language')}</span>
                  </div>
                  <p className="text-xs text-on-surface-variant mb-2">{t('userMenu.language.description')}</p>
                  <div className="flex gap-1.5">
                    {LOCALE_OPTIONS.map(opt => (
                      <button
                        key={opt.value}
                        onClick={() => handleLocaleChange(opt.value)}
                        className={`flex-1 px-2 py-1.5 rounded text-xs font-medium transition-all cursor-pointer ${
                          locale === opt.value
                            ? 'bg-primary/15 text-primary border border-primary/30'
                            : 'bg-surface-container-high text-on-surface-variant hover:text-on-surface border border-transparent'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Theme */}
                <div className="px-5 py-3 border-b border-outline-variant/10">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="material-symbols-outlined text-sm text-on-surface-variant">palette</span>
                    <span className="text-sm font-medium text-on-surface">{t('userMenu.theme')}</span>
                  </div>
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => handleThemeChange('light')}
                      className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-xs font-medium transition-all cursor-pointer ${
                        theme === 'light'
                          ? 'bg-primary/15 text-primary border border-primary/30'
                          : 'bg-surface-container-high text-on-surface-variant hover:text-on-surface border border-transparent'
                      }`}
                    >
                      <span className="material-symbols-outlined text-sm">light_mode</span>
                      {t('userMenu.theme.light')}
                    </button>
                    <button
                      onClick={() => handleThemeChange('dark')}
                      className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-xs font-medium transition-all cursor-pointer ${
                        theme === 'dark'
                          ? 'bg-primary/15 text-primary border border-primary/30'
                          : 'bg-surface-container-high text-on-surface-variant hover:text-on-surface border border-transparent'
                      }`}
                    >
                      <span className="material-symbols-outlined text-sm">dark_mode</span>
                      {t('userMenu.theme.dark')}
                    </button>
                  </div>
                </div>

                {/* Logout */}
                <div className="px-5 py-3">
                  <button
                    onClick={logout}
                    className="flex items-center gap-2 text-sm text-on-surface-variant hover:text-error transition-colors w-full bg-transparent cursor-pointer py-1"
                  >
                    <span className="material-symbols-outlined text-sm">logout</span>
                    {t('userMenu.logout')}
                  </button>
                </div>

                {/* Saved toast inside menu */}
                {saved && (
                  <div className="px-5 py-2 bg-success/10 text-success text-xs font-medium text-center">
                    {t('userMenu.saved')}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="mt-3 pt-3 border-t border-outline-variant/10 px-3">
            <a href="https://www.zh-aoi.com/" target="_blank" rel="noopener noreferrer" className={`text-outline hover:text-on-surface-variant transition-colors no-underline block text-center ${collapsed ? 'text-sm' : 'text-[11px]'}`}>
              {collapsed ? '©' : <>{t('nav.poweredBy')} &copy; 2026</>}
            </a>
          </div>
        </div>
      </aside>

      {/* Agent Tool Picker Modal */}
      {showModal && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center"
          onClick={() => { setShowModal(false); setSelectedSkill(null); setHoveredTemplate(null); }}
        >
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

          {/* Modal */}
          <div
            className="relative bg-surface-container rounded-xl shadow-2xl border border-outline-variant/10 w-full max-w-2xl mx-4 overflow-hidden overflow-y-auto max-h-[90vh] animate-in"
            onClick={e => e.stopPropagation()}
          >
            {!selectedSkill ? (
              <>
                {/* Step 1: Agent Options */}
                <div className="px-6 py-5 flex items-center justify-between border-b border-outline-variant/10">
                  <div className="flex items-center gap-3">
                    <span className="material-symbols-outlined text-primary">auto_fix_high</span>
                    <h2 className="text-sm font-headline font-bold">{t('dashboard.templateWizard' as any)}</h2>
                  </div>
                  <button
                    onClick={() => { setShowModal(false); setSelectedSkill(null); setHoveredTemplate(null); }}
                    className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-surface-container-high transition-colors bg-transparent cursor-pointer"
                  >
                    <span className="material-symbols-outlined text-on-surface-variant text-sm">close</span>
                  </button>
                </div>
                <div className="p-6 grid grid-cols-2 md:grid-cols-4 gap-3">
                  {DOC_TYPES.map(doc => (
                    <button
                      key={doc.id}
                      onClick={() => handleSkillClick(doc.id)}
                      disabled={creating}
                      className="bg-surface-container-high p-5 rounded-lg flex flex-col gap-3 hover:bg-surface-variant transition-all text-left disabled:opacity-50 cursor-pointer group border border-transparent hover:border-primary/20"
                    >
                      <span className={`material-symbols-outlined text-2xl ${doc.colorClass} group-hover:scale-110 transition-transform`}>
                        {doc.icon}
                      </span>
                      <span className="text-sm font-bold text-on-surface">{t(doc.labelKey)}</span>
                      <span className="text-sm text-on-surface-variant">{t(doc.descKey)}</span>
                    </button>
                  ))}
                </div>
                <div className="px-6 pb-5">
                  <p className="text-sm text-on-surface-variant text-center">
                    {t('nav.modalHint')}
                  </p>
                </div>
              </>
            ) : (
              <>
                {/* Step 2: Template Selection */}
                <div className="px-6 py-4 flex items-center justify-between border-b border-outline-variant/10">
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => { setSelectedSkill(null); setHoveredTemplate(null); }}
                      className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-surface-container-high transition-colors bg-transparent cursor-pointer"
                    >
                      <span className="material-symbols-outlined text-on-surface-variant text-sm">arrow_back</span>
                    </button>
                    <span className={`material-symbols-outlined ${DOC_TYPES.find(d => d.id === selectedSkill)?.colorClass || 'text-primary'}`}>
                      {DOC_TYPES.find(d => d.id === selectedSkill)?.icon}
                    </span>
                    <h2 className="text-sm font-headline font-bold">
                      {t((DOC_TYPES.find(d => d.id === selectedSkill)?.labelKey || 'nav.modalTitle') as any)} — {t('templates.selectTitle' as any)}
                    </h2>
                  </div>
                  <button
                    onClick={() => { setShowModal(false); setSelectedSkill(null); setHoveredTemplate(null); }}
                    className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-surface-container-high transition-colors bg-transparent cursor-pointer"
                  >
                    <span className="material-symbols-outlined text-on-surface-variant text-sm">close</span>
                  </button>
                </div>
                <div>
                  {/* Template Grid */}
                  <div className={`p-4 grid gap-3 ${(SKILL_TEMPLATES[selectedSkill] || []).length > 4 ? 'grid-cols-2 md:grid-cols-4' : 'grid-cols-2'}`}>
                    {(SKILL_TEMPLATES[selectedSkill] || []).map(tmpl => {
                      const previewKey = `${selectedSkill}:${tmpl.id}`;
                      const preview = TEMPLATE_PREVIEW[previewKey];
                      const isHovered = hoveredTemplate === tmpl.id;
                      const skillType = selectedSkill?.replace('-gen', '') || '';

                      // --- Mini preview (non-hovered, 48px) ---
                      const renderMini = () => {
                        const ac = preview?.accent || '#6b7280';
                        const tx = preview?.text || '#1f2937';
                        const cd = preview?.card || '#f3f4f6';
                        if (skillType === 'docx') {
                          // Mini doc: heading line + paragraph lines
                          return (
                            <div className="absolute inset-0 p-2.5 flex flex-col gap-1 justify-center">
                              <div className="h-1.5 w-10 rounded-sm" style={{ background: ac, opacity: 0.8 }} />
                              <div className="h-1 w-full rounded-sm" style={{ background: tx, opacity: 0.12 }} />
                              <div className="h-1 w-4/5 rounded-sm" style={{ background: tx, opacity: 0.1 }} />
                              <div className="h-1 w-3/5 rounded-sm" style={{ background: tx, opacity: 0.08 }} />
                            </div>
                          );
                        }
                        if (skillType === 'xlsx') {
                          // Mini grid: header row + data rows
                          return (
                            <div className="absolute inset-0 p-2 flex flex-col gap-0.5 justify-center">
                              <div className="flex gap-0.5">
                                <div className="h-2 flex-1 rounded-sm" style={{ background: ac, opacity: 0.7 }} />
                                <div className="h-2 flex-1 rounded-sm" style={{ background: ac, opacity: 0.7 }} />
                                <div className="h-2 flex-1 rounded-sm" style={{ background: ac, opacity: 0.7 }} />
                              </div>
                              <div className="flex gap-0.5">
                                <div className="h-1.5 flex-1 rounded-sm" style={{ background: cd }} />
                                <div className="h-1.5 flex-1 rounded-sm" style={{ background: cd }} />
                                <div className="h-1.5 flex-1 rounded-sm" style={{ background: cd }} />
                              </div>
                              <div className="flex gap-0.5">
                                <div className="h-1.5 flex-1 rounded-sm" style={{ background: cd, opacity: 0.7 }} />
                                <div className="h-1.5 flex-1 rounded-sm" style={{ background: cd, opacity: 0.7 }} />
                                <div className="h-1.5 flex-1 rounded-sm" style={{ background: cd, opacity: 0.7 }} />
                              </div>
                            </div>
                          );
                        }
                        if (skillType === 'pdf') {
                          // Mini page: title block + two-col hint
                          return (
                            <div className="absolute inset-0 p-2.5 flex flex-col gap-1 justify-center">
                              <div className="h-2 w-12 rounded-sm" style={{ background: ac, opacity: 0.8 }} />
                              <div className="h-px w-full" style={{ background: tx, opacity: 0.1 }} />
                              <div className="flex gap-1">
                                <div className="h-1 flex-1 rounded-sm" style={{ background: tx, opacity: 0.1 }} />
                                <div className="h-1 flex-1 rounded-sm" style={{ background: tx, opacity: 0.08 }} />
                              </div>
                            </div>
                          );
                        }
                        // PPTX / Slides: slide bars (original style)
                        return (
                          <div className="absolute inset-0 p-2 flex items-end gap-0.5">
                            <div className="h-3/5 flex-1 rounded-sm" style={{ background: ac, opacity: 0.8 }} />
                            <div className="h-4/5 flex-1 rounded-sm" style={{ background: ac, opacity: 0.6 }} />
                            <div className="h-3/4 flex-1 rounded-sm" style={{ background: ac, opacity: 0.7 }} />
                          </div>
                        );
                      };

                      // --- Full mockup (hovered, 130px) ---
                      const renderFull = () => {
                        const ac = preview?.accent || '#6b7280';
                        const tx = preview?.text || '#1f2937';
                        const cd = preview?.card || '#f3f4f6';

                        if (skillType === 'docx') {
                          // Document layout: heading, paragraphs, sections
                          return (
                            <div className="absolute inset-0 p-3 flex flex-col gap-1.5">
                              {/* Title */}
                              <div className="h-3 w-20 rounded-sm" style={{ background: ac, opacity: 0.85 }} />
                              {/* Divider */}
                              <div className="h-px w-full" style={{ background: ac, opacity: 0.3 }} />
                              {/* Paragraph 1 */}
                              <div className="flex flex-col gap-0.5">
                                <div className="h-1.5 w-full rounded-sm" style={{ background: tx, opacity: 0.15 }} />
                                <div className="h-1.5 w-full rounded-sm" style={{ background: tx, opacity: 0.13 }} />
                                <div className="h-1.5 w-3/4 rounded-sm" style={{ background: tx, opacity: 0.11 }} />
                              </div>
                              {/* Subheading */}
                              <div className="h-2.5 w-14 rounded-sm mt-0.5" style={{ background: ac, opacity: 0.6 }} />
                              {/* Paragraph 2 */}
                              <div className="flex flex-col gap-0.5">
                                <div className="h-1.5 w-full rounded-sm" style={{ background: tx, opacity: 0.12 }} />
                                <div className="h-1.5 w-5/6 rounded-sm" style={{ background: tx, opacity: 0.1 }} />
                              </div>
                              {/* Bullet list hint */}
                              <div className="flex flex-col gap-0.5 pl-2 mt-auto">
                                <div className="flex items-center gap-1">
                                  <div className="w-1 h-1 rounded-full" style={{ background: ac, opacity: 0.5 }} />
                                  <div className="h-1 w-16 rounded-sm" style={{ background: tx, opacity: 0.1 }} />
                                </div>
                                <div className="flex items-center gap-1">
                                  <div className="w-1 h-1 rounded-full" style={{ background: ac, opacity: 0.5 }} />
                                  <div className="h-1 w-12 rounded-sm" style={{ background: tx, opacity: 0.1 }} />
                                </div>
                              </div>
                            </div>
                          );
                        }

                        if (skillType === 'xlsx') {
                          // Spreadsheet layout: header row + data grid
                          return (
                            <div className="absolute inset-0 p-2.5 flex flex-col gap-1">
                              {/* Header row */}
                              <div className="flex gap-1">
                                <div className="h-3 flex-1 rounded-sm flex items-center justify-center" style={{ background: ac, opacity: 0.8 }}>
                                  <div className="h-1 w-3/5 rounded-sm" style={{ background: '#fff', opacity: 0.6 }} />
                                </div>
                                <div className="h-3 flex-1 rounded-sm flex items-center justify-center" style={{ background: ac, opacity: 0.8 }}>
                                  <div className="h-1 w-3/5 rounded-sm" style={{ background: '#fff', opacity: 0.6 }} />
                                </div>
                                <div className="h-3 flex-1 rounded-sm flex items-center justify-center" style={{ background: ac, opacity: 0.8 }}>
                                  <div className="h-1 w-3/5 rounded-sm" style={{ background: '#fff', opacity: 0.6 }} />
                                </div>
                                <div className="h-3 flex-1 rounded-sm flex items-center justify-center" style={{ background: ac, opacity: 0.8 }}>
                                  <div className="h-1 w-3/5 rounded-sm" style={{ background: '#fff', opacity: 0.6 }} />
                                </div>
                              </div>
                              {/* Data rows */}
                              {[0.9, 0.7, 0.8, 0.6, 0.75].map((op, i) => (
                                <div key={i} className="flex gap-1">
                                  <div className="h-2.5 flex-1 rounded-sm" style={{ background: cd, opacity: i % 2 === 0 ? 1 : 0.7 }} />
                                  <div className="h-2.5 flex-1 rounded-sm" style={{ background: cd, opacity: i % 2 === 0 ? 1 : 0.7 }} />
                                  <div className="h-2.5 flex-1 rounded-sm" style={{ background: cd, opacity: i % 2 === 0 ? 1 : 0.7 }} />
                                  <div className="h-2.5 flex-1 rounded-sm" style={{ background: i === 4 ? ac : cd, opacity: i === 4 ? 0.3 : (i % 2 === 0 ? 1 : 0.7) }} />
                                </div>
                              ))}
                              {/* Summary row */}
                              <div className="flex gap-1 mt-auto">
                                <div className="h-2.5 flex-[3] rounded-sm" style={{ background: tx, opacity: 0.08 }} />
                                <div className="h-2.5 flex-1 rounded-sm" style={{ background: ac, opacity: 0.4 }} />
                              </div>
                            </div>
                          );
                        }

                        if (skillType === 'pdf') {
                          // PDF page layout: title block, divider, multi-column
                          return (
                            <div className="absolute inset-0 p-3 flex flex-col gap-1.5">
                              {/* Title block */}
                              <div className="flex items-center gap-2">
                                <div className="w-5 h-5 rounded-sm" style={{ background: ac, opacity: 0.8 }} />
                                <div className="flex flex-col gap-0.5 flex-1">
                                  <div className="h-2.5 w-16 rounded-sm" style={{ background: tx, opacity: 0.7 }} />
                                  <div className="h-1 w-10 rounded-sm" style={{ background: tx, opacity: 0.2 }} />
                                </div>
                              </div>
                              {/* Divider */}
                              <div className="h-px w-full" style={{ background: ac, opacity: 0.3 }} />
                              {/* Two-column content */}
                              <div className="flex-1 flex gap-2">
                                <div className="flex-1 flex flex-col gap-0.5">
                                  <div className="h-1.5 w-full rounded-sm" style={{ background: tx, opacity: 0.12 }} />
                                  <div className="h-1.5 w-full rounded-sm" style={{ background: tx, opacity: 0.1 }} />
                                  <div className="h-1.5 w-4/5 rounded-sm" style={{ background: tx, opacity: 0.08 }} />
                                  <div className="flex-1" />
                                  <div className="h-4 w-full rounded-sm" style={{ background: cd }} />
                                </div>
                                <div className="flex-1 flex flex-col gap-0.5">
                                  <div className="h-1.5 w-full rounded-sm" style={{ background: tx, opacity: 0.12 }} />
                                  <div className="h-1.5 w-full rounded-sm" style={{ background: tx, opacity: 0.1 }} />
                                  <div className="h-1.5 w-3/5 rounded-sm" style={{ background: tx, opacity: 0.08 }} />
                                  <div className="flex-1" />
                                  <div className="h-4 w-full rounded-sm" style={{ background: cd }} />
                                </div>
                              </div>
                              {/* Footer */}
                              <div className="flex justify-between items-center">
                                <div className="h-1 w-10 rounded-sm" style={{ background: tx, opacity: 0.08 }} />
                                <div className="h-1 w-4 rounded-sm" style={{ background: tx, opacity: 0.1 }} />
                              </div>
                            </div>
                          );
                        }

                        // PPTX / Slides: slide mockup (improved)
                        return (
                          <div className="absolute inset-0 p-3 flex flex-col gap-1.5">
                            <div className="flex items-center gap-1.5">
                              <div className="w-4 h-4 rounded-sm" style={{ background: ac }} />
                              <div className="h-2.5 w-16 rounded-sm" style={{ background: tx, opacity: 0.7 }} />
                            </div>
                            <div className="flex-1 flex gap-2">
                              <div className="flex-1 flex flex-col gap-1">
                                <div className="h-1.5 w-full rounded-sm" style={{ background: tx, opacity: 0.15 }} />
                                <div className="h-1.5 w-4/5 rounded-sm" style={{ background: tx, opacity: 0.12 }} />
                                <div className="h-1.5 w-3/5 rounded-sm" style={{ background: tx, opacity: 0.1 }} />
                                <div className="flex-1" />
                                <div className="flex gap-1">
                                  <div className="h-5 flex-1 rounded-sm" style={{ background: cd }} />
                                  <div className="h-5 flex-1 rounded-sm" style={{ background: cd }} />
                                </div>
                              </div>
                              <div className="w-14 rounded-sm flex flex-col gap-1 p-1" style={{ background: cd }}>
                                <div className="h-4 w-full rounded-sm" style={{ background: ac, opacity: 0.4 }} />
                                <div className="h-1 w-full rounded-sm" style={{ background: tx, opacity: 0.1 }} />
                                <div className="h-1 w-3/4 rounded-sm" style={{ background: tx, opacity: 0.08 }} />
                              </div>
                            </div>
                          </div>
                        );
                      };

                      return (
                        <button
                          key={tmpl.id}
                          onClick={() => handleCreate(selectedSkill, t(tmpl.promptKey as any))}
                          onMouseEnter={() => setHoveredTemplate(tmpl.id)}
                          onMouseLeave={() => setHoveredTemplate(null)}
                          disabled={creating}
                          className={`bg-surface-container-high rounded-lg flex flex-col items-center text-center disabled:opacity-50 cursor-pointer group border transition-all duration-300 ease-out overflow-hidden ${
                            isHovered ? 'border-primary/40 shadow-lg' : 'border-transparent hover:border-primary/20'
                          }`}
                        >
                          {/* Preview mockup — both layers always rendered, crossfade via opacity */}
                          <div
                            className="w-full overflow-hidden relative transition-all duration-300 ease-out"
                            style={{
                              background: preview?.bg || '#f3f4f6',
                              height: isHovered ? '130px' : '48px',
                            }}
                          >
                            {/* Layer 1: Mini type-specific preview (default) */}
                            <div
                              className="transition-opacity duration-300 ease-out"
                              style={{ opacity: isHovered ? 0 : 1 }}
                            >
                              {renderMini()}
                            </div>
                            {/* Layer 2: Full type-specific mockup (hover) */}
                            <div
                              className="transition-opacity duration-300 ease-out"
                              style={{ opacity: isHovered ? 1 : 0 }}
                            >
                              {renderFull()}
                            </div>
                          </div>
                          {/* Label + description */}
                          <div className="px-2.5 pb-2.5 pt-2">
                            <span className="text-xs font-bold text-on-surface leading-tight block">{t(tmpl.labelKey as any)}</span>
                            <div
                              className="overflow-hidden transition-all duration-300 ease-out"
                              style={{ maxHeight: isHovered ? '48px' : '0px', opacity: isHovered ? 1 : 0 }}
                            >
                              <span className="text-xs text-on-surface-variant leading-snug mt-1 block">{t(tmpl.descKey as any)}</span>
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="px-4 pb-4">
                  <button
                    onClick={() => handleCreate(selectedSkill)}
                    disabled={creating}
                    className="w-full py-2 text-xs font-bold text-on-surface-variant hover:text-on-surface bg-surface-container-highest/50 hover:bg-surface-container-highest rounded-lg transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
                  >
                    <span className="material-symbols-outlined text-sm">skip_next</span>
                    {t('templates.skip' as any)}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
