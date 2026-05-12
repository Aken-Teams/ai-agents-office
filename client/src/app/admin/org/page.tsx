'use client';

import { useState, useEffect, useMemo } from 'react';
import { useAdminAuth } from '../components/AdminAuthProvider';

const DOMAINS: { code: string; label: string }[] = [
  { code: 'PANJIT', label: '台灣 PANJIT' },
  { code: 'PYNMAX', label: '環茂' },
  { code: 'WXPJ',   label: '無錫強茂' },
  { code: 'PJWS',   label: '強茂深圳' },
  { code: 'GDPJ',   label: '蘇州群鑫' },
  { code: 'PJXZ',   label: '強茂徐州' },
  { code: 'PJSD',   label: '山東強茂' },
];

interface OrgMember {
  username: string;
  displayName: string;
}

interface OrgNode {
  name: string;
  dn: string;
  type: 'organization' | 'ou';
  members: OrgMember[];
  memberCount: number;
  children: OrgNode[];
  childCount: number;
}

interface OrgTree {
  success: boolean;
  domain: string;
  cached: boolean;
  cachedAt: string | null;
  tree: OrgNode;
}

/** Recursively collect all members for search highlight */
function collectAllMembers(node: OrgNode): OrgMember[] {
  return [...node.members, ...node.children.flatMap(collectAllMembers)];
}

/** Count total members in subtree */
function countTotal(node: OrgNode): number {
  return node.memberCount + node.children.reduce((s, c) => s + countTotal(c), 0);
}

/** Check if node or any descendant matches the query */
function nodeMatchesQuery(node: OrgNode, q: string): boolean {
  if (!q) return true;
  const lq = q.toLowerCase();
  if (node.name.toLowerCase().includes(lq)) return true;
  if (node.members.some(m => (m.displayName ?? '').toLowerCase().includes(lq) || (m.username ?? '').toLowerCase().includes(lq))) return true;
  return node.children.some(c => nodeMatchesQuery(c, q));
}

