'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAdminAuth } from '../components/AdminAuthProvider';
import { useTranslation } from '../../../i18n';
import { PRICING_MARKUP } from '../../../lib/pricing';

interface QuotaGroup {
  id: string;
  name: string;
  limit_usd: number;
  description: string | null;
  member_count: number;
  created_at: string;
}

interface GroupMember {
  id: string;
  email: string;
  display_name: string | null;
  status: string;
  quota_override: number | null;
  total_input: number;
  total_output: number;
}

interface UserOption {
  id: string;
  email: string;
  display_name: string | null;
  quota_group_id: string | null;
  quota_group_name: string | null;
}

const DEPLOY_MODE = process.env.NEXT_PUBLIC_DEPLOY_MODE || 'pro-panjit';
const IS_PANJIT = DEPLOY_MODE === 'pro-panjit';
const AD_DOMAIN_LIST: { code: string; label: string }[] = [
  { code: 'PANJIT', label: '台灣 PANJIT' },
  { code: 'PYNMAX', label: '環茂' },
  { code: 'WXPJ', label: '無錫強茂' },
  { code: 'PJWS', label: '強茂深圳' },
  { code: 'GDPJ', label: '蘇州群鑫' },
  { code: 'PJXZ', label: '強茂徐州' },
  { code: 'PJSD', label: '山東強茂' },
];

interface AdTreeMember {
  username: string;
  displayName: string;
  inSystem: boolean;
  userId: string | null;
  status: string | null;
  effectiveLimit: number;
}
interface AdTreeNodeT {
  name: string;
  type: string;
  members: AdTreeMember[];
  children: AdTreeNodeT[];
}
type AdPick = { username: string; domain: string; displayName: string; userId: string | null };

/** Does this node (or any descendant) match the search query? */
function adNodeMatches(node: AdTreeNodeT, lq: string): boolean {
  if (!lq) return true;
  if ((node.name || '').toLowerCase().includes(lq)) return true;
  if (node.members.some(m => m.displayName.toLowerCase().includes(lq) || m.username.toLowerCase().includes(lq))) return true;
  return node.children.some(c => adNodeMatches(c, lq));
}

