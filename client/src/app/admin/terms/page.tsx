'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAdminAuth } from '../components/AdminAuthProvider';
import { useTranslation } from '../../../i18n';

// ─── Toggle Switch ───
function Toggle({ checked, onChange, color = 'primary' }: { checked: boolean; onChange: (v: boolean) => void; color?: 'primary' | 'error' }) {
  const bg = checked
    ? color === 'error' ? 'bg-error' : 'bg-primary'
    : 'bg-outline-variant/40';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors duration-200 ${bg}`}
    >
      <span className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-md ring-0 transition-transform duration-200 translate-y-0.5 ${checked ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
    </button>
  );
}

// ─── Highlight {{placeholders}} in preview ───
function HighlightPlaceholders({ children }: { children: React.ReactNode }) {
  if (typeof children !== 'string') return <>{children}</>;
  const parts = children.split(/(\{\{[a-z_]+\}\})/g);
  if (parts.length === 1) return <>{children}</>;
  return (
    <>
      {parts.map((part, i) =>
        /^\{\{[a-z_]+\}\}$/.test(part)
          ? <code key={i} className="text-primary bg-primary/10 border border-primary/20 px-1 py-0.5 rounded text-[12px] font-mono font-semibold">{part}</code>
          : part
      )}
    </>
  );
}

// ─── Editor backdrop with highlighted placeholders ───
function EditorBackdrop({ content }: { content: string }) {
  const parts = content.split(/(\{\{[a-z_]+\}\})/g);
  return (
    <>
      {parts.map((part, i) =>
        /^\{\{[a-z_]+\}\}$/.test(part)
          ? <mark key={i} className="text-primary bg-primary/10 rounded px-px">{part}</mark>
          : part
      )}
      {/* Trailing newline so backdrop height matches textarea */}
      {'\n'}
    </>
  );
}

// ─── Markdown Toolbar ───
const MD_TOOLS = [
  { icon: 'format_bold', label: '粗體', prefix: '**', suffix: '**', placeholder: '粗體文字' },
  { icon: 'format_italic', label: '斜體', prefix: '_', suffix: '_', placeholder: '斜體文字' },
  { icon: 'strikethrough_s', label: '刪除線', prefix: '~~', suffix: '~~', placeholder: '刪除文字' },
  { sep: true },
  { icon: 'format_h1', label: '標題 1', prefix: '# ', suffix: '', placeholder: '標題', line: true },
  { icon: 'format_h2', label: '標題 2', prefix: '## ', suffix: '', placeholder: '標題', line: true },
  { icon: 'format_h3', label: '標題 3', prefix: '### ', suffix: '', placeholder: '標題', line: true },
  { sep: true },
  { icon: 'format_list_bulleted', label: '項目清單', prefix: '- ', suffix: '', placeholder: '項目', line: true },
  { icon: 'format_list_numbered', label: '編號清單', prefix: '1. ', suffix: '', placeholder: '項目', line: true },
  { icon: 'checklist', label: '核取清單', prefix: '- [ ] ', suffix: '', placeholder: '待辦事項', line: true },
  { sep: true },
  { icon: 'format_quote', label: '引用', prefix: '> ', suffix: '', placeholder: '引用文字', line: true },
  { icon: 'horizontal_rule', label: '分隔線', prefix: '\n---\n', suffix: '', placeholder: '', insert: true },
  { icon: 'link', label: '連結', prefix: '[', suffix: '](https://)', placeholder: '連結文字' },
  { icon: 'table_chart', label: '表格', prefix: '\n| 欄位1 | 欄位2 | 欄位3 |\n| --- | --- | --- |\n| 內容 | 內容 | 內容 |\n', suffix: '', placeholder: '', insert: true },
  { icon: 'code', label: '程式碼', prefix: '`', suffix: '`', placeholder: '程式碼' },
] as const;

type MdTool = (typeof MD_TOOLS)[number];

function MarkdownToolbar({ textareaRef, content, setContent }: {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  content: string;
  setContent: (v: string) => void;
}) {
  const handleTool = useCallback((tool: MdTool) => {
    if ('sep' in tool) return;
    const ta = textareaRef.current;
    if (!ta) return;

    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = content.substring(start, end);

    const scrollTop = ta.scrollTop;

    if ('insert' in tool && tool.insert) {
      const newContent = content.substring(0, start) + tool.prefix + content.substring(end);
      setContent(newContent);
      requestAnimationFrame(() => {
        ta.focus();
        ta.scrollTop = scrollTop;
        const pos = start + tool.prefix.length;
        ta.setSelectionRange(pos, pos);
      });
      return;
    }

    if ('line' in tool && tool.line) {
      const lineStart = content.lastIndexOf('\n', start - 1) + 1;
      const before = content.substring(0, lineStart);
      const lineContent = selected || tool.placeholder;
      const after = content.substring(end);
      const newContent = before + tool.prefix + lineContent + tool.suffix + after;
      setContent(newContent);
      requestAnimationFrame(() => {
        ta.focus();
        ta.scrollTop = scrollTop;
        const newStart = lineStart + tool.prefix.length;
        ta.setSelectionRange(newStart, newStart + lineContent.length);
      });
      return;
    }

    // Inline wrap
    const text = selected || tool.placeholder;
    const newContent = content.substring(0, start) + tool.prefix + text + tool.suffix + content.substring(end);
    setContent(newContent);
    requestAnimationFrame(() => {
      ta.focus();
      ta.scrollTop = scrollTop;
      const newStart = start + tool.prefix.length;
      ta.setSelectionRange(newStart, newStart + text.length);
    });
  }, [textareaRef, content, setContent]);

  return (
    <div className="flex items-center gap-0.5 flex-wrap px-1 py-1.5 border-b border-outline-variant/12 bg-surface-container/50">
      {MD_TOOLS.map((tool, i) => {
        if ('sep' in tool) {
          return <div key={i} className="w-px h-5 bg-outline-variant/20 mx-1" />;
        }
        return (
          <button
            key={i}
            type="button"
            onClick={() => handleTool(tool)}
            title={tool.label}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors cursor-pointer"
          >
            <span className="material-symbols-outlined text-[18px]">{tool.icon}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─── Main Page ───
export default function AdminTermsPage() {
  return <AdminTermsContent />;
}

function AdminTermsContent() {
  const { token, isReadonly, canOperate } = useAdminAuth();
  const editable = !isReadonly || canOperate('terms');
  const { t } = useTranslation();
  const [content, setContent] = useState('');
  const [version, setVersion] = useState('1');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [bumpVersion, setBumpVersion] = useState(false);
  const [resetAcceptance, setResetAcceptance] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

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
    if (!token || saving || !editable) return;
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

  // Handle Tab key in textarea
  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = e.currentTarget;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const newContent = content.substring(0, start) + '  ' + content.substring(end);
      setContent(newContent);
      requestAnimationFrame(() => {
        ta.setSelectionRange(start + 2, start + 2);
      });
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
              <button
                key={p.key}
                type="button"
                onClick={() => {
                  if (!editable) return;
                  const ta = textareaRef.current;
                  if (!ta) return;
                  const scrollTop = ta.scrollTop;
                  const start = ta.selectionStart;
                  const newContent = content.substring(0, start) + p.key + content.substring(ta.selectionEnd);
                  setContent(newContent);
                  requestAnimationFrame(() => {
                    ta.focus();
                    ta.scrollTop = scrollTop;
                    const pos = start + p.key.length;
                    ta.setSelectionRange(pos, pos);
                  });
                }}
                className="text-xs bg-primary/10 border border-primary/20 px-2.5 py-1.5 rounded-lg font-mono text-primary hover:bg-primary/20 transition-colors cursor-pointer"
              >
                <span className="text-primary font-semibold">{p.key}</span>
                <span className="text-on-surface-variant ml-1.5">→ {p.desc}</span>
              </button>
            ))}
          </div>
          <p className="text-xs text-on-surface-variant mt-1.5">
            {t('admin.terms.placeholderGuideDesc' as any) || '點擊佔位符可直接插入至編輯器，使用者端會被替換為系統設定中的實際數值。'}
          </p>
        </div>

        {/* Editor / Preview */}
        <div className="flex-1 min-h-0">
          {!showPreview ? (
            <div className="w-full h-full flex flex-col bg-surface-container-high rounded-xl border border-outline-variant/15 focus-within:border-primary/40 transition-colors overflow-hidden">
              {/* Toolbar */}
              {editable && (
                <MarkdownToolbar textareaRef={textareaRef} content={content} setContent={setContent} />
              )}
              <div className="relative flex-1 min-h-[300px] overflow-hidden">
                {/* Backdrop: renders highlighted placeholders, synced to textarea scroll */}
                <div
                  ref={backdropRef}
                  aria-hidden
                  className="absolute inset-0 p-4 md:p-6 text-sm font-mono text-on-surface whitespace-pre-wrap break-words overflow-hidden pointer-events-none"
                  style={{ wordBreak: 'break-word' }}
                >
                  {content ? <EditorBackdrop content={content} /> : null}
                </div>
                {/* Textarea on top: transparent text, visible caret */}
                <textarea
                  ref={textareaRef}
                  value={content}
                  onChange={e => setContent(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onScroll={() => {
                    if (backdropRef.current && textareaRef.current) {
                      backdropRef.current.scrollTop = textareaRef.current.scrollTop;
                    }
                  }}
                  disabled={!editable}
                  className="absolute inset-0 w-full h-full bg-transparent p-4 md:p-6 text-sm font-mono resize-none focus:outline-none selection:bg-primary/30"
                  style={{ color: 'transparent', caretColor: 'var(--color-on-surface, #1b1b1f)', WebkitTextFillColor: 'transparent' }}
                  placeholder={'# 使用條款標題\n\n## 第一章 總則\n\n使用條款內容...\n\n- 項目一\n- 項目二\n\n> 引用文字\n\n| 欄位 | 說明 |\n| --- | --- |\n| 項目 | 內容 |'}
                />
              </div>
            </div>
          ) : (
            <div className="w-full h-full min-h-[300px] overflow-y-auto bg-surface-container-high rounded-xl p-4 md:p-6 border border-outline-variant/15">
              <div className="prose-terms text-sm text-on-surface leading-relaxed">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    h1: ({ children, ...props }) => <h1 className="text-lg font-bold text-on-surface mt-0 mb-3 pb-2 border-b border-outline-variant/15" {...props}>{children}</h1>,
                    h2: ({ children, ...props }) => <h2 className="text-base font-bold text-on-surface mt-5 mb-2" {...props}>{children}</h2>,
                    h3: ({ children, ...props }) => <h3 className="text-sm font-semibold text-on-surface mt-3 mb-1.5" {...props}>{children}</h3>,
                    p: ({ children, ...props }) => <p className="mb-2.5 last:mb-0 leading-relaxed text-on-surface-variant" {...props}><HighlightPlaceholders>{children}</HighlightPlaceholders></p>,
                    ul: ({ children, ...props }) => <ul className="list-disc pl-5 mb-3 space-y-1" {...props}>{children}</ul>,
                    ol: ({ children, ...props }) => <ol className="list-decimal pl-5 mb-3 space-y-1" {...props}>{children}</ol>,
                    li: ({ children, ...props }) => <li className="leading-relaxed text-on-surface-variant" {...props}><HighlightPlaceholders>{children}</HighlightPlaceholders></li>,
                    strong: ({ children, ...props }) => <strong className="font-semibold text-on-surface" {...props}><HighlightPlaceholders>{children}</HighlightPlaceholders></strong>,
                    blockquote: ({ children, ...props }) => (
                      <blockquote className="border-l-3 border-primary/30 pl-3 my-3 text-on-surface-variant bg-primary/5 rounded-r-lg py-2 pr-3" {...props}>{children}</blockquote>
                    ),
                    table: ({ children, ...props }) => (
                      <div className="overflow-x-auto my-3 rounded-lg border border-outline-variant/20">
                        <table className="w-full text-sm border-collapse min-w-[520px]" {...props}>{children}</table>
                      </div>
                    ),
                    thead: ({ children, ...props }) => <thead className="bg-surface-container" {...props}>{children}</thead>,
                    th: ({ children, ...props }) => <th className="text-left px-3 py-2 font-semibold text-on-surface border-b border-outline-variant/20 whitespace-nowrap" {...props}><HighlightPlaceholders>{children}</HighlightPlaceholders></th>,
                    td: ({ children, ...props }) => <td className="px-3 py-2 text-on-surface-variant border-b border-outline-variant/10 align-top" {...props}><HighlightPlaceholders>{children}</HighlightPlaceholders></td>,
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
        {editable && (
          <div className="bg-surface-container rounded-xl p-4 md:p-5 space-y-4">
            <div className="flex flex-col sm:flex-row gap-4">
              {/* Bump version toggle */}
              <label className="flex items-center gap-3 cursor-pointer select-none">
                <Toggle checked={bumpVersion} onChange={v => { setBumpVersion(v); if (!v) setResetAcceptance(false); }} />
                <div>
                  <span className="text-sm font-medium text-on-surface">
                    {t('admin.terms.bumpVersion' as any) || '更新版本號'}
                  </span>
                  <span className="text-xs text-on-surface-variant ml-2 font-mono">
                    v{version} → v{Number(version) + 1}
                  </span>
                </div>
              </label>

              {/* Reset acceptance toggle */}
              {bumpVersion && (
                <div className="animate-in fade-in slide-in-from-left-2 duration-200">
                  <label className="flex items-center gap-3 cursor-pointer select-none">
                    <Toggle checked={resetAcceptance} onChange={setResetAcceptance} color="error" />
                    <span className="text-sm font-medium text-error">
                      {t('admin.terms.resetAcceptance' as any) || '重設所有使用者接受狀態'}
                    </span>
                  </label>
                </div>
              )}
            </div>

            {/* Reset acceptance warning */}
            {bumpVersion && resetAcceptance && (
              <div className="flex items-start gap-2.5 bg-error/8 border border-error/20 rounded-xl px-4 py-3 animate-in fade-in slide-in-from-bottom-2 duration-200">
                <span className="material-symbols-outlined text-error text-lg mt-0.5 shrink-0">warning</span>
                <div className="text-sm text-error/90 leading-relaxed">
                  <span className="font-semibold text-error">注意：</span>開啟此選項後，所有使用者下次登入時都需要重新閱讀並同意新版條款，才能繼續使用系統。適用於條款有重大更新的情況。
                </div>
              </div>
            )}

            <div className="flex justify-end">
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
          </div>
        )}
      </div>
    </div>
  );
}
