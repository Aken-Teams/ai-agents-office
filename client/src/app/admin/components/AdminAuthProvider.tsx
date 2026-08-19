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
  adminSidebarOperate: string[];
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
  canOperate: (pageKey: string) => boolean;
  logout: () => void;
}

const AdminAuthContext = createContext<AdminAuthContextType | null>(null);

/** Server explicitly rejected the token (401) or blocked the account (403). */
class AuthTokenError extends Error {
  constructor() { super('Invalid token'); this.name = 'AuthTokenError'; }
}

// Backoff for retrying /api/auth/me after a transient failure (~30s total).
const ME_RETRY_DELAYS = [1000, 2000, 4000, 8000, 15000];

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

  const canOperate = useCallback((pageKey: string): boolean => {
    if (!permissions) return false;
    // Admin can always operate
    if (permissions.adminSidebarOperate?.includes('*')) return true;
    return permissions.adminSidebarOperate?.includes(pageKey) ?? false;
  }, [permissions]);

  // Same rule as the main AuthProvider: only a 401/403 from the server means the
  // token is bad. A backend restart or a 5xx from an unrelated subsystem must
  // not wipe the session and bounce the admin to /login — retry instead.
  useEffect(() => {
    const storedToken = localStorage.getItem('token');
    if (!storedToken) {
      router.replace('/login');
      return;
    }

    setToken(storedToken);

    let cancelled = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const attemptFetch = () => {
      if (cancelled) return;
      fetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${storedToken}` },
      })
        .then(r => {
          if (r.status === 401 || r.status === 403) throw new AuthTokenError();
          if (!r.ok) throw new Error(`auth/me failed: ${r.status}`);
          return r.json();
        })
        .then(data => {
          if (cancelled) return;
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
        .catch((err: unknown) => {
          if (cancelled) return;
          if (err instanceof AuthTokenError) {
            localStorage.removeItem('token');
            router.replace('/login');
            return;
          }
          // Transient — keep the token and retry with backoff.
          attempt++;
          if (attempt > ME_RETRY_DELAYS.length) {
            setIsLoading(false); // stop the spinner; token stays, reload recovers
            return;
          }
          timer = setTimeout(attemptFetch, ME_RETRY_DELAYS[attempt - 1]);
        });
    };
    attemptFetch();

    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [router]);

  const logout = useCallback(() => {
    localStorage.removeItem('token');
    setToken(null);
    setUser(null);
    router.push('/login');
  }, [router]);

  const isReadonly = user?.role === 'readonly';

  return (
    <AdminAuthContext.Provider value={{ user, token, isLoading, isReadonly, permissions, hasPermission, canOperate, logout }}>
      {children}
    </AdminAuthContext.Provider>
  );
}