function OrgNodeRow({
  node,
  depth,
  query,
  expandGen,
  collapseGen,
}: {
  node: OrgNode;
  depth: number;
  query: string;
  expandGen: number;
  collapseGen: number;
}) {
  const hasMatch = nodeMatchesQuery(node, query);
  const [open, setOpen] = useState(depth < 1);

  useEffect(() => {
    if (expandGen > 0) setOpen(true);
  }, [expandGen]);

  useEffect(() => {
    if (collapseGen > 0) setOpen(false);
  }, [collapseGen]);

  useEffect(() => {
    if (query) setOpen(true);
  }, [query]);

  if (query && !hasMatch) return null;

  const totalMembers = countTotal(node);
  const lq = query.toLowerCase();

  function highlight(text: string | null) {
    const safeText = text ?? '';
    if (!query) return safeText;
    const idx = safeText.toLowerCase().indexOf(lq);
    if (idx === -1) return safeText;
    return (
      <>
        {safeText.slice(0, idx)}
        <mark className="bg-tertiary/30 text-on-surface rounded-sm">{safeText.slice(idx, idx + query.length)}</mark>
        {safeText.slice(idx + query.length)}
      </>
    );
  }

  const hasChildren = node.children.length > 0;
  const showMembers = node.members.filter(m =>
    !query || (m.displayName ?? '').toLowerCase().includes(lq) || (m.username ?? '').toLowerCase().includes(lq)
  );

  return (
    <div>
      {/* OU Row */}
      <div
        className={`flex items-center gap-2 px-2 py-1.5 hover:bg-surface-container/50 transition-colors cursor-pointer select-none rounded group`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => setOpen(v => !v)}
      >
        {/* Expand icon */}
        <span className={`material-symbols-outlined text-[16px] text-on-surface-variant/50 transition-transform duration-150 shrink-0 ${open ? 'rotate-90' : ''} ${!hasChildren && node.members.length === 0 ? 'opacity-0' : ''}`}>
          chevron_right
        </span>
        {/* Folder icon */}
        <span className={`material-symbols-outlined text-[18px] shrink-0 ${node.type === 'organization' ? 'text-primary' : 'text-tertiary/80'}`}>
          {node.type === 'organization' ? 'corporate_fare' : 'folder'}
        </span>
        {/* Name */}
        <span className="flex-1 text-sm font-bold text-on-surface truncate min-w-0">
          {highlight(node.name)}
        </span>
        {/* Member count */}
        {totalMembers > 0 && (
          <span className="text-[10px] font-mono text-on-surface-variant/60 shrink-0">
            {totalMembers}人
          </span>
        )}
      </div>

      {/* Members list */}
      {open && showMembers.length > 0 && (
        <div className="space-y-0">
          {showMembers.map(m => (
            <div
              key={m.username}
              className="flex items-center gap-2 hover:bg-surface-container/30 transition-colors rounded"
              style={{ paddingLeft: `${(depth + 1) * 16 + 8}px`, paddingTop: '4px', paddingBottom: '4px', paddingRight: '8px' }}
            >
              <span className="material-symbols-outlined text-[15px] text-on-surface-variant/40 shrink-0">person</span>
              <span className="text-sm text-on-surface flex-1 min-w-0 truncate">{highlight(m.displayName)}</span>
              <span className="text-xs font-mono text-on-surface-variant/50 shrink-0">{highlight(m.username)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Children */}
      {open && node.children.map(child => (
        <OrgNodeRow
          key={child.dn}
          node={child}
          depth={depth + 1}
          query={query}
          expandGen={expandGen}
          collapseGen={collapseGen}
        />
      ))}
    </div>
  );
}

export default function AdminOrgChart() {
  const { token } = useAdminAuth();
  const [domain, setDomain] = useState(DOMAINS[0].code);
  const [data, setData] = useState<OrgTree | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [expandGen, setExpandGen] = useState(0);
  const [collapseGen, setCollapseGen] = useState(0);
  const isExpanded = expandGen > collapseGen;

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    setError('');
    setData(null);
    fetch(`/api/admin/org/tree?domain=${domain}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then((d: OrgTree) => {
        if (!d.success) throw new Error('API returned failure');
        setData(d);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [token, domain]);

  const allMembers = useMemo(() => data ? collectAllMembers(data.tree) : [], [data]);
  const totalCount = useMemo(() => data ? countTotal(data.tree) : 0, [data]);

  const filteredCount = useMemo(() => {
    if (!data || !query) return totalCount;
    const lq = query.toLowerCase();
    return allMembers.filter(m => (m.displayName ?? '').toLowerCase().includes(lq) || (m.username ?? '').toLowerCase().includes(lq)).length;
  }, [allMembers, query, totalCount, data]);

  return (
    <>
      {/* Header */}
      <header className="sticky top-0 z-40 bg-surface/90 backdrop-blur-xl shadow-[0_1px_0_0_rgba(255,255,255,0.05)]">

        {/* ── Desktop title + search row ── */}
        <div className="hidden md:flex items-center justify-between px-8 h-16 gap-4">
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-lg font-black text-on-surface font-headline">組織圖</span>
            <span className="text-[10px] px-2 py-0.5 bg-primary/10 text-primary rounded font-bold tracking-widest uppercase">AD</span>
          </div>
          {/* Search */}
          <div className="relative flex-1 max-w-xs">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline text-sm">search</span>
            <input
              type="text"
              placeholder="搜尋姓名 / 帳號..."
              value={query}
              onChange={e => setQuery(e.target.value)}
              className="w-full bg-surface-container-highest border-none focus:ring-1 focus:ring-primary/40 rounded py-2 pl-10 pr-4 text-sm text-on-surface placeholder:text-outline"
            />
            {query && (
              <button onClick={() => setQuery('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-outline hover:text-primary cursor-pointer transition-colors">
                <span className="material-symbols-outlined text-sm">close</span>
              </button>
            )}
          </div>
        </div>

        {/* ── Desktop domain tabs ── */}
        <div className="hidden md:flex gap-0 px-8 border-t border-outline-variant/10 overflow-x-auto scrollbar-none">
          {DOMAINS.map(({ code, label }) => (
            <button
              key={code}
              onClick={() => { setDomain(code); setQuery(''); setExpandGen(0); setCollapseGen(0); }}
              className={`px-3 py-2 flex flex-col items-center whitespace-nowrap cursor-pointer transition-colors border-b-2 ${
                domain === code ? 'text-primary border-primary' : 'text-on-surface-variant/60 border-transparent hover:text-on-surface'
              }`}
            >
              <span className="text-xs font-bold uppercase tracking-wider">{code}</span>
              <span className="text-[11px]">{label}</span>
            </button>
          ))}
        </div>

        {/* ── Mobile title row ── */}
        <div className="md:hidden flex items-center justify-between px-4 h-14 gap-3">
          <div className="flex items-center gap-2">
            <span className="text-base font-black text-on-surface font-headline">組織圖</span>
            <span className="text-[10px] px-2 py-0.5 bg-primary/10 text-primary rounded font-bold tracking-widest uppercase shrink-0">AD</span>
            {data && !loading && (
              <span className="text-xs text-on-surface-variant font-mono">
                共 {query ? <span className="text-tertiary">{filteredCount}/{totalCount}</span> : totalCount} 人
              </span>
            )}
          </div>
        </div>

        {/* ── Mobile search + domain chips ── */}
        <div className="md:hidden px-4 pb-2 space-y-2 border-t border-outline-variant/10 pt-2">
          <div className="relative">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline text-sm">search</span>
            <input
              type="text"
              placeholder="搜尋姓名 / 帳號..."
              value={query}
              onChange={e => setQuery(e.target.value)}
              className="w-full bg-surface-container-highest border-none focus:ring-1 focus:ring-primary/40 rounded py-2.5 pl-10 pr-9 text-sm text-on-surface placeholder:text-outline"
            />
            {query && (
              <button onClick={() => setQuery('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-outline hover:text-primary cursor-pointer transition-colors">
                <span className="material-symbols-outlined text-sm">close</span>
              </button>
            )}
          </div>
          <div className="overflow-hidden"><div className="overflow-x-auto scrollbar-none pb-4 -mb-4">
            <div className="flex w-max rounded-lg overflow-hidden border border-outline-variant/15">
              {DOMAINS.map(({ code, label }, i) => (
                <button
                  key={code}
                  onClick={() => { setDomain(code); setQuery(''); setExpandGen(0); setCollapseGen(0); }}
                  className={`shrink-0 px-3.5 py-2 text-xs font-bold whitespace-nowrap cursor-pointer transition-colors ${
                    i < DOMAINS.length - 1 ? 'border-r border-outline-variant/15' : ''
                  } ${
                    domain === code
                      ? 'bg-primary/15 text-primary'
                      : 'bg-surface-container text-on-surface-variant'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div></div>
        </div>

      </header>

      {/* Content */}
      <div className="p-3 md:p-8 flex-1">
        {/* Mobile: expand toggle + cache */}
        {data && !loading && (
          <div className="md:hidden flex items-center gap-2 mb-3 text-xs text-on-surface-variant/60 font-mono">
            {data.cached && data.cachedAt && (
              <span>快取 {new Date(data.cachedAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
            )}
            <button
              onClick={() => isExpanded ? setCollapseGen(v => v + 1) : setExpandGen(v => v + 1)}
              className="flex items-center gap-1 hover:text-primary transition-colors cursor-pointer ml-auto"
            >
              <span className="material-symbols-outlined text-sm">{isExpanded ? 'unfold_less' : 'unfold_more'}</span>
              {isExpanded ? '全部收合' : '全部展開'}
            </button>
          </div>
        )}
        {/* Desktop: stats bar */}
        {data && !loading && (
          <div className="hidden md:flex items-center gap-4 mb-4 text-xs text-on-surface-variant/60 font-mono">
            <span>{DOMAINS.find(d => d.code === domain)?.label ?? domain} · 共 {totalCount} 人</span>
            {query && <span className="text-tertiary">搜尋：{filteredCount} 筆符合</span>}
            {data.cached && data.cachedAt && (
              <span>快取於 {new Date(data.cachedAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
            )}
            <button
              onClick={() => isExpanded ? setCollapseGen(v => v + 1) : setExpandGen(v => v + 1)}
              className="flex items-center gap-1 hover:text-primary transition-colors cursor-pointer ml-auto"
            >
              <span className="material-symbols-outlined text-sm">{isExpanded ? 'unfold_less' : 'unfold_more'}</span>
              {isExpanded ? '全部收合' : '全部展開'}
            </button>
          </div>
        )}

        {loading && (
          <div className="flex items-center justify-center h-40 gap-2 text-on-surface-variant text-sm">
            <span className="material-symbols-outlined animate-spin text-primary">refresh</span>
            載入 {domain} 組織圖...
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 p-4 bg-error/10 text-error text-sm rounded">
            <span className="material-symbols-outlined text-sm">error</span>
            {error}
          </div>
        )}

        {data && !loading && (
          <div className="bg-surface-container rounded-lg overflow-hidden">
            <OrgNodeRow
              node={data.tree}
              depth={0}
              query={query}
              expandGen={expandGen}
              collapseGen={collapseGen}
            />
            {query && filteredCount === 0 && (
              <div className="flex items-center justify-center gap-2 py-12 text-on-surface-variant text-sm">
                <span className="material-symbols-outlined">search_off</span>
                找不到符合「{query}」的結果
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
