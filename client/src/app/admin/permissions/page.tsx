'use client';

import React, { useState, useEffect } from 'react';
import { useAdminAuth } from '../components/AdminAuthProvider';
import { useTranslation } from '../../../i18n';

interface RolePermissions {
  adminSidebar: { readonly: string[]; readonlyOperate?: string[] };
  frontendNav: { user: string[]; readonly: string[] };
  features: { user: string[]; readonly: string[] };
}

type ReadonlyState = 'hidden' | 'view' | 'operate';

// Admin sidebar items grouped by section
const ADMIN_SIDEBAR_GROUPS = [
  {
    id: 'pinned',
    labelKey: 'admin.permissions.group.general',
    icon: 'dashboard',
    items: [
      { key: 'overview', labelKey: 'admin.sidebar.overview', descKey: 'admin.permissions.desc.overview', icon: 'dashboard' },
    ],
  },
  {
    id: 'members',
    labelKey: 'admin.sidebar.group.members',
    icon: 'people',
    items: [
      { key: 'org', labelKey: 'admin.sidebar.orgChart', descKey: 'admin.permissions.desc.org', icon: 'account_tree', deployMode: 'panjit' as const },
      { key: 'users', labelKey: 'admin.sidebar.users', descKey: 'admin.permissions.desc.users', icon: 'corporate_fare' },
      { key: 'conversations', labelKey: 'admin.sidebar.conversations', descKey: 'admin.permissions.desc.conversations', icon: 'forum' },
      { key: 'quota-groups', labelKey: 'admin.sidebar.quotaGroups', descKey: 'admin.permissions.desc.quotaGroups', icon: 'category' },
      { key: 'quota-requests', labelKey: 'admin.sidebar.quotaRequests', descKey: 'admin.permissions.desc.quotaRequests', icon: 'request_quote' },
      { key: 'invite-codes', labelKey: 'admin.sidebar.inviteCodes', descKey: 'admin.permissions.desc.inviteCodes', icon: 'card_membership', deployMode: 'out' as const },
    ],
  },
  {
    id: 'operations',
    labelKey: 'admin.sidebar.group.operations',
    icon: 'tune',
    items: [
      { key: 'announcements', labelKey: 'admin.sidebar.announcements', descKey: 'admin.permissions.desc.announcements', icon: 'campaign' },
      { key: 'terms', labelKey: 'admin.sidebar.terms', descKey: 'admin.permissions.desc.terms', icon: 'gavel', deployMode: 'panjit' as const },
      { key: 'skills', labelKey: 'admin.sidebar.skills', descKey: 'admin.permissions.desc.skills', icon: 'hub' },
      { key: 'tokens', labelKey: 'admin.sidebar.tokens', descKey: 'admin.permissions.desc.tokens', icon: 'payments' },
      { key: 'analytics', labelKey: 'admin.sidebar.analytics', descKey: 'admin.permissions.desc.analytics', icon: 'bar_chart' },
    ],
  },
  {
    id: 'system',
    labelKey: 'admin.sidebar.group.system',
    icon: 'settings',
    items: [
      { key: 'security', labelKey: 'admin.sidebar.security', descKey: 'admin.permissions.desc.security', icon: 'shield_with_heart' },
      { key: 'settings', labelKey: 'admin.sidebar.settings', descKey: 'admin.permissions.desc.settings', icon: 'settings' },
    ],
  },
] as const;

const FRONTEND_NAV_ITEMS = [
  { key: 'dashboard', labelKey: 'nav.dashboard', descKey: 'admin.permissions.desc.nav.dashboard', icon: 'dashboard' },
  { key: 'assistant', labelKey: 'nav.assistant', descKey: 'admin.permissions.desc.nav.assistant', icon: 'smart_toy' },
  { key: 'conversations', labelKey: 'nav.conversations', descKey: 'admin.permissions.desc.nav.conversations', icon: 'forum' },
  { key: 'files', labelKey: 'nav.files', descKey: 'admin.permissions.desc.nav.files', icon: 'folder' },
  { key: 'usage', labelKey: 'nav.usage', descKey: 'admin.permissions.desc.nav.usage', icon: 'bar_chart' },
  { key: 'memories', labelKey: 'nav.memories', descKey: 'admin.permissions.desc.nav.memories', icon: 'psychology' },
  { key: 'guide', labelKey: 'nav.guide', descKey: 'admin.permissions.desc.nav.guide', icon: 'menu_book' },
] as const;

const FEATURE_ITEMS = [
  { key: 'email-agent', label: 'Email Agent', descKey: 'admin.permissions.desc.feature.emailAgent', icon: 'mail' },
] as const;

