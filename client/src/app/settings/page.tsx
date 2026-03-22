'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { AuthProvider, useAuth } from '../components/AuthProvider';
import Navbar from '../components/Navbar';
import { I18nProvider, useTranslation } from '../../i18n';
import { useSidebarMargin } from '../hooks/useSidebarCollapsed';
import type { Locale, Theme } from '../../i18n/types';

const LOCALE_OPTIONS: { value: Locale; label: string }[] = [
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en', label: 'English' },
];

function SettingsContent() {
  const { user, token, isLoading } = useAuth();
  const { locale, theme, setLocale, setTheme, t } = useTranslation();
  const router = useRouter();
  const marginStyle = useSidebarMargin();
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [isLoading, user, router]);

  if (isLoading || !user) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center">
        <div className="text-on-surface-variant">{t('common.loading')}</div>
      </div>
    );
  }

  async function handleLocaleChange(newLocale: Locale) {
    await setLocale(newLocale);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function handleThemeChange(newTheme: Theme) {
    await setTheme(newTheme);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="min-h-screen bg-surface bg-pattern">
      <Navbar />
      <main className={`${marginStyle} transition-all duration-300 p-8`}>
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-headline font-bold text-on-surface">{t('settings.title')}</h1>
          <p className="text-on-surface-variant mt-1">{t('settings.subtitle')}</p>
        </div>

        <div className="max-w-2xl space-y-6">
          {/* Language Selection */}
          <div className="bg-surface-container border border-outline-variant/10 rounded-lg p-6">
            <div className="flex items-center gap-3 mb-4">
              <span className="material-symbols-outlined text-primary">language</span>
              <div>
                <h2 className="text-sm font-bold text-on-surface">{t('settings.language.title')}</h2>
                <p className="text-sm text-on-surface-variant">{t('settings.language.description')}</p>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              {LOCALE_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => handleLocaleChange(opt.value)}
                  className={`p-3 rounded-lg border text-sm font-medium transition-all cursor-pointer ${
                    locale === opt.value
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-outline-variant/20 bg-surface-container-high text-on-surface-variant hover:border-primary/30 hover:text-on-surface'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Theme Selection */}
          <div className="bg-surface-container border border-outline-variant/10 rounded-lg p-6">
            <div className="flex items-center gap-3 mb-4">
              <span className="material-symbols-outlined text-primary">palette</span>
              <div>
                <h2 className="text-sm font-bold text-on-surface">{t('settings.theme.title')}</h2>
                <p className="text-sm text-on-surface-variant">{t('settings.theme.description')}</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => handleThemeChange('dark')}
                className={`p-4 rounded-lg border text-sm font-medium transition-all cursor-pointer flex items-center gap-3 ${
                  theme === 'dark'
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-outline-variant/20 bg-surface-container-high text-on-surface-variant hover:border-primary/30 hover:text-on-surface'
                }`}
              >
                <span className="material-symbols-outlined">dark_mode</span>
                {t('settings.theme.dark')}
              </button>
              <button
                onClick={() => handleThemeChange('light')}
                className={`p-4 rounded-lg border text-sm font-medium transition-all cursor-pointer flex items-center gap-3 ${
                  theme === 'light'
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-outline-variant/20 bg-surface-container-high text-on-surface-variant hover:border-primary/30 hover:text-on-surface'
                }`}
              >
                <span className="material-symbols-outlined">light_mode</span>
                {t('settings.theme.light')}
              </button>
            </div>
          </div>
        </div>

        {/* Saved toast */}
        {saved && (
          <div className="fixed bottom-6 right-6 bg-success text-white px-4 py-2 rounded-lg text-sm font-medium animate-in">
            {t('settings.saved')}
          </div>
        )}
      </main>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <AuthProvider>
      <SettingsPageWithI18n />
    </AuthProvider>
  );
}

function SettingsPageWithI18n() {
  const { user } = useAuth();
  return (
    <I18nProvider
      initialLocale={user?.locale}
      initialTheme={user?.theme}
    >
      <SettingsContent />
    </I18nProvider>
  );
}
