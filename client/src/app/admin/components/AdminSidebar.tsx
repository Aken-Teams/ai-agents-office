'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAdminAuth } from './AdminAuthProvider';

const ADMIN_NAV = [
  { href: '/admin/overview', label: '總覽', icon: 'dashboard' },
  { href: '/admin/users', label: '用戶管理', icon: 'corporate_fare' },
  { href: '/admin/tokens', label: 'Token 帳本', icon: 'payments' },
  { href: '/admin/security', label: '安全審計', icon: 'shield_with_heart' },
];

const BOTTOM_NAV = [
  { href: '/dashboard', label: '返回用戶面板', icon: 'arrow_back' },
];

export default function AdminSidebar() {
  const pathname = usePathname();
  const { user, logout } = useAdminAuth();

  return (
    <aside className="h-screen fixed left-0 top-0 w-64 bg-surface-container-lowest flex flex-col py-6 font-headline text-sm tracking-tight z-50 border-r border-outline-variant/10">
      {/* Header */}
      <div className="px-6 mb-2">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-primary/20 flex items-center justify-center rounded-lg">
            <span className="material-symbols-outlined text-primary">admin_panel_settings</span>
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tighter text-on-surface">AI Agents Office</h1>
            <p className="text-[10px] uppercase tracking-[0.2em] text-primary">Admin</p>
          </div>
        </div>
      </div>

      {/* Sovereign Label */}
      <div className="px-6 py-4">
        <p className="text-[10px] uppercase tracking-[0.3em] text-on-surface-variant font-bold">系統管理員</p>
        <p className="text-[9px] text-outline mt-0.5">最高權限</p>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-1 px-4">
        {ADMIN_NAV.map(link => {
          const isActive = pathname.startsWith(link.href);
          return (
            <Link
              key={link.href}
              href={link.href}
              className={`flex items-center gap-3 py-2.5 px-3 no-underline transition-all duration-200 ${
                isActive
                  ? 'text-primary bg-surface-container border-l-2 border-primary'
                  : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container/50'
              }`}
            >
              <span className="material-symbols-outlined text-[20px]">{link.icon}</span>
              <span>{link.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* Bottom */}
      <div className="mt-auto pt-6 space-y-1 px-4">
        {BOTTOM_NAV.map(link => (
          <Link
            key={link.href}
            href={link.href}
            className="flex items-center gap-3 py-2 px-3 text-on-surface-variant hover:text-on-surface transition-all no-underline"
          >
            <span className="material-symbols-outlined text-sm">{link.icon}</span>
            <span className="text-xs">{link.label}</span>
          </Link>
        ))}

        <div className="flex items-center gap-3 py-2 px-3 text-on-surface-variant">
          <span className="material-symbols-outlined text-sm">person</span>
          <span className="text-xs truncate">{user?.email || 'Admin'}</span>
        </div>

        <button
          onClick={logout}
          className="flex items-center gap-3 py-2 px-3 text-on-surface-variant hover:text-on-surface transition-all w-full text-left bg-transparent cursor-pointer"
        >
          <span className="material-symbols-outlined text-sm">logout</span>
          <span className="text-xs">登出</span>
        </button>

        {/* Footer */}
        <div className="mt-3 pt-3 border-t border-outline-variant/10 px-3">
          <a href="https://www.zh-aoi.com/" target="_blank" rel="noopener noreferrer" className="text-[11px] text-outline hover:text-on-surface-variant transition-colors no-underline block text-center">
            Powered by 智合科技 &copy; 2026
          </a>
        </div>
      </div>
    </aside>
  );
}