/** Recursive org-tree row with selectable members + their quota. */
function AdTreeRow({ node, depth, query, domain, selected, onToggle }: {
  node: AdTreeNodeT; depth: number; query: string; domain: string;
  selected: Map<string, AdPick>; onToggle: (key: string, pick: AdPick) => void;
}) {
  const [open, setOpen] = useState(depth < 1);
  useEffect(() => { if (query) setOpen(true); }, [query]);
  const lq = query.toLowerCase();
  if (query && !adNodeMatches(node, lq)) return null;
  const hasChildren = node.children.length > 0;
  const showMembers = node.members.filter(m => !query || m.displayName.toLowerCase().includes(lq) || m.username.toLowerCase().includes(lq));
  return (
    <div>
      <div
        className="flex items-center gap-1.5 px-2 py-1.5 hover:bg-surface-container/50 transition-colors cursor-pointer select-none rounded"
        style={{ paddingLeft: `${depth * 14 + 4}px` }}
        onClick={() => setOpen(v => !v)}
      >
        <span className={`material-symbols-outlined text-[15px] text-on-surface-variant/50 transition-transform shrink-0 ${open ? 'rotate-90' : ''} ${!hasChildren && node.members.length === 0 ? 'opacity-0' : ''}`}>chevron_right</span>
        <span className={`material-symbols-outlined text-[16px] shrink-0 ${node.type === 'organization' ? 'text-primary' : 'text-tertiary/80'}`}>{node.type === 'organization' ? 'corporate_fare' : 'folder'}</span>
        <span className="flex-1 text-xs font-bold text-on-surface truncate min-w-0">{node.name}</span>
      </div>
      {open && showMembers.map(m => {
        const key = `${domain}:${m.username}`;
        const checked = selected.has(key);
        return (
          <label key={m.username} className={`flex items-center gap-2.5 py-1.5 pr-2 rounded cursor-pointer transition-colors ${checked ? 'bg-primary/8' : 'hover:bg-surface-container/40'}`} style={{ paddingLeft: `${(depth + 1) * 14 + 8}px` }}>
            <div className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 ${checked ? 'bg-primary border-primary' : 'border-outline-variant/30 bg-surface-container-highest'}`}>
              {checked && <span className="material-symbols-outlined text-on-primary text-[12px]">check</span>}
            </div>
            <input type="checkbox" checked={checked} onChange={() => onToggle(key, { username: m.username, domain, displayName: m.displayName, userId: m.userId })} className="sr-only" />
            <span className="material-symbols-outlined text-[14px] text-on-surface-variant/40 shrink-0">person</span>
            <span className="text-sm text-on-surface flex-1 min-w-0 truncate">{m.displayName}</span>
            <span className="text-xs font-mono text-on-surface-variant/50 shrink-0 hidden sm:inline">{m.username}</span>
            <span className="text-xs font-mono text-on-surface shrink-0 w-9 text-right">${m.effectiveLimit}</span>
            <span className={`text-[10px] shrink-0 w-10 text-right ${m.inSystem ? 'text-on-surface-variant/50' : 'text-tertiary'}`}>{m.inSystem ? '已加入' : '未加入'}</span>
          </label>
        );
      })}
      {open && node.children.map((c, i) => (
        <AdTreeRow key={i} node={c} depth={depth + 1} query={query} domain={domain} selected={selected} onToggle={onToggle} />
      ))}
    </div>
  );
}

function calcCost(input: number, output: number): number {
  return ((input / 1_000_000 * 3) + (output / 1_000_000 * 15)) * PRICING_MARKUP;
}

export default function AdminQuotaGroups() {
  return <QuotaGroupsContent />;
}

function QuotaGroupsContent() {
  const { token, isReadonly, canOperate } = useAdminAuth();
  const canEdit = !isReadonly || canOperate('quota-groups');
  const { t } = useTranslation();
  const [groups, setGroups] = useState<QuotaGroup[]>([]);
  const [loading, setLoading] = useState(true);

  // Modal state
  const [showForm, setShowForm] = useState(false);
  const [editTarget, setEditTarget] = useState<QuotaGroup | null>(null);
  const [formName, setFormName] = useState('');
  const [formLimit, setFormLimit] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [saving, setSaving] = useState(false);

  // Delete
  const [deleteTarget, setDeleteTarget] = useState<QuotaGroup | null>(null);

  // Expanded group + members
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [memberShowCount, setMemberShowCount] = useState(10);
  const MEMBER_PAGE_SIZE = 10;

  // Assign modal
  const [showAssign, setShowAssign] = useState(false);
  const [allUsers, setAllUsers] = useState<UserOption[]>([]);
  const [assignSearch, setAssignSearch] = useState('');
  const [assignSelected, setAssignSelected] = useState<Set<string>>(new Set());
  const [assigning, setAssigning] = useState(false);

  // AD picker (pro-panjit): pick people straight from the directory, with their
  // current quota shown, and provision them into the system on confirm.
  const [adDomain, setAdDomain] = useState(AD_DOMAIN_LIST[0].code);
  const [adTree, setAdTree] = useState<AdTreeNodeT | null>(null);
  const [adLoading, setAdLoading] = useState(false);
  const [adSelected, setAdSelected] = useState<Map<string, AdPick>>(new Map());
  const [adDomainOpen, setAdDomainOpen] = useState(false);

  const fetchGroups = useCallback(() => {
    if (!token) return;
    fetch('/api/admin/quota-groups', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(data => { setGroups(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, [token]);

  useEffect(() => { fetchGroups(); }, [fetchGroups]);

  const fetchMembers = useCallback((groupId: string) => {
    if (!token) return;
    setMembersLoading(true);
    fetch(`/api/admin/quota-groups/${groupId}/members`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(data => { setMembers(data); setMembersLoading(false); })
      .catch(() => setMembersLoading(false));
  }, [token]);

  function openCreate() {
    setEditTarget(null);
    setFormName(''); setFormLimit(''); setFormDesc('');
    setShowForm(true);
  }

  function openEdit(g: QuotaGroup) {
    setEditTarget(g);
    setFormName(g.name);
    setFormLimit(String(g.limit_usd));
    setFormDesc(g.description || '');
    setShowForm(true);
  }

  async function handleSave() {
    if (!token || saving) return;
    const limit_usd = parseFloat(formLimit);
    if (!formName.trim() || isNaN(limit_usd) || limit_usd < 0) return;
    setSaving(true);
    try {
      const body = { name: formName.trim(), limit_usd, description: formDesc.trim() || null };
      if (editTarget) {
        await fetch(`/api/admin/quota-groups/${editTarget.id}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } else {
        await fetch('/api/admin/quota-groups', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      }
      setShowForm(false);
      fetchGroups();
    } finally { setSaving(false); }
  }

  async function handleDelete() {
    if (!token || !deleteTarget) return;
    await fetch(`/api/admin/quota-groups/${deleteTarget.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    setDeleteTarget(null);
    if (expandedId === deleteTarget.id) { setExpandedId(null); setMembers([]); }
    fetchGroups();
  }

  function toggleExpand(groupId: string) {
    if (expandedId === groupId) {
      setExpandedId(null);
      setMembers([]);
    } else {
      setExpandedId(groupId);
      setMemberShowCount(MEMBER_PAGE_SIZE);
      fetchMembers(groupId);
    }
  }

  function openAssignModal(_groupId: string) {
    if (!token) return;
    setShowAssign(true);
    setAssignSearch('');
    setAssignSelected(new Set());
    setAllUsers([]);
    setAdSelected(new Map());
    setAdDomain(AD_DOMAIN_LIST[0].code);
    setAdTree(null);
    setAdDomainOpen(false);
  }

  // Load users for the assign modal via SERVER-SIDE search, so members beyond
  // the first page are still found. (The /users endpoint caps limit at 100, so
  // a client-side filter over a single page silently misses older accounts.)
  useEffect(() => {
    if (IS_PANJIT || !showAssign || !token) return; // pro-panjit uses the AD picker below
    const q = assignSearch.trim();
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const url = `/api/admin/users?limit=100${q ? `&search=${encodeURIComponent(q)}` : ''}`;
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal });
        const data = await res.json();
        setAllUsers((data.users || []).map((u: any) => ({
          id: u.id, email: u.email, display_name: u.display_name,
          quota_group_id: u.quota_group_id, quota_group_name: u.quota_group_name,
        })));
      } catch { /* aborted / failed */ }
    }, q ? 250 : 0);
    return () => { clearTimeout(timer); ctrl.abort(); };
  }, [showAssign, assignSearch, token]);

  // pro-panjit: load AD directory members for the selected company (with their
  // current system quota). Search is client-side over the loaded company list.
  useEffect(() => {
    if (!IS_PANJIT || !showAssign || !token) return;
    setAdLoading(true);
    fetch(`/api/admin/ad/members?domain=${adDomain}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => setAdTree(d.tree || null))
      .catch(() => setAdTree(null))
      .finally(() => setAdLoading(false));
  }, [showAssign, adDomain, token]);

  async function handleAssign() {
    if (!token || !expandedId || assigning) return;

    // pro-panjit: provision AD-only picks into the system first, then assign.
    if (IS_PANJIT) {
      if (adSelected.size === 0) return;
      setAssigning(true);
      try {
        const ids: string[] = [];
        for (const m of adSelected.values()) {
          if (m.userId) { ids.push(m.userId); continue; }
          const res = await fetch('/api/admin/users/provision-ad', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: m.username, domain: m.domain, displayName: m.displayName }),
          });
          if (res.ok) { const d = await res.json().catch(() => null); if (d?.id) ids.push(d.id); }
        }
        if (ids.length) {
          await fetch(`/api/admin/quota-groups/${expandedId}/assign`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ userIds: ids }),
          });
        }
        setShowAssign(false);
        fetchGroups();
        fetchMembers(expandedId);
      } finally { setAssigning(false); }
      return;
    }

    if (assignSelected.size === 0) return;
    setAssigning(true);
    try {
      await fetch(`/api/admin/quota-groups/${expandedId}/assign`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ userIds: Array.from(assignSelected) }),
      });
      setShowAssign(false);
      fetchGroups();
      fetchMembers(expandedId);
    } finally { setAssigning(false); }
  }

  async function handleUnassign(userIds: string[]) {
    if (!token || !expandedId) return;
    await fetch('/api/admin/quota-groups/unassign', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ userIds }),
    });
    fetchGroups();
    fetchMembers(expandedId);
  }

  // The server already filters by `assignSearch` (see the effect above), so the
  // list reflects whole-table search results — no client-side filtering needed.
  const assignFiltered = allUsers;

  return (
    <>
      {/* Sticky Header */}
      <header className="sticky top-0 h-14 md:h-16 bg-surface/80 backdrop-blur-xl flex justify-between items-center px-4 md:px-8 z-40 shadow-[0_1px_0_0_rgba(255,255,255,0.05)]">
        <div className="flex items-center gap-2 md:gap-4 min-w-0">
          <span className="text-base md:text-lg font-black text-on-surface font-headline shrink-0">{t('admin.quotaGroups.title' as any)}</span>
          <span className="hidden md:inline text-sm text-on-surface-variant font-mono truncate">{t('admin.quotaGroups.description' as any)}</span>
        </div>
        {canEdit && (
          <button
            onClick={openCreate}
            className="flex items-center gap-1.5 ml-3 px-3 md:px-4 py-2 md:py-2.5 cyber-gradient rounded-xl text-on-primary text-xs md:text-sm font-headline font-bold hover:brightness-110 active:scale-95 transition-all cursor-pointer shrink-0"
          >
            <span className="material-symbols-outlined text-lg">add</span>
            <span className="hidden sm:inline">{t('admin.quotaGroups.create' as any)}</span>
          </button>
        )}
      </header>

      <div className="flex-1 p-4 md:p-8 space-y-4 md:space-y-6 overflow-y-auto">
      {/* Groups List */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
        </div>
      ) : groups.length === 0 ? (
        <div className="text-center py-16 bg-surface-container rounded-xl border border-outline-variant/10">
          <span className="material-symbols-outlined text-4xl text-on-surface-variant/30 mb-3 block">category</span>
          <p className="text-sm text-on-surface-variant">{t('admin.quotaGroups.empty' as any)}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map(g => (
            <div key={g.id} className="bg-surface-container rounded-xl border border-outline-variant/10 overflow-hidden">
              {/* Group Card */}
              <div
                className="flex items-center gap-3 md:gap-4 px-3 md:px-5 py-3 md:py-4 cursor-pointer hover:bg-surface-container-high/30 transition-colors"
                onClick={() => toggleExpand(g.id)}
              >
                <div className="w-9 h-9 md:w-11 md:h-11 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                  <span className="material-symbols-outlined text-primary text-xl md:text-2xl">category</span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-bold text-on-surface truncate">{g.name}</h3>
                    <span className="px-2 py-0.5 bg-primary/10 text-primary text-xs font-bold rounded-full shrink-0">
                      ${g.limit_usd}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 mt-0.5 text-xs text-on-surface-variant">
                    <span className="flex items-center gap-1">
                      <span className="material-symbols-outlined text-xs">group</span>
                      {t('admin.quotaGroups.memberCount' as any, { count: g.member_count })}
                    </span>
                    {g.description && <span className="hidden md:inline truncate">{g.description}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-0.5 md:gap-1 shrink-0">
                  {canEdit && (<>
                    <button
                      onClick={e => { e.stopPropagation(); openEdit(g); }}
                      className="w-7 h-7 md:w-8 md:h-8 flex items-center justify-center rounded-lg text-on-surface-variant hover:text-primary hover:bg-primary/10 transition-colors cursor-pointer"
                    >
                      <span className="material-symbols-outlined text-base md:text-lg">edit</span>
                    </button>
                    <button
                      onClick={e => { e.stopPropagation(); setDeleteTarget(g); }}
                      className="w-7 h-7 md:w-8 md:h-8 flex items-center justify-center rounded-lg text-on-surface-variant hover:text-error hover:bg-error/10 transition-colors cursor-pointer"
                    >
                      <span className="material-symbols-outlined text-base md:text-lg">delete</span>
                    </button>
                  </>)}
                  <span className={`material-symbols-outlined text-on-surface-variant text-base md:text-lg transition-transform ${expandedId === g.id ? 'rotate-180' : ''}`}>
                    expand_more
                  </span>
                </div>
              </div>

              {/* Expanded Members */}
              {expandedId === g.id && (
                <div className="border-t border-outline-variant/10 bg-surface-container-low/30">
                  <div className="flex items-center justify-between px-3 md:px-5 py-3">
                    <span className="text-xs font-bold text-on-surface-variant uppercase tracking-widest">
                      {t('admin.quotaGroups.members' as any)}
                    </span>
                    {canEdit && (
                      <button
                        onClick={() => openAssignModal(g.id)}
                        className="flex items-center gap-1 px-3 py-1.5 text-xs font-bold text-primary hover:bg-primary/10 rounded-lg transition-colors cursor-pointer"
                      >
                        <span className="material-symbols-outlined text-sm">person_add</span>
                        {t('admin.quotaGroups.assign' as any)}
                      </button>
                    )}
                  </div>
                  {membersLoading ? (
                    <div className="flex justify-center py-6">
                      <div className="w-6 h-6 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                    </div>
                  ) : members.length === 0 ? (
                    <p className="text-center py-6 text-xs text-on-surface-variant">{t('admin.quotaGroups.noMembers' as any)}</p>
                  ) : (
                    <div className="divide-y divide-outline-variant/10">
                      {members.slice(0, memberShowCount).map(m => {
                        const cost = calcCost(m.total_input, m.total_output);
                        const effectiveLimit = m.quota_override != null ? m.quota_override : g.limit_usd;
                        const pct = effectiveLimit > 0 ? Math.min(cost / effectiveLimit * 100, 100) : 0;
                        return (
                          <div key={m.id} className="flex items-start md:items-center gap-2.5 md:gap-3 px-3 md:px-5 py-3 hover:bg-surface-container/50 transition-colors group">
                            <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-xs font-bold text-primary shrink-0 mt-0.5 md:mt-0">
                              {(m.display_name || m.email).slice(0, 1).toUpperCase()}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <p className="text-sm text-on-surface truncate font-medium">{m.display_name || m.email.split('@')[0]}</p>
                                {m.quota_override != null && (
                                  // Named group (group/tip) so the tooltip reacts to hovering the
                                  // badge only, not the whole row (which uses the unnamed `group`).
                                  // Tooltip opens UPWARD because the card is overflow-hidden and a
                                  // downward tooltip on the last member would be clipped.
                                  <span className="relative inline-flex group/tip shrink-0">
                                    <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 bg-orange-500/10 text-orange-400 rounded-full cursor-help">
                                      {t('admin.quotaGroups.source.personal' as any)} ${m.quota_override}
                                      <span className="material-symbols-outlined text-[12px] leading-none">info</span>
                                    </span>
                                    <span
                                      role="tooltip"
                                      className="pointer-events-none absolute bottom-full left-0 mb-2 z-50 w-56 opacity-0 translate-y-1 group-hover/tip:opacity-100 group-hover/tip:translate-y-0 transition-all duration-150"
                                    >
                                      <span className="relative block rounded-lg bg-slate-800 text-slate-100 px-3 py-2 text-[11px] leading-relaxed shadow-xl ring-1 ring-black/10">
                                        {t('admin.quotaGroups.source.personalHint' as any)}
                                        {/* downward caret pointing at the badge */}
                                        <span className="absolute left-4 top-full w-2.5 h-2.5 -translate-y-1/2 rotate-45 bg-slate-800" />
                                      </span>
                                    </span>
                                  </span>
                                )}
                              </div>
                              <p className="text-xs text-on-surface-variant/60 truncate">{m.email}</p>
                              {/* Mobile: cost + progress below name */}
                              <div className="flex items-center gap-2 mt-1.5 md:hidden">
                                <div className="flex-1 h-1.5 bg-surface-container-highest rounded-full overflow-hidden">
                                  <div
                                    className={`h-full rounded-full transition-all ${pct >= 80 ? 'bg-error' : pct >= 50 ? 'bg-warning' : 'bg-primary'}`}
                                    style={{ width: `${pct}%` }}
                                  />
                                </div>
                                <span className="text-[11px] font-mono text-on-surface-variant shrink-0">
                                  <span className={pct >= 80 ? 'text-error' : pct >= 50 ? 'text-warning' : ''}>${cost.toFixed(2)}</span>
                                  <span className="text-on-surface-variant/40">/{effectiveLimit}</span>
                                </span>
                              </div>
                            </div>
                            {/* Desktop: cost + progress on right */}
                            <div className="hidden md:flex flex-col items-end gap-1 shrink-0 min-w-[100px]">
                              <span className="text-xs font-mono text-on-surface-variant">
                                <span className={pct >= 80 ? 'text-error font-bold' : pct >= 50 ? 'text-warning font-bold' : ''}>${cost.toFixed(2)}</span>
                                <span className="text-on-surface-variant/40"> / ${effectiveLimit}</span>
                              </span>
                              <div className="w-full h-1.5 bg-surface-container-highest rounded-full overflow-hidden">
                                <div
                                  className={`h-full rounded-full transition-all ${pct >= 80 ? 'bg-error' : pct >= 50 ? 'bg-warning' : 'bg-primary'}`}
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                            </div>
                            {canEdit && (
                              <button
                                onClick={() => handleUnassign([m.id])}
                                className="w-7 h-7 flex items-center justify-center rounded-lg text-on-surface-variant/40 hover:text-error hover:bg-error/10 transition-colors cursor-pointer md:opacity-0 md:group-hover:opacity-100 shrink-0"
                              >
                                <span className="material-symbols-outlined text-sm">close</span>
                              </button>
                            )}
                          </div>
                        );
                      })}
                      {members.length > memberShowCount && (
                        <button
                          onClick={() => setMemberShowCount(prev => prev + MEMBER_PAGE_SIZE)}
                          className="w-full py-3 text-xs font-bold text-primary hover:bg-primary/5 transition-colors cursor-pointer flex items-center justify-center gap-1"
                        >
                          <span className="material-symbols-outlined text-sm">expand_more</span>
                          {t('admin.quotaGroups.showMore' as any, { remaining: members.length - memberShowCount })}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Create/Edit Modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={() => setShowForm(false)}>
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
          <div className="relative bg-surface-container rounded-2xl p-6 border border-outline-variant/20 shadow-2xl w-full max-w-md mx-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-headline font-bold text-on-surface mb-5">
              {editTarget ? t('admin.quotaGroups.edit' as any) : t('admin.quotaGroups.create' as any)}
            </h3>
            <div className="space-y-4">
              <div>
                <label className="text-xs font-bold text-on-surface-variant uppercase tracking-widest block mb-1.5">
                  {t('admin.quotaGroups.name' as any)}
                </label>
                <input
                  type="text"
                  value={formName}
                  onChange={e => setFormName(e.target.value)}
                  placeholder={t('admin.quotaGroups.namePlaceholder' as any)}
                  className="w-full bg-surface-container-highest border border-outline-variant/20 rounded-lg py-2.5 px-3 text-sm text-on-surface placeholder:text-on-surface-variant/40 focus:ring-1 focus:ring-primary/30 focus:border-primary/40 outline-none"
                />
              </div>
              <div>
                <label className="text-xs font-bold text-on-surface-variant uppercase tracking-widest block mb-1.5">
                  {t('admin.quotaGroups.limit' as any)} (USD)
                </label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={formLimit}
                  onChange={e => setFormLimit(e.target.value)}
                  placeholder="50"
                  className="w-full bg-surface-container-highest border border-outline-variant/20 rounded-lg py-2.5 px-3 text-sm text-on-surface placeholder:text-on-surface-variant/40 focus:ring-1 focus:ring-primary/30 focus:border-primary/40 outline-none"
                />
              </div>
              <div>
                <label className="text-xs font-bold text-on-surface-variant uppercase tracking-widest block mb-1.5">
                  {t('admin.quotaGroups.descriptionLabel' as any)}
                </label>
                <input
                  type="text"
                  value={formDesc}
                  onChange={e => setFormDesc(e.target.value)}
                  placeholder={t('admin.quotaGroups.descriptionPlaceholder' as any)}
                  className="w-full bg-surface-container-highest border border-outline-variant/20 rounded-lg py-2.5 px-3 text-sm text-on-surface placeholder:text-on-surface-variant/40 focus:ring-1 focus:ring-primary/30 focus:border-primary/40 outline-none"
                />
              </div>
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => setShowForm(false)}
                className="px-4 py-2 text-sm text-on-surface-variant hover:text-on-surface transition-colors cursor-pointer"
              >
                {t('common.cancel' as any)}
              </button>
              <button
                onClick={handleSave}
                disabled={saving || !formName.trim() || !formLimit}
                className="px-5 py-2 cyber-gradient text-on-primary rounded-lg text-sm font-bold cursor-pointer hover:brightness-110 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {saving ? '...' : t('common.save' as any)}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirm Modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={() => setDeleteTarget(null)}>
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
          <div className="relative bg-surface-container rounded-2xl p-6 border border-outline-variant/20 shadow-2xl w-full max-w-sm mx-4 text-center" onClick={e => e.stopPropagation()}>
            <div className="w-14 h-14 rounded-full bg-error/10 flex items-center justify-center mx-auto mb-4">
              <span className="material-symbols-outlined text-error text-3xl">delete_forever</span>
            </div>
            <h3 className="text-base font-headline font-bold text-on-surface mb-2">{t('admin.quotaGroups.deleteConfirm' as any)}</h3>
            <p className="text-sm text-on-surface-variant mb-1">
              {deleteTarget.name} (${deleteTarget.limit_usd})
            </p>
            <p className="text-xs text-on-surface-variant/60 mb-5">
              {t('admin.quotaGroups.deleteHint' as any, { count: deleteTarget.member_count })}
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setDeleteTarget(null)}
                className="flex-1 py-2.5 bg-surface-container-highest border border-outline-variant/10 text-on-surface font-bold text-sm rounded-lg cursor-pointer hover:bg-surface-variant transition-colors"
              >
                {t('common.cancel' as any)}
              </button>
              <button
                onClick={handleDelete}
                className="flex-1 py-2.5 bg-error text-on-error font-bold text-sm rounded-lg cursor-pointer hover:bg-error/80 transition-colors"
              >
                {t('common.delete' as any)}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Assign Users Modal */}
      {showAssign && (
        <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center" onClick={() => setShowAssign(false)}>
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
          <div
            className="relative bg-surface-container rounded-t-2xl md:rounded-2xl p-5 md:p-6 border border-outline-variant/20 shadow-2xl w-full md:max-w-2xl md:h-[78vh] max-h-[90vh] flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <h3 className="text-base font-headline font-bold text-on-surface mb-4">{t('admin.quotaGroups.assignModal.title' as any)}</h3>
            <div className="relative mb-3">
              <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant/50 text-lg">search</span>
              <input
                type="text"
                value={assignSearch}
                onChange={e => setAssignSearch(e.target.value)}
                placeholder={t('admin.quotaGroups.assignModal.search' as any)}
                className="w-full bg-surface-container-highest border border-outline-variant/20 rounded-lg pl-9 pr-3 py-2.5 text-sm text-on-surface placeholder:text-on-surface-variant/40 focus:ring-1 focus:ring-primary/30 focus:border-primary/40 outline-none"
              />
            </div>
            {IS_PANJIT && (
              <div className="relative mb-3">
                <button
                  type="button"
                  onClick={() => setAdDomainOpen(v => !v)}
                  className="w-full flex items-center justify-between gap-2 bg-surface-container-highest border border-outline-variant/20 rounded-lg px-3 py-2.5 text-sm text-on-surface hover:border-primary/40 transition-colors cursor-pointer"
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <span className="material-symbols-outlined text-[18px] text-primary shrink-0">corporate_fare</span>
                    <span className="font-medium truncate">{AD_DOMAIN_LIST.find(d => d.code === adDomain)?.label}</span>
                    <span className="text-xs text-on-surface-variant/50 font-mono shrink-0">{adDomain}</span>
                  </span>
                  <span className={`material-symbols-outlined text-[20px] text-on-surface-variant/60 transition-transform shrink-0 ${adDomainOpen ? 'rotate-180' : ''}`}>expand_more</span>
                </button>
                {adDomainOpen && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setAdDomainOpen(false)} />
                    <div className="absolute left-0 right-0 mt-1.5 z-20 bg-surface-container-high border border-outline-variant/20 rounded-xl shadow-2xl py-1.5 max-h-72 overflow-y-auto">
                      {AD_DOMAIN_LIST.map(({ code, label }) => {
                        const active = adDomain === code;
                        return (
                          <button
                            key={code}
                            type="button"
                            onClick={() => { setAdDomain(code); setAdDomainOpen(false); }}
                            className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-left transition-colors ${active ? 'bg-primary/10 text-primary' : 'text-on-surface hover:bg-surface-container-highest'}`}
                          >
                            <span className={`material-symbols-outlined text-[18px] shrink-0 ${active ? 'text-primary' : 'text-on-surface-variant/50'}`}>{active ? 'check_circle' : 'corporate_fare'}</span>
                            <span className="flex-1 font-medium truncate">{label}</span>
                            <span className="text-xs font-mono text-on-surface-variant/50 shrink-0">{code}</span>
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            )}
            <div className="flex-1 overflow-y-auto min-h-0 -mx-1 px-1">
              {IS_PANJIT ? (
                adLoading ? (
                  <div className="flex items-center justify-center py-10 gap-2 text-on-surface-variant text-sm">
                    <span className="material-symbols-outlined animate-spin text-primary">refresh</span>載入 {adDomain} 組織...
                  </div>
                ) : !adTree ? (
                  <div className="flex flex-col items-center justify-center py-10">
                    <span className="material-symbols-outlined text-3xl text-on-surface-variant/30 mb-2">person_off</span>
                    <p className="text-sm text-on-surface-variant">{t('admin.quotaGroups.assignModal.noUsers' as any)}</p>
                  </div>
                ) : (assignSearch.trim() && !adNodeMatches(adTree, assignSearch.trim().toLowerCase())) ? (
                  <div className="flex flex-col items-center justify-center py-10">
                    <span className="material-symbols-outlined text-3xl text-on-surface-variant/30 mb-2">search_off</span>
                    <p className="text-sm text-on-surface-variant">找不到符合「{assignSearch}」的人員</p>
                  </div>
                ) : (
                  <AdTreeRow
                    node={adTree}
                    depth={0}
                    query={assignSearch.trim()}
                    domain={adDomain}
                    selected={adSelected}
                    onToggle={(key, pick) => setAdSelected(prev => {
                      const next = new Map(prev);
                      if (next.has(key)) next.delete(key); else next.set(key, pick);
                      return next;
                    })}
                  />
                )
              ) : (
              assignFiltered.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10">
                  <span className="material-symbols-outlined text-3xl text-on-surface-variant/30 mb-2">person_off</span>
                  <p className="text-sm text-on-surface-variant">{t('admin.quotaGroups.assignModal.noUsers' as any)}</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {assignFiltered.map(u => {
                    const isInThisGroup = u.quota_group_id === expandedId;
                    const checked = assignSelected.has(u.id);
                    return (
                      <label
                        key={u.id}
                        className={`flex items-center gap-3 px-3 py-3 rounded-xl cursor-pointer transition-all ${
                          isInThisGroup
                            ? 'opacity-40 pointer-events-none bg-surface-container-low/30'
                            : checked
                            ? 'bg-primary/8 ring-1 ring-primary/20'
                            : 'hover:bg-surface-container-high/50'
                        }`}
                      >
                        <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 transition-all ${
                          checked || isInThisGroup
                            ? 'bg-primary border-primary'
                            : 'border-outline-variant/30 bg-surface-container-highest'
                        }`}>
                          {(checked || isInThisGroup) && (
                            <span className="material-symbols-outlined text-on-primary text-sm">check</span>
                          )}
                        </div>
                        <input
                          type="checkbox"
                          checked={checked || isInThisGroup}
                          disabled={isInThisGroup}
                          onChange={() => {
                            setAssignSelected(prev => {
                              const next = new Set(prev);
                              if (next.has(u.id)) next.delete(u.id); else next.add(u.id);
                              return next;
                            });
                          }}
                          className="sr-only"
                        />
                        <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-xs font-bold text-primary shrink-0">
                          {(u.display_name || u.email).slice(0, 1).toUpperCase()}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-on-surface truncate font-medium">{u.display_name || u.email.split('@')[0]}</p>
                          <p className="text-xs text-on-surface-variant/60 truncate">{u.email}</p>
                        </div>
                        {u.quota_group_id && u.quota_group_id !== expandedId && (
                          <span className="text-[10px] px-2 py-0.5 bg-surface-container-highest text-on-surface-variant rounded-full shrink-0 font-medium">
                            {u.quota_group_name}
                          </span>
                        )}
                        {isInThisGroup && (
                          <span className="text-[10px] px-2 py-0.5 bg-primary/10 text-primary rounded-full shrink-0 font-medium">
                            {t('admin.quotaGroups.assignModal.alreadyIn' as any)}
                          </span>
                        )}
                      </label>
                    );
                  })}
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between mt-4 pt-3 border-t border-outline-variant/10">
              <span className="text-xs text-on-surface-variant">
                {t('admin.quotaGroups.assignModal.selected' as any, { count: IS_PANJIT ? adSelected.size : assignSelected.size })}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowAssign(false)}
                  className="px-4 py-2 text-sm text-on-surface-variant hover:text-on-surface transition-colors cursor-pointer"
                >
                  {t('common.cancel' as any)}
                </button>
                <button
                  onClick={handleAssign}
                  disabled={assigning || (IS_PANJIT ? adSelected.size === 0 : assignSelected.size === 0)}
                  className="px-5 py-2 cyber-gradient text-on-primary rounded-lg text-sm font-bold cursor-pointer hover:brightness-110 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {assigning ? '...' : t('admin.quotaGroups.assignModal.confirm' as any)}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      </div>
    </>
  );
}
