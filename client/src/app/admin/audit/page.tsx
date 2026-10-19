'use client';

/**
 * 使用軌跡 — the trails that had nowhere to live.
 *
 * `admin_audit_log` had been written to since the beginning and never shown:
 * the only code that read it counted rows for a tile on the overview. So a
 * record of who suspended whom, who approved which quota and who moved the
 * system limits existed and could not be consulted, which is the same as not
 * keeping it when somebody finally asks what happened.
 *
 * The other two audit trails are deliberately NOT moved here. Security events
 * and add-in tool actions already have purpose-built views that do more than
 * list rows — the security page scores severity and exports a report, the
 * add-in audit groups by conversation — and collapsing them into a generic
 * table would lose that. This page links to them instead.
 */

import { useState, useEffect, useCallback } from 'react';
import { useAdminAuth } from '../components/AdminAuthProvider';

interface AuditEntry {
  id: string;
  created_at: string;
  action: string;
  admin_name: string | null;
  admin_email: string | null;
  target_type: string | null;
  target_id: string | null;
  details: string | null;
}

interface InstallerEvent {
  id: string;
  created_at: string;
  event_type: 'upload' | 'delete' | 'url_set' | 'download';
  user_name: string | null;
  user_email: string | null;
  source: 'file' | 'url' | null;
  version: string | null;
  file_name: string | null;
  file_size: number | null;
  ip: string | null;
}

/** Action names are logged in English; these are what an admin should read. */
const ACTION_LABELS: Record<string, string> = {
  update_settings: '修改系統設定',
  update_tos: '修改使用條款',
  update_line_settings: '修改 LINE 設定',
  suspend_user: '停用使用者',
  activate_user: '啟用使用者',
  delete_user: '刪除使用者',
  change_role: '變更角色',
  set_quota_override: '調整個人額度',
  approve_quota_request: '核准額度申請',
  deny_quota_request: '駁回額度申請',
  provision_ad_user: '建立 AD 使用者',
  upload_addin_installer: '上傳增益集安裝檔',
  delete_addin_installer: '移除增益集安裝檔',
};

const ACTION_TONE: Record<string, string> = {
  suspend_user: 'text-error bg-error/10',
  delete_user: 'text-error bg-error/10',
  delete_addin_installer: 'text-error bg-error/10',
  deny_quota_request: 'text-error bg-error/10',
  activate_user: 'text-success bg-success/10',
  approve_quota_request: 'text-success bg-success/10',
  upload_addin_installer: 'text-success bg-success/10',
};

const INSTALLER_META: Record<InstallerEvent['event_type'], { label: string; icon: string; cls: string }> = {
  upload:   { label: '上傳新版',   icon: 'upload',   cls: 'text-success bg-success/10' },
  url_set:  { label: '更新網址',   icon: 'link',     cls: 'text-primary bg-primary/10' },
  delete:   { label: '移除安裝檔', icon: 'delete',   cls: 'text-error bg-error/10' },
  download: { label: '下載',       icon: 'download', cls: 'text-on-surface-variant bg-surface-container-highest' },
};

function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** What the stored JSON keys mean, in the words an admin would use. */
const FIELD_LABELS: Record<string, string> = {
  user_id: '使用者',
  group_id: '額度群組',
  new_limit: '新額度',
  quota_override: '個人額度',
  email: '信箱',
  from: '原角色',
  to: '新角色',
  name: '檔名',
  size: '大小',
  reason: '理由',
  note: '備註',
};

const ROLE_LABELS: Record<string, string> = {
  user: '一般使用者',
  readonly: '唯讀管理員',
  admin: '管理者',
};

const TARGET_LABELS: Record<string, string> = {
  user: '使用者',
  quota_request: '額度申請',
  system: '系統',
  addin_installer: '增益集安裝檔',
  system_settings: '系統設定',
  tos_content: '使用條款',
};

/** Fields that are money, so they read as money rather than as a bare number. */
const MONEY_FIELDS = new Set(['new_limit', 'quota_override']);

/**
 * Audit details are stored as JSON holding raw ids. Render them as sentences a
 * person can act on — but never DROP a field we did not anticipate, because
 * the unexpected one is usually the one being looked for; unknown keys fall
 * through with their original name rather than disappearing.
 */
function summariseDetails(raw: string | null, names: Record<string, string>): string {
  if (!raw) return '';
  try {
    const d = JSON.parse(raw);
    if (Array.isArray(d.changes)) return d.changes.join('；');
    return Object.entries(d)
      .map(([k, v]) => {
        const label = FIELD_LABELS[k] || k;
        let val = typeof v === 'object' ? JSON.stringify(v) : String(v);
        if (names[val]) val = names[val];                      // uuid → 人名／群組名
        else if (k === 'from' || k === 'to') val = ROLE_LABELS[val] || val;
        else if (MONEY_FIELDS.has(k)) val = `$${val}`;
        return `${label}：${val}`;
      })
      .join('；');
  } catch {
    return raw;
  }
}

type Tab = 'admin' | 'installer';

