'use client';

import { useState, useEffect } from 'react';
import { useAdminAuth } from '../components/AdminAuthProvider';
import { useTranslation } from '../../../i18n';
import type { Locale, Theme } from '../../../i18n/types';

interface Settings {
  usageLimitUsd: number;
  storageQuotaGb: number;
  uploadQuotaMb: number;
}

const LOCALE_OPTIONS: { value: Locale; label: string }[] = [
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en', label: 'English' },
];

export default function AdminSettings() {
  return <AdminSettingsContent />;
}

function AdminSettingsContent() {
  const { token } = useAdminAuth();
  const { locale, theme, setLocale, setTheme, t } = useTranslation();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [form, setForm] = useState({ usageLimitUsd: '', storageQuotaGb: '', uploadQuotaMb: '' });
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [prefSaved, setPrefSaved] = useState(false);

  useEffect(() => {
    if (!token) return;
    fetch('/api/admin/settings', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then((data: Settings) => {
        setSettings(data);
        setForm({
          usageLimitUsd: String(data.usageLimitUsd),
          storageQuotaGb: String(data.storageQuotaGb),
          uploadQuotaMb: String(data.uploadQuotaMb),
        });
      })
      .catch(console.error);
  }, [token]);

  async function saveSetting(key: keyof Settings) {
    if (!token || saving) return;
    const val = parseFloat(form[key]);
    if (isNaN(val) || val < 0) return;

    setSaving(true);
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: val }),
      });
      if (res.ok) {
        const data = await res.json();
        setSettings({ usageLimitUsd: data.usageLimitUsd, storageQuotaGb: data.storageQuotaGb, uploadQuotaMb: data.uploadQuotaMb });
        setForm({
          usageLimitUsd: String(data.usageLimitUsd),
          storageQuotaGb: String(data.storageQuotaGb),
          uploadQuotaMb: String(data.uploadQuotaMb),
        });
        setEditing(null);
        setSaved(key);
        setTimeout(() => setSaved(null), 2000);
      }
    } catch { /* ignore */ }
    setSaving(false);
  }

  async function handleLocaleChange(newLocale: Locale) {
    await setLocale(newLocale);
    setPrefSaved(true);
    setTimeout(() => setPrefSaved(false), 2000);
  }

  async function handleThemeChange(newTheme: Theme) {
    await setTheme(newTheme);
    setPrefSaved(true);
    setTimeout(() => setPrefSaved(false), 2000);
  }

  const SETTINGS_CONFIG = [
    {
      key: 'usageLimitUsd' as const,
      icon: 'account_balance_wallet',
      iconColor: 'text-warning',
      title: t('admin.settings.usageLimit.title'),
      description: t('admin.settings.usageLimit.description'),
      unit: 'USD',
      prefix: '$',
      suffix: t('admin.settings.usageLimit.suffix'),
      min: 0,
      max: 100000,
      step: 1,
    },
    {
      key: 'storageQuotaGb' as const,
      icon: 'folder',
      iconColor: 'text-primary',
      title: t('admin.settings.storageQuota.title'),
      description: t('admin.settings.storageQuota.description'),
      unit: 'GB',
      prefix: '',
      suffix: t('admin.settings.storageQuota.suffix'),
      min: 0.1,
      max: 100,
      step: 0.1,
    },
    {
      key: 'uploadQuotaMb' as const,
      icon: 'cloud_upload',
      iconColor: 'text-tertiary',
      title: t('admin.settings.uploadQuota.title'),
      description: t('admin.settings.uploadQuota.description'),
      unit: 'MB',
      prefix: '',
      suffix: t('admin.settings.uploadQuota.suffix'),
      min: 10,
      max: 10000,
      step: 10,
    },
  ];

  return (
    <>
      {/* Header */}
      <header className="sticky top-0 h-16 bg-surface/80 backdrop-blur-xl flex justify-between items-center px-8 z-40 shadow-[0_1px_0_0_rgba(255,255,255,0.05)]">
        <div className="flex items-center gap-4">
          <span className="text-lg font-black text-on-surface font-headline">{t('admin.settings.title')}</span>
          <span className="text-sm text-on-surface-variant font-mono">{t('admin.settings.subtitle')}</span>
        </div>
      </header>

      {/* Content */}
      <div className="p-8 flex-1 space-y-6 flex flex-col">
        {/* Personal Preferences */}
        <div className="bg-surface-container rounded-lg overflow-hidden">
          <div className="p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-lg bg-surface-container-highest flex items-center justify-center shrink-0">
                <span className="material-symbols-outlined text-2xl text-primary">person</span>
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-headline font-bold text-on-surface">{t('admin.settings.preferences.title')}</h3>
                  {prefSaved && (
                    <span className="flex items-center gap-1 text-sm text-success font-bold">
                      <span className="material-symbols-outlined text-sm">check_circle</span>
                      {t('admin.settings.saved')}
                    </span>
                  )}
                </div>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Language */}
              <div>
                <label className="text-sm text-on-surface-variant mb-2 block">{t('admin.settings.preferences.language')}</label>
                <div className="flex gap-2">
                  {LOCALE_OPTIONS.map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => handleLocaleChange(opt.value)}
                      className={`flex-1 px-3 py-2 rounded border text-sm font-medium transition-all cursor-pointer ${
                        locale === opt.value
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-outline-variant/20 bg-surface-container-high text-on-surface-variant hover:border-primary/30'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
              {/* Theme */}
              <div>
                <label className="text-sm text-on-surface-variant mb-2 block">{t('admin.settings.preferences.theme')}</label>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleThemeChange('dark')}
                    className={`flex-1 px-3 py-2 rounded border text-sm font-medium transition-all cursor-pointer flex items-center justify-center gap-2 ${
                      theme === 'dark'
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-outline-variant/20 bg-surface-container-high text-on-surface-variant hover:border-primary/30'
                    }`}
                  >
                    <span className="material-symbols-outlined text-sm">dark_mode</span>
                    {t('admin.settings.preferences.themeDark')}
                  </button>
                  <button
                    onClick={() => handleThemeChange('light')}
                    className={`flex-1 px-3 py-2 rounded border text-sm font-medium transition-all cursor-pointer flex items-center justify-center gap-2 ${
                      theme === 'light'
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-outline-variant/20 bg-surface-container-high text-on-surface-variant hover:border-primary/30'
                    }`}
                  >
                    <span className="material-symbols-outlined text-sm">light_mode</span>
                    {t('admin.settings.preferences.themeLight')}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Usage Limit — full width */}
        {(() => {
          const cfg = SETTINGS_CONFIG[0];
          const isEditing0 = editing === cfg.key;
          const value = settings?.[cfg.key];
          const isSaved0 = saved === cfg.key;
          return (
            <div className="bg-surface-container rounded-lg overflow-hidden">
              <div className="p-6">
                <div className="flex items-start gap-4">
                  <div className="w-12 h-12 rounded-lg bg-surface-container-highest flex items-center justify-center shrink-0">
                    <span className={`material-symbols-outlined text-2xl ${cfg.iconColor}`}>{cfg.icon}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="text-base font-headline font-bold text-on-surface">{cfg.title}</h3>
                      {isSaved0 && (
                        <span className="flex items-center gap-1 text-sm text-success font-bold">
                          <span className="material-symbols-outlined text-sm">check_circle</span>
                          {t('admin.settings.saved')}
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-on-surface-variant leading-relaxed mb-4">{cfg.description}</p>
                    {isEditing0 ? (
                      <div className="flex items-center gap-3">
                        {cfg.prefix && <span className="text-on-surface-variant text-base font-bold">{cfg.prefix}</span>}
                        <input type="number" value={form[cfg.key]} onChange={e => setForm(prev => ({ ...prev, [cfg.key]: e.target.value }))} className="w-40 px-4 py-2.5 bg-surface-container-highest text-on-surface text-base rounded border border-outline-variant/20 focus:border-primary focus:outline-none font-mono" min={cfg.min} max={cfg.max} step={cfg.step} />
                        <span className="text-sm text-on-surface-variant">{cfg.unit}</span>
                        <button onClick={() => saveSetting(cfg.key)} disabled={saving} className="px-4 py-2.5 bg-primary text-on-primary text-sm font-bold rounded hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50">{saving ? t('admin.settings.saving') : t('admin.settings.save')}</button>
                        <button onClick={() => { setEditing(null); if (settings) setForm(prev => ({ ...prev, [cfg.key]: String(settings[cfg.key]) })); }} className="px-4 py-2.5 bg-surface-container-high text-on-surface-variant text-sm rounded hover:bg-surface-variant transition-colors cursor-pointer">{t('admin.settings.cancel')}</button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-3">
                        <span className="text-3xl font-headline font-black text-on-surface">{cfg.prefix}{value ?? '—'}</span>
                        <span className="text-sm text-on-surface-variant">{cfg.suffix}</span>
                        <button onClick={() => setEditing(cfg.key)} className="ml-4 px-4 py-2 bg-surface-container-high text-on-surface-variant text-sm rounded hover:bg-surface-variant transition-colors cursor-pointer flex items-center gap-1.5">
                          <span className="material-symbols-outlined text-sm">edit</span>
                          {t('admin.settings.edit')}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })()}

        {/* Storage + Upload — side by side */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {SETTINGS_CONFIG.slice(1).map(cfg => {
            const isEditingCfg = editing === cfg.key;
            const value = settings?.[cfg.key];
            const isSavedCfg = saved === cfg.key;
            return (
              <div key={cfg.key} className="bg-surface-container rounded-lg overflow-hidden">
                <div className="p-6">
                  <div className="flex items-start gap-4">
                    <div className="w-12 h-12 rounded-lg bg-surface-container-highest flex items-center justify-center shrink-0">
                      <span className={`material-symbols-outlined text-2xl ${cfg.iconColor}`}>{cfg.icon}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="text-base font-headline font-bold text-on-surface">{cfg.title}</h3>
                        {isSavedCfg && (
                          <span className="flex items-center gap-1 text-sm text-success font-bold">
                            <span className="material-symbols-outlined text-sm">check_circle</span>
                            {t('admin.settings.saved')}
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-on-surface-variant leading-relaxed mb-4">{cfg.description}</p>
                      {isEditingCfg ? (
                        <div className="flex items-center gap-3 flex-wrap">
                          {cfg.prefix && <span className="text-on-surface-variant text-base font-bold">{cfg.prefix}</span>}
                          <input type="number" value={form[cfg.key]} onChange={e => setForm(prev => ({ ...prev, [cfg.key]: e.target.value }))} className="w-32 px-4 py-2.5 bg-surface-container-highest text-on-surface text-base rounded border border-outline-variant/20 focus:border-primary focus:outline-none font-mono" min={cfg.min} max={cfg.max} step={cfg.step} />
                          <span className="text-sm text-on-surface-variant">{cfg.unit}</span>
                          <button onClick={() => saveSetting(cfg.key)} disabled={saving} className="px-4 py-2.5 bg-primary text-on-primary text-sm font-bold rounded hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50">{saving ? t('admin.settings.saving') : t('admin.settings.save')}</button>
                          <button onClick={() => { setEditing(null); if (settings) setForm(prev => ({ ...prev, [cfg.key]: String(settings[cfg.key]) })); }} className="px-4 py-2.5 bg-surface-container-high text-on-surface-variant text-sm rounded hover:bg-surface-variant transition-colors cursor-pointer">{t('admin.settings.cancel')}</button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-3">
                          <span className="text-3xl font-headline font-black text-on-surface">{cfg.prefix}{value ?? '—'}</span>
                          <span className="text-sm text-on-surface-variant">{cfg.suffix}</span>
                          <button onClick={() => setEditing(cfg.key)} className="ml-4 px-4 py-2 bg-surface-container-high text-on-surface-variant text-sm rounded hover:bg-surface-variant transition-colors cursor-pointer flex items-center gap-1.5">
                            <span className="material-symbols-outlined text-sm">edit</span>
                            {t('admin.settings.edit')}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Info Section — fixed at bottom */}
        <div className="mt-auto bg-surface-container-low border border-outline-variant/5 p-6 relative overflow-hidden">
          <div className="absolute right-4 bottom-4 opacity-[0.04] pointer-events-none">
            <span className="material-symbols-outlined text-[6rem]">info</span>
          </div>
          <div className="relative z-10">
            <h3 className="text-base font-headline font-bold text-on-surface mb-3">{t('admin.settings.info.title')}</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-surface-container p-4 border-l-2 border-warning">
                <h4 className="text-sm text-on-surface font-bold mb-1">{t('admin.settings.info.usageLimitTitle')}</h4>
                <p className="text-sm text-on-surface-variant">{t('admin.settings.info.usageLimitDesc')}</p>
              </div>
              <div className="bg-surface-container p-4 border-l-2 border-primary">
                <h4 className="text-sm text-on-surface font-bold mb-1">{t('admin.settings.info.storageTitle')}</h4>
                <p className="text-sm text-on-surface-variant">{t('admin.settings.info.storageDesc')}</p>
              </div>
              <div className="bg-surface-container p-4 border-l-2 border-tertiary">
                <h4 className="text-sm text-on-surface font-bold mb-1">{t('admin.settings.info.uploadTitle')}</h4>
                <p className="text-sm text-on-surface-variant">{t('admin.settings.info.uploadDesc')}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
