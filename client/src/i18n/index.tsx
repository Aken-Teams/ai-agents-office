'use client';

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from 'react';
import type { Locale, Theme, TranslationKey, TranslationDictionary } from './types';
import zhTW from './locales/zh-TW';

/* ---------- lazy-load translation dictionaries ---------- */
const dictionaries: Record<Locale, TranslationDictionary | (() => Promise<TranslationDictionary>)> = {
  'zh-TW': zhTW,
  'zh-CN': () => import('./locales/zh-CN').then(m => m.default as TranslationDictionary),
  en: () => import('./locales/en').then(m => m.default as TranslationDictionary),
};

// Cache loaded dictionaries
const loaded: Partial<Record<Locale, TranslationDictionary>> = { 'zh-TW': zhTW };

async function getDictionary(locale: Locale): Promise<TranslationDictionary> {
  if (loaded[locale]) return loaded[locale]!;
  const entry = dictionaries[locale];
  const dict = typeof entry === 'function' ? await entry() : entry;
  loaded[locale] = dict;
  return dict;
}

/* ---------- context ---------- */
interface I18nContextType {
  locale: Locale;
  theme: Theme;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  setLocale: (locale: Locale) => Promise<void>;
  setTheme: (theme: Theme) => Promise<void>;
}

const I18nContext = createContext<I18nContextType | null>(null);

// Fallback t() that returns zh-TW values (used when no provider is present)
const fallbackT = (key: TranslationKey, params?: Record<string, string | number>): string => {
  let text = (zhTW as TranslationDictionary)[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return text;
};

const fallbackCtx: I18nContextType = {
  locale: 'zh-TW',
  theme: 'dark',
  t: fallbackT,
  setLocale: async () => {},
  setTheme: async () => {},
};

export function useTranslation() {
  const ctx = useContext(I18nContext);
  return ctx ?? fallbackCtx;
}

/* ---------- helpers ---------- */
function applyThemeClass(theme: Theme) {
  const root = document.documentElement;
  root.classList.remove('dark', 'light');
  root.classList.add(theme);
}

function readLocalStorage<T extends string>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  return (localStorage.getItem(key) as T) || fallback;
}

/* ---------- provider ---------- */
interface I18nProviderProps {
  children: ReactNode;
  /** Initial locale from user profile (or undefined for unauthenticated pages). */
  initialLocale?: Locale;
  /** Initial theme from user profile (or undefined for unauthenticated pages). */
  initialTheme?: Theme;
}

export function I18nProvider({ children, initialLocale, initialTheme }: I18nProviderProps) {
  const [locale, setLocaleState] = useState<Locale>(
    initialLocale || readLocalStorage('locale', 'zh-TW' as Locale),
  );
  const [theme, setThemeState] = useState<Theme>(
    initialTheme || readLocalStorage('theme', 'dark' as Theme),
  );
  const [dict, setDict] = useState<TranslationDictionary>(zhTW);

  // Load dictionary when locale changes
  useEffect(() => {
    getDictionary(locale).then(setDict);
  }, [locale]);

  // Apply theme class on mount and when theme changes
  useEffect(() => {
    applyThemeClass(theme);
  }, [theme]);

  // Sync when user profile loads (initialLocale/initialTheme may arrive after mount)
  useEffect(() => {
    if (initialLocale && initialLocale !== locale) {
      setLocaleState(initialLocale);
      localStorage.setItem('locale', initialLocale);
    }
    if (initialTheme && initialTheme !== theme) {
      setThemeState(initialTheme);
      localStorage.setItem('theme', initialTheme);
      applyThemeClass(initialTheme);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialLocale, initialTheme]);

  // Translation function with interpolation
  const t = useCallback(
    (key: TranslationKey, params?: Record<string, string | number>): string => {
      let text = dict[key] ?? (zhTW as TranslationDictionary)[key] ?? key;
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
        }
      }
      return text;
    },
    [dict],
  );

  // Set locale — persist to server (if logged in) + localStorage
  const setLocale = useCallback(async (newLocale: Locale) => {
    setLocaleState(newLocale);
    localStorage.setItem('locale', newLocale);
    // Try to persist to server (ignore errors for unauthenticated pages)
    const token = localStorage.getItem('token');
    if (token) {
      try {
        await fetch('/api/auth/preferences', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ locale: newLocale }),
        });
      } catch { /* ignore */ }
    }
  }, []);

  // Set theme — persist + apply DOM class
  const setTheme = useCallback(async (newTheme: Theme) => {
    setThemeState(newTheme);
    localStorage.setItem('theme', newTheme);
    applyThemeClass(newTheme);
    const token = localStorage.getItem('token');
    if (token) {
      try {
        await fetch('/api/auth/preferences', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ theme: newTheme }),
        });
      } catch { /* ignore */ }
    }
  }, []);

  return (
    <I18nContext.Provider value={{ locale, theme, t, setLocale, setTheme }}>
      {children}
    </I18nContext.Provider>
  );
}