export default function AdminAudit() {
  const { token } = useAdminAuth();
  const [tab, setTab] = useState<Tab>('admin');

  // 管理操作
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [actions, setActions] = useState<Array<{ action: string; n: number }>>([]);
  const [actionFilter, setActionFilter] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [meta, setMeta] = useState({ total: 0, totalPages: 1 });
  // uuid → display name, resolved server-side so the page never prints an id.
  const [names, setNames] = useState<Record<string, string>>({});

  // 增益集安裝
  const [events, setEvents] = useState<InstallerEvent[]>([]);
  const [evFilter, setEvFilter] = useState<'all' | 'publish' | 'download'>('all');
  const [evPage, setEvPage] = useState(1);
  const [evMeta, setEvMeta] = useState({ total: 0, totalPages: 1, downloadTotal: 0, downloadPeople: 0 });

  const loadAudit = useCallback(async () => {
    if (!token) return;
    const qs = new URLSearchParams({ page: String(page), limit: '10' });
    if (actionFilter) qs.set('action', actionFilter);
    if (query) qs.set('search', query);
    try {
      const res = await fetch(`/api/admin/audit-log?${qs}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return;
      const d = await res.json();
      setEntries(d.entries || []);
      setActions(d.actions || []);
      setNames(d.names || {});
      setMeta({ total: d.total || 0, totalPages: d.totalPages || 1 });
    } catch { /* ignore */ }
  }, [token, page, actionFilter, query]);

  const loadEvents = useCallback(async () => {
    if (!token) return;
    const qs = new URLSearchParams({ page: String(evPage), limit: '10' });
    if (evFilter !== 'all') qs.set('type', evFilter);
    try {
      const res = await fetch(`/api/admin/addin-installer/events?${qs}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return;
      const d = await res.json();
      setEvents(d.events || []);
      setEvMeta({
        total: d.total || 0,
        totalPages: d.totalPages || 1,
        downloadTotal: d.downloadTotal || 0,
        downloadPeople: d.downloadPeople || 0,
      });
    } catch { /* ignore */ }
  }, [token, evPage, evFilter]);

  useEffect(() => { loadAudit(); }, [loadAudit]);
  useEffect(() => { loadEvents(); }, [loadEvents]);

  const pager = (cur: number, total: number, set: (n: number) => void, count: number) => (
    total > 1 ? (
      <div className="flex items-center justify-between mt-4 pt-3 border-t border-outline-variant/10">
        <span className="text-xs text-on-surface-variant">共 {count} 筆</span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => set(Math.max(1, cur - 1))}
            disabled={cur <= 1}
            className="px-2.5 py-1.5 text-xs rounded bg-surface-container-highest text-on-surface-variant hover:text-on-surface disabled:opacity-30 cursor-pointer disabled:cursor-default"
          >
            上一頁
          </button>
          <span className="text-xs text-on-surface-variant tabular-nums">{cur} / {total}</span>
          <button
            onClick={() => set(Math.min(total, cur + 1))}
            disabled={cur >= total}
            className="px-2.5 py-1.5 text-xs rounded bg-surface-container-highest text-on-surface-variant hover:text-on-surface disabled:opacity-30 cursor-pointer disabled:cursor-default"
          >
            下一頁
          </button>
        </div>
      </div>
    ) : null
  );

  return (
    <>
      <header className="sticky top-0 h-14 md:h-16 bg-surface/80 backdrop-blur-xl flex justify-between items-center px-4 md:px-8 z-40 shadow-[0_1px_0_0_rgba(255,255,255,0.05)]">
        <span className="text-base md:text-lg font-black text-on-surface font-headline">使用軌跡</span>
      </header>

      <div className="p-4 md:p-8 space-y-4 md:space-y-6">
        {/* Tabs */}
        <div className="flex gap-1 bg-surface-container rounded-lg p-1 w-fit">
          {([
            { key: 'admin' as const, label: '管理操作', icon: 'manage_accounts', n: meta.total },
            { key: 'installer' as const, label: '增益集安裝', icon: 'download_for_offline', n: evMeta.total },
          ]).map(x => (
            <button
              key={x.key}
              onClick={() => setTab(x.key)}
              className={`flex items-center gap-2 px-4 py-2 text-sm font-bold rounded transition-colors cursor-pointer ${
                tab === x.key ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:text-on-surface'
              }`}
            >
              <span className="material-symbols-outlined text-base">{x.icon}</span>
              {x.label}
              <span className={`text-xs tabular-nums ${tab === x.key ? 'opacity-70' : 'opacity-50'}`}>{x.n}</span>
            </button>
          ))}
        </div>

        {tab === 'admin' ? (
          <div className="bg-surface-container rounded-lg p-4 md:p-6">
            <div className="flex flex-wrap items-center gap-2 mb-4">
              <select
                value={actionFilter}
                onChange={e => { setActionFilter(e.target.value); setPage(1); }}
                className="px-3 py-2 bg-surface-container-highest text-on-surface text-sm rounded border border-outline-variant/20 focus:border-primary focus:outline-none cursor-pointer"
              >
                <option value="">所有動作</option>
                {actions.map(a => (
                  <option key={a.action} value={a.action}>
                    {(ACTION_LABELS[a.action] || a.action)}（{a.n}）
                  </option>
                ))}
              </select>
              <form
                onSubmit={e => { e.preventDefault(); setQuery(search); setPage(1); }}
                className="flex-1 min-w-[180px] flex gap-2"
              >
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="搜尋管理員、對象或內容"
                  className="flex-1 min-w-0 px-3 py-2 bg-surface-container-highest text-on-surface text-sm rounded border border-outline-variant/20 focus:border-primary focus:outline-none"
                />
                <button type="submit" className="px-3 py-2 bg-primary text-on-primary text-sm font-bold rounded hover:bg-primary/90 cursor-pointer shrink-0">
                  搜尋
                </button>
              </form>
            </div>

            {entries.length === 0 ? (
              <p className="text-sm text-on-surface-variant/60 py-10 text-center">沒有符合的紀錄。</p>
            ) : (
              <div className="space-y-1">
                {entries.map(e => {
                  const detail = summariseDetails(e.details, names);
                  const targetLabel = e.target_type ? (TARGET_LABELS[e.target_type] || e.target_type) : '';
                  // Prefer the resolved name; fall back to the type alone
                  // rather than to a truncated id, which tells nobody anything.
                  const targetName = e.target_id ? names[e.target_id] : '';
                  return (
                    <div key={e.id} className="flex items-start gap-3 px-3 py-2.5 rounded hover:bg-surface-container-high transition-colors">
                      <span className={`text-[11px] font-bold px-2 py-1 rounded whitespace-nowrap shrink-0 ${ACTION_TONE[e.action] || 'text-on-surface-variant bg-surface-container-highest'}`}>
                        {ACTION_LABELS[e.action] || e.action}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-on-surface">
                          {e.admin_name || e.admin_email || '（已刪除的管理員）'}
                          {targetLabel && (
                            <span className="text-on-surface-variant">
                              {' → '}{targetName || targetLabel}
                            </span>
                          )}
                        </p>
                        {detail && (
                          <p className="text-[11px] text-on-surface-variant/70 mt-0.5 break-words">{detail}</p>
                        )}
                      </div>
                      <p className="text-[11px] text-on-surface-variant whitespace-nowrap shrink-0">
                        {new Date(e.created_at).toLocaleString('zh-TW')}
                      </p>
                    </div>
                  );
                })}
              </div>
            )}
            {pager(page, meta.totalPages, setPage, meta.total)}
          </div>
        ) : (
          <div className="bg-surface-container rounded-lg p-4 md:p-6">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <p className="text-xs text-on-surface-variant">
                累計下載 <span className="font-bold text-on-surface">{evMeta.downloadTotal}</span> 次，
                共 <span className="font-bold text-on-surface">{evMeta.downloadPeople}</span> 人
              </p>
              <div className="flex gap-1 bg-surface-container-highest rounded-lg p-1">
                {([
                  { key: 'all' as const, label: '全部' },
                  { key: 'publish' as const, label: '版本異動' },
                  { key: 'download' as const, label: '下載' },
                ]).map(f => (
                  <button
                    key={f.key}
                    onClick={() => { setEvFilter(f.key); setEvPage(1); }}
                    className={`px-3 py-1.5 text-xs font-bold rounded transition-colors cursor-pointer ${
                      evFilter === f.key ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:text-on-surface'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>

            {events.length === 0 ? (
              <p className="text-sm text-on-surface-variant/60 py-10 text-center">
                還沒有任何紀錄。到「系統設定」設定安裝檔之後，上傳與下載都會記在這裡。
              </p>
            ) : (
              <div className="space-y-1">
                {events.map(ev => {
                  const m = INSTALLER_META[ev.event_type];
                  return (
                    <div key={ev.id} className="flex items-start gap-3 px-3 py-2.5 rounded hover:bg-surface-container-high transition-colors">
                      <span className={`material-symbols-outlined text-base w-7 h-7 rounded flex items-center justify-center shrink-0 ${m.cls}`}>
                        {m.icon}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className="text-sm font-bold text-on-surface">{m.label}</span>
                          {ev.version && <span className="text-xs text-primary font-mono">{ev.version}</span>}
                          <span className="text-xs text-on-surface-variant">
                            {ev.user_name || ev.user_email || '（已刪除的使用者）'}
                          </span>
                        </div>
                        {ev.file_name && (
                          <p className="text-[11px] text-on-surface-variant/70 mt-0.5 truncate" title={ev.file_name}>
                            {ev.file_name}{ev.file_size ? ` · ${formatBytes(ev.file_size)}` : ''}
                          </p>
                        )}
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-[11px] text-on-surface-variant whitespace-nowrap">
                          {new Date(ev.created_at).toLocaleString('zh-TW')}
                        </p>
                        {ev.ip && <p className="text-[10px] text-on-surface-variant/50 font-mono mt-0.5">{ev.ip}</p>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {pager(evPage, evMeta.totalPages, setEvPage, evMeta.total)}
          </div>
        )}

      </div>
    </>
  );
}
