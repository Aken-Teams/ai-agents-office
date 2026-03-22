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
  { id: 'data-analyst', labelKey: 'nav.docTypes.dataAnalyst.label' as const, descKey: 'nav.docTypes.dataAnalyst.desc' as const, icon: 'analytics', colorClass: 'text-primary' },
  { id: 'research', labelKey: 'nav.docTypes.research.label' as const, descKey: 'nav.docTypes.research.desc' as const, icon: 'travel_explore', colorClass: 'text-on-surface-variant' },
];

const LOCALE_OPTIONS: { value: Locale; label: string }[] = [
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en', label: 'English' },
];

export default function Navbar() {
  const { user, token, logout } = useAuth();
  const { locale, theme, setLocale, setTheme, t } = useTranslation();
  const pathname = usePathname();
  const router = useRouter();
  const [showModal, setShowModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window !== 'undefined') return localStorage.getItem(SIDEBAR_KEY) === '1';
    return false;
  });

  // Password change state
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [passwordSuccess, setPasswordSuccess] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);

  const [saved, setSaved] = useState(false);

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

  // Sync to localStorage + dispatch event for other components
  useEffect(() => {
    localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0');
    window.dispatchEvent(new CustomEvent('sidebar-toggle', { detail: collapsed }));
  }, [collapsed]);

  if (!user) return null;

  async function handleCreate(skillId: string) {
    if (!token || creating) return;
    setCreating(true);
    try {
      const docType = DOC_TYPES.find(s => s.id === skillId);
      const title = docType?.labelKey ? `New ${t(docType.labelKey)}` : 'New Conversation';
      const res = await fetch('/api/conversations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ title, skillId }),
      });
      const conv = await res.json();
      setShowModal(false);
      router.push(`/chat/${conv.id}`);
    } finally {
      setCreating(false);
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

  return (
    <>
      <aside className={`h-screen fixed left-0 top-0 bg-surface-dim flex flex-col py-6 font-headline text-sm tracking-tight z-50 border-r border-outline-variant/10 transition-all duration-300 ${collapsed ? 'w-[68px]' : 'w-64'}`}>
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

        {/* New Document Button */}
        <div className={`mt-6 ${collapsed ? 'px-2' : 'px-6'}`}>
          <div className="relative group">
            <button
              onClick={() => setShowModal(true)}
              className={`w-full cyber-gradient py-3 text-on-primary font-bold rounded flex items-center justify-center gap-2 text-sm uppercase tracking-widest active:scale-[0.99] transition-all cursor-pointer ${collapsed ? 'px-0' : ''}`}
            >
              <span className="material-symbols-outlined text-sm">add</span>
              {!collapsed && t('nav.newDocument')}
            </button>
            {collapsed && (
              <span className="absolute left-full ml-3 top-1/2 -translate-y-1/2 px-3 py-1.5 bg-surface-container-highest text-on-surface text-sm font-bold whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-200 z-[60] shadow-lg border border-outline-variant/10">
                {t('nav.newDocument')}
              </span>
            )}
          </div>
        </div>

        {/* Bottom */}
        <div className={`mt-auto pt-6 space-y-1 ${collapsed ? 'px-2' : 'px-4'}`}>
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
                {/* Profile Info */}
                <div className="px-5 py-4 border-b border-outline-variant/10">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-10 h-10 bg-primary/20 flex items-center justify-center rounded-full">
                      <span className="material-symbols-outlined text-primary">person</span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-bold text-on-surface truncate">{user.displayName || '—'}</p>
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
          onClick={() => setShowModal(false)}
        >
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

          {/* Modal */}
          <div
            className="relative bg-surface-container rounded-xl shadow-2xl border border-outline-variant/10 w-full max-w-lg mx-4 overflow-hidden animate-in"
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="px-6 py-5 flex items-center justify-between border-b border-outline-variant/10">
              <div className="flex items-center gap-3">
                <span className="material-symbols-outlined text-primary">add_circle</span>
                <h2 className="text-sm font-headline font-bold">{t('nav.modalTitle')}</h2>
              </div>
              <button
                onClick={() => setShowModal(false)}
                className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-surface-container-high transition-colors bg-transparent cursor-pointer"
              >
                <span className="material-symbols-outlined text-on-surface-variant text-sm">close</span>
              </button>
            </div>

            {/* Agent Options Grid */}
            <div className="p-6 grid grid-cols-3 gap-3">
              {DOC_TYPES.map(doc => (
                <button
                  key={doc.id}
                  onClick={() => handleCreate(doc.id)}
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

            {/* Footer hint */}
            <div className="px-6 pb-5">
              <p className="text-sm text-on-surface-variant text-center">
                {t('nav.modalHint')}
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
