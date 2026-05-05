'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAdminAuth } from './AdminAuthProvider';
import { useTranslation } from '../../../i18n';

const deployMode = process.env.NEXT_PUBLIC_DEPLOY_MODE || 'pro-panjit';
const ADMIN_SIDEBAR_KEY = 'admin-sidebar-collapsed';

const PINNED_NAV = { href: '/admin/overview', labelKey: 'admin.sidebar.overview' as const, icon: 'dashboard' };

const NAV_GROUPS = [
  {
    id: 'members',
    labelKey: 'admin.sidebar.group.members' as const,
    icon: 'people',
    items: [
      { href: '/admin/users', labelKey: 'admin.sidebar.users' as const, icon: 'corporate_fare' },
      { href: '/admin/conversations', labelKey: 'admin.sidebar.conversations' as const, icon: 'forum', readonlyHidden: true },
      { href: '/admin/quota-groups', labelKey: 'admin.sidebar.quotaGroups' as const, icon: 'category' },
      ...(deployMode === 'pro-out' ? [{ href: '/admin/invite-codes', labelKey: 'admin.sidebar.inviteCodes' as const, icon: 'card_membership' }] : []),
    ],
  },
  {
    id: 'operations',
    labelKey: 'admin.sidebar.group.operations' as const,
    icon: 'tune',
    items: [
      { href: '/admin/announcements', labelKey: 'admin.sidebar.announcements' as const, icon: 'campaign', readonlyHidden: true },
      { href: '/admin/skills', labelKey: 'admin.sidebar.skills' as const, icon: 'hub' },
      { href: '/admin/tokens', labelKey: 'admin.sidebar.tokens' as const, icon: 'payments' },
      { href: '/admin/analytics', labelKey: 'admin.sidebar.analytics' as const, icon: 'bar_chart' },
    ],
  },
  {
    id: 'system',
    labelKey: 'admin.sidebar.group.system' as const,
    icon: 'settings',
    items: [
      { href: '/admin/security', labelKey: 'admin.sidebar.security' as const, icon: 'shield_with_heart' },
      { href: '/admin/settings', labelKey: 'admin.sidebar.settings' as const, icon: 'settings' },
    ],
  },
];

function findGroupForPath(path: string): string | null {
  const group = NAV_GROUPS.find(g => g.items.some(item => path.startsWith(item.href)));
  return group?.id ?? null;
}

