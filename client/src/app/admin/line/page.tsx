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
  disabled: boolean;
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
  const [disableTarget, setDisableTarget] = useState<LineUser | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LineUser | null>(null);
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

  useEffect(() => { loadSettings(); loadUsers(); loadQuota(); }, [loadSettings, loadUsers, loadQuota]);

  // Suspend (with confirm) or restore a LINE user. Restoring returns them to
  // their original access; the binding is never deleted.
  async function setDisabled(u: LineUser, disabled: boolean) {
    if (!token || busy || isReadonly) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/line/users/${encodeURIComponent(u.lineUserId)}/${disabled ? 'disable' : 'enable'}`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) { setDisableTarget(null); loadUsers(); }
      else setError(disabled ? '停用失敗' : '啟用失敗');
    } catch { setError('操作失敗（網路錯誤）'); }
    finally { setBusy(false); }
  }

  // Fully unbind (delete) a LINE account from its internal user. Unlike disable,
  // this removes the binding so the LINE can be re-bound to another account.
  async function unbindUser(u: LineUser) {
    if (!token || busy || isReadonly) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/line/users/${encodeURIComponent(u.lineUserId)}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) { setDeleteTarget(null); loadUsers(); }
      else setError('解除綁定失敗');
    } catch { setError('操作失敗（網路錯誤）'); }
    finally { setBusy(false); }
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
            <span className="material-symbols-outlined text-xl text-primary shrink-0">campaign</span>
            <h3 className="text-sm md:text-base font-headline font-bold text-on-surface shrink-0">本月推播訊息額度</h3>
            <span className="hidden lg:inline text-xs text-on-surface-variant truncate">(LINE 官方帳號；回覆訊息不計入)</span>
            <button onClick={loadQuota} className="ml-auto shrink-0 text-xs text-on-surface-variant hover:text-primary flex items-center gap-1 cursor-pointer whitespace-nowrap">
              <span className="material-symbols-outlined text-sm">refresh</span><span className="hidden sm:inline">重新整理</span>
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
            <span className="material-symbols-outlined text-xl text-tertiary shrink-0">account_balance_wallet</span>
            <h3 className="text-sm md:text-base font-headline font-bold text-on-surface shrink-0">LINE 使用者額度</h3>
            <span className="text-xs text-on-surface-variant shrink-0">({users.length} 位)</span>
            <button onClick={loadUsers} className="ml-auto shrink-0 text-xs text-on-surface-variant hover:text-primary flex items-center gap-1 cursor-pointer whitespace-nowrap">
              <span className="material-symbols-outlined text-sm">refresh</span><span className="hidden sm:inline">重新整理</span>
            </button>
          </div>

          {loadingUsers ? (
            <p className="text-sm text-on-surface-variant py-6 text-center">載入中…</p>
          ) : users.length === 0 ? (
            <p className="text-sm text-on-surface-variant py-6 text-center">目前沒有已綁定的 LINE 使用者。</p>
          ) : (
            <>
            {/* Mobile: stacked cards */}
            <div className="md:hidden space-y-2">
              {users.map(u => (
                <div key={u.lineUserId} className={`p-3 rounded-xl border border-outline-variant/10 bg-surface-container-high/30 ${u.disabled ? 'opacity-55' : ''}`}>
                  <div className="flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium text-on-surface text-sm truncate">{u.displayName || u.email}</span>
                        {u.disabled && <span className="shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded bg-error/10 text-error">已停用</span>}
                      </div>
                      <div className="text-[11px] text-on-surface-variant/70 truncate">{u.email}</div>
                    </div>
                    {!isReadonly && (
                      <div className="flex items-center gap-1.5 shrink-0">
                        {u.disabled
                          ? <button onClick={() => setDisabled(u, false)} disabled={busy} className="px-3 py-1.5 rounded-lg text-xs font-bold text-primary border border-primary/30 hover:bg-primary/10 cursor-pointer disabled:opacity-40">啟用</button>
                          : <button onClick={() => setDisableTarget(u)} disabled={busy} className="px-3.5 py-1.5 rounded-lg text-xs font-bold text-error border border-error/40 bg-error/5 hover:bg-error/10 cursor-pointer disabled:opacity-40">停用</button>}
                        <button onClick={() => setDeleteTarget(u)} disabled={busy} title="解除綁定（刪除）"
                          className="w-8 h-8 flex items-center justify-center rounded-lg text-error border border-error/40 bg-error/5 hover:bg-error/10 cursor-pointer disabled:opacity-40">
                          <span className="material-symbols-outlined text-[18px]">link_off</span>
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="mt-2.5 flex items-center gap-2">
                    <div className="flex-1 h-1.5 bg-surface-container-highest rounded-full overflow-hidden">
                      <div className={`h-full ${barColor(u)}`} style={{ width: `${Math.min(u.pctUsed, 100)}%` }} />
                    </div>
                    <span className={`text-[11px] tabular-nums shrink-0 ${u.exceeded ? 'text-error font-bold' : 'text-on-surface-variant'}`}>{u.pctUsed}%</span>
                  </div>
                  <div className="mt-1.5 flex items-center justify-between text-[11px] text-on-surface-variant">
                    <span>已用 <span className="font-mono text-on-surface">{money(u.cost)}</span> / {money(u.limit)}</span>
                    <span className={u.exceeded ? 'text-error font-medium' : ''}>剩餘 {money(u.remaining)}</span>
                  </div>
                </div>
              ))}
            </div>
            {/* Desktop: full table */}
            <div className="hidden md:block overflow-x-auto">
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
                    <tr key={u.lineUserId} className={`border-b border-outline-variant/8 hover:bg-surface-container-high/40 ${u.disabled ? 'opacity-55' : ''}`}>
                      <td className="py-2.5 pr-3">
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium text-on-surface truncate max-w-[150px]">{u.displayName || u.email}</span>
                          {u.disabled && <span className="shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded bg-error/10 text-error">已停用</span>}
                        </div>
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
                          <div className="flex items-center justify-end gap-1.5">
                            {u.disabled ? (
                              <button onClick={() => setDisabled(u, false)} disabled={busy} title="恢復使用權限"
                                className="px-3 py-1.5 rounded-lg text-xs font-bold text-primary border border-primary/30 hover:bg-primary/10 transition-colors cursor-pointer disabled:opacity-40">
                                啟用
                              </button>
                            ) : (
                              <button onClick={() => setDisableTarget(u)} disabled={busy} title="停用此 LINE 用戶"
                                className="px-3.5 py-1.5 rounded-lg text-xs font-bold text-error border border-error/40 bg-error/5 hover:bg-error/10 transition-colors cursor-pointer disabled:opacity-40">
                                停用
                              </button>
                            )}
                            <button onClick={() => setDeleteTarget(u)} disabled={busy} title="解除綁定（刪除）"
                              className="px-3 py-1.5 rounded-lg text-xs font-bold text-error border border-error/40 bg-error/5 hover:bg-error/10 transition-colors cursor-pointer disabled:opacity-40">
                              解除綁定
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </>
          )}
        </div>
      </div>

      {/* Settings modal — runtime settings (DB) + connection info (.env) */}
      {settingsOpen && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 backdrop-blur-sm p-3 md:p-4" onClick={() => setSettingsOpen(false)}>
          <div className="bg-surface-container-lowest rounded-2xl shadow-2xl w-full max-w-2xl max-h-[92vh] md:max-h-[88vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
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

      {/* Disable confirm */}
      {disableTarget && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={() => !busy && setDisableTarget(null)}>
          <div className="bg-surface-container-lowest rounded-2xl shadow-2xl w-full max-w-sm p-6" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-headline font-bold text-on-surface mb-2">停用 LINE 用戶</h3>
            <p className="text-sm text-on-surface-variant mb-1">確定要停用「{disableTarget.displayName || disableTarget.email}」嗎？</p>
            <p className="text-xs text-on-surface-variant mb-5">停用後，此 LINE 帳號傳訊息時會收到「沒有使用權限」的提示，<strong className="text-on-surface">無法對話</strong>。綁定與資料都會保留，<strong className="text-primary">隨時可在此處重新「啟用」</strong>恢復原本權限。</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDisableTarget(null)} disabled={busy} className="px-4 py-2 rounded-xl text-sm font-bold text-on-surface-variant hover:bg-surface-container-high cursor-pointer disabled:opacity-40">取消</button>
              <button onClick={() => setDisabled(disableTarget, true)} disabled={busy} className="px-5 py-2 rounded-xl text-sm font-bold text-on-error bg-error hover:bg-error/90 cursor-pointer disabled:opacity-40 flex items-center gap-2">
                {busy && <span className="material-symbols-outlined animate-spin text-base">progress_activity</span>}
                停用
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Unbind (delete) confirm */}
      {deleteTarget && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={() => !busy && setDeleteTarget(null)}>
          <div className="bg-surface-container-lowest rounded-2xl shadow-2xl w-full max-w-sm p-6" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-headline font-bold text-on-surface mb-2">解除 LINE 綁定</h3>
            <p className="text-sm text-on-surface-variant mb-1">確定要解除「{deleteTarget.displayName || deleteTarget.email}」的 LINE 綁定嗎？</p>
            <p className="text-xs text-on-surface-variant mb-5">這支 LINE 與此帳號的連結會被<strong className="text-error">永久移除</strong>，之後可重新綁定到其他帳號。<strong className="text-on-surface">使用者帳號本身與既有對話、檔案不受影響</strong>，但要再用 LINE 需重新掃碼綁定。</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeleteTarget(null)} disabled={busy} className="px-4 py-2 rounded-xl text-sm font-bold text-on-surface-variant hover:bg-surface-container-high cursor-pointer disabled:opacity-40">取消</button>
              <button onClick={() => unbindUser(deleteTarget)} disabled={busy} className="px-5 py-2 rounded-xl text-sm font-bold text-on-error bg-error hover:bg-error/90 cursor-pointer disabled:opacity-40 flex items-center gap-2">
                {busy && <span className="material-symbols-outlined animate-spin text-base">progress_activity</span>}
                解除綁定
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
