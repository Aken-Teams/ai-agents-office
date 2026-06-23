'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';

const SSE_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

interface Recipient { email: string; name?: string }
interface AdMember { username: string; displayName: string; domain: string }

/**
 * Admin config for "who gets emailed when a user submits a quota request".
 * One unified add box: type an email to add it directly, or type a name to
 * search the AD address book and click to add. pro-panjit only.
 */
export default function QuotaNotifyModal({ token, onClose }: { token: string | null; onClose: () => void }) {
  const auth = useCallback(() => ({ Authorization: `Bearer ${token}` }), [token]);

  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [mailConfigured, setMailConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState(false);

  // Unified search box
  const [query, setQuery] = useState('');
  const [domain, setDomain] = useState('PANJIT');
  const [domains, setDomains] = useState<string[]>([]);
  const [adMembers, setAdMembers] = useState<AdMember[]>([]);
  const [adLoading, setAdLoading] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [hint, setHint] = useState('');
  const [domainOpen, setDomainOpen] = useState(false);
  const [domainPos, setDomainPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const domainRef = useRef<HTMLDivElement>(null);
  const domainBtnRef = useRef<HTMLButtonElement>(null);

  const openDomainMenu = () => {
    if (domainOpen) { setDomainOpen(false); return; }
    const r = domainBtnRef.current?.getBoundingClientRect();
    if (r) setDomainPos({ top: r.bottom + 4, left: r.left, width: Math.max(r.width, 176) });
    setDomainOpen(true);
  };

  // Test send
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  // Load AD member list for a domain (auto on open + domain change).
  const loadAdMembers = useCallback(async (dom: string) => {
    if (!token) return;
    setAdLoading(true);
    setAdMembers([]);
    try {
      const res = await fetch(`${SSE_BASE}/api/admin/ad/members?domain=${encodeURIComponent(dom)}`, { headers: auth() });
      if (!res.ok) return;
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
    } catch { /* ignore */ } finally {
      setAdLoading(false);
    }
  }, [token, auth]);

  // Load current config + AD domains, then auto-load the first domain's members.
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
      .then(d => {
        const list = d?.domains?.length ? d.domains : ['PANJIT'];
        setDomains(list);
        setDomain(list[0]);
        loadAdMembers(list[0]);
      })
      .catch(() => { loadAdMembers('PANJIT'); });
  }, [token, auth, loadAdMembers]);

  // Close the company dropdown on outside click.
  useEffect(() => {
    if (!domainOpen) return;
    const onDown = (e: MouseEvent) => { if (domainRef.current && !domainRef.current.contains(e.target as Node)) setDomainOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [domainOpen]);

  const has = (email: string) => recipients.some(r => r.email === email.trim().toLowerCase());

  function addRecipient(email: string, name?: string) {
    const e = email.trim().toLowerCase();
    if (!e.includes('@') || has(e)) return;
    setRecipients(prev => [...prev, { email: e, name: name?.trim() || undefined }]);
  }

  function removeRecipient(email: string) {
    setRecipients(prev => prev.filter(r => r.email !== email));
  }

  const q = query.trim();
  const looksLikeEmail = q.includes('@') && /\S+@\S+\.\S+/.test(q);

  async function addEmailDirect() {
    if (!looksLikeEmail) return;
    addRecipient(q);
    setQuery('');
    setHint('');
  }

  async function addFromAd(m: AdMember) {
    if (!token || adding) return;
    setAdding(m.username);
    setHint('');
    try {
      const res = await fetch(`${SSE_BASE}/api/admin/ad/resolve-email?username=${encodeURIComponent(m.username)}&domain=${encodeURIComponent(m.domain)}`, { headers: auth() });
      const d = res.ok ? await res.json() : null;
      if (d?.email) {
        addRecipient(d.email, m.displayName);
        setQuery('');
      } else {
        setHint(`「${m.displayName}」在 AD 沒有設定信箱，無法加入`);
      }
    } catch {
      setHint('查詢信箱失敗，請稍後再試');
    } finally {
      setAdding(null);
    }
  }

  // Live results under the search box (only when typing).
  const adMatches = useMemo(() => {
    if (!q || looksLikeEmail) return [];
    const lower = q.toLowerCase();
    return adMembers.filter(m => m.displayName.toLowerCase().includes(lower) || m.username.toLowerCase().includes(lower)).slice(0, 30);
  }, [q, looksLikeEmail, adMembers]);

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
    if (!token || testing || recipients.length === 0) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(`${SSE_BASE}/api/admin/quota-notify/test`, {
        method: 'POST',
        headers: { ...auth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok) setTestResult({ ok: true, msg: `已寄出至 ${(d.sentTo || []).join('、')}` });
      else setTestResult({ ok: false, msg: d.detail || d.error || `寄送失敗 (${res.status})` });
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
        className="relative bg-surface-container rounded-t-2xl md:rounded-2xl border border-outline-variant/20 shadow-2xl w-full md:max-w-xl md:max-h-[85vh] max-h-[92vh] flex flex-col"
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
          <div className="flex-1 flex items-center justify-center text-on-surface-variant text-sm py-16">載入中…</div>
        ) : (
          <div className="flex-1 overflow-y-auto px-5 md:px-6 py-4 space-y-4">
            {!mailConfigured && (
              <div className="text-xs bg-error/10 text-error rounded-lg px-3 py-2">⚠ 郵件閘道尚未設定（缺少 AD_API），無法寄信。</div>
            )}

            {/* Unified add box */}
            <div>
              <label className="text-xs font-bold text-on-surface-variant uppercase tracking-wider mb-2 block">新增通知對象</label>
              <div className="flex gap-2">
                <div className="relative shrink-0" ref={domainRef}>
                  <button
                    ref={domainBtnRef}
                    type="button"
                    onClick={openDomainMenu}
                    className="flex items-center gap-1.5 bg-surface-container-high border border-outline-variant/20 hover:border-primary/50 rounded-lg pl-3 pr-2 py-2 text-sm text-on-surface cursor-pointer transition-colors w-[7.5rem]"
                    title="AD 公司別"
                  >
                    <span className="truncate flex-1 text-left">{domain}</span>
                    <span className={`material-symbols-outlined text-lg text-on-surface-variant/60 transition-transform ${domainOpen ? 'rotate-180' : ''}`}>expand_more</span>
                  </button>
                  {domainOpen && domainPos && (
                    <div
                      className="fixed z-[60] max-h-64 overflow-y-auto bg-surface-container-highest border border-outline-variant/20 rounded-xl shadow-2xl py-1"
                      style={{ top: domainPos.top, left: domainPos.left, width: domainPos.width }}
                    >
                      {(domains.length ? domains : ['PANJIT']).map(d => (
                        <button
                          key={d}
                          type="button"
                          onClick={() => { setDomain(d); loadAdMembers(d); setDomainOpen(false); }}
                          className={`w-full px-3 py-2 text-left text-sm cursor-pointer transition-colors ${d === domain ? 'text-primary bg-primary/5 font-bold' : 'text-on-surface hover:bg-surface-container'}`}
                        >
                          {d}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="relative flex-1">
                  <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant/50 text-lg pointer-events-none">search</span>
                  <input
                    value={query}
                    onChange={e => { setQuery(e.target.value); setHint(''); }}
                    onKeyDown={e => { if (e.key === 'Enter' && looksLikeEmail) addEmailDirect(); }}
                    placeholder="輸入信箱，或搜尋 AD 姓名／帳號…"
                    className="w-full bg-surface-container-high border border-outline-variant/20 focus:border-primary rounded-lg pl-10 pr-3 py-2 text-sm text-on-surface"
                  />
                </div>
              </div>
              {hint && <p className="text-xs text-error mt-2">{hint}</p>}

              {/* Live results */}
              {q && (
                <div className="mt-2 border border-outline-variant/10 rounded-lg overflow-hidden">
                  {looksLikeEmail ? (
                    <button
                      onClick={addEmailDirect}
                      disabled={has(q)}
                      className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-container-highest/60 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <span className="material-symbols-outlined text-primary">add_circle</span>
                      <span className="text-sm text-on-surface flex-1 truncate">{has(q) ? `${q}（已在清單中）` : `加入信箱：${q}`}</span>
                    </button>
                  ) : adLoading ? (
                    <p className="text-xs text-on-surface-variant/60 px-3 py-3 text-center">載入 AD 通訊錄中…</p>
                  ) : adMatches.length === 0 ? (
                    <p className="text-xs text-on-surface-variant/60 px-3 py-3 text-center">找不到符合的 AD 成員（或可直接輸入完整信箱）</p>
                  ) : (
                    <div className="max-h-52 overflow-y-auto divide-y divide-outline-variant/10">
                      {adMatches.map(m => (
                        <button
                          key={m.username}
                          onClick={() => addFromAd(m)}
                          disabled={adding === m.username}
                          className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-surface-container-highest/60 cursor-pointer disabled:opacity-50"
                        >
                          <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center text-xs font-bold text-primary shrink-0">{m.displayName.slice(0, 1)}</div>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm text-on-surface truncate">{m.displayName}</p>
                            <p className="text-xs text-on-surface-variant/60 truncate">{m.username}</p>
                          </div>
                          <span className="text-xs font-bold text-primary shrink-0">{adding === m.username ? '查詢中…' : '加入'}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Recipient list */}
            <div>
              <label className="text-xs font-bold text-on-surface-variant uppercase tracking-wider mb-2 block">通知對象（{recipients.length}）</label>
              {recipients.length === 0 ? (
                <p className="text-sm text-on-surface-variant/60 py-3 bg-surface-container-high/50 rounded-lg px-3 text-center">尚未設定任何收件者</p>
              ) : (
                <div className="space-y-1.5">
                  {recipients.map(r => (
                    <div key={r.email} className="flex items-center gap-3 bg-surface-container-high rounded-lg px-3 py-2">
                      <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center text-xs font-bold text-primary shrink-0">{(r.name || r.email).slice(0, 1).toUpperCase()}</div>
                      <div className="min-w-0 flex-1">
                        {r.name && <p className="text-sm text-on-surface truncate">{r.name}</p>}
                        <p className={`truncate ${r.name ? 'text-xs text-on-surface-variant/60' : 'text-sm text-on-surface'}`}>{r.email}</p>
                      </div>
                      <button onClick={() => removeRecipient(r.email)} className="w-7 h-7 flex items-center justify-center rounded-lg text-on-surface-variant/50 hover:text-error hover:bg-error/10 cursor-pointer shrink-0" title="移除">
                        <span className="material-symbols-outlined text-lg">close</span>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {testResult && (
              <p className={`text-xs rounded-lg px-3 py-2 ${testResult.ok ? 'bg-success/10 text-success' : 'bg-error/10 text-error'}`}>
                {testResult.ok ? '✓ ' : '✕ '}{testResult.msg}
              </p>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center gap-2 px-5 md:px-6 py-4 border-t border-outline-variant/10 shrink-0">
          <button
            onClick={sendTest}
            disabled={testing || recipients.length === 0}
            className="px-3 py-2 text-sm font-bold text-on-surface-variant hover:bg-surface-container-highest rounded-lg cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title={recipients.length === 0 ? '請先加入收件者' : '寄一封測試信給目前所有對象'}
          >
            {testing ? '寄送中…' : '寄測試信'}
          </button>
          {savedMsg && <span className="text-sm text-success font-bold ml-1">✓ 已儲存</span>}
          <button onClick={onClose} className="ml-auto px-4 py-2 bg-surface-container-highest border border-outline-variant/10 text-on-surface font-bold text-sm rounded-lg cursor-pointer hover:bg-surface-variant transition-colors">關閉</button>
          <button onClick={save} disabled={saving} className="px-5 py-2 bg-primary text-on-primary font-bold text-sm rounded-lg cursor-pointer hover:bg-primary/80 transition-colors disabled:opacity-50">
            {saving ? '儲存中…' : '儲存設定'}
          </button>
        </div>
      </div>
    </div>
  );
}