export default function AdminSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout, isReadonly } = useAdminAuth();
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window !== 'undefined') return localStorage.getItem(ADMIN_SIDEBAR_KEY) === '1';
    return false;
  });
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [openGroup, setOpenGroup] = useState<string | null>(() => findGroupForPath(pathname));

  useEffect(() => {
    localStorage.setItem(ADMIN_SIDEBAR_KEY, collapsed ? '1' : '0');
    window.dispatchEvent(new CustomEvent('admin-sidebar-toggle', { detail: collapsed }));
  }, [collapsed]);

  // Close mobile menu on route change & auto-open matching group
  useEffect(() => {
    setMobileMenuOpen(false);
    const match = findGroupForPath(pathname);
    if (match) setOpenGroup(match);
  }, [pathname]);

  const toggleGroup = (id: string) => {
    setOpenGroup(prev => prev === id ? null : id);
  };

  return (
    <>
      {/* ===== Mobile Top Bar ===== */}
      <header className="md:hidden fixed top-0 left-0 right-0 h-14 bg-surface-dim border-b border-outline-variant/10 flex items-center justify-between px-4 z-50">
        <Link href="/admin/overview" className="flex items-center gap-2 no-underline">
          <div className="w-8 h-8 bg-primary/20 flex items-center justify-center rounded-lg">
            <span className="material-symbols-outlined text-primary" style={{ fontSize: 18 }}>admin_panel_settings</span>
          </div>
          <div>
            <span className="font-headline text-base font-bold tracking-tighter text-on-surface">AI Agents Office</span>
            <span className="ml-1.5 text-[10px] uppercase tracking-[0.2em] text-primary font-bold">Admin</span>
          </div>
        </Link>
        <button
          onClick={() => setMobileMenuOpen(v => !v)}
          className="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-surface-container text-on-surface-variant cursor-pointer"
        >
          <span className="material-symbols-outlined">{mobileMenuOpen ? 'close' : 'menu'}</span>
        </button>
      </header>

      {/* ===== Mobile Dropdown Nav ===== */}
      {mobileMenuOpen && (
        <div className="md:hidden fixed inset-0 z-[45]" onClick={() => setMobileMenuOpen(false)}>
          <div
            className="absolute top-14 left-0 right-0 bg-surface-dim border-b border-outline-variant/10 shadow-lg animate-[slideDown_0.2s_ease-out] max-h-[calc(100svh-3.5rem)] overflow-y-auto"
            onClick={e => e.stopPropagation()}
          >
            {/* User Row */}
            <div className="flex items-center px-4 py-2.5 gap-2">
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <div className="w-9 h-9 bg-primary/15 flex items-center justify-center rounded-full shrink-0">
                  <span className="material-symbols-outlined text-primary text-sm">person</span>
                </div>
                <div className="min-w-0 flex-1 text-left">
                  <p className="text-sm font-bold text-on-surface truncate">{user?.displayName || user?.email || 'Admin'}</p>
                  <p className="text-[11px] text-on-surface-variant truncate">{user?.email}</p>
                </div>
              </div>
              <span className="text-[10px] uppercase tracking-widest text-primary font-bold bg-primary/10 px-2 py-0.5 rounded-full shrink-0">
                {t('admin.sidebar.roleLabel')}
              </span>
              <button
                onClick={() => { setMobileMenuOpen(false); logout(); }}
                className="w-9 h-9 flex items-center justify-center rounded-lg text-on-surface-variant active:text-error active:bg-error/10 transition-colors cursor-pointer shrink-0"
                title={t('admin.sidebar.logout')}
              >
                <span className="material-symbols-outlined text-xl">logout</span>
              </button>
            </div>

            {/* Nav Links — Grouped with section headers */}
            <nav className="py-1 border-t border-outline-variant/10">
              {/* Pinned: Overview */}
              <Link
                href={PINNED_NAV.href}
                onClick={() => setMobileMenuOpen(false)}
                className={`flex items-center gap-3 px-5 py-3.5 no-underline transition-colors ${
                  pathname.startsWith(PINNED_NAV.href)
                    ? 'text-primary bg-primary/5'
                    : 'text-on-surface-variant active:bg-surface-container'
                }`}
              >
                <span className="material-symbols-outlined text-xl">{PINNED_NAV.icon}</span>
                <span className="text-sm font-headline font-bold">{t(PINNED_NAV.labelKey)}</span>
              </Link>

              {/* Groups with accordion (collapsed by default) */}
              {NAV_GROUPS.map(group => {
                const isOpen = openGroup === group.id;
                const hasActiveChild = group.items.some(item => pathname.startsWith(item.href));
                return (
                  <div key={group.id}>
                    <button
                      onClick={() => toggleGroup(group.id)}
                      className={`flex items-center gap-3 px-5 py-3 w-full bg-transparent cursor-pointer transition-colors ${
                        hasActiveChild ? 'text-primary' : 'text-on-surface-variant active:bg-surface-container'
                      }`}
                    >
                      <span className="material-symbols-outlined text-xl">{group.icon}</span>
                      <span className="flex-1 text-left text-xs uppercase tracking-widest font-bold font-headline">{t(group.labelKey)}</span>
                      <span className={`material-symbols-outlined text-[18px] transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}>
                        expand_more
                      </span>
                    </button>
                    {isOpen && group.items.filter(link => !(isReadonly && (link as any).readonlyHidden)).map(link => {
                      const isActive = pathname.startsWith(link.href);
                      return (
                        <Link
                          key={link.href}
                          href={link.href}
                          onClick={() => setMobileMenuOpen(false)}
                          className={`flex items-center gap-3 pl-12 pr-5 py-3 no-underline transition-colors ${
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
                  </div>
                );
              })}

              {/* Switch to User View */}
              <Link
                href="/dashboard"
                onClick={() => setMobileMenuOpen(false)}
                className="flex items-center gap-3 px-5 py-3.5 no-underline text-primary active:bg-primary/10 transition-colors"
              >
                <span className="material-symbols-outlined text-xl">swap_horiz</span>
                <span className="text-sm font-headline font-bold">{t('admin.sidebar.switchToUser' as any)}</span>
              </Link>
            </nav>

            {/* Footer */}
            <div className="py-3 border-t border-outline-variant/10">
              <a href="https://www.zh-aoi.com/" target="_blank" rel="noopener noreferrer" className="text-[11px] text-outline hover:text-on-surface-variant transition-colors no-underline block text-center">
                {t('admin.sidebar.poweredBy')} &copy; 2026
              </a>
            </div>
          </div>
        </div>
      )}

      {/* ===== Desktop Sidebar ===== */}
      <aside className={`hidden md:flex h-screen fixed left-0 top-0 bg-surface-container-lowest flex-col py-6 font-headline text-sm tracking-tight z-50 border-r border-outline-variant/10 transition-all duration-300 ${collapsed ? 'w-[68px] overflow-visible' : 'w-64'}`}>
      {/* Header */}
      <div className={`mb-2 shrink-0 ${collapsed ? 'px-3' : 'px-6'}`}>
        <Link href="/admin/overview" className="flex items-center gap-3 no-underline">
          <div className="w-8 h-8 bg-primary/20 flex items-center justify-center rounded-lg shrink-0">
            <span className="material-symbols-outlined text-primary">admin_panel_settings</span>
          </div>
          {!collapsed && (
            <div>
              <h1 className="text-lg font-bold tracking-tighter text-on-surface">AI Agents Office</h1>
              <p className="text-sm uppercase tracking-[0.2em] text-primary">Admin</p>
            </div>
          )}
        </Link>
      </div>

      {/* Role Label */}
      {!collapsed && (
        <div className="px-6 py-4">
          <p className="text-sm uppercase tracking-[0.3em] text-on-surface-variant font-bold">{isReadonly ? t('admin.sidebar.readonlyLabel' as any) : t('admin.sidebar.roleLabel')}</p>
          <p className="text-xs text-outline mt-0.5">{isReadonly ? t('admin.sidebar.readonlyDescription' as any) : t('admin.sidebar.roleDescription')}</p>
        </div>
      )}

      {/* Navigation */}
      <nav className={`flex-1 min-h-0 ${collapsed ? 'px-2 overflow-visible' : 'px-4 overflow-y-auto'}`}>
        {/* Pinned: Overview */}
        <Link
          href={PINNED_NAV.href}
          className={`relative group flex items-center gap-3 py-2.5 no-underline transition-all duration-200 ${collapsed ? 'justify-center px-0' : 'px-3'} ${
            pathname.startsWith(PINNED_NAV.href)
              ? 'text-primary bg-surface-container border-l-2 border-primary'
              : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container/50'
          }`}
        >
          <span className="material-symbols-outlined text-[20px]">{PINNED_NAV.icon}</span>
          {!collapsed && <span>{t(PINNED_NAV.labelKey)}</span>}
          {collapsed && (
            <span className="absolute left-full ml-3 px-3 py-1.5 bg-surface-container-highest text-on-surface text-sm font-bold whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-200 z-[60] shadow-lg border border-outline-variant/10">
              {t(PINNED_NAV.labelKey)}
            </span>
          )}
        </Link>

        {/* Accordion Groups */}
        <div className="mt-2 space-y-1">
          {NAV_GROUPS.map(group => {
            const isOpen = openGroup === group.id;
            const hasActiveChild = group.items.some(item => pathname.startsWith(item.href));

            return (
              <div key={group.id}>
                {/* Group Header */}
                {collapsed ? (
                  // Collapsed: icon with flyout submenu on hover
                  <div className="relative group/gh">
                    <button
                      className={`flex items-center justify-center py-2.5 w-full bg-transparent cursor-pointer transition-all duration-200 ${
                        hasActiveChild
                          ? 'text-primary'
                          : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container/50'
                      }`}
                    >
                      <span className="material-symbols-outlined text-[20px]">{group.icon}</span>
                    </button>
                    {/* Flyout submenu — pl-2 creates visual gap while keeping hover area continuous */}
                    <div className="absolute left-full top-0 pl-2 opacity-0 group-hover/gh:opacity-100 pointer-events-none group-hover/gh:pointer-events-auto transition-opacity duration-200 z-[60]">
                      <div className="py-1.5 bg-surface-container-highest rounded-lg shadow-lg border border-outline-variant/10 min-w-[160px]">
                      <div className="px-3 py-1.5 text-xs font-bold text-on-surface-variant uppercase tracking-widest">{t(group.labelKey)}</div>
                      {group.items.filter(link => !(isReadonly && (link as any).readonlyHidden)).map(link => {
                        const isActive = pathname.startsWith(link.href);
                        return (
                          <Link
                            key={link.href}
                            href={link.href}
                            className={`flex items-center gap-2.5 px-3 py-2 no-underline text-sm transition-colors ${
                              isActive ? 'text-primary font-bold' : 'text-on-surface hover:bg-surface-container'
                            }`}
                          >
                            <span className="material-symbols-outlined text-[18px]">{link.icon}</span>
                            <span>{t(link.labelKey)}</span>
                          </Link>
                        );
                      })}
                      </div>
                    </div>
                  </div>
                ) : (
                  // Expanded: clickable group header with chevron
                  <button
                    onClick={() => toggleGroup(group.id)}
                    className={`flex items-center gap-3 py-2.5 px-3 w-full bg-transparent cursor-pointer transition-all duration-200 rounded ${
                      hasActiveChild
                        ? 'text-primary'
                        : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container/50'
                    }`}
                  >
                    <span className="material-symbols-outlined text-[20px]">{group.icon}</span>
                    <span className="flex-1 text-left text-sm font-bold">{t(group.labelKey)}</span>
                    <span className={`material-symbols-outlined text-[16px] transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}>
                      expand_more
                    </span>
                  </button>
                )}

                {/* Group Children — only in expanded sidebar */}
                {!collapsed && isOpen && (
                  <div className="space-y-0.5">
                    {group.items.filter(link => !(isReadonly && (link as any).readonlyHidden)).map(link => {
                      const isActive = pathname.startsWith(link.href);
                      return (
                        <Link
                          key={link.href}
                          href={link.href}
                          className={`flex items-center gap-3 py-2 pl-9 pr-3 no-underline transition-all duration-200 ${
                            isActive
                              ? 'text-primary bg-surface-container border-l-2 border-primary'
                              : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container/50'
                          }`}
                        >
                          <span className="material-symbols-outlined text-[18px]">{link.icon}</span>
                          <span className="text-sm">{t(link.labelKey)}</span>
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </nav>

      {/* Bottom */}
      <div className={`mt-auto pt-6 space-y-1 shrink-0 ${collapsed ? 'px-2' : 'px-4'}`}>
        {/* Switch to User View */}
        <Link
          href="/dashboard"
          className={`relative group flex items-center gap-3 py-2.5 no-underline text-primary hover:bg-primary/10 transition-all rounded-lg mb-2 ${collapsed ? 'justify-center px-0' : 'px-3'}`}
        >
          <span className="material-symbols-outlined text-[20px]">swap_horiz</span>
          {!collapsed && <span className="text-sm font-bold">{t('admin.sidebar.switchToUser' as any)}</span>}
          {collapsed && (
            <span className="absolute left-full ml-3 px-3 py-1.5 bg-surface-container-highest text-on-surface text-sm font-bold whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-200 z-[60] shadow-lg border border-outline-variant/10">
              {t('admin.sidebar.switchToUser' as any)}
            </span>
          )}
        </Link>

        {/* Collapse Toggle */}
        <button
          onClick={() => setCollapsed(v => !v)}
          className={`relative group flex items-center gap-3 py-2 text-on-surface-variant hover:text-on-surface transition-all w-full bg-transparent cursor-pointer ${collapsed ? 'justify-center px-0' : 'px-3'}`}
        >
          <span className={`material-symbols-outlined text-sm transition-transform duration-300 ${collapsed ? 'rotate-180' : ''}`}>
            chevron_left
          </span>
          {!collapsed && <span className="text-sm">{t('admin.sidebar.collapse')}</span>}
          {collapsed && (
            <span className="absolute left-full ml-3 px-3 py-1.5 bg-surface-container-highest text-on-surface text-sm font-bold whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-200 z-[60] shadow-lg border border-outline-variant/10">
              {t('admin.sidebar.expand')}
            </span>
          )}
        </button>

        {/* User + Logout */}
        {collapsed ? (
          <button
            onClick={logout}
            className="relative group flex items-center justify-center py-2 w-full bg-transparent cursor-pointer text-on-surface-variant hover:text-error transition-colors"
            title={t('admin.sidebar.logout')}
          >
            <span className="material-symbols-outlined text-sm">logout</span>
            <span className="absolute left-full ml-3 px-3 py-1.5 bg-surface-container-highest text-on-surface text-sm font-bold whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-200 z-[60] shadow-lg border border-outline-variant/10">
              {t('admin.sidebar.logout')}
            </span>
          </button>
        ) : (
          <div className="flex items-center gap-2 py-2 px-3 text-on-surface-variant">
            <span className="material-symbols-outlined text-sm shrink-0">person</span>
            <span className="text-sm truncate flex-1 min-w-0">{user?.email || 'Admin'}</span>
            <button
              onClick={logout}
              className="shrink-0 w-7 h-7 flex items-center justify-center rounded hover:bg-surface-container hover:text-error transition-colors cursor-pointer bg-transparent"
              title={t('admin.sidebar.logout')}
            >
              <span className="material-symbols-outlined text-[16px]">logout</span>
            </button>
          </div>
        )}

        {/* Footer */}
        <div className="mt-3 pt-3 border-t border-outline-variant/10 px-3">
          <a href="https://www.zh-aoi.com/" target="_blank" rel="noopener noreferrer" className={`text-outline hover:text-on-surface-variant transition-colors no-underline block text-center ${collapsed ? 'text-sm' : 'text-xs'}`}>
            {collapsed ? '\u00A9' : <>{t('admin.sidebar.poweredBy')} &copy; 2026</>}
          </a>
        </div>
      </div>
    </aside>
    </>
  );
}
