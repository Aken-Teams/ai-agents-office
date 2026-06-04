'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAdminAuth } from '../components/AdminAuthProvider';

interface LineSettings {
  maxMsgPerMin: number;
  conversationIdleHours: number;
  fileShareTtlDays: number;
  defaultQuotaUsd: number;
}

interface MessageQuota {
  type?: 'none' | 'limited';
  limit?: number | null;
  used?: number;
  remaining?: number | null;
  error?: string;
}

interface LineStatus {
  enabled: boolean;
  channelConfigured: boolean;
  channelId: string;
  botBasicId: string;
  liffId: string;
  publicApiBase: string;
  webhookUrl: string;
}

interface LineUser {
  lineUserId: string;
  displayName: string | null;
  email: string;
  userId: string;
  status: string;
  linkedVia: string | null;
  lastMessageAt: string | null;
  cost: number;
  limit: number;
  remaining: number;
  pctUsed: number;
  exceeded: boolean;
  limitSource: 'personal' | 'group' | 'global';
}

// Editable settings: key, label, hint, range, unit.
const FIELDS: { key: keyof LineSettings; label: string; hint: string; min: number; max: number; step: number; unit: string }[] = [
  { key: 'maxMsgPerMin', label: '每分鐘訊息上限', hint: '單一 LINE 使用者每分鐘可送出的訊息數,超過會被擋下。', min: 1, max: 1000, step: 1, unit: '則/分' },
  { key: 'conversationIdleHours', label: '對話閒置時數', hint: '超過此時數沒互動,下一則訊息會開新對話(舊對話會被摘要)。', min: 1, max: 168, step: 1, unit: '小時' },
  { key: 'fileShareTtlDays', label: '檔案分享有效天數', hint: '透過 LINE 發出的檔案下載連結保留幾天後過期。', min: 1, max: 365, step: 1, unit: '天' },
  { key: 'defaultQuotaUsd', label: '新用戶預設額度', hint: '新綁定的 LINE 使用者預設用量上限(僅影響日後新用戶)。', min: 0, max: 100000, step: 1, unit: 'USD' },
];

const money = (n: number) => `$${n.toFixed(2)}`;
const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');

