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

/**
 * Thrown only when the server itself says the token is invalid (401) or the
 * account is blocked (403). Every other failure — network error, 502/503 while
 * the backend restarts, an upstream AI provider taking a route down — is
 * transient and must NOT clear the session.
 */
class AuthTokenError extends Error {
  constructor() { super('Invalid token'); this.name = 'AuthTokenError'; }
}

// Backoff for retrying /api/auth/me after a transient failure (~30s total).
const ME_RETRY_DELAYS = [1000, 2000, 4000, 8000, 15000];

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

  // Check stored token on mount.
  //
  // A backend hiccup is NOT an invalid token. Previously any failure here (5xx,
  // a restart, an upstream like DeepSeek dragging the server down) deleted the
  // stored JWT and logged everyone out — an unrelated subsystem could kick the
  // whole platform to the login screen. Now only an explicit 401/403 from the
  // server clears the token; transient failures keep the session and retry.
  useEffect(() => {
    const storedToken = localStorage.getItem('token');
    if (!storedToken) { setIsLoading(false); return; }
    setToken(storedToken);

    let cancelled = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let gaveUp = false;

    const attemptFetch = () => {
      if (cancelled) return;
      fetchMe(storedToken).catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof AuthTokenError) {
          // The server explicitly rejected the token (expired / suspended).
          localStorage.removeItem('token');
          setToken(null);
          setIsLoading(false);
          return;
        }
        // Transient: server down, 5xx, timeout. Keep the token, back off, retry.
        attempt++;
        if (attempt > ME_RETRY_DELAYS.length) {
          // Stop blocking the UI, but keep the token — a reload (or the
          // online/visible listeners below) restores the session once the
          // backend is healthy again, with no re-login.
          gaveUp = true;
          setIsLoading(false);
          return;
        }
        timer = setTimeout(attemptFetch, ME_RETRY_DELAYS[attempt - 1]);
      });
    };
    attemptFetch();

    // Self-heal: when the tab comes back online / into view after we gave up,
    // try once more instead of leaving the user stranded on a dead session.
    const revive = () => {
      if (cancelled || !gaveUp) return;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      gaveUp = false;
      attempt = 0;
      setIsLoading(true);
      attemptFetch();
    };
    window.addEventListener('online', revive);
    document.addEventListener('visibilitychange', revive);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener('online', revive);
      document.removeEventListener('visibilitychange', revive);
    };
  }, []);

  async function fetchMe(t: string) {
    let res: Response;
    try {
      res = await fetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${t}` },
      });
    } catch {
      throw new Error('auth/me unreachable'); // network error → transient
    }
    // Only these mean "this token is no longer valid".
    if (res.status === 401 || res.status === 403) throw new AuthTokenError();
    if (!res.ok) throw new Error(`auth/me failed: ${res.status}`); // 5xx → transient
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
