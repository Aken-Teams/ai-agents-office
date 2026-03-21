'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from './AuthProvider';

const NAV_LINKS = [
  { href: '/dashboard', label: '儀表板', icon: 'dashboard' },
  { href: '/files', label: '檔案管理', icon: 'folder_open' },
  { href: '/usage', label: '用量統計', icon: 'bar_chart' },
];

export default function Navbar() {
  const { user, logout } = useAuth();
  const pathname = usePathname();

  if (!user) return null;

  return (
    <aside className="h-screen w-64 fixed left-0 top-0 bg-surface-dim flex flex-col py-6 font-headline text-sm tracking-tight z-50 border-r border-outline-variant/10">
      {/* Logo */}
      <div className="px-6 mb-8">
        <Link href="/dashboard" className="flex items-center gap-3 no-underline">
          <div className="w-8 h-8 bg-primary/20 flex items-center justify-center rounded-lg">
            <span className="material-symbols-outlined text-primary">terminal</span>
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tighter text-on-surface">AI Agents</h1>
            <p className="text-[10px] uppercase tracking-[0.2em] text-primary">Office</p>
          </div>
        </Link>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-4 space-y-1">
        {NAV_LINKS.map(link => {
          const isActive = pathname === link.href;
          return (
            <Link
              key={link.href}
              href={link.href}
              className={`flex items-center gap-3 px-3 py-2.5 no-underline transition-all duration-200 ${
                isActive
                  ? 'text-primary bg-surface-container border-l-2 border-primary'
                  : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container/50'
              }`}
            >
              <span className="material-symbols-outlined">{link.icon}</span>
              <span>{link.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* New Document Button */}
      <div className="px-6 mt-6">
        <Link
          href="/dashboard"
          className="w-full cyber-gradient py-3 text-on-primary font-bold rounded flex items-center justify-center gap-2 text-xs uppercase tracking-widest active:scale-[0.99] transition-all no-underline"
        >
          <span className="material-symbols-outlined text-sm">add</span>
          新建文件
        </Link>
      </div>

      {/* Bottom */}
      <div className="px-4 mt-auto pt-6 space-y-1">
        <div className="flex items-center gap-3 px-3 py-2 text-on-surface-variant">
          <span className="material-symbols-outlined text-sm">person</span>
          <span className="text-xs truncate">{user.displayName || user.email}</span>
        </div>
        <button
          onClick={logout}
          className="flex items-center gap-3 px-3 py-2 text-on-surface-variant hover:text-on-surface transition-all w-full text-left bg-transparent"
        >
          <span className="material-symbols-outlined">logout</span>
          <span>登出</span>
        </button>
      </div>
    </aside>
  );
}
