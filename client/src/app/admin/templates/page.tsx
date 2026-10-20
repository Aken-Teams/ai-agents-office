'use client';

/**
 * 增益集指令範本 — what colleagues have actually saved.
 *
 * Read-only by design. A template is one person's shorthand for a job they
 * repeat; an admin editing or deleting one changes that person's workflow
 * without them finding out until it breaks. The value here is seeing what
 * people reach for — which jobs recur, which wording works — not curating it.
 *
 * The 組織 column means two different things depending on the account, so it
 * says which: an AD user shows the department AD has them in, and an external
 * user shows the company on the invite code they signed up with. Neither is
 * guessed — when the source has nothing, the row says 其他 rather than
 * inventing an affiliation.
 */

import { useState, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Dropdown from '../../components/Dropdown';
import { useAdminAuth } from '../components/AdminAuthProvider';

interface Template {
  id: string;
  name: string;
  content: string;
  host: string;
  created_at: string;
  updated_at: string;
  author: string;
  email: string;
  kind: 'ad' | 'external';
  org: string;
  /** Full OU path for AD users; '' for external ones. */
  orgPath: string;
  domain: string | null;
}

interface Author {
  id: string;
  name: string;
  org: string;
  n: number;
}

/**
 * Templates are written with their section names as standalone **bold** lines
 * — 開工前, 查資料, 配色. Markdown reads those as inline emphasis, so each
 * heading collapses onto the first sentence of its own section and the
 * document loses the spine its author gave it. A line that is nothing but
 * bold text is a heading; promote it to one. Fenced code is left alone.
 */
function asDocument(md: string): string {
  return md
    .split(/(```[\s\S]*?```)/g)
    .map((part, i) => (i % 2 ? part : part.replace(/^[ \t]*\*\*([^*\n]+)\*\*[:：]?[ \t]*$/gm, '### $1')))
    .join('');
}

/** Markdown → readable one-liner for the list teaser. */
function plain(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')        // fenced code: a teaser can't show it
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(?<!\w)[*_]([^*_]+)[*_](?!\w)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const HOST_META: Record<string, { label: string; icon: string; cls: string }> = {
  excel: { label: 'Excel', icon: 'table_chart', cls: 'text-success bg-success/10' },
  word: { label: 'Word', icon: 'description', cls: 'text-tertiary bg-tertiary/10' },
  ppt: { label: 'PowerPoint', icon: 'present_to_all', cls: 'text-warning bg-warning/10' },
  all: { label: '通用', icon: 'apps', cls: 'text-on-surface-variant bg-surface-container-highest' },
};

export default function AdminTemplates() {
  const { token } = useAdminAuth();
  const [entries, setEntries] = useState<Template[]>([]);
  const [hosts, setHosts] = useState<Array<{ host: string; n: number }>>([]);
  const [authors, setAuthors] = useState<Author[]>([]);
  const [hostFilter, setHostFilter] = useState('');
  const [authorFilter, setAuthorFilter] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [meta, setMeta] = useState({ total: 0, totalPages: 1, authorCount: 0, adResolved: true });
  const [open, setOpen] = useState<Template | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    const qs = new URLSearchParams({ page: String(page), limit: '10' });
    if (hostFilter) qs.set('host', hostFilter);
    if (authorFilter) qs.set('author', authorFilter);
    if (query) qs.set('search', query);
    try {
      const res = await fetch(`/api/admin/prompt-templates?${qs}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return;
      const d = await res.json();
      setEntries(d.entries || []);
      setHosts(d.hosts || []);
      setAuthors(d.authors || []);
      setMeta({
        total: d.total || 0,
        totalPages: d.totalPages || 1,
        authorCount: d.authorCount || 0,
        adResolved: d.adResolved !== false,
      });
    } catch { /* ignore */ }
  }, [token, page, hostFilter, authorFilter, query]);

  useEffect(() => { load(); }, [load]);

  return (
    <>
      <header className="sticky top-0 h-14 md:h-16 bg-surface/80 backdrop-blur-xl flex justify-between items-center px-4 md:px-8 z-40 shadow-[0_1px_0_0_rgba(255,255,255,0.05)]">
        <span className="text-base md:text-lg font-black text-on-surface font-headline">增益集指令範本</span>
        <span className="text-xs md:text-sm text-on-surface-variant">
          {meta.total} 則 · {meta.authorCount} 人建立
        </span>
      </header>

      <div className="p-4 md:p-8 space-y-4">
        {!meta.adResolved && (
          <div className="flex items-start gap-2 px-4 py-3 bg-warning/10 rounded-lg">
            <span className="material-symbols-outlined text-warning text-base shrink-0">info</span>
            <p className="text-xs text-on-surface-variant">
              目前讀不到 AD 組織資料，AD 帳號的組織欄會顯示「其他」。姓名與其他欄位不受影響。
            </p>
          </div>
        )}

        <div className="bg-surface-container rounded-lg p-4 md:p-6">
          {/* Filters */}
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <div className="flex gap-1 bg-surface-container-highest rounded-lg p-1 overflow-x-auto max-w-full">
              <button
                onClick={() => { setHostFilter(''); setPage(1); }}
                className={`px-3 py-1.5 text-xs font-bold rounded transition-colors cursor-pointer ${
                  !hostFilter ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:text-on-surface'
                }`}
              >
                全部
              </button>
              {hosts.map(h => (
                <button
                  key={h.host}
                  onClick={() => { setHostFilter(h.host); setPage(1); }}
                  className={`px-3 py-1.5 text-xs font-bold rounded transition-colors cursor-pointer ${
                    hostFilter === h.host ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:text-on-surface'
                  }`}
                >
                  {HOST_META[h.host]?.label || h.host}
                  <span className="ml-1 opacity-60">{h.n}</span>
                </button>
              ))}
            </div>
            {/* A dropdown rather than more chips: the host list is four fixed
                values, the author list grows with every colleague who saves a
                template. Shared Dropdown rather than a native <select> — the
                OS draws that one's list, so it ignores the admin theme. */}
            <Dropdown
              compact
              className="w-full sm:w-[220px] sm:shrink-0"
              value={authorFilter}
              onChange={v => { setAuthorFilter(v); setPage(1); }}
              options={[
                { value: '', label: '所有建立者' },
                ...authors.map(a => ({
                  value: a.id,
                  // Department disambiguates the two colleagues who share a name;
                  // the count tells the reader which pick is worth making.
                  label: `${a.name}${a.org ? `（${a.org}）` : ''} · ${a.n}`,
                })),
              ]}
            />
            <form
              onSubmit={e => { e.preventDefault(); setQuery(search); setPage(1); }}
              className="flex-1 min-w-[200px] flex gap-2"
            >
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="搜尋範本名稱、內容或建立者"
                className="flex-1 min-w-0 px-3 py-2 bg-surface-container-highest text-on-surface text-sm rounded border border-outline-variant/20 focus:border-primary focus:outline-none"
              />
              <button type="submit" className="px-3 py-2 bg-primary text-on-primary text-sm font-bold rounded hover:bg-primary/90 cursor-pointer shrink-0">
                搜尋
              </button>
            </form>
          </div>

          {entries.length === 0 ? (
            <p className="text-sm text-on-surface-variant/60 py-12 text-center">
              {query || hostFilter || authorFilter ? '沒有符合的範本。' : '還沒有人建立指令範本。'}
            </p>
          ) : (
            <div className="space-y-1">
              {entries.map(t => {
                const h = HOST_META[t.host] || HOST_META.all;
                return (
                  <button
                    key={t.id}
                    onClick={() => setOpen(t)}
                    className="w-full flex items-start gap-3 px-3 py-3 rounded text-left bg-transparent hover:bg-surface-container-high transition-colors cursor-pointer"
                  >
                    <span className={`material-symbols-outlined text-base w-7 h-7 rounded flex items-center justify-center shrink-0 ${h.cls}`}>
                      {h.icon}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="text-sm font-bold text-on-surface">{t.name}</span>
                        <span className="text-[11px] text-on-surface-variant">{h.label}</span>
                      </div>
                      {/* One line of the prompt, so the list reads as content
                          rather than filenames. Two on phones, where the line
                          is short enough that one says almost nothing. */}
                      <p className="text-xs text-on-surface-variant/70 mt-0.5 line-clamp-2 sm:line-clamp-1">
                        {plain(t.content)}
                      </p>
                      {/* Phone: author below the content. A right-hand column
                          at this width takes 40% of the row and leaves the
                          title wrapping in the remainder. */}
                      <p className="sm:hidden text-[11px] text-on-surface-variant/70 mt-1.5 truncate">
                        {t.author}
                        <span className="opacity-40 mx-1.5">·</span>
                        {t.kind === 'external' && <span className="text-primary/70 mr-1">公司</span>}
                        {t.org}
                      </p>
                    </div>
                    <div className="hidden sm:block text-right shrink-0 max-w-[40%]">
                      <p className="text-xs text-on-surface truncate">{t.author}</p>
                      <p className="text-[11px] text-on-surface-variant/70 truncate" title={t.orgPath || t.org}>
                        {t.kind === 'external' && (
                          <span className="text-primary/70 mr-1">公司</span>
                        )}
                        {t.org}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {entries.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 mt-4 pt-3 border-t border-outline-variant/10">
              <span className="text-xs text-on-surface-variant tabular-nums">
                共 {meta.total} 則 · 第 {(page - 1) * 10 + 1}–{Math.min(page * 10, meta.total)} 則
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="px-2.5 py-1.5 text-xs rounded bg-surface-container-highest text-on-surface-variant hover:text-on-surface disabled:opacity-30 cursor-pointer disabled:cursor-default"
                >
                  上一頁
                </button>
                <span className="text-xs text-on-surface-variant tabular-nums">{page} / {meta.totalPages}</span>
                <button
                  onClick={() => setPage(p => Math.min(meta.totalPages, p + 1))}
                  disabled={page >= meta.totalPages}
                  className="px-2.5 py-1.5 text-xs rounded bg-surface-container-highest text-on-surface-variant hover:text-on-surface disabled:opacity-30 cursor-pointer disabled:cursor-default"
                >
                  下一頁
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Full prompt. Read-only: no save, no delete — see the file header. */}
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm p-0 sm:p-4"
          onClick={() => setOpen(null)}
        >
          <div
            className="w-full sm:max-w-2xl h-[92svh] sm:h-auto sm:max-h-[80vh] bg-surface rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-start gap-3 px-4 sm:px-5 py-4 border-b border-outline-variant/10">
              <span className={`material-symbols-outlined text-base w-8 h-8 rounded flex items-center justify-center shrink-0 ${(HOST_META[open.host] || HOST_META.all).cls}`}>
                {(HOST_META[open.host] || HOST_META.all).icon}
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-black text-on-surface">{open.name}</h3>
                <p className="text-xs text-on-surface-variant mt-1 flex items-baseline gap-1.5 min-w-0">
                  <span className="shrink-0 font-medium">{open.author}</span>
                  <span className="text-on-surface-variant/70 truncate" title={open.orgPath || open.org}>
                    {open.kind === 'external' ? '公司：' : ''}{open.org}
                  </span>
                  {open.domain && <span className="text-on-surface-variant/40 shrink-0">{open.domain}</span>}
                </p>
              </div>
              <button
                onClick={() => setOpen(null)}
                className="w-8 h-8 flex items-center justify-center rounded-lg bg-surface-container-high hover:bg-surface-container-highest text-on-surface-variant cursor-pointer shrink-0"
              >
                <span className="material-symbols-outlined text-sm">close</span>
              </button>
            </div>
            {/* Rendered, not raw: these prompts are written as markdown —
                section headings, bullet hierarchies, the occasional table —
                and a <pre> showed the asterisks instead of the structure they
                mark. `tmpl-md` sets it as the spec it is; see globals.css. */}
            <div className="px-4 sm:px-6 py-5 overflow-auto tmpl-md">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{asDocument(open.content)}</ReactMarkdown>
            </div>
            <div className="px-4 sm:px-5 py-3 border-t border-outline-variant/10 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <span className="text-[11px] text-on-surface-variant/60">
                建立 {new Date(open.created_at).toLocaleString('zh-TW')}
                {open.updated_at !== open.created_at && ` · 更新 ${new Date(open.updated_at).toLocaleString('zh-TW')}`}
              </span>
              <span className="text-[11px] text-on-surface-variant/50">僅供檢視</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