const DEPLOY_MODE_LABELS: Record<string, { label: string; color: string }> = {
  panjit: { label: 'Panjit', color: 'bg-primary/10 text-primary' },
  out: { label: 'External', color: 'bg-tertiary/10 text-tertiary' },
};

export default function AdminPermissions() {
  const { token, isReadonly } = useAdminAuth();
  const { t } = useTranslation();
  const [perms, setPerms] = useState<RolePermissions | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!token) return;
    fetch('/api/admin/permissions', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(setPerms)
      .catch(console.error);
  }, [token]);

  if (isReadonly) return null;
  if (!perms) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // Ensure readonlyOperate exists
  if (!perms.adminSidebar.readonlyOperate) {
    perms.adminSidebar.readonlyOperate = [];
  }

  function getReadonlyState(key: string): ReadonlyState {
    if (!perms) return 'hidden';
    if (perms.adminSidebar.readonlyOperate?.includes(key)) return 'operate';
    if (perms.adminSidebar.readonly.includes(key)) return 'view';
    return 'hidden';
  }

  function setReadonlyState(key: string, state: ReadonlyState) {
    setPerms(prev => {
      if (!prev) return prev;
      const updated = JSON.parse(JSON.stringify(prev)) as RolePermissions;
      if (!updated.adminSidebar.readonlyOperate) updated.adminSidebar.readonlyOperate = [];
      updated.adminSidebar.readonly = updated.adminSidebar.readonly.filter(k => k !== key);
      updated.adminSidebar.readonlyOperate = updated.adminSidebar.readonlyOperate.filter(k => k !== key);
      if (state === 'view') {
        updated.adminSidebar.readonly.push(key);
      } else if (state === 'operate') {
        updated.adminSidebar.readonly.push(key);
        updated.adminSidebar.readonlyOperate.push(key);
      }
      return updated;
    });
    setSaved(false);
  }

  function toggle(category: 'frontendNav' | 'features', role: 'readonly' | 'user', key: string) {
    setPerms(prev => {
      if (!prev) return prev;
      const updated = JSON.parse(JSON.stringify(prev)) as RolePermissions;
      const list = (updated[category] as any)[role] as string[];
      const idx = list.indexOf(key);
      if (idx >= 0) list.splice(idx, 1); else list.push(key);
      return updated;
    });
    setSaved(false);
  }

  async function handleSave() {
    if (!token || !perms || saving) return;
    setSaving(true);
    try {
      const res = await fetch('/api/admin/permissions', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(perms),
      });
      if (res.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } catch { /* ignore */ }
    setSaving(false);
  }

  function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: () => void }) {
    return (
      <button
        onClick={onChange}
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors cursor-pointer ${
          checked ? 'bg-primary' : 'bg-outline/30'
        }`}
      >
        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
          checked ? 'translate-x-6' : 'translate-x-1'
        }`} />
      </button>
    );
  }

  function StateSelector({ state, onChange }: { state: ReadonlyState; onChange: (s: ReadonlyState) => void }) {
    const states: { value: ReadonlyState; labelKey: string; icon: string }[] = [
      { value: 'hidden', labelKey: 'admin.permissions.state.hidden', icon: 'visibility_off' },
      { value: 'view', labelKey: 'admin.permissions.state.view', icon: 'visibility' },
      { value: 'operate', labelKey: 'admin.permissions.state.operate', icon: 'edit' },
    ];
    return (
      <div className="inline-flex rounded-lg bg-surface-container-highest/50 p-0.5 gap-0.5">
        {states.map(s => (
          <button
            key={s.value}
            onClick={() => onChange(s.value)}
            title={t(s.labelKey as any)}
            className={`flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition-all cursor-pointer ${
              state === s.value
                ? s.value === 'hidden'
                  ? 'bg-surface-container text-on-surface-variant shadow-sm'
                  : s.value === 'view'
                    ? 'bg-primary/15 text-primary shadow-sm'
                    : 'bg-tertiary/15 text-tertiary shadow-sm'
                : 'text-outline hover:text-on-surface-variant'
            }`}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>{s.icon}</span>
            <span>{t(s.labelKey as any)}</span>
          </button>
        ))}
      </div>
    );
  }

  /* ── Shared item info row ── */
  function ItemInfo({ item }: { item: { labelKey?: string; label?: string; descKey?: string; icon?: string; deployMode?: string } }) {
    return (
      <div className="flex items-center gap-3">
        {item.icon && <span className="material-symbols-outlined text-on-surface-variant text-lg shrink-0">{item.icon}</span>}
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-on-surface font-medium">{item.labelKey ? t(item.labelKey as any) : item.label}</span>
            {item.deployMode && DEPLOY_MODE_LABELS[item.deployMode] && (
              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${DEPLOY_MODE_LABELS[item.deployMode].color}`}>
                {DEPLOY_MODE_LABELS[item.deployMode].label}
              </span>
            )}
          </div>
          {item.descKey && <div className="text-xs text-on-surface-variant mt-0.5">{t(item.descKey as any)}</div>}
        </div>
      </div>
    );
  }

  /* ── Section for Frontend Nav / Features (toggle-based) ── */
  function Section({
    titleKey, descKey, items, roles, getChecked, onToggle,
  }: {
    titleKey: string;
    descKey: string;
    items: ReadonlyArray<{ key: string; labelKey?: string; label?: string; descKey?: string; icon?: string }>;
    roles: Array<{ key: string; labelKey: string; disabled?: boolean }>;
    getChecked: (itemKey: string, roleKey: string) => boolean;
    onToggle: (itemKey: string, roleKey: string) => void;
  }) {
    return (
      <div className="bg-surface-container rounded-2xl border border-outline-variant/10 overflow-hidden">
        <div className="px-4 md:px-6 py-4 border-b border-outline-variant/10">
          <h2 className="text-base font-headline font-bold text-on-surface">{t(titleKey as any)}</h2>
          <p className="text-sm text-on-surface-variant mt-0.5">{t(descKey as any)}</p>
        </div>

        {/* Desktop table */}
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-outline-variant/10">
                <th className="text-left px-6 py-3 font-headline font-bold text-on-surface-variant">{t('admin.permissions.item' as any)}</th>
                {roles.map(role => (
                  <th key={role.key} className="text-center px-4 py-3 font-headline font-bold text-on-surface-variant w-32">
                    {t(role.labelKey as any)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map(item => (
                <tr key={item.key} className="border-b border-outline-variant/5 last:border-b-0 hover:bg-surface-container-high/30 transition-colors">
                  <td className="px-6 py-3"><ItemInfo item={item} /></td>
                  {roles.map(role => (
                    <td key={role.key} className="text-center px-4 py-3">
                      {role.disabled ? (
                        <div className="flex justify-center">
                          <span className="material-symbols-outlined text-primary text-lg">check_circle</span>
                        </div>
                      ) : (
                        <div className="flex justify-center">
                          <ToggleSwitch
                            checked={getChecked(item.key, role.key)}
                            onChange={() => onToggle(item.key, role.key)}
                          />
                        </div>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Mobile cards */}
        <div className="md:hidden divide-y divide-outline-variant/10">
          {items.map(item => (
            <div key={item.key} className="px-4 py-3 space-y-2.5">
              <ItemInfo item={item} />
              <div className="flex items-center justify-center gap-4">
                {roles.filter(r => !r.disabled).map(role => (
                  <div key={role.key} className="flex items-center gap-2">
                    <ToggleSwitch
                      checked={getChecked(item.key, role.key)}
                      onChange={() => onToggle(item.key, role.key)}
                    />
                    <span className="text-xs text-on-surface-variant">{t(role.labelKey as any)}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4 md:p-8">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl md:text-2xl font-headline font-bold text-on-surface">{t('admin.permissions.title' as any)}</h1>
          <p className="text-sm text-on-surface-variant mt-1">{t('admin.permissions.subtitle' as any)}</p>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className={`flex items-center gap-2 px-4 md:px-5 py-2.5 rounded-xl text-sm font-bold transition-all cursor-pointer shrink-0 ${
            saved
              ? 'bg-success/15 text-success'
              : 'bg-primary text-on-primary hover:bg-primary/90'
          } disabled:opacity-50`}
        >
          <span className="material-symbols-outlined text-lg">{saved ? 'check' : 'save'}</span>
          <span className="hidden sm:inline">
            {saving ? t('admin.permissions.saving' as any) : saved ? t('admin.permissions.saved' as any) : t('admin.permissions.save' as any)}
          </span>
        </button>
      </div>

      {/* Admin Sidebar — grouped */}
      <div className="bg-surface-container rounded-2xl border border-outline-variant/10 overflow-hidden">
        <div className="px-4 md:px-6 py-4 border-b border-outline-variant/10">
          <h2 className="text-base font-headline font-bold text-on-surface">{t('admin.permissions.adminSidebar' as any)}</h2>
          <p className="text-sm text-on-surface-variant mt-0.5">{t('admin.permissions.adminSidebar.desc' as any)}</p>
        </div>

        {/* Admin-only note */}
        <div className="mx-4 md:mx-6 mt-4 mb-2 flex items-start gap-2 px-3 py-2 rounded-lg bg-primary/5 border border-primary/10">
          <span className="material-symbols-outlined text-primary text-base shrink-0 mt-0.5">lock</span>
          <span className="text-xs text-on-surface-variant">
            <span className="font-bold text-primary">{t('admin.sidebar.permissions' as any)}</span>
            {' — '}
            {t('admin.permissions.adminOnlyNote' as any)}
          </span>
        </div>

        {/* Desktop table */}
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-outline-variant/10">
                <th className="text-left px-6 py-3 font-headline font-bold text-on-surface-variant">{t('admin.permissions.item' as any)}</th>
                <th className="text-center px-4 py-3 font-headline font-bold text-on-surface-variant w-32">{t('admin.permissions.admin' as any)}</th>
                <th className="text-center px-4 py-3 font-headline font-bold text-on-surface-variant">{t('admin.permissions.readonly' as any)}</th>
              </tr>
            </thead>
            <tbody>
              {ADMIN_SIDEBAR_GROUPS.map(group => (
                <React.Fragment key={group.id}>
                  <tr className="bg-surface-container-high/40">
                    <td colSpan={3} className="px-6 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className="material-symbols-outlined text-on-surface-variant text-base">{group.icon}</span>
                        <span className="text-xs font-headline font-bold text-on-surface-variant uppercase tracking-widest">{t(group.labelKey as any)}</span>
                      </div>
                    </td>
                  </tr>
                  {group.items.map(item => (
                    <tr key={item.key} className="border-b border-outline-variant/5 last:border-b-0 hover:bg-surface-container-high/30 transition-colors">
                      <td className="px-6 py-3">
                        <div className="pl-4"><ItemInfo item={item} /></div>
                      </td>
                      <td className="text-center px-4 py-3">
                        <div className="flex justify-center">
                          <span className="material-symbols-outlined text-primary text-lg">check_circle</span>
                        </div>
                      </td>
                      <td className="text-center px-4 py-3">
                        <div className="flex justify-center">
                          <StateSelector
                            state={getReadonlyState(item.key)}
                            onChange={(s) => setReadonlyState(item.key, s)}
                          />
                        </div>
                      </td>
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>

        {/* Mobile cards */}
        <div className="md:hidden">
          {ADMIN_SIDEBAR_GROUPS.map(group => (
            <div key={group.id}>
              {/* Group header */}
              <div className="flex items-center gap-2 px-4 py-2.5 bg-surface-container-high/40">
                <span className="material-symbols-outlined text-on-surface-variant text-base">{group.icon}</span>
                <span className="text-xs font-headline font-bold text-on-surface-variant uppercase tracking-widest">{t(group.labelKey as any)}</span>
              </div>
              {/* Items */}
              <div className="divide-y divide-outline-variant/5">
                {group.items.map(item => (
                  <div key={item.key} className="px-4 py-3 space-y-2.5">
                    <ItemInfo item={item} />
                    <div className="flex flex-col items-center gap-1">
                      <span className="text-[10px] text-on-surface-variant font-medium">{t('admin.permissions.readonly' as any)}</span>
                      <StateSelector
                        state={getReadonlyState(item.key)}
                        onChange={(s) => setReadonlyState(item.key, s)}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Frontend Nav */}
      <Section
        titleKey="admin.permissions.frontendNav"
        descKey="admin.permissions.frontendNav.desc"
        items={FRONTEND_NAV_ITEMS}
        roles={[
          { key: 'admin', labelKey: 'admin.permissions.admin', disabled: true },
          { key: 'readonly', labelKey: 'admin.permissions.readonly' },
          { key: 'user', labelKey: 'admin.permissions.user' },
        ]}
        getChecked={(itemKey, roleKey) => {
          if (roleKey === 'admin') return true;
          if (roleKey === 'readonly') return perms.frontendNav.readonly.includes(itemKey);
          return perms.frontendNav.user.includes(itemKey);
        }}
        onToggle={(itemKey, roleKey) => {
          if (roleKey === 'readonly') toggle('frontendNav', 'readonly', itemKey);
          if (roleKey === 'user') toggle('frontendNav', 'user', itemKey);
        }}
      />

      {/* Features */}
      <Section
        titleKey="admin.permissions.features"
        descKey="admin.permissions.features.desc"
        items={FEATURE_ITEMS}
        roles={[
          { key: 'admin', labelKey: 'admin.permissions.admin', disabled: true },
          { key: 'readonly', labelKey: 'admin.permissions.readonly' },
          { key: 'user', labelKey: 'admin.permissions.user' },
        ]}
        getChecked={(itemKey, roleKey) => {
          if (roleKey === 'admin') return true;
          if (roleKey === 'readonly') return perms.features.readonly.includes(itemKey);
          return perms.features.user.includes(itemKey);
        }}
        onToggle={(itemKey, roleKey) => {
          if (roleKey === 'readonly') toggle('features', 'readonly', itemKey);
          if (roleKey === 'user') toggle('features', 'user', itemKey);
        }}
      />
    </div>
  );
}
