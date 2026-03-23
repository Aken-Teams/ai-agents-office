'use client';

import { useState, useEffect } from 'react';
import { AdminAuthProvider, useAdminAuth } from './components/AdminAuthProvider';
import AdminSidebar from './components/AdminSidebar';
import { I18nProvider } from '../../i18n';

const ADMIN_SIDEBAR_KEY = 'admin-sidebar-collapsed';

function AdminShell({ children }: { children: React.ReactNode }) {
  const { isLoading, user } = useAdminAuth();
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window !== 'undefined') return localStorage.getItem(ADMIN_SIDEBAR_KEY) === '1';
    return false;
  });

  useEffect(() => {
    const handler = (e: Event) => setCollapsed((e as CustomEvent).detail);
    window.addEventListener('admin-sidebar-toggle', handler);
    return () => window.removeEventListener('admin-sidebar-toggle', handler);
  }, []);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-surface-container-lowest flex items-center justify-center">
        <div className="flex items-center gap-3 text-on-surface-variant">
          <span className="material-symbols-outlined animate-spin">progress_activity</span>
          <AdminLoadingText />
        </div>
      </div>
    );
  }

  return (
    <I18nProvider initialLocale={user?.locale} initialTheme={user?.theme}>
      <div className="min-h-screen bg-surface-container-lowest">
        <AdminSidebar />
        <main className={`min-h-screen flex flex-col transition-all duration-300 ${collapsed ? 'md:ml-[68px]' : 'md:ml-64'}`}>
          {children}
        </main>
      </div>
    </I18nProvider>
  );
}

function AdminLoadingText() {
  return <span className="text-sm font-headline">Loading...</span>;
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <AdminAuthProvider>
      <AdminShell>{children}</AdminShell>
    </AdminAuthProvider>
  );
}
