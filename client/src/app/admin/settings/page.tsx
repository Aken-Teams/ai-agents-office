'use client';

import { useState, useEffect } from 'react';
import { useAdminAuth } from '../components/AdminAuthProvider';
import { useTranslation } from '../../../i18n';
import type { Locale, Theme } from '../../../i18n/types';

interface Settings {
  usageLimitUsd: number;
  storageQuotaGb: number;
  uploadQuotaMb: number;
  watermark?: { enabled: boolean; text: string };
  addinInstaller?: AddinInstaller;
}

interface AddinInstaller {
  enabled: boolean;
  mode: 'url' | 'file';
  url: string;
  file: { name: string; size: number; uploadedAt: string } | null;
  version: string;
  note: string;
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
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
  const { token, isReadonly, canOperate } = useAdminAuth();
  const canEditSettings = canOperate('settings');
  const { locale, theme, setLocale, setTheme, t } = useTranslation();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [form, setForm] = useState({ usageLimitUsd: '', storageQuotaGb: '', uploadQuotaMb: '' });
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [prefSaved, setPrefSaved] = useState(false);
  const [wmForm, setWmForm] = useState<{ enabled: boolean; text: string }>({ enabled: false, text: '' });
  const [wmSaving, setWmSaving] = useState(false);
  const [wmSaved, setWmSaved] = useState(false);
  const [addinForm, setAddinForm] = useState<AddinInstaller>({ enabled: false, mode: 'url', url: '', file: null, version: '', note: '' });
  const [addinUploading, setAddinUploading] = useState(false);
  const [addinSaving, setAddinSaving] = useState(false);
  const [addinSaved, setAddinSaved] = useState(false);
  const [addinError, setAddinError] = useState<string | null>(null);

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
        if (data.watermark) setWmForm(data.watermark);
        if (data.addinInstaller) setAddinForm(data.addinInstaller);
      })
      .catch(console.error);
  }, [token]);

  async function saveWatermark(next: { enabled: boolean; text: string }) {
    if (!token || wmSaving) return;
    setWmSaving(true);
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ watermark: next }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.watermark) setWmForm(data.watermark);
        setWmSaved(true);
        setTimeout(() => setWmSaved(false), 2000);
      }
    } catch { /* ignore */ }
    setWmSaving(false);
  }

  async function saveAddin(next: AddinInstaller) {
    if (!token || addinSaving) return;
    setAddinSaving(true);
    setAddinError(null);
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ addinInstaller: next }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.addinInstaller) setAddinForm(data.addinInstaller);
        // The server drops a URL it will not serve and switches the toggle off
        // with it. Saying "saved" to that would leave the admin believing the
        // download is live, so the mismatch is reported instead.
        if (next.url.trim() && !data.addinInstaller?.url) {
          setAddinError('網址格式不對，必須是 http:// 或 https:// 開頭的完整網址。');
        } else {
          setAddinSaved(true);
          setTimeout(() => setAddinSaved(false), 2000);
        }
      }
    } catch { /* ignore */ }
    setAddinSaving(false);
  }

  async function uploadInstaller(file: File) {
    if (!token || addinUploading) return;
    setAddinUploading(true);
    setAddinError(null);
    try {
      const body = new FormData();
      body.append('file', file);
      const res = await fetch('/api/admin/settings/addin-installer', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body,
      });
      // Read as text first: a rejected upload can come back as an HTML error
      // page from the body-size layer, and res.json() on that throws something
      // that says nothing about what actually happened.
      const raw = await res.text();
      let data: any = null;
      try { data = JSON.parse(raw); } catch { /* not json */ }
      if (res.ok && data?.addinInstaller) {
        setAddinForm(data.addinInstaller);
        setAddinSaved(true);
        setTimeout(() => setAddinSaved(false), 2000);
      } else {
        setAddinError(data?.error || `上傳失敗（${res.status}）。檔案可能太大，或被伺服器前面的代理擋下。`);
      }
    } catch {
      setAddinError('上傳失敗，請確認檔案大小與網路連線。');
    }
    setAddinUploading(false);
  }

  async function removeInstaller() {
    if (!token || addinUploading) return;
    setAddinUploading(true);
    setAddinError(null);
    try {
      const res = await fetch('/api/admin/settings/addin-installer', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        if (data.addinInstaller) setAddinForm(data.addinInstaller);
      }
    } catch { /* ignore */ }
    setAddinUploading(false);
  }

  async function saveSetting(key: 'usageLimitUsd' | 'storageQuotaGb' | 'uploadQuotaMb') {
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
      <header className="sticky top-0 h-14 md:h-16 bg-surface/80 backdrop-blur-xl flex justify-between items-center px-4 md:px-8 z-40 shadow-[0_1px_0_0_rgba(255,255,255,0.05)]">
        <div className="flex items-center gap-2 md:gap-4">
          <span className="text-base md:text-lg font-black text-on-surface font-headline shrink-0">{t('admin.settings.title')}</span>
          <span className="text-xs md:text-sm text-on-surface-variant font-mono truncate">{t('admin.settings.subtitle')}</span>
        </div>
      </header>

      {/* Content */}
      <div className="p-4 md:p-8 flex-1 space-y-4 md:space-y-6 flex flex-col">
        {/* Personal Preferences */}
        <div className="bg-surface-container rounded-lg overflow-hidden">
          <div className="p-4 md:p-6">
            <div className="flex items-center gap-3 mb-3 md:mb-4">
              <div className="w-10 h-10 md:w-12 md:h-12 rounded-lg bg-surface-container-highest flex items-center justify-center shrink-0">
                <span className="material-symbols-outlined text-xl md:text-2xl text-primary">person</span>
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm md:text-base font-headline font-bold text-on-surface">{t('admin.settings.preferences.title')}</h3>
                  {prefSaved && (
                    <span className="flex items-center gap-1 text-xs md:text-sm text-success font-bold">
                      <span className="material-symbols-outlined text-xs md:text-sm">check_circle</span>
                      {t('admin.settings.saved')}
                    </span>
                  )}
                </div>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6">
              {/* Language */}
              <div>
                <label className="text-xs md:text-sm text-on-surface-variant mb-1.5 md:mb-2 block">{t('admin.settings.preferences.language')}</label>
                <div className="flex gap-1.5 md:gap-2">
                  {LOCALE_OPTIONS.map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => handleLocaleChange(opt.value)}
                      className={`flex-1 px-2 md:px-3 py-1.5 md:py-2 rounded border text-xs md:text-sm font-medium transition-all cursor-pointer ${
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
                <label className="text-xs md:text-sm text-on-surface-variant mb-1.5 md:mb-2 block">{t('admin.settings.preferences.theme')}</label>
                <div className="flex gap-1.5 md:gap-2">
                  <button
                    onClick={() => handleThemeChange('dark')}
                    className={`flex-1 px-2 md:px-3 py-1.5 md:py-2 rounded border text-xs md:text-sm font-medium transition-all cursor-pointer flex items-center justify-center gap-1.5 md:gap-2 ${
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
                    className={`flex-1 px-2 md:px-3 py-1.5 md:py-2 rounded border text-xs md:text-sm font-medium transition-all cursor-pointer flex items-center justify-center gap-1.5 md:gap-2 ${
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
              <div className="p-4 md:p-6">
                <div className="flex items-start gap-3 md:gap-4">
                  <div className="w-10 h-10 md:w-12 md:h-12 rounded-lg bg-surface-container-highest flex items-center justify-center shrink-0">
                    <span className={`material-symbols-outlined text-xl md:text-2xl ${cfg.iconColor}`}>{cfg.icon}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="text-sm md:text-base font-headline font-bold text-on-surface">{cfg.title}</h3>
                      {isSaved0 && (
                        <span className="flex items-center gap-1 text-xs md:text-sm text-success font-bold">
                          <span className="material-symbols-outlined text-xs md:text-sm">check_circle</span>
                          {t('admin.settings.saved')}
                        </span>
                      )}
                    </div>
                    <p className="text-xs md:text-sm text-on-surface-variant leading-relaxed mb-3 md:mb-4">{cfg.description}</p>
                    {isEditing0 ? (
                      <div className="space-y-2 md:space-y-0 md:flex md:items-center md:gap-3">
                        <div className="flex items-center gap-2 md:gap-3">
                          {cfg.prefix && <span className="text-on-surface-variant text-sm md:text-base font-bold">{cfg.prefix}</span>}
                          <input type="number" value={form[cfg.key]} onChange={e => setForm(prev => ({ ...prev, [cfg.key]: e.target.value }))} className="w-28 md:w-40 px-3 md:px-4 py-2 md:py-2.5 bg-surface-container-highest text-on-surface text-sm md:text-base rounded border border-outline-variant/20 focus:border-primary focus:outline-none font-mono" min={cfg.min} max={cfg.max} step={cfg.step} />
                          <span className="text-xs md:text-sm text-on-surface-variant">{cfg.unit}</span>
                        </div>
                        <div className="flex items-center gap-2 justify-end md:justify-start">
                          <button onClick={() => saveSetting(cfg.key)} disabled={saving} className="px-3 md:px-4 py-2 md:py-2.5 bg-primary text-on-primary text-xs md:text-sm font-bold rounded hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50">{saving ? t('admin.settings.saving') : t('admin.settings.save')}</button>
                          <button onClick={() => { setEditing(null); if (settings) setForm(prev => ({ ...prev, [cfg.key]: String(settings[cfg.key]) })); }} className="px-3 md:px-4 py-2 md:py-2.5 bg-surface-container-high text-on-surface-variant text-xs md:text-sm rounded hover:bg-surface-variant transition-colors cursor-pointer">{t('admin.settings.cancel')}</button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 md:gap-3">
                        <span className="text-2xl md:text-3xl font-headline font-black text-on-surface">{cfg.prefix}{value ?? '—'}</span>
                        <span className="text-xs md:text-sm text-on-surface-variant">{cfg.suffix}</span>
                        {canEditSettings && <button onClick={() => setEditing(cfg.key)} className="ml-2 md:ml-4 px-3 md:px-4 py-1.5 md:py-2 bg-surface-container-high text-on-surface-variant text-xs md:text-sm rounded hover:bg-surface-variant transition-colors cursor-pointer flex items-center gap-1.5">
                          <span className="material-symbols-outlined text-xs md:text-sm">edit</span>
                          {t('admin.settings.edit')}
                        </button>}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })()}

        {/* Storage + Upload — side by side */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6">
          {SETTINGS_CONFIG.slice(1).map(cfg => {
            const isEditingCfg = editing === cfg.key;
            const value = settings?.[cfg.key];
            const isSavedCfg = saved === cfg.key;
            return (
              <div key={cfg.key} className="bg-surface-container rounded-lg overflow-hidden">
                <div className="p-4 md:p-6">
                  <div className="flex items-start gap-3 md:gap-4">
                    <div className="w-10 h-10 md:w-12 md:h-12 rounded-lg bg-surface-container-highest flex items-center justify-center shrink-0">
                      <span className={`material-symbols-outlined text-xl md:text-2xl ${cfg.iconColor}`}>{cfg.icon}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="text-sm md:text-base font-headline font-bold text-on-surface">{cfg.title}</h3>
                        {isSavedCfg && (
                          <span className="flex items-center gap-1 text-xs md:text-sm text-success font-bold">
                            <span className="material-symbols-outlined text-xs md:text-sm">check_circle</span>
                            {t('admin.settings.saved')}
                          </span>
                        )}
                      </div>
                      <p className="text-xs md:text-sm text-on-surface-variant leading-relaxed mb-3 md:mb-4">{cfg.description}</p>
                      {isEditingCfg ? (
                        <div className="space-y-2 md:space-y-0 md:flex md:items-center md:gap-3">
                          <div className="flex items-center gap-2 md:gap-3">
                            {cfg.prefix && <span className="text-on-surface-variant text-sm md:text-base font-bold">{cfg.prefix}</span>}
                            <input type="number" value={form[cfg.key]} onChange={e => setForm(prev => ({ ...prev, [cfg.key]: e.target.value }))} className="w-24 md:w-32 px-3 md:px-4 py-2 md:py-2.5 bg-surface-container-highest text-on-surface text-sm md:text-base rounded border border-outline-variant/20 focus:border-primary focus:outline-none font-mono" min={cfg.min} max={cfg.max} step={cfg.step} />
                            <span className="text-xs md:text-sm text-on-surface-variant">{cfg.unit}</span>
                          </div>
                          <div className="flex items-center gap-2 justify-end md:justify-start">
                            <button onClick={() => saveSetting(cfg.key)} disabled={saving} className="px-3 md:px-4 py-2 md:py-2.5 bg-primary text-on-primary text-xs md:text-sm font-bold rounded hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50">{saving ? t('admin.settings.saving') : t('admin.settings.save')}</button>
                            <button onClick={() => { setEditing(null); if (settings) setForm(prev => ({ ...prev, [cfg.key]: String(settings[cfg.key]) })); }} className="px-3 md:px-4 py-2 md:py-2.5 bg-surface-container-high text-on-surface-variant text-xs md:text-sm rounded hover:bg-surface-variant transition-colors cursor-pointer">{t('admin.settings.cancel')}</button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 md:gap-3">
                          <span className="text-2xl md:text-3xl font-headline font-black text-on-surface">{cfg.prefix}{value ?? '—'}</span>
                          <span className="text-xs md:text-sm text-on-surface-variant">{cfg.suffix}</span>
                          {canEditSettings && <button onClick={() => setEditing(cfg.key)} className="ml-2 md:ml-4 px-3 md:px-4 py-1.5 md:py-2 bg-surface-container-high text-on-surface-variant text-xs md:text-sm rounded hover:bg-surface-variant transition-colors cursor-pointer flex items-center gap-1.5">
                            <span className="material-symbols-outlined text-xs md:text-sm">edit</span>
                            {t('admin.settings.edit')}
                          </button>}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Watermark */}
        <div className="bg-surface-container rounded-lg overflow-hidden">
          <div className="p-4 md:p-6">
            <div className="flex items-start gap-3 md:gap-4">
              <div className="w-10 h-10 md:w-12 md:h-12 rounded-lg bg-surface-container-highest flex items-center justify-center shrink-0">
                <span className="material-symbols-outlined text-xl md:text-2xl text-secondary">branding_watermark</span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="text-sm md:text-base font-headline font-bold text-on-surface">浮水印</h3>
                  {wmSaved && (
                    <span className="flex items-center gap-1 text-xs md:text-sm text-success font-bold">
                      <span className="material-symbols-outlined text-xs md:text-sm">check_circle</span>
                      {t('admin.settings.saved')}
                    </span>
                  )}
                </div>
                <p className="text-xs md:text-sm text-on-surface-variant leading-relaxed mb-3 md:mb-4">
                  開啟後，使用者下載或預覽生成的檔案（PDF / Word / PPT / Excel / HTML）時，會疊上斜向平鋪的浮水印文字。原始檔案不受影響，僅在輸出時加上。
                </p>
                <div className="flex flex-col gap-3 md:flex-row md:items-center">
                  <button
                    type="button"
                    disabled={!canEditSettings}
                    onClick={() => setWmForm(prev => ({ ...prev, enabled: !prev.enabled }))}
                    className={`relative w-11 h-6 rounded-full transition-colors shrink-0 cursor-pointer disabled:opacity-50 ${wmForm.enabled ? 'bg-primary' : 'bg-outline-variant/40'}`}
                  >
                    <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${wmForm.enabled ? 'translate-x-5' : ''}`} />
                  </button>
                  <span className="text-sm text-on-surface-variant w-10 shrink-0">{wmForm.enabled ? '啟用' : '停用'}</span>
                  <input
                    type="text"
                    value={wmForm.text}
                    disabled={!canEditSettings || !wmForm.enabled}
                    maxLength={120}
                    onChange={e => setWmForm(prev => ({ ...prev, text: e.target.value }))}
                    placeholder="浮水印文字，例如：機密文件 · 草稿"
                    className="flex-1 min-w-0 px-3 md:px-4 py-2 md:py-2.5 bg-surface-container-highest text-on-surface text-sm md:text-base rounded border border-outline-variant/20 focus:border-primary focus:outline-none disabled:opacity-50"
                  />
                  {canEditSettings && (
                    <button onClick={() => saveWatermark(wmForm)} disabled={wmSaving} className="px-3 md:px-4 py-2 md:py-2.5 bg-primary text-on-primary text-xs md:text-sm font-bold rounded hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50 shrink-0">
                      {wmSaving ? t('admin.settings.saving') : t('admin.settings.save')}
                    </button>
                  )}
                </div>
                <p className="text-[11px] text-on-surface-variant/60 mt-2">註：PDF 因內建字型限制只會顯示英數字部分；Word / PPT / Excel / HTML 可正常顯示中文。</p>
              </div>
            </div>
          </div>
        </div>

        {/* Office add-in installer */}
        <div className="bg-surface-container rounded-lg overflow-hidden">
          <div className="p-4 md:p-6">
            <div className="flex items-start gap-3 md:gap-4">
              <div className="w-10 h-10 md:w-12 md:h-12 rounded-lg bg-surface-container-highest flex items-center justify-center shrink-0">
                <span className="material-symbols-outlined text-xl md:text-2xl text-primary">download_for_offline</span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="text-sm md:text-base font-headline font-bold text-on-surface">Office 增益集安裝檔</h3>
                  {addinSaved && (
                    <span className="flex items-center gap-1 text-xs md:text-sm text-success font-bold">
                      <span className="material-symbols-outlined text-xs md:text-sm">check_circle</span>
                      {t('admin.settings.saved')}
                    </span>
                  )}
                </div>
                <p className="text-xs md:text-sm text-on-surface-variant leading-relaxed mb-3 md:mb-4">
                  開啟後，使用者的儀表板會出現下載入口。安裝檔放在你自己的檔案伺服器上，這裡只存網址——簽章與防毒信任由出檔的人負責，系統不另存一份。
                </p>

                <div className="flex flex-col gap-3">
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      disabled={!canEditSettings}
                      onClick={() => setAddinForm(prev => ({ ...prev, enabled: !prev.enabled }))}
                      className={`relative w-11 h-6 rounded-full transition-colors shrink-0 cursor-pointer disabled:opacity-50 ${addinForm.enabled ? 'bg-primary' : 'bg-outline-variant/40'}`}
                    >
                      <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${addinForm.enabled ? 'translate-x-5' : ''}`} />
                    </button>
                    <span className="text-sm text-on-surface-variant">{addinForm.enabled ? '前台顯示' : '前台隱藏'}</span>
                  </div>

                  {/* Source: someone else's file server, or this one. */}
                  <div className="flex gap-2">
                    {([
                      { key: 'url' as const, icon: 'link', label: '用網址', hint: 'IT 已經有地方放檔案' },
                      { key: 'file' as const, icon: 'upload_file', label: '上傳檔案', hint: '沒有檔案伺服器時用這個' },
                    ]).map(opt => (
                      <button
                        key={opt.key}
                        type="button"
                        disabled={!canEditSettings}
                        onClick={() => { setAddinForm(prev => ({ ...prev, mode: opt.key })); setAddinError(null); }}
                        className={`flex-1 flex items-start gap-2 px-3 py-2.5 rounded border text-left transition-colors cursor-pointer disabled:opacity-50 ${
                          addinForm.mode === opt.key
                            ? 'border-primary bg-primary/5'
                            : 'border-outline-variant/20 bg-surface-container-highest hover:border-outline-variant/40'
                        }`}
                      >
                        <span className={`material-symbols-outlined text-lg shrink-0 ${addinForm.mode === opt.key ? 'text-primary' : 'text-on-surface-variant'}`}>{opt.icon}</span>
                        <span className="min-w-0">
                          <span className={`block text-sm font-bold ${addinForm.mode === opt.key ? 'text-primary' : 'text-on-surface'}`}>{opt.label}</span>
                          <span className="block text-[11px] text-on-surface-variant mt-0.5">{opt.hint}</span>
                        </span>
                      </button>
                    ))}
                  </div>

                  {addinForm.mode === 'url' ? (
                    <label className="block">
                      <span className="block text-xs font-bold text-on-surface-variant mb-1">下載網址</span>
                      <input
                        type="url"
                        value={addinForm.url}
                        disabled={!canEditSettings}
                        maxLength={2048}
                        onChange={e => { setAddinForm(prev => ({ ...prev, url: e.target.value })); setAddinError(null); }}
                        placeholder="https://files.example.com/addin/JVision-Setup.exe"
                        className="w-full px-3 md:px-4 py-2 md:py-2.5 bg-surface-container-highest text-on-surface text-sm md:text-base rounded border border-outline-variant/20 focus:border-primary focus:outline-none disabled:opacity-50"
                      />
                    </label>
                  ) : (
                    <div>
                      <span className="block text-xs font-bold text-on-surface-variant mb-1">安裝檔</span>
                      {addinForm.file ? (
                        <div className="flex items-center gap-3 px-3 py-2.5 bg-surface-container-highest rounded border border-outline-variant/20">
                          <span className="material-symbols-outlined text-xl text-primary shrink-0">deployed_code</span>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm text-on-surface font-bold truncate">{addinForm.file.name}</p>
                            <p className="text-[11px] text-on-surface-variant mt-0.5">
                              {formatBytes(addinForm.file.size)}
                              {addinForm.file.uploadedAt && ` · 上傳於 ${new Date(addinForm.file.uploadedAt).toLocaleString('zh-TW')}`}
                            </p>
                          </div>
                          {canEditSettings && (
                            <button
                              onClick={removeInstaller}
                              disabled={addinUploading}
                              className="text-xs text-error hover:underline cursor-pointer disabled:opacity-50 shrink-0"
                            >
                              移除
                            </button>
                          )}
                        </div>
                      ) : (
                        <label className={`flex items-center justify-center gap-2 px-3 py-5 rounded border border-dashed border-outline-variant/40 text-sm text-on-surface-variant ${canEditSettings && !addinUploading ? 'cursor-pointer hover:border-primary hover:text-primary' : 'opacity-50'}`}>
                          <span className="material-symbols-outlined text-xl">{addinUploading ? 'hourglass_top' : 'upload'}</span>
                          {addinUploading ? '上傳中，大檔案需要一點時間…' : '選擇安裝檔（.exe / .msi / .zip）'}
                          <input
                            type="file"
                            accept=".exe,.msi,.zip"
                            disabled={!canEditSettings || addinUploading}
                            className="hidden"
                            onChange={e => {
                              const f = e.target.files?.[0];
                              // Reset the input so picking the same file twice
                              // still fires a change event after a failure.
                              e.target.value = '';
                              if (f) uploadInstaller(f);
                            }}
                          />
                        </label>
                      )}
                      <p className="text-[11px] text-on-surface-variant/60 mt-1.5">
                        檔案存在這台伺服器上，使用者要登入才下載得到。上限 200MB。換版時重新上傳即可，不用改網址。
                      </p>
                    </div>
                  )}

                  <div className="flex flex-col gap-3 md:flex-row">
                    <label className="block md:w-40 shrink-0">
                      <span className="block text-xs font-bold text-on-surface-variant mb-1">版本（選填）</span>
                      <input
                        type="text"
                        value={addinForm.version}
                        disabled={!canEditSettings}
                        maxLength={40}
                        onChange={e => setAddinForm(prev => ({ ...prev, version: e.target.value }))}
                        placeholder="v1.4.2"
                        className="w-full px-3 md:px-4 py-2 md:py-2.5 bg-surface-container-highest text-on-surface text-sm md:text-base rounded border border-outline-variant/20 focus:border-primary focus:outline-none disabled:opacity-50"
                      />
                    </label>
                    <label className="block flex-1 min-w-0">
                      <span className="block text-xs font-bold text-on-surface-variant mb-1">說明（選填）</span>
                      <input
                        type="text"
                        value={addinForm.note}
                        disabled={!canEditSettings}
                        maxLength={200}
                        onChange={e => setAddinForm(prev => ({ ...prev, note: e.target.value }))}
                        placeholder="支援 Word / Excel / PowerPoint，安裝前請先關閉 Office"
                        className="w-full px-3 md:px-4 py-2 md:py-2.5 bg-surface-container-highest text-on-surface text-sm md:text-base rounded border border-outline-variant/20 focus:border-primary focus:outline-none disabled:opacity-50"
                      />
                    </label>
                  </div>

                  {addinError && (
                    <p className="flex items-center gap-1.5 text-xs md:text-sm text-error">
                      <span className="material-symbols-outlined text-sm">error</span>
                      {addinError}
                    </p>
                  )}

                  {canEditSettings && (
                    <div className="flex items-center justify-end gap-3">
                      {addinForm.mode === 'url' && addinForm.url && (
                        <a href={addinForm.url} target="_blank" rel="noopener noreferrer" className="text-xs md:text-sm text-primary hover:underline">
                          測試這個連結 ↗
                        </a>
                      )}
                      <button onClick={() => saveAddin(addinForm)} disabled={addinSaving} className="px-3 md:px-4 py-2 md:py-2.5 bg-primary text-on-primary text-xs md:text-sm font-bold rounded hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50 shrink-0">
                        {addinSaving ? t('admin.settings.saving') : t('admin.settings.save')}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Info Section — fixed at bottom */}
        <div className="mt-auto bg-surface-container-low border border-outline-variant/5 p-4 md:p-6 relative overflow-hidden rounded-lg">
          <div className="absolute right-4 bottom-4 opacity-[0.04] pointer-events-none">
            <span className="material-symbols-outlined max-md:!text-[3rem]" style={{ fontSize: '6rem' }}>info</span>
          </div>
          <div className="relative z-10">
            <h3 className="text-sm md:text-base font-headline font-bold text-on-surface mb-2 md:mb-3">{t('admin.settings.info.title')}</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 md:gap-4">
              <div className="bg-surface-container p-3 md:p-4 border-l-2 border-warning">
                <h4 className="text-xs md:text-sm text-on-surface font-bold mb-0.5 md:mb-1">{t('admin.settings.info.usageLimitTitle')}</h4>
                <p className="text-xs md:text-sm text-on-surface-variant">{t('admin.settings.info.usageLimitDesc')}</p>
              </div>
              <div className="bg-surface-container p-3 md:p-4 border-l-2 border-primary">
                <h4 className="text-xs md:text-sm text-on-surface font-bold mb-0.5 md:mb-1">{t('admin.settings.info.storageTitle')}</h4>
                <p className="text-xs md:text-sm text-on-surface-variant">{t('admin.settings.info.storageDesc')}</p>
              </div>
              <div className="bg-surface-container p-3 md:p-4 border-l-2 border-tertiary">
                <h4 className="text-xs md:text-sm text-on-surface font-bold mb-0.5 md:mb-1">{t('admin.settings.info.uploadTitle')}</h4>
                <p className="text-xs md:text-sm text-on-surface-variant">{t('admin.settings.info.uploadDesc')}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
