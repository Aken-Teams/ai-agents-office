'use client';

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import TermsModal from './TermsModal';

interface User {
  id: string;
  email: string;
  displayName: string | null;
  role?: string;
  locale?: 'zh-TW' | 'zh-CN' | 'en';
  theme?: 'dark' | 'light';
  oauthProvider?: string | null;
  hasPassword?: boolean;
  // Present on the /me payload — lets gated pages (e.g. the dashboard) hold off
  // first-login popups until onboarding/terms are done and the redirect lands.
  onboardingRequired?: boolean;
  termsRequired?: boolean;
  // Guest demo accounts (pro-out trial): one-time, 24h, $30 quota.
  isDemo?: boolean;
  demoExpiresAt?: string | null;
}

interface Permissions {
  adminSidebar: string[];
  frontendNav: string[];
  features: string[];
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  permissions: Permissions | null;
  hasPermission: (category: keyof Permissions, key: string) => boolean;
  login: (email: string, password: string) => Promise<void>;
  loginWithGoogle: (token: string, tokenType?: 'credential' | 'access_token') => Promise<{ needsVerification?: boolean; email?: string } | void>;
  register: (email: string, password: string, displayName: string, inviteCode?: string) => Promise<{ pending: boolean; needsVerification: boolean; email?: string; message?: string }>;
  verifyEmail: (email: string, code: string) => Promise<void>;
  resendCode: (email: string) => Promise<void>;
  logout: () => void;
  updateUser: (partial: Partial<User>) => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [showTermsModal, setShowTermsModal] = useState(false);
  const [permissions, setPermissions] = useState<Permissions | null>(null);
  const router = useRouter();

  const hasPermission = useCallback((category: keyof Permissions, key: string): boolean => {
    if (!permissions) return false;
    const list = permissions[category];
    return list.includes('*') || list.includes(key);
  }, [permissions]);

  // Check stored token on mount
  useEffect(() => {
    const storedToken = localStorage.getItem('token');
    if (storedToken) {
      setToken(storedToken);
      fetchMe(storedToken).catch(() => {
        localStorage.removeItem('token');
        setToken(null);
        setIsLoading(false);
      });
    } else {
      setIsLoading(false);
    }
  }, []);

  async function fetchMe(t: string) {
    const res = await fetch('/api/auth/me', {
      headers: { Authorization: `Bearer ${t}` },
    });
    if (!res.ok) throw new Error('Invalid token');
    const data = await res.json();
    setUser(data);
    setIsLoading(false);
    if (data.onboardingRequired) {
      router.replace('/onboarding');
    } else if (data.termsRequired) {
      setShowTermsModal(true);
    }
    // Fetch permissions
    fetch('/api/auth/permissions', { headers: { Authorization: `Bearer ${t}` } })
      .then(r => r.ok ? r.json() : null)
      .then(p => { if (p) setPermissions(p); })
      .catch(() => {});
  }

  const login = useCallback(async (email: string, password: string) => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Login failed');
    }
    const data = await res.json();
    localStorage.setItem('token', data.token);
    localStorage.setItem('greeting_login_id', String(Date.now()));
    setToken(data.token);
    setUser(data.user);
  }, []);

  const loginWithGoogle = useCallback(async (token: string, tokenType: 'credential' | 'access_token' = 'credential') => {
    const body = tokenType === 'access_token'
      ? { access_token: token }
      : { credential: token };
    const res = await fetch('/api/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      // Handle verification needed (new Google user or pending_verification)
      if (data.needsVerification) {
        return { needsVerification: true, email: data.email };
      }
      throw new Error(data.error || 'Google login failed');
    }
    localStorage.setItem('token', data.token);
    localStorage.setItem('greeting_login_id', String(Date.now()));
    setToken(data.token);
    await fetchMe(data.token);
  }, []);

  const register = useCallback(async (email: string, password: string, displayName: string, inviteCode?: string) => {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, displayName, ...(inviteCode ? { inviteCode } : {}) }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Registration failed');
    }
    const data = await res.json();
    // Email verification flow
    if (data.needsVerification) {
      return { pending: false, needsVerification: true, email: data.email };
    }
    // Admin approval flow (fallback)
    if (data.pending) {
      return { pending: true, needsVerification: false, message: data.message };
    }
    // Fallback: if server returns token
    if (data.token) {
      localStorage.setItem('token', data.token);
      setToken(data.token);
      setUser(data.user);
    }
    return { pending: false, needsVerification: false };
  }, []);

  const verifyEmail = useCallback(async (email: string, code: string) => {
    const res = await fetch('/api/auth/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Verification failed');
    }
    const data = await res.json();
    localStorage.setItem('token', data.token);
    localStorage.setItem('greeting_login_id', String(Date.now()));
    setToken(data.token);
    setUser(data.user);
  }, []);

  const resendCode = useCallback(async (email: string) => {
    const res = await fetch('/api/auth/resend-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to resend code');
    }
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem('token');
    localStorage.removeItem('greeting_login_id');
    localStorage.removeItem('greeting_shown_for');
    setToken(null);
    setUser(null);
    // Send the user back to the login screen — otherwise the current page stays
    // mounted with the navbar gone (it returns null once user is null), leaving
    // them stranded on a deep page like /team/[id]/schedules after logging out.
    router.replace('/login');
  }, [router]);

  const updateUser = useCallback((partial: Partial<User>) => {
    setUser(prev => prev ? { ...prev, ...partial } : prev);
  }, []);

  return (
    <AuthContext.Provider value={{ user, token, isLoading, permissions, hasPermission, login, loginWithGoogle, register, verifyEmail, resendCode, logout, updateUser }}>
      {children}
      {showTermsModal && token && (
        <TermsModal token={token} onAccepted={() => setShowTermsModal(false)} />
      )}
    </AuthContext.Provider>
  );
}
