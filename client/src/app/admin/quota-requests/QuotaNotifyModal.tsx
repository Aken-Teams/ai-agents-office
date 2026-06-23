'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';

const SSE_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

interface Recipient { email: string; name?: string }
interface AdMember { username: string; displayName: string; domain: string }

/**
 * Admin config for "who gets emailed when a user submits a quota request".
 * Recipients are picked via AD search (or typed manually). pro-panjit only.
 */
export default function QuotaNotifyModal({ token, onClose }: { token: string | null; onClose: () => void }) {
  const auth = useCallback(() => ({ Authorization: `Bearer ${token}` }), [token]);

  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [mailConfigured, setMailConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState(false);

  // Manual add
  const [manualEmail, setManualEmail] = useState('');
  const [manualName, setManualName] = useState('');

  // AD picker
  const [domains, setDomains] = useState<string[]>([]);
  const [domain, setDomain] = useState('PANJIT');
  const [adMembers, setAdMembers] = useState<AdMember[]>([]);
  const [adLoading, setAdLoading] = useState(false);
  const [adSearch, setAdSearch] = useState('');
  const [adding, setAdding] = useState<string | null>(null);
  const [adError, setAdError] = useState('');

  // Test send
  const [testEmail, setTestEmail] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  // Load current config + AD domains
  useEffect(() => {
    if (!token) return;
    setLoading(true);
    fetch(`${SSE_BASE}/api/admin/quota-notify`, { headers: auth() })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) { setRecipients(d.recipients || []); setMailConfigured(!!d.mailConfigured); } })
      .catch(() => {})
      .finally(() => setLoading(false));
    fetch(`${SSE_BASE}/api/admin/org/domains`, { headers: auth() })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.domains?.length) { setDomains(d.domains); setDomain(d.domains[0]); } })
      .catch(() => {});
  }, [token, auth]);

  const has = (email: string) => recipients.some(r => r.email === email.toLowerCase());

  function addRecipient(email: string, name?: string) {
    const e = email.trim().toLowerCase();
    if (!e.includes('@') || has(e)) return;
    setRecipients(prev => [...prev, { email: e, name: name?.trim() || undefined }]);
  }

  function addManual() {
    if (!manualEmail.includes('@')) return;
    addRecipient(manualEmail, manualName);
    setManualEmail('');
    setManualName('');
  }

  function removeRecipient(email: string) {
    setRecipients(prev => prev.filter(r => r.email !== email));
  }

  // Flatten the AD org tree into a member list.
  const loadAdMembers = useCallback(async (dom: string) => {
    if (!token) return;
    setAdLoading(true);
    setAdError('');
    setAdMembers([]);
    try {
      const res = await fetch(`${SSE_BASE}/api/admin/ad/members?domain=${encodeURIComponent(dom)}`, { headers: auth() });
      if (!res.ok) { setAdError('無法載入 AD 成員'); return; }
      const data = await res.json();
      const out: AdMember[] = [];
      const seen = new Set<string>();
      const walk = (node: any) => {
        if (!node) return;
        for (const m of node.members || []) {
          const key = (m.username || '').toLowerCase();
          if (m.username && !seen.has(key)) {
            seen.add(key);
            out.push({ username: m.username, displayName: m.displayName || m.username, domain: dom });
          }
        }
        for (const c of node.children || []) walk(c);
      };
      walk(data.tree);
      out.sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-Hant'));
      setAdMembers(out);
    } catch {
      setAdError('無法載入 AD 成員');
    } finally {
      setAdLoading(false);
    }
  }, [token, auth]);

  async function addFromAd(m: AdMember) {
    if (!token || adding) return;
    setAdding(m.username);
    setAdError('');
    try {
      const res = await fetch(`${SSE_BASE}/api/admin/ad/resolve-email?username=${encodeURIComponent(m.username)}&domain=${encodeURIComponent(m.domain)}`, { headers: auth() });
      const d = res.ok ? await res.json() : null;
      if (d?.email) {
        addRecipient(d.email, m.displayName);
      } else {
        setAdError(`找不到「${m.displayName}」的信箱`);
      }
    } catch {
      setAdError('查詢信箱失敗');
    } finally {
      setAdding(null);
    }
  }

  const filteredAd = useMemo(() => {
    const q = adSearch.trim().toLowerCase();
    const list = q ? adMembers.filter(m => m.displayName.toLowerCase().includes(q) || m.username.toLowerCase().includes(q)) : adMembers;
    return list.slice(0, 100);
  }, [adMembers, adSearch]);

  async function save() {
    if (!token || saving) return;
    setSaving(true);
    setSavedMsg(false);
    try {
      const res = await fetch(`${SSE_BASE}/api/admin/quota-notify`, {
        method: 'PUT',
        headers: { ...auth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipients }),
      });
      if (res.ok) { const d = await res.json(); setRecipients(d.recipients || recipients); setSavedMsg(true); setTimeout(() => setSavedMsg(false), 2500); }
    } finally {
      setSaving(false);
    }
  }

  async function sendTest() {
    if (!token || testing) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(`${SSE_BASE}/api/admin/quota-notify/test`, {
        method: 'POST',
        headers: { ...auth(), 'Content-Type': 'application/json' },
        body: JSON.stringify(testEmail.includes('@') ? { email: testEmail.trim() } : {}),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok) {
        setTestResult({ ok: true, msg: `已寄出至 ${(d.sentTo || []).join(', ')}` });
      } else {
        setTestResult({ ok: false, msg: d.detail || d.error || `寄送失敗 (${res.status})` });
      }
    } catch (e) {
      setTestResult({ ok: false, msg: e instanceof Error ? e.message : '寄送失敗' });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        className="relative bg-surface-container rounded-t-2xl md:rounded-2xl border border-outline-variant/20 shadow-2xl w-full md:max-w-2xl md:h-[82vh] max-h-[92vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 md:px-6 py-4 border-b border-outline-variant/10 shrink-0">
          <span className="material-symbols-outlined text-primary">mark_email_unread</span>
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-headline font-bold text-on-surface">額度申請通知設定</h3>
            <p className="text-xs text-on-surface-variant">使用者提出額度申請時，系統會寄信通知以下對象</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-lg text-on-surface-variant hover:bg-surface-container-highest cursor-pointer">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        {loading ? (
          <div className="flex-1 flex items-center justify-center text-on-surface-variant text-sm">載入中…</div>
        ) : (
          <div className="flex-1 overflow-y-auto px-5 md:px-6 py-4 space-y-5">
            {!mailConfigured && (
              <div className="text-xs bg-error/10 text-error rounded-lg px-3 py-2">
                ⚠ 郵件閘道尚未設定（缺少 AD_API），無法寄信。
              </div>
            )}

            {/* Current recipients */}
            <section>
              <h4 className="text-xs font-bold text-on-surface-variant uppercase tracking-wider mb-2">通知對象（{recipients.length}）</h4>
              {recipients.length === 0 ? (
                <p className="text-sm text-on-surface-variant/60 py-2">尚未設定任何收件者</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {recipients.map(r => (
                    <span key={r.email} className="inline-flex items-center gap-1.5 bg-surface-container-highest rounded-full pl-3 pr-1.5 py-1 text-sm">
                      <span className="text-on-surface">{r.name || r.email.split('@')[0]}</span>
                      <span className="text-on-surface-variant/60 text-xs">{r.email}</span>
                      <button onClick={() => removeRecipient(r.email)} className="w-5 h-5 flex items-center justify-center rounded-full hover:bg-error/10 hover:text-error text-on-surface-variant cursor-pointer">
                        <span className="material-symbols-outlined text-sm">close</span>
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </section>

            {/* Manual add */}
            <section>
              <h4 className="text-xs font-bold text-on-surface-variant uppercase tracking-wider mb-2">手動加入信箱</h4>
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  value={manualEmail}
                  onChange={e => setManualEmail(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') addManual(); }}
                  placeholder="someone@panjit.com.tw"
                  className="flex-1 bg-surface-container-high border border-outline-variant/20 focus:border-primary rounded-lg px-3 py-2 text-sm text-on-surface"
                />
                <input
                  value={manualName}
                  onChange={e => setManualName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') addManual(); }}
                  placeholder="顯示名稱（選填）"
                  className="sm:w-40 bg-surface-container-high border border-outline-variant/20 focus:border-primary rounded-lg px-3 py-2 text-sm text-on-surface"
                />
                <button
                  onClick={addManual}
                  disabled={!manualEmail.includes('@')}
                  className="px-4 py-2 bg-primary/10 text-primary font-bold text-sm rounded-lg cursor-pointer hover:bg-primary/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                >
                  加入
                </button>
              </div>
            </section>

            {/* AD picker */}
            <section>
              <h4 className="text-xs font-bold text-on-surface-variant uppercase tracking-wider mb-2">從 AD 通訊錄選擇</h4>
              <div className="flex gap-2 mb-2">
                <select
                  value={domain}
                  onChange={e => setDomain(e.target.value)}
                  className="bg-surface-container-high border border-outline-variant/20 focus:border-primary rounded-lg px-3 py-2 text-sm text-on-surface cursor-pointer"
                >
                  {(domains.length ? domains : ['PANJIT']).map(d => <option key={d} value={d}>{d}</option>)}
                </select>
                <button
                  onClick={() => loadAdMembers(domain)}
                  disabled={adLoading}
                  className="px-4 py-2 bg-surface-container-highest text-on-surface font-bold text-sm rounded-lg cursor-pointer hover:bg-surface-variant transition-colors disabled:opacity-50"
                >
                  {adLoading ? '載入中…' : '載入成員'}
                </button>
              </div>
              {adError && <p className="text-xs text-error mb-2">{adError}</p>}
              {adMembers.length > 0 && (
                <>
                  <div className="relative mb-2">
                    <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant/50 text-lg pointer-events-none">search</span>
                    <input
                      value={adSearch}
                      onChange={e => setAdSearch(e.target.value)}
                      placeholder="搜尋姓名或帳號…"
                      className="w-full bg-surface-container-high border border-outline-variant/20 focus:border-primary rounded-lg pl-10 pr-3 py-2 text-sm text-on-surface"
                    />
                  </div>
                  <div className="border border-outline-variant/10 rounded-lg divide-y divide-outline-variant/10 max-h-56 overflow-y-auto">
                    {filteredAd.map(m => {
                      const added = recipients.some(r => r.name === m.displayName); // best-effort visual hint
                      return (
                        <div key={m.username} className="flex items-center gap-3 px-3 py-2 hover:bg-surface-container-highest/50">
                          <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center text-xs font-bold text-primary shrink-0">
                            {m.displayName.slice(0, 1)}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm text-on-surface truncate">{m.displayName}</p>
                            <p className="text-xs text-on-surface-variant/60 truncate">{m.username}</p>
                          </div>
                          <button
                            onClick={() => addFromAd(m)}
                            disabled={adding === m.username}
                            className="px-3 py-1 text-xs font-bold rounded-lg cursor-pointer transition-colors shrink-0 bg-primary/10 text-primary hover:bg-primary/20 disabled:opacity-50"
                          >
                            {adding === m.username ? '查詢中…' : added ? '再加入' : '加入'}
                          </button>
                        </div>
                      );
                    })}
                    {filteredAd.length === 0 && <p className="text-xs text-on-surface-variant/60 px-3 py-3 text-center">無符合成員</p>}
                  </div>
                </>
              )}
            </section>

            {/* Test send */}
            <section className="pt-2 border-t border-outline-variant/10">
              <h4 className="text-xs font-bold text-on-surface-variant uppercase tracking-wider mb-2">測試寄信</h4>
              <div className="flex gap-2">
                <input
                  value={testEmail}
                  onChange={e => setTestEmail(e.target.value)}
                  placeholder="測試信箱（留空則寄給上方所有對象）"
                  className="flex-1 bg-surface-container-high border border-outline-variant/20 focus:border-primary rounded-lg px-3 py-2 text-sm text-on-surface"
                />
                <button
                  onClick={sendTest}
                  disabled={testing}
                  className="px-4 py-2 bg-surface-container-highest text-on-surface font-bold text-sm rounded-lg cursor-pointer hover:bg-surface-variant transition-colors disabled:opacity-50 shrink-0"
                >
                  {testing ? '寄送中…' : '寄出測試'}
                </button>
              </div>
              {testResult && (
                <p className={`text-xs mt-2 rounded-lg px-3 py-2 ${testResult.ok ? 'bg-success/10 text-success' : 'bg-error/10 text-error'}`}>
                  {testResult.ok ? '✓ ' : '✕ '}{testResult.msg}
                </p>
              )}
            </section>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center gap-3 px-5 md:px-6 py-4 border-t border-outline-variant/10 shrink-0">
          {savedMsg && <span className="text-sm text-success font-bold">✓ 已儲存</span>}
          <button onClick={onClose} className="ml-auto px-4 py-2 bg-surface-container-highest border border-outline-variant/10 text-on-surface font-bold text-sm rounded-lg cursor-pointer hover:bg-surface-variant transition-colors">
            關閉
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="px-5 py-2 bg-primary text-on-primary font-bold text-sm rounded-lg cursor-pointer hover:bg-primary/80 transition-colors disabled:opacity-50"
          >
            {saving ? '儲存中…' : '儲存設定'}
          </button>
        </div>
      </div>
    </div>
  );
}
