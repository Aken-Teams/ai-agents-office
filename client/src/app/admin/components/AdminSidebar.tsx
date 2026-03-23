'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAdminAuth } from './AdminAuthProvider';
import { useTranslation } from '../../../i18n';

const ADMIN_SIDEBAR_KEY = 'admin-sidebar-collapsed';

const ADMIN_NAV = [
  { href: '/admin/overview', labelKey: 'admin.sidebar.overview' as const, icon: 'dashboard' },
  { href: '/admin/users', labelKey: 'admin.sidebar.users' as const, icon: 'corporate_fare' },
  { href: '/admin/skills', labelKey: 'admin.sidebar.skills' as const, icon: 'hub' },
  { href: '/admin/tokens', labelKey: 'admin.sidebar.tokens' as const, icon: 'payments' },
  { href: '/admin/security', labelKey: 'admin.sidebar.security' as const, icon: 'shield_with_heart' },
  { href: '/admin/settings', labelKey: 'admin.sidebar.settings' as const, icon: 'settings' },
];

export default function AdminSidebar() {
  const pathname = usePathname();
  const { user, logout } = useAdminAuth();
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window !== 'undefined') return localStorage.getItem(ADMIN_SIDEBAR_KEY) === '1';
    return false;
  });
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    localStorage.setItem(ADMIN_SIDEBAR_KEY, collapsed ? '1' : '0');
    window.dispatchEvent(new CustomEvent('admin-sidebar-toggle', { detail: collapsed }));
  }, [collapsed]);

  // Listen for mobile sidebar toggle
  useEffect(() => {
    const handler = () => setMobileOpen(v => !v);
    window.addEventListener('admin-mobile-sidebar-toggle', handler);
    return () => window.removeEventListener('admin-mobile-sidebar-toggle', handler);
  }, []);

  // Close mobile sidebar on route change
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  return (
    <>
      {/* Mobile backdrop */}
      {mobileOpen && (
        <div className="fixed inset-0 bg-black/50 z-40 md:hidden" onClick={() => setMobileOpen(false)} />
      )}
      <aside className={`h-screen fixed left-0 top-0 bg-surface-container-lowest flex flex-col py-6 font-headline text-sm tracking-tight z-50 border-r border-outline-variant/10 transition-all duration-300 ${collapsed ? 'w-[68px]' : 'w-64'} max-md:w-64 ${mobileOpen ? 'max-md:translate-x-0' : 'max-md:-translate-x-full'}`}>
      {/* Header */}
      <div className={`mb-2 ${collapsed ? 'px-3' : 'px-6'}`}>
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
          <p className="text-sm uppercase tracking-[0.3em] text-on-surface-variant font-bold">{t('admin.sidebar.roleLabel')}</p>
          <p className="text-xs text-outline mt-0.5">{t('admin.sidebar.roleDescription')}</p>
        </div>
      )}

      {/* Navigation */}
      <nav className={`flex-1 space-y-1 ${collapsed ? 'px-2' : 'px-4'}`}>
        {ADMIN_NAV.map(link => {
          const isActive = pathname.startsWith(link.href);
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
              <span className="material-symbols-outlined text-[20px]">{link.icon}</span>
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

        <div className={`relative group flex items-center gap-3 py-2 text-on-surface-variant ${collapsed ? 'justify-center px-0' : 'px-3'}`}>
          <span className="material-symbols-outlined text-sm">person</span>
          {!collapsed && <span className="text-sm truncate">{user?.email || 'Admin'}</span>}
          {collapsed && (
            <span className="absolute left-full ml-3 px-3 py-1.5 bg-surface-container-highest text-on-surface text-sm font-bold whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-200 z-[60] shadow-lg border border-outline-variant/10">
              {user?.email || 'Admin'}
            </span>
          )}
        </div>

        <button
          onClick={logout}
          className={`relative group flex items-center gap-3 py-2 text-on-surface-variant hover:text-on-surface transition-all w-full text-left bg-transparent cursor-pointer ${collapsed ? 'justify-center px-0' : 'px-3'}`}
        >
          <span className="material-symbols-outlined text-sm">logout</span>
          {!collapsed && <span className="text-sm">{t('admin.sidebar.logout')}</span>}
          {collapsed && (
            <span className="absolute left-full ml-3 px-3 py-1.5 bg-surface-container-highest text-on-surface text-sm font-bold whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-200 z-[60] shadow-lg border border-outline-variant/10">
              {t('admin.sidebar.logout')}
            </span>
          )}
        </button>

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
