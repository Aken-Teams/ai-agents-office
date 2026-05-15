'use client';

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';

interface AdminUser {
  id: string;
  email: string;
  displayName: string | null;
  role: string;
  locale?: 'zh-TW' | 'zh-CN' | 'en';
  theme?: 'dark' | 'light';
}

interface Permissions {
  adminSidebar: string[];
  frontendNav: string[];
  features: string[];
}

interface AdminAuthContextType {
  user: AdminUser | null;
  token: string | null;
  isLoading: boolean;
  isReadonly: boolean;
  permissions: Permissions | null;
  hasPermission: (category: keyof Permissions, key: string) => boolean;
  logout: () => void;
}

const AdminAuthContext = createContext<AdminAuthContextType | null>(null);

export function useAdminAuth() {
  const ctx = useContext(AdminAuthContext);
  if (!ctx) throw new Error('useAdminAuth must be used within AdminAuthProvider');
  return ctx;
}

export function AdminAuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AdminUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [permissions, setPermissions] = useState<Permissions | null>(null);
  const router = useRouter();

  const hasPermission = useCallback((category: keyof Permissions, key: string): boolean => {
    if (!permissions) return false;
    const list = permissions[category];
    return list.includes('*') || list.includes(key);
  }, [permissions]);

  useEffect(() => {
    const storedToken = localStorage.getItem('token');
    if (!storedToken) {
      router.replace('/login');
      return;
    }

    setToken(storedToken);
    fetch('/api/auth/me', {
      headers: { Authorization: `Bearer ${storedToken}` },
    })
      .then(r => {
        if (!r.ok) throw new Error('Invalid token');
        return r.json();
      })
      .then(data => {
        if (data.role !== 'admin' && data.role !== 'readonly') {
          router.replace('/dashboard');
          return;
        }
        setUser(data);
        setIsLoading(false);
        // Fetch permissions
        fetch('/api/auth/permissions', { headers: { Authorization: `Bearer ${storedToken}` } })
          .then(r => r.ok ? r.json() : null)
          .then(p => { if (p) setPermissions(p); })
          .catch(() => {});
      })
      .catch(() => {
        localStorage.removeItem('token');
        router.replace('/login');
      });
  }, [router]);

  const logout = useCallback(() => {
    localStorage.removeItem('token');
    setToken(null);
    setUser(null);
    router.push('/login');
  }, [router]);

  const isReadonly = user?.role === 'readonly';

  return (
    <AdminAuthContext.Provider value={{ user, token, isLoading, isReadonly, permissions, hasPermission, logout }}>
      {children}
    </AdminAuthContext.Provider>
  );
}
