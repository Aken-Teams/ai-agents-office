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
          <span className="text-xs md:text-sm text-on-surface-variant font-mono truncate">設定與額度</span>
        </div>
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

        {/* Bot status (read-only) */}
        <div className="bg-surface-container rounded-lg p-4 md:p-6">
          <div className="flex items-center gap-3 mb-3 md:mb-4">
            <div className="w-10 h-10 md:w-12 md:h-12 rounded-lg bg-surface-container-highest flex items-center justify-center shrink-0">
              <span className="material-symbols-outlined text-xl md:text-2xl text-success">smart_toy</span>
            </div>
            <div>
              <h3 className="text-sm md:text-base font-headline font-bold text-on-surface">機器人狀態</h3>
              <p className="text-xs text-on-surface-variant">下列為環境變數設定(唯讀),需更改請改 .env 後重啟服務。</p>
            </div>
            <span className={`ml-auto px-3 py-1 rounded-full text-xs font-bold ${status?.enabled ? 'bg-success/15 text-success' : 'bg-error/15 text-error'}`}>
              {status?.enabled ? '已啟用' : '已停用'}
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2 text-xs md:text-sm">
            <StatusRow label="金鑰設定" value={status?.channelConfigured ? '已設定' : '未設定'} ok={status?.channelConfigured} />
            <StatusRow label="Channel ID" value={status?.channelId || '—'} />
            <StatusRow label="Bot ID" value={status?.botBasicId || '—'} />
            <StatusRow label="LIFF ID" value={status?.liffId || '—'} />
            <StatusRow label="Webhook URL" value={status?.webhookUrl || '—'} mono />
            <StatusRow label="對外網址" value={status?.publicApiBase || '—'} mono />
          </div>
        </div>

        {/* Editable settings */}
        <div className="bg-surface-container rounded-lg p-4 md:p-6">
          <div className="flex items-center gap-2 mb-4">
            <span className="material-symbols-outlined text-xl text-primary">tune</span>
            <h3 className="text-sm md:text-base font-headline font-bold text-on-surface">運行設定</h3>
            <span className="text-xs text-on-surface-variant">(儲存後即時生效,不需重啟)</span>
            {saved && (
              <span className="ml-auto flex items-center gap-1 text-xs md:text-sm text-success font-bold">
                <span className="material-symbols-outlined text-sm">check_circle</span>已儲存
              </span>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-5">
            {FIELDS.map(f => (
              <div key={f.key}>
                <label className="text-xs md:text-sm text-on-surface font-medium block mb-1">{f.label}</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number" min={f.min} max={f.max} step={f.step}
                    value={form[f.key]}
                    disabled={isReadonly}
                    onChange={e => setForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                    className="w-28 md:w-36 px-3 py-2 bg-surface-container-highest text-on-surface text-sm rounded border border-outline-variant/20 focus:border-primary focus:outline-none font-mono disabled:opacity-50"
                  />
                  <span className="text-xs text-on-surface-variant">{f.unit}</span>
                </div>
                <p className="text-[11px] md:text-xs text-on-surface-variant/70 mt-1 leading-relaxed">{f.hint}</p>
              </div>
            ))}
          </div>
          {!isReadonly && (
            <div className="mt-5">
              <button
                onClick={saveSettings}
                disabled={saving}
                className="px-5 py-2.5 bg-primary text-on-primary text-sm font-bold rounded hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50"
              >
                {saving ? '儲存中…' : '儲存'}
              </button>
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
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function StatusRow({ label, value, ok, mono }: { label: string; value: string; ok?: boolean; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1 border-b border-outline-variant/8">
      <span className="text-on-surface-variant shrink-0">{label}</span>
      <span className={`truncate text-right ${mono ? 'font-mono text-xs' : ''} ${ok === true ? 'text-success' : ok === false ? 'text-error' : 'text-on-surface'}`}>{value}</span>
    </div>
  );
}
