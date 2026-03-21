'use client';

import { AdminAuthProvider, useAdminAuth } from './components/AdminAuthProvider';
import AdminSidebar from './components/AdminSidebar';

function AdminShell({ children }: { children: React.ReactNode }) {
  const { isLoading } = useAdminAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen bg-surface-container-lowest flex items-center justify-center">
        <div className="flex items-center gap-3 text-on-surface-variant">
          <span className="material-symbols-outlined animate-spin">progress_activity</span>
          <span className="text-sm font-headline">正在初始化管理控制台...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface-container-lowest">
      <AdminSidebar />
      <main className="ml-64 min-h-screen flex flex-col">{children}</main>
    </div>
  );
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <AdminAuthProvider>
      <AdminShell>{children}</AdminShell>
    </AdminAuthProvider>
  );
}
