'use client';

import { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAdminAuth } from '../components/AdminAuthProvider';
import { useTranslation } from '../../../i18n';

export default function AdminTermsPage() {
  return <AdminTermsContent />;
}

function AdminTermsContent() {
  const { token, isReadonly } = useAdminAuth();
  const { t } = useTranslation();
  const [content, setContent] = useState('');
  const [version, setVersion] = useState('1');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [bumpVersion, setBumpVersion] = useState(false);
  const [resetAcceptance, setResetAcceptance] = useState(false);

  useEffect(() => {
    if (!token) return;
    fetch('/api/admin/terms', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(data => {
        setContent(data.content || '');
        setVersion(data.version || '1');
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [token]);

  async function handleSave() {
    if (!token || saving || isReadonly) return;
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch('/api/admin/terms', {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, bumpVersion, resetAcceptance: bumpVersion && resetAcceptance }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.version) setVersion(data.version);
        setSaved(true);
        setBumpVersion(false);
        setResetAcceptance(false);
        setTimeout(() => setSaved(false), 3000);
      }
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <span className="material-symbols-outlined animate-spin text-primary text-3xl">progress_activity</span>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <header className="sticky top-0 h-14 md:h-16 bg-surface/80 backdrop-blur-xl flex justify-between items-center px-4 md:px-8 z-40">
        <div className="flex items-center gap-2 md:gap-4">
          <span className="text-base md:text-lg font-black text-on-surface font-headline shrink-0">
            {t('admin.terms.title' as any) || '使用條款管理'}
          </span>
          <span className="text-xs md:text-sm text-on-surface-variant font-mono truncate">
            {t('admin.terms.subtitle' as any) || '編輯使用者同意條款'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-on-surface-variant font-mono">
            v{version}
          </span>
          {saved && (
            <span className="flex items-center gap-1 text-xs text-primary font-medium animate-fade-in">
              <span className="material-symbols-outlined text-sm">check_circle</span>
              {t('admin.settings.saved' as any) || '已儲存'}
            </span>
          )}
        </div>
      </header>

      <div className="p-4 md:p-8 flex-1 flex flex-col min-h-0 space-y-4">
        {/* Toggle bar */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowPreview(false)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
              !showPreview ? 'bg-primary text-on-primary' : 'bg-surface-container-high text-on-surface-variant hover:text-on-surface'
            }`}
          >
            <span className="material-symbols-outlined text-sm align-middle mr-1">edit_note</span>
            {t('admin.terms.editor' as any) || '編輯器'}
          </button>
          <button
            onClick={() => setShowPreview(true)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
              showPreview ? 'bg-primary text-on-primary' : 'bg-surface-container-high text-on-surface-variant hover:text-on-surface'
            }`}
          >
            <span className="material-symbols-outlined text-sm align-middle mr-1">visibility</span>
            {t('admin.terms.preview' as any) || '預覽'}
          </button>
        </div>

        {/* Placeholder guide */}
        <div className="bg-surface-container rounded-lg p-3 md:p-4">
          <div className="flex items-center gap-2 mb-2">
            <span className="material-symbols-outlined text-sm text-on-surface-variant">info</span>
            <span className="text-xs font-semibold text-on-surface">
              {t('admin.terms.placeholderGuide' as any) || '動態數值佔位符'}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {[
              { key: '{{usage_limit_usd}}', desc: 'USD 用量上限' },
              { key: '{{storage_quota_gb}}', desc: 'GB 儲存上限' },
              { key: '{{upload_quota_mb}}', desc: 'MB 上傳上限' },
            ].map(p => (
              <code key={p.key} className="text-xs bg-surface-container-highest px-2 py-1 rounded font-mono text-primary">
                {p.key} <span className="text-on-surface-variant">→ {p.desc}</span>
              </code>
            ))}
          </div>
          <p className="text-xs text-on-surface-variant mt-1.5">
            {t('admin.terms.placeholderGuideDesc' as any) || '這些佔位符在使用者端會被替換為系統設定中的實際數值。'}
          </p>
        </div>

        {/* Editor / Preview */}
        <div className="flex-1 min-h-0">
          {!showPreview ? (
            <textarea
              value={content}
              onChange={e => setContent(e.target.value)}
              disabled={isReadonly}
              className="w-full h-full min-h-[300px] bg-surface-container-high rounded-xl p-4 md:p-6 text-sm font-mono text-on-surface resize-none border border-outline-variant/15 focus:border-primary/40 focus:outline-none transition-colors"
              placeholder="# 使用條款\n\nMarkdown 格式..."
            />
          ) : (
            <div className="w-full h-full min-h-[300px] overflow-y-auto bg-surface-container-high rounded-xl p-4 md:p-6 border border-outline-variant/15">
              <div className="prose-terms text-sm text-on-surface leading-relaxed">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    h1: ({ children, ...props }) => <h1 className="text-lg font-bold text-on-surface mt-0 mb-3 pb-2 border-b border-outline-variant/15" {...props}>{children}</h1>,
                    h2: ({ children, ...props }) => <h2 className="text-base font-bold text-on-surface mt-5 mb-2" {...props}>{children}</h2>,
                    h3: ({ children, ...props }) => <h3 className="text-sm font-semibold text-on-surface mt-3 mb-1.5" {...props}>{children}</h3>,
                    p: ({ children, ...props }) => <p className="mb-2.5 last:mb-0 leading-relaxed text-on-surface-variant" {...props}>{children}</p>,
                    ul: ({ children, ...props }) => <ul className="list-disc pl-5 mb-3 space-y-1" {...props}>{children}</ul>,
                    ol: ({ children, ...props }) => <ol className="list-decimal pl-5 mb-3 space-y-1" {...props}>{children}</ol>,
                    li: ({ children, ...props }) => <li className="leading-relaxed text-on-surface-variant" {...props}>{children}</li>,
                    strong: ({ children, ...props }) => <strong className="font-semibold text-on-surface" {...props}>{children}</strong>,
                    blockquote: ({ children, ...props }) => (
                      <blockquote className="border-l-3 border-primary/30 pl-3 my-3 text-on-surface-variant bg-primary/5 rounded-r-lg py-2 pr-3" {...props}>{children}</blockquote>
                    ),
                    table: ({ children, ...props }) => (
                      <div className="overflow-x-auto my-3 rounded-lg border border-outline-variant/20">
                        <table className="w-full text-sm border-collapse" {...props}>{children}</table>
                      </div>
                    ),
                    thead: ({ children, ...props }) => <thead className="bg-surface-container" {...props}>{children}</thead>,
                    th: ({ children, ...props }) => <th className="text-left px-3 py-2 font-semibold text-on-surface border-b border-outline-variant/20" {...props}>{children}</th>,
                    td: ({ children, ...props }) => <td className="px-3 py-2 text-on-surface-variant border-b border-outline-variant/10" {...props}>{children}</td>,
                    hr: (props) => <hr className="my-4 border-outline-variant/15" {...props} />,
                    a: ({ children, href, ...props }) => (
                      <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline" {...props}>{children}</a>
                    ),
                  }}
                >
                  {content}
                </ReactMarkdown>
              </div>
            </div>
          )}
        </div>

        {/* Save options */}
        {!isReadonly && (
          <div className="bg-surface-container rounded-lg p-4 flex flex-col md:flex-row md:items-center gap-4">
            <div className="flex-1 flex flex-col sm:flex-row gap-3">
              <label className="flex items-center gap-2 text-sm text-on-surface cursor-pointer">
                <input
                  type="checkbox"
                  checked={bumpVersion}
                  onChange={e => {
                    setBumpVersion(e.target.checked);
                    if (!e.target.checked) setResetAcceptance(false);
                  }}
                  className="accent-primary w-4 h-4"
                />
                <span>{t('admin.terms.bumpVersion' as any) || '更新版本號'}</span>
                <span className="text-xs text-on-surface-variant">
                  (v{version} → v{Number(version) + 1})
                </span>
              </label>
              {bumpVersion && (
                <label className="flex items-center gap-2 text-sm text-on-surface cursor-pointer animate-fade-in">
                  <input
                    type="checkbox"
                    checked={resetAcceptance}
                    onChange={e => setResetAcceptance(e.target.checked)}
                    className="accent-error w-4 h-4"
                  />
                  <span className="text-error">
                    {t('admin.terms.resetAcceptance' as any) || '重設所有使用者接受狀態'}
                  </span>
                </label>
              )}
            </div>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-6 py-2.5 rounded-xl font-bold text-on-primary bg-primary hover:brightness-110 transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 shrink-0"
            >
              <span className="material-symbols-outlined text-lg">
                {saving ? 'progress_activity' : 'save'}
              </span>
              {saving
                ? (t('admin.settings.saving' as any) || '儲存中...')
                : (t('admin.settings.save' as any) || '儲存')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
