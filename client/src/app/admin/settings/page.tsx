'use client';

import { useState, useEffect } from 'react';
import { useAdminAuth } from '../components/AdminAuthProvider';

interface Settings {
  usageLimitUsd: number;
  storageQuotaGb: number;
  uploadQuotaMb: number;
}

export default function AdminSettings() {
  const { token } = useAdminAuth();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [form, setForm] = useState({ usageLimitUsd: '', storageQuotaGb: '', uploadQuotaMb: '' });
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

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

  const SETTINGS_CONFIG = [
    {
      key: 'usageLimitUsd' as const,
      icon: 'account_balance_wallet',
      iconColor: 'text-warning',
      title: '用戶用量上限',
      description: '每位用戶帳號的最高消費額度（美金）。超過此額度的用戶將無法登入及使用系統生成文件。',
      unit: 'USD',
      prefix: '$',
      suffix: '/ 用戶',
      min: 0,
      max: 100000,
      step: 1,
    },
    {
      key: 'storageQuotaGb' as const,
      icon: 'folder',
      iconColor: 'text-primary',
      title: '文件儲存上限',
      description: '每位用戶生成文件的最大儲存空間。超過此上限後將無法生成新文件，需先刪除舊檔案。',
      unit: 'GB',
      prefix: '',
      suffix: 'GB / 用戶',
      min: 0.1,
      max: 100,
      step: 0.1,
    },
    {
      key: 'uploadQuotaMb' as const,
      icon: 'cloud_upload',
      iconColor: 'text-tertiary',
      title: '上傳儲存上限',
      description: '每位用戶上傳檔案的最大儲存空間。用於分析用途的上傳檔案（CSV、Excel 等）受此限制。',
      unit: 'MB',
      prefix: '',
      suffix: 'MB / 用戶',
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
          <span className="text-lg font-black text-on-surface font-headline">系統設定</span>
          <span className="text-sm text-on-surface-variant font-mono">用量與儲存配額管理</span>
        </div>
      </header>

      {/* Content */}
      <div className="p-8 flex-1 space-y-6">
        {/* 用戶用量上限 — 滿版 */}
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
                          已儲存
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-on-surface-variant leading-relaxed mb-4">{cfg.description}</p>
                    {isEditing0 ? (
                      <div className="flex items-center gap-3">
                        {cfg.prefix && <span className="text-on-surface-variant text-base font-bold">{cfg.prefix}</span>}
                        <input type="number" value={form[cfg.key]} onChange={e => setForm(prev => ({ ...prev, [cfg.key]: e.target.value }))} className="w-40 px-4 py-2.5 bg-surface-container-highest text-on-surface text-base rounded border border-outline-variant/20 focus:border-primary focus:outline-none font-mono" min={cfg.min} max={cfg.max} step={cfg.step} />
                        <span className="text-sm text-on-surface-variant">{cfg.unit}</span>
                        <button onClick={() => saveSetting(cfg.key)} disabled={saving} className="px-4 py-2.5 bg-primary text-on-primary text-sm font-bold rounded hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50">{saving ? '儲存中...' : '儲存'}</button>
                        <button onClick={() => { setEditing(null); if (settings) setForm(prev => ({ ...prev, [cfg.key]: String(settings[cfg.key]) })); }} className="px-4 py-2.5 bg-surface-container-high text-on-surface-variant text-sm rounded hover:bg-surface-variant transition-colors cursor-pointer">取消</button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-3">
                        <span className="text-3xl font-headline font-black text-on-surface">{cfg.prefix}{value ?? '—'}</span>
                        <span className="text-sm text-on-surface-variant">{cfg.suffix}</span>
                        <button onClick={() => setEditing(cfg.key)} className="ml-4 px-4 py-2 bg-surface-container-high text-on-surface-variant text-sm rounded hover:bg-surface-variant transition-colors cursor-pointer flex items-center gap-1.5">
                          <span className="material-symbols-outlined text-sm">edit</span>
                          修改
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })()}

        {/* 文件儲存 + 上傳儲存 — 併排 */}
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
                            已儲存
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-on-surface-variant leading-relaxed mb-4">{cfg.description}</p>
                      {isEditingCfg ? (
                        <div className="flex items-center gap-3 flex-wrap">
                          {cfg.prefix && <span className="text-on-surface-variant text-base font-bold">{cfg.prefix}</span>}
                          <input type="number" value={form[cfg.key]} onChange={e => setForm(prev => ({ ...prev, [cfg.key]: e.target.value }))} className="w-32 px-4 py-2.5 bg-surface-container-highest text-on-surface text-base rounded border border-outline-variant/20 focus:border-primary focus:outline-none font-mono" min={cfg.min} max={cfg.max} step={cfg.step} />
                          <span className="text-sm text-on-surface-variant">{cfg.unit}</span>
                          <button onClick={() => saveSetting(cfg.key)} disabled={saving} className="px-4 py-2.5 bg-primary text-on-primary text-sm font-bold rounded hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50">{saving ? '儲存中...' : '儲存'}</button>
                          <button onClick={() => { setEditing(null); if (settings) setForm(prev => ({ ...prev, [cfg.key]: String(settings[cfg.key]) })); }} className="px-4 py-2.5 bg-surface-container-high text-on-surface-variant text-sm rounded hover:bg-surface-variant transition-colors cursor-pointer">取消</button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-3">
                          <span className="text-3xl font-headline font-black text-on-surface">{cfg.prefix}{value ?? '—'}</span>
                          <span className="text-sm text-on-surface-variant">{cfg.suffix}</span>
                          <button onClick={() => setEditing(cfg.key)} className="ml-4 px-4 py-2 bg-surface-container-high text-on-surface-variant text-sm rounded hover:bg-surface-variant transition-colors cursor-pointer flex items-center gap-1.5">
                            <span className="material-symbols-outlined text-sm">edit</span>
                            修改
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

        {/* Info Section — 滿版 */}
        <div className="bg-surface-container-low border border-outline-variant/5 p-6 relative overflow-hidden">
          <div className="absolute right-4 bottom-4 opacity-[0.04] pointer-events-none">
            <span className="material-symbols-outlined text-[6rem]">info</span>
          </div>
          <div className="relative z-10">
            <h3 className="text-base font-headline font-bold text-on-surface mb-3">設定說明</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-surface-container p-4 border-l-2 border-warning">
                <h4 className="text-sm text-on-surface font-bold mb-1">用量上限</h4>
                <p className="text-sm text-on-surface-variant">
                  基於 Claude Sonnet 4 定價（$3/M input, $15/M output）乘以 10 倍計費。用戶超過上限後，登入與生成文件都會被阻擋。
                </p>
              </div>
              <div className="bg-surface-container p-4 border-l-2 border-primary">
                <h4 className="text-sm text-on-surface font-bold mb-1">文件儲存</h4>
                <p className="text-sm text-on-surface-variant">
                  限制每位用戶 AI 生成文件的總儲存量。包含 PPTX、DOCX、XLSX、PDF 等所有生成的檔案。
                </p>
              </div>
              <div className="bg-surface-container p-4 border-l-2 border-tertiary">
                <h4 className="text-sm text-on-surface font-bold mb-1">上傳儲存</h4>
                <p className="text-sm text-on-surface-variant">
                  限制每位用戶上傳的分析檔案總量。包含 CSV、Excel、JSON 等供 AI 分析的檔案。
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
