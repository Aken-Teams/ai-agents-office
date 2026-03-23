'use client';

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';

interface User {
  id: string;
  email: string;
  displayName: string | null;
  role?: string;
  locale?: 'zh-TW' | 'zh-CN' | 'en';
  theme?: 'dark' | 'light';
  oauthProvider?: string | null;
  hasPassword?: boolean;
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  loginWithGoogle: (token: string, tokenType?: 'credential' | 'access_token') => Promise<void>;
  register: (email: string, password: string, displayName: string) => Promise<{ pending: boolean; message?: string }>;
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
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Google login failed');
    }
    const data = await res.json();
    localStorage.setItem('token', data.token);
    setToken(data.token);
    // Fetch full user profile (including oauthProvider, hasPassword, locale, theme)
    await fetchMe(data.token);
  }, []);

  const register = useCallback(async (email: string, password: string, displayName: string) => {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, displayName }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Registration failed');
    }
    const data = await res.json();
    // New flow: registration returns pending status, no auto-login
    if (data.pending) {
      return { pending: true, message: data.message };
    }
    // Fallback: if server returns token (e.g. admin-created accounts)
    if (data.token) {
      localStorage.setItem('token', data.token);
      setToken(data.token);
      setUser(data.user);
    }
    return { pending: false };
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem('token');
    setToken(null);
    setUser(null);
  }, []);

  const updateUser = useCallback((partial: Partial<User>) => {
    setUser(prev => prev ? { ...prev, ...partial } : prev);
  }, []);

  return (
    <AuthContext.Provider value={{ user, token, isLoading, login, loginWithGoogle, register, logout, updateUser }}>
      {children}
    </AuthContext.Provider>
  );
}