export default function AdminLinePage() {
  const { token, isReadonly } = useAdminAuth();
  const [status, setStatus] = useState<LineStatus | null>(null);
  const [form, setForm] = useState<Record<keyof LineSettings, string>>({
    maxMsgPerMin: '', conversationIdleHours: '', fileShareTtlDays: '', defaultQuotaUsd: '',
  });
  const [users, setUsers] = useState<LineUser[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [quota, setQuota] = useState<MessageQuota | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<{ lineUserId: string; reason: string | null; createdAt: string }[]>([]);
  const [delTarget, setDelTarget] = useState<LineUser | null>(null);
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const loadSettings = useCallback(() => {
    if (!token) return;
    fetch('/api/admin/line/settings', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then((data: { settings: LineSettings; status: LineStatus }) => {
        setStatus(data.status);
        setForm({
          maxMsgPerMin: String(data.settings.maxMsgPerMin),
          conversationIdleHours: String(data.settings.conversationIdleHours),
          fileShareTtlDays: String(data.settings.fileShareTtlDays),
          defaultQuotaUsd: String(data.settings.defaultQuotaUsd),
        });
      })
      .catch(() => setError('讀取設定失敗'));
  }, [token]);

  const loadUsers = useCallback(() => {
    if (!token) return;
    setLoadingUsers(true);
    fetch('/api/admin/line/users', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then((data: { users: LineUser[] }) => setUsers(data.users || []))
      .catch(() => setError('讀取 LINE 使用者失敗'))
      .finally(() => setLoadingUsers(false));
  }, [token]);

  const loadQuota = useCallback(() => {
    if (!token) return;
    fetch('/api/admin/line/message-quota', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then((data: MessageQuota) => setQuota(data))
      .catch(() => setQuota({ error: '讀取失敗' }));
  }, [token]);

  const loadBlocklist = useCallback(() => {
    if (!token) return;
    fetch('/api/admin/line/blocklist', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then((data: { blocked: { lineUserId: string; reason: string | null; createdAt: string }[] }) => setBlocked(data.blocked || []))
      .catch(() => {});
  }, [token]);

  useEffect(() => { loadSettings(); loadUsers(); loadQuota(); loadBlocklist(); }, [loadSettings, loadUsers, loadQuota, loadBlocklist]);

  async function doDeleteUser() {
    if (!token || !delTarget || busy || isReadonly) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/line/users/${encodeURIComponent(delTarget.lineUserId)}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) { setDelTarget(null); loadUsers(); loadBlocklist(); }
      else setError('刪除失敗');
    } catch { setError('刪除失敗（網路錯誤）'); }
    finally { setBusy(false); }
  }

  async function doUnblock(lineUserId: string) {
    if (!token || busy || isReadonly) return;
    setBusy(true);
    try {
      await fetch(`/api/admin/line/blocklist/${encodeURIComponent(lineUserId)}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      });
      loadBlocklist();
    } finally { setBusy(false); }
  }

  async function saveSettings() {
    if (!token || saving || isReadonly) return;
    setError(null);
    const body: Partial<LineSettings> = {};
    for (const f of FIELDS) {
      const val = parseFloat(form[f.key]);
      if (isNaN(val) || val < f.min || val > f.max) {
        setError(`「${f.label}」需介於 ${f.min} 與 ${f.max} 之間`);
        return;
      }
      body[f.key] = val;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/admin/line/settings', {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      } else {
        const d = await res.json().catch(() => ({}));
        setError(d.error || '儲存失敗');
      }
    } catch {
      setError('儲存失敗(網路錯誤)');
    }
    setSaving(false);
  }

  const barColor = (u: LineUser) => u.exceeded ? 'bg-error' : u.pctUsed >= 70 ? 'bg-warning' : 'bg-primary';

  return (
    <>
      {/* Header */}
      <header className="sticky top-0 h-14 md:h-16 bg-surface/80 backdrop-blur-xl flex justify-between items-center px-4 md:px-8 z-40 shadow-[0_1px_0_0_rgba(255,255,255,0.05)]">
        <div className="flex items-center gap-2 md:gap-4">
          <span className="text-base md:text-lg font-black text-on-surface font-headline shrink-0">LINE Bot</span>
          <span className="text-xs md:text-sm text-on-surface-variant font-mono truncate">使用者與額度</span>
        </div>
        <button onClick={() => setSettingsOpen(true)} title="運行設定與連線資訊"
          className="flex items-center gap-1.5 px-3 h-9 rounded-lg text-sm font-bold text-on-surface-variant hover:text-primary hover:bg-surface-container transition-colors cursor-pointer">
          <span className="material-symbols-outlined text-[20px]">settings</span>
          <span className="hidden md:inline">運行設定</span>
        </button>
      </header>

      <div className="p-4 md:p-8 flex-1 space-y-4 md:space-y-6">
        {error && (
          <div className="bg-error/10 border border-error/30 text-error text-xs md:text-sm rounded-lg px-4 py-2.5">{error}</div>
        )}

        {/* LINE monthly push-message quota (from LINE API) */}
        <div className="bg-surface-container rounded-lg p-4 md:p-6">
          <div className="flex items-center gap-2 mb-3 md:mb-4">
            <span className="material-symbols-outlined text-xl text-primary">campaign</span>
            <h3 className="text-sm md:text-base font-headline font-bold text-on-surface">本月推播訊息額度</h3>
            <span className="text-xs text-on-surface-variant">(LINE 官方帳號；回覆訊息不計入)</span>
            <button onClick={loadQuota} className="ml-auto text-xs text-on-surface-variant hover:text-primary flex items-center gap-1 cursor-pointer">
              <span className="material-symbols-outlined text-sm">refresh</span>重新整理
            </button>
          </div>
          {!quota ? (
            <p className="text-sm text-on-surface-variant">載入中…</p>
          ) : quota.error ? (
            <p className="text-sm text-error">無法取得額度:{quota.error}</p>
          ) : quota.type === 'none' ? (
            <p className="text-sm text-on-surface">方案無推播上限(unlimited)。本月已推播 <span className="font-mono font-bold">{quota.used ?? 0}</span> 則。</p>
          ) : (
            <div>
              <div className="flex flex-wrap items-end gap-x-6 gap-y-1 mb-3">
                <div><span className="text-2xl md:text-3xl font-headline font-black text-on-surface">{(quota.remaining ?? 0).toLocaleString()}</span><span className="text-xs text-on-surface-variant ml-1.5">則剩餘</span></div>
                <div className="text-xs md:text-sm text-on-surface-variant">已用 <span className="font-mono text-on-surface">{(quota.used ?? 0).toLocaleString()}</span> / 上限 <span className="font-mono text-on-surface">{(quota.limit ?? 0).toLocaleString()}</span> 則</div>
              </div>
              {(() => {
                const limit = quota.limit ?? 0;
                const used = quota.used ?? 0;
                const pct = limit > 0 ? Math.min(Math.round((used / limit) * 100), 100) : 0;
                const color = pct >= 100 ? 'bg-error' : pct >= 80 ? 'bg-warning' : 'bg-primary';
                return (
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-2 bg-surface-container-highest rounded-full overflow-hidden">
                      <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
                    </div>
                    <span className="text-xs text-on-surface-variant tabular-nums">{pct}%</span>
                  </div>
                );
              })()}
            </div>
          )}
        </div>


        {/* LINE users quota table */}
        <div className="bg-surface-container rounded-lg p-4 md:p-6">
          <div className="flex items-center gap-2 mb-4">
            <span className="material-symbols-outlined text-xl text-tertiary">account_balance_wallet</span>
            <h3 className="text-sm md:text-base font-headline font-bold text-on-surface">LINE 使用者額度</h3>
            <span className="text-xs text-on-surface-variant">({users.length} 位)</span>
            <button onClick={loadUsers} className="ml-auto text-xs text-on-surface-variant hover:text-primary flex items-center gap-1 cursor-pointer">
              <span className="material-symbols-outlined text-sm">refresh</span>重新整理
            </button>
          </div>

          {loadingUsers ? (
            <p className="text-sm text-on-surface-variant py-6 text-center">載入中…</p>
          ) : users.length === 0 ? (
            <p className="text-sm text-on-surface-variant py-6 text-center">目前沒有已綁定的 LINE 使用者。</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs md:text-sm">
                <thead>
                  <tr className="text-on-surface-variant border-b border-outline-variant/15 text-left">
                    <th className="py-2 pr-3 font-medium">使用者</th>
                    <th className="py-2 px-3 font-medium text-right">已用</th>
                    <th className="py-2 px-3 font-medium text-right">上限</th>
                    <th className="py-2 px-3 font-medium text-right">剩餘</th>
                    <th className="py-2 px-3 font-medium w-32">用量</th>
                    <th className="py-2 px-3 font-medium">最後訊息</th>
                    {!isReadonly && <th className="py-2 px-3 font-medium text-right">操作</th>}
                  </tr>
                </thead>
                <tbody>
                  {users.map(u => (
                    <tr key={u.lineUserId} className="border-b border-outline-variant/8 hover:bg-surface-container-high/40">
                      <td className="py-2.5 pr-3">
                        <div className="font-medium text-on-surface truncate max-w-[180px]">{u.displayName || u.email}</div>
                        <div className="text-[11px] text-on-surface-variant/70 truncate max-w-[180px]">{u.email}</div>
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono text-on-surface">{money(u.cost)}</td>
                      <td className="py-2.5 px-3 text-right font-mono text-on-surface-variant">
                        {money(u.limit)}
                        <span className="ml-1 text-[10px] text-on-surface-variant/50">{u.limitSource === 'personal' ? '個人' : u.limitSource === 'group' ? '群組' : '全域'}</span>
                      </td>
                      <td className={`py-2.5 px-3 text-right font-mono ${u.exceeded ? 'text-error' : 'text-on-surface'}`}>{money(u.remaining)}</td>
                      <td className="py-2.5 px-3">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1.5 bg-surface-container-highest rounded-full overflow-hidden">
                            <div className={`h-full ${barColor(u)}`} style={{ width: `${Math.min(u.pctUsed, 100)}%` }} />
                          </div>
                          <span className={`text-[11px] tabular-nums ${u.exceeded ? 'text-error font-bold' : 'text-on-surface-variant'}`}>{u.pctUsed}%</span>
                        </div>
                      </td>
                      <td className="py-2.5 px-3 text-on-surface-variant whitespace-nowrap">{fmtDate(u.lastMessageAt)}</td>
                      {!isReadonly && (
                        <td className="py-2.5 px-3 text-right">
                          <button onClick={() => setDelTarget(u)} title="刪除並封鎖此 LINE 用戶"
                            className="inline-flex items-center justify-center w-8 h-8 rounded-lg text-on-surface-variant hover:text-error hover:bg-error/10 transition-colors cursor-pointer">
                            <span className="material-symbols-outlined text-[18px]">person_remove</span>
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Blocklist */}
        {blocked.length > 0 && (
          <div className="bg-surface-container rounded-2xl border border-outline-variant/15 p-5 md:p-6 mt-6">
            <h2 className="font-headline font-bold text-on-surface mb-1 flex items-center gap-2">
              <span className="material-symbols-outlined text-error text-[20px]">block</span>
              已封鎖的 LINE 帳號（{blocked.length}）
            </h2>
            <p className="text-xs text-on-surface-variant mb-4">這些帳號無法傳訊息給機器人，也無法重新綁定。解除封鎖後即可再次綁定使用。</p>
            <div className="space-y-2">
              {blocked.map(b => (
                <div key={b.lineUserId} className="flex items-center gap-3 p-3 rounded-xl border border-outline-variant/10 bg-surface-container-high/40">
                  <span className="material-symbols-outlined text-error/70 shrink-0">block</span>
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-xs text-on-surface truncate">{b.lineUserId}</div>
                    <div className="text-[11px] text-on-surface-variant">封鎖於 {fmtDate(b.createdAt)}{b.reason ? ` · ${b.reason}` : ''}</div>
                  </div>
                  {!isReadonly && (
                    <button onClick={() => doUnblock(b.lineUserId)} disabled={busy}
                      className="px-3 py-1.5 rounded-lg text-xs font-bold text-primary border border-primary/30 hover:bg-primary/10 transition-colors cursor-pointer disabled:opacity-40">
                      解除封鎖
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Settings modal — runtime settings (DB) + connection info (.env) */}
      {settingsOpen && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={() => setSettingsOpen(false)}>
          <div className="bg-surface-container-lowest rounded-2xl shadow-2xl w-full max-w-2xl max-h-[88vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="sticky top-0 bg-surface-container-lowest/95 backdrop-blur flex items-center gap-2 px-5 py-4 border-b border-outline-variant/10 z-10">
              <span className="material-symbols-outlined text-primary">tune</span>
              <h3 className="text-base font-headline font-bold text-on-surface">LINE 運行設定</h3>
              <span className={`ml-auto px-2.5 py-1 rounded-full text-xs font-bold ${status?.enabled ? 'bg-success/15 text-success' : 'bg-error/15 text-error'}`}>
                {status?.enabled ? '已啟用' : '已停用'}
              </span>
              <button onClick={() => setSettingsOpen(false)} className="w-8 h-8 flex items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container-high transition-colors cursor-pointer">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <div className="p-5 md:p-6">
              <p className="text-[11px] font-bold uppercase tracking-wider text-on-surface-variant/70 mb-2">運行設定 · 即時生效</p>
              <div className="rounded-xl border border-outline-variant/15 divide-y divide-outline-variant/10 overflow-hidden">
                {FIELDS.map(f => (
                  <div key={f.key} className="flex items-center gap-4 px-4 py-3.5">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-on-surface">{f.label}</div>
                      <div className="text-xs text-on-surface-variant/70 mt-0.5 leading-relaxed">{f.hint}</div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <input
                        type="number" min={f.min} max={f.max} step={f.step}
                        value={form[f.key]}
                        disabled={isReadonly}
                        onChange={e => setForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                        className="w-20 px-2.5 py-1.5 bg-surface-container-highest text-on-surface text-sm text-right rounded-lg border border-outline-variant/20 focus:border-primary focus:outline-none font-mono disabled:opacity-50"
                      />
                      <span className="text-xs text-on-surface-variant w-10">{f.unit}</span>
                    </div>
                  </div>
                ))}
              </div>
              {!isReadonly && (
                <div className="mt-4 flex items-center gap-3">
                  <button onClick={saveSettings} disabled={saving}
                    className="px-5 py-2.5 bg-primary text-on-primary text-sm font-bold rounded-lg hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50">
                    {saving ? '儲存中…' : '儲存設定'}
                  </button>
                  {saved && (
                    <span className="flex items-center gap-1 text-sm text-success font-bold">
                      <span className="material-symbols-outlined text-sm">check_circle</span>已儲存
                    </span>
                  )}
                </div>
              )}

              <p className="text-[11px] font-bold uppercase tracking-wider text-on-surface-variant/70 mt-7 mb-2">連線資訊 · 來自 .env（唯讀）</p>
              <div className="rounded-xl border border-outline-variant/15 px-4 py-1">
                <div className="grid grid-cols-1 md:grid-cols-2 md:gap-x-8">
                  <CopyField label="金鑰設定" value={status?.channelConfigured ? '已設定' : '未設定'} ok={status?.channelConfigured} copyable={false} />
                  <CopyField label="Channel ID" value={status?.channelId || '—'} />
                  <CopyField label="Bot ID" value={status?.botBasicId || '—'} />
                  <CopyField label="LIFF ID" value={status?.liffId || '—'} />
                  <div className="md:col-span-2"><CopyField label="Webhook URL" value={status?.webhookUrl || '—'} /></div>
                  <div className="md:col-span-2"><CopyField label="對外網址" value={status?.publicApiBase || '—'} /></div>
                </div>
              </div>
              <p className="text-[11px] text-on-surface-variant/60 mt-2">需更改連線資訊請改 .env 後重啟服務。</p>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirm */}
      {delTarget && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={() => !busy && setDelTarget(null)}>
          <div className="bg-surface-container-lowest rounded-2xl shadow-2xl w-full max-w-sm p-6" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-headline font-bold text-on-surface mb-2">刪除並封鎖 LINE 用戶</h3>
            <p className="text-sm text-on-surface-variant mb-1">確定要刪除「{delTarget.displayName || delTarget.email}」的 LINE 綁定嗎？</p>
            <p className="text-xs text-on-surface-variant mb-5">刪除後，此 LINE 帳號將<strong className="text-error">無法再與機器人對話，也無法重新綁定</strong>，直到你在下方「已封鎖」清單解除。網頁帳號本身不受影響。</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDelTarget(null)} disabled={busy} className="px-4 py-2 rounded-xl text-sm font-bold text-on-surface-variant hover:bg-surface-container-high cursor-pointer disabled:opacity-40">取消</button>
              <button onClick={doDeleteUser} disabled={busy} className="px-5 py-2 rounded-xl text-sm font-bold text-on-error bg-error hover:bg-error/90 cursor-pointer disabled:opacity-40 flex items-center gap-2">
                {busy && <span className="material-symbols-outlined animate-spin text-base">progress_activity</span>}
                刪除並封鎖
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function CopyField({ label, value, ok, copyable = true }: { label: string; value: string; ok?: boolean; copyable?: boolean }) {
  const [copied, setCopied] = useState(false);
  const canCopy = copyable && !!value && value !== '—';
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
  };
  return (
    <div className="group flex items-center gap-3 py-2 border-b border-outline-variant/8 last:border-b-0">
      <span className="text-[11px] text-on-surface-variant shrink-0 w-24">{label}</span>
      <span className={`flex-1 min-w-0 truncate font-mono text-xs ${ok === true ? 'text-success' : ok === false ? 'text-error' : 'text-on-surface'}`}>{value}</span>
      {canCopy && (
        <button onClick={copy} title="複製" className="shrink-0 text-on-surface-variant/0 group-hover:text-on-surface-variant hover:!text-primary transition-colors cursor-pointer">
          <span className="material-symbols-outlined text-[16px]">{copied ? 'check' : 'content_copy'}</span>
        </button>
      )}
    </div>
  );
}
