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

interface AdminAuthContextType {
  user: AdminUser | null;
  token: string | null;
  isLoading: boolean;
  isReadonly: boolean;
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
  const router = useRouter();

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
    <AdminAuthContext.Provider value={{ user, token, isLoading, isReadonly, logout }}>
      {children}
    </AdminAuthContext.Provider>
  );
}
