'use client';

/**
 * Create-only schedule modal. Building a schedule lives here; viewing schedules
 * and whether they ran on time lives on the /team/[id]/schedules calendar page.
 */

import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from '../../i18n';
import { DOC_EXPORT, type ExportFormat } from './docFormats';

/**
 * Fully-custom dropdown. A native <select>'s open list is drawn by the OS (cramped,
 * unstyleable), and an in-flow popup gets clipped by the modal's overflow. So the
 * menu is rendered in a portal on <body> with fixed positioning — it always floats
 * above the window, matches the app's styling, and sizes to its content.
 */
function Dropdown({ value, onChange, options, className }: {
  value: string | number;
  onChange: (v: string) => void;
  options: { value: string | number; label: string }[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const b = btnRef.current?.getBoundingClientRect();
      if (b) setPos({ top: b.bottom + 4, left: b.left, width: b.width });
    };
    place();
    const onDoc = (e: MouseEvent) => {
      if (btnRef.current?.contains(e.target as Node) || menuRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    // Re-anchoring on every scroll is fiddly; closing keeps the menu from drifting.
    const close = () => setOpen(false);
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => { document.removeEventListener('mousedown', onDoc); window.removeEventListener('resize', close); window.removeEventListener('scroll', close, true); };
  }, [open]);

  const sel = options.find(o => String(o.value) === String(value));
  return (
    <div className={`relative ${className || ''}`}>
      <button ref={btnRef} type="button" onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-1.5 bg-surface-container border border-outline-variant/30 rounded-lg pl-3 pr-2 py-2.5 text-sm text-on-surface focus:outline-none focus:border-primary hover:border-outline-variant/50 transition-colors cursor-pointer">
        <span className="truncate">{sel?.label ?? ''}</span>
        <span className={`material-symbols-outlined text-on-surface-variant text-[18px] shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}>expand_more</span>
      </button>
      {open && pos && createPortal(
        <div ref={menuRef} style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width, zIndex: 100 }}
          className="max-h-64 overflow-y-auto rounded-xl border border-outline-variant/30 bg-surface-container-lowest shadow-2xl py-1">
          {options.map(o => {
            const active = String(o.value) === String(value);
            return (
              <button key={String(o.value)} type="button" onClick={() => { onChange(String(o.value)); setOpen(false); }}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors cursor-pointer ${active ? 'text-primary font-bold bg-primary/10' : 'text-on-surface hover:bg-surface-container'}`}>
                <span className="flex-1 truncate">{o.label}</span>
                {active && <span className="material-symbols-outlined text-[16px] shrink-0">check</span>}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}

const DOW = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

// pro-panjit: the recipient is chosen from the AD directory (per company/domain)
// instead of typed, so scheduled reports only go to real 強茂 mailboxes.
const IS_PANJIT = (process.env.NEXT_PUBLIC_DEPLOY_MODE || 'pro-panjit') === 'pro-panjit';
const AD_DOMAIN_LIST: { code: string; label: string }[] = [
  { code: 'PANJIT', label: '台灣 PANJIT' },
  { code: 'PYNMAX', label: '璟茂' },
  { code: 'WXPJ', label: '無錫強茂' },
  { code: 'PJWS', label: '強茂深圳' },
  { code: 'GDPJ', label: '蘇州群鑫' },
  { code: 'PJXZ', label: '強茂徐州' },
  { code: 'PJSD', label: '山東強茂' },
];
interface AdMemberT { username: string; displayName: string }
interface AdNodeT { members?: { username: string; displayName: string }[]; children?: AdNodeT[] }
/** Flatten the AD org tree into a de-duplicated, searchable member list. */
function flattenAdTree(node: AdNodeT | null | undefined): AdMemberT[] {
  const out: AdMemberT[] = [];
  const seen = new Set<string>();
  const walk = (n?: AdNodeT | null) => {
    if (!n) return;
    for (const m of n.members || []) {
      const k = (m.username || '').toLowerCase();
      if (m.username && !seen.has(k)) { seen.add(k); out.push({ username: m.username, displayName: m.displayName || m.username }); }
    }
    for (const c of n.children || []) walk(c);
  };
  walk(node);
  return out;
}

export default function ScheduleCreateModal({
  teamId, token, defaultEmail, defaultQuestion, sourceHasFiles, onClose, onCreated,
}: {
  teamId: string;
  token: string | null;
  defaultEmail: string;
  defaultQuestion?: string;
  sourceHasFiles?: boolean;   // the analysis being scheduled had uploaded files
  onClose: () => void;
  onCreated?: () => void;
}) {
  const { t } = useTranslation();
  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [question, setQuestion] = useState(defaultQuestion?.trim() || '');
  const [frequency, setFrequency] = useState<'daily' | 'weekly'>('daily');
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [time, setTime] = useState('09:00');
  // Multiple recipients: each is an email plus (for AD picks) a display name.
  const [recipients, setRecipients] = useState<{ email: string; name?: string }[]>(
    defaultEmail?.trim() ? [{ email: defaultEmail.trim() }] : [],
  );
  const [emailInput, setEmailInput] = useState('');
  const [showAllRecipients, setShowAllRecipients] = useState(false);
  // Optional: also produce a file each run ('' = text report only).
  const [docFormat, setDocFormat] = useState<ExportFormat | ''>('');
  const [docStyleId, setDocStyleId] = useState('');
  const docFmt = docFormat ? DOC_EXPORT.find(f => f.format === docFormat) : null;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // AD recipient picker (pro-panjit): domain selector + directory search.
  const [adDomain, setAdDomain] = useState('PANJIT');
  const [adMembers, setAdMembers] = useState<AdMemberT[]>([]);
  const [adLoading, setAdLoading] = useState(false);
  const [adSearch, setAdSearch] = useState('');
  const [resolving, setResolving] = useState(false);

  // Add a recipient, ignoring duplicates (case-insensitive on the address).
  const addRecipient = (email: string, name?: string) => {
    const addr = email.trim();
    if (!addr) return;
    setRecipients(prev => prev.some(r => r.email.toLowerCase() === addr.toLowerCase()) ? prev : [...prev, { email: addr, name }]);
  };
  const removeRecipient = (addr: string) => setRecipients(prev => prev.filter(r => r.email !== addr));
  const headers = (): HeadersInit => (token ? { Authorization: `Bearer ${token}` } : {});

  function pickDocFormat(f: ExportFormat | '') {
    setDocFormat(f);
    if (f) setDocStyleId(DOC_EXPORT.find(x => x.format === f)!.styles[0].id);
  }

  // Load the selected company's AD directory (pro-panjit only).
  useEffect(() => {
    if (!IS_PANJIT || !token) return;
    let cancelled = false;
    setAdLoading(true);
    fetch(`/api/admin/ad/members?domain=${adDomain}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled) setAdMembers(flattenAdTree(d?.tree)); })
      .catch(() => { if (!cancelled) setAdMembers([]); })
      .finally(() => { if (!cancelled) setAdLoading(false); });
    return () => { cancelled = true; };
  }, [adDomain, token]);

  // Resolve the picked AD person to their real mailbox.
  async function pickAdUser(m: AdMemberT) {
    setResolving(true); setError(null);
    try {
      const res = await fetch(`/api/admin/ad/resolve-email?username=${encodeURIComponent(m.username)}&domain=${adDomain}`, { headers: headers() });
      const d = await res.json().catch(() => null) as { email?: string; displayName?: string } | null;
      if (d?.email) { addRecipient(d.email, m.displayName || d.displayName || ''); setAdSearch(''); }
      else setError(`「${m.displayName || m.username}」在 AD 沒有可用的信箱。`);
    } catch { setError('解析信箱失敗，請稍後再試。'); }
    finally { setResolving(false); }
  }

  const add = async () => {
    if (!question.trim() || !recipients.length || saving) return;
    const [h, m] = time.split(':').map(Number);
    setSaving(true);
    setError(null);
    let docFields: Record<string, string> = {};
    if (docFormat && docFmt) {
      const style = docFmt.styles.find(s => s.id === docStyleId) || docFmt.styles[0];
      docFields = { docFormat, docStylePrompt: (t(style.promptKey as never) as string) || '' };
    }
    try {
      const res = await fetch(`/api/teams/${teamId}/schedules`, {
        method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), question: question.trim(), frequency, hour: h, minute: m, dayOfWeek, email: recipients.map(r => r.email).join(','), ...docFields }),
      });
      if (res.ok) { onCreated?.(); onClose(); return; }
      // Surface the server's reason instead of leaving the modal silently stuck.
      const msg = await res.json().catch(() => null);
      setError(msg?.error || `建立失敗（伺服器回應 ${res.status}）`);
    } catch {
      setError('無法連線到伺服器，請稍後再試。');
    } finally { setSaving(false); }
  };

  const STEPS = [{ n: 1, label: '基本' }, { n: 2, label: '週期與文件' }, { n: 3, label: '收件者' }, { n: 4, label: '確認' }];
  const canNext1 = !!name.trim() && !!question.trim();
  // Which step gates the "下一步" button (step 2 has a default, so it never blocks).
  const canAdvance = step === 1 ? canNext1 : step === 3 ? recipients.length > 0 : true;

  // Human-readable summary values for the confirmation step.
  const scheduleText = frequency === 'daily' ? `每天 ${time}` : `每週${DOW[dayOfWeek]} ${time}`;
  const docStyleLabel = docFmt ? (t((docFmt.styles.find(s => s.id === docStyleId) || docFmt.styles[0]).labelKey as never) as string) : '';

  // A schedule only re-runs the topic text; it can't carry the files this analysis
  // used. Rather than silently drop them, block scheduling from a file-based run.
  if (sourceHasFiles) {
    return (
      <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={onClose}>
        <div className="bg-surface-container-lowest rounded-2xl shadow-2xl w-full max-w-md p-6 text-center" onClick={e => e.stopPropagation()}>
          <div className="w-12 h-12 rounded-full bg-tertiary/10 flex items-center justify-center mx-auto mb-3">
            <span className="material-symbols-outlined text-tertiary">construction</span>
          </div>
          <h3 className="text-lg font-headline font-bold text-on-surface mb-2">暫不支援此排程</h3>
          <p className="text-sm text-on-surface-variant leading-relaxed mb-5">
            此功能還在開發中，因此暫不提供有上傳過文件的分析進行排程。<br />
            排程只會用「議題文字」定期重新分析，無法帶入你上傳的檔案；若分析依賴上傳資料，請改用即時分析。
          </p>
          <button onClick={onClose} className="px-5 py-2 rounded-xl text-sm font-bold text-on-primary cyber-gradient transition-all cursor-pointer">我知道了</button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-surface-container-lowest rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-1">
          <span className="material-symbols-outlined text-primary">add_alarm</span>
          <h3 className="text-lg font-headline font-bold text-on-surface">新增排程</h3>
        </div>
        <p className="text-sm text-on-surface-variant mb-5">設定時間，團隊會自動跑分析、把結果寄到信箱，並記錄在排程管理頁。</p>

        {/* Stepper */}
        <div className="flex items-center mb-6">
          {STEPS.map((s, i) => (
            <div key={s.n} className={`flex items-center ${i < STEPS.length - 1 ? 'flex-1' : ''}`}>
              <div className="flex items-center gap-1.5 shrink-0">
                <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0 transition-colors ${step >= s.n ? 'cyber-gradient text-on-primary' : 'bg-surface-container-high text-on-surface-variant'}`}>
                  {step > s.n ? <span className="material-symbols-outlined text-[15px]">check</span> : s.n}
                </span>
                <span className={`text-xs font-bold ${step === s.n ? 'text-primary' : 'text-on-surface-variant'}`}>{s.label}</span>
              </div>
              {i < STEPS.length - 1 && <div className={`flex-1 h-0.5 mx-2 rounded ${step > s.n ? 'bg-primary/50' : 'bg-outline-variant/20'}`} />}
            </div>
          ))}
        </div>

        {/* ── Step 1: 基本 ── */}
        {step === 1 && (
          <>
            <label className="block text-xs font-bold text-on-surface-variant mb-1.5">排程名稱 <span className="text-error">*</span><span className="font-normal text-on-surface-variant/60">（給這個排程取個好認的名字）</span></label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="例如：每日台股盤勢"
              className="w-full bg-surface-container border border-outline-variant/30 rounded-xl px-3 py-2.5 text-sm text-on-surface focus:outline-none focus:border-primary mb-4" />

            <label className="block text-xs font-bold text-on-surface-variant mb-1.5">分析議題 / 需求 <span className="text-error">*</span><span className="font-normal text-on-surface-variant/60">（團隊真正要分析的內容）</span></label>
            <textarea value={question} onChange={e => setQuestion(e.target.value)} rows={5} placeholder="要團隊定期分析的議題，例如：今天的台股盤勢與我持股的風險"
              className="w-full bg-surface-container border border-outline-variant/30 rounded-xl px-3 py-2.5 text-sm text-on-surface resize-none focus:outline-none focus:border-primary" />

            <div className="flex items-start gap-2.5 mt-3 px-3.5 py-3 rounded-xl bg-surface-container border border-outline-variant/20 text-sm text-on-surface-variant leading-relaxed">
              <span className="material-symbols-outlined text-[20px] text-on-surface-variant/70 shrink-0 mt-0.5">info</span>
              <span>排程只會用「議題文字」定期重新分析，<b className="text-on-surface">不會帶入你上傳的檔案</b>。適合盤勢、新聞等會持續更新的公開議題。若分析需要用到檔案，請直接回到團隊頁上傳檔案後執行分析（排程無法帶入檔案）。</span>
            </div>
          </>
        )}

        {/* ── Step 2: 週期與文件 ── */}
        {step === 2 && (
          <>
            <label className="block text-xs font-bold text-on-surface-variant mb-1.5">執行週期 <span className="text-error">*</span></label>
            <div className="flex flex-wrap items-center gap-2.5 mb-5">
              <div className="flex rounded-lg border border-outline-variant/30 overflow-hidden shrink-0">
                <button onClick={() => setFrequency('daily')} className={`px-4 py-2.5 text-sm cursor-pointer ${frequency === 'daily' ? 'cyber-gradient text-on-primary' : 'text-on-surface-variant hover:bg-surface-container'}`}>每天</button>
                <button onClick={() => setFrequency('weekly')} className={`px-4 py-2.5 text-sm cursor-pointer ${frequency === 'weekly' ? 'cyber-gradient text-on-primary' : 'text-on-surface-variant hover:bg-surface-container'}`}>每週</button>
              </div>
              {frequency === 'weekly' && (
                <Dropdown value={dayOfWeek} onChange={v => setDayOfWeek(Number(v))} className="w-28 shrink-0"
                  options={DOW.map((d, i) => ({ value: i, label: d }))} />
              )}
              <input type="time" value={time} onChange={e => setTime(e.target.value)}
                className="bg-surface-container border border-outline-variant/30 rounded-lg px-3 py-2.5 text-sm text-on-surface focus:outline-none focus:border-primary shrink-0" />
            </div>

            <label className="block text-xs font-bold text-on-surface-variant mb-1.5">產出報告文件<span className="font-normal text-on-surface-variant/60">（選填，每次執行後自動附上下載連結）</span></label>
            <div className="grid grid-cols-5 gap-2 mb-2">
              <button type="button" onClick={() => pickDocFormat('')}
                className={`flex flex-col items-center gap-0.5 rounded-xl border p-2 transition-colors cursor-pointer ${!docFormat ? 'border-primary bg-primary/10' : 'border-outline-variant/20 hover:bg-surface-container'}`}>
                <span className={`material-symbols-outlined text-[18px] ${!docFormat ? 'text-primary' : 'text-on-surface-variant'}`}>block</span>
                <span className={`text-[11px] font-bold ${!docFormat ? 'text-primary' : 'text-on-surface'}`}>不產生</span>
              </button>
              {DOC_EXPORT.map(f => (
                <button key={f.format} type="button" onClick={() => pickDocFormat(f.format)}
                  className={`flex flex-col items-center gap-0.5 rounded-xl border p-2 transition-colors cursor-pointer ${docFormat === f.format ? 'border-primary bg-primary/10' : 'border-outline-variant/20 hover:bg-surface-container'}`}>
                  <span className={`material-symbols-outlined text-[18px] ${docFormat === f.format ? 'text-primary' : 'text-on-surface-variant'}`}>{f.icon}</span>
                  <span className={`text-[11px] font-bold ${docFormat === f.format ? 'text-primary' : 'text-on-surface'}`}>{f.label}</span>
                </button>
              ))}
            </div>
            {docFmt && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {docFmt.styles.map(s => (
                  <button key={s.id} type="button" onClick={() => setDocStyleId(s.id)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-bold border transition-colors cursor-pointer ${docStyleId === s.id ? 'border-primary bg-primary/10 text-primary' : 'border-outline-variant/20 text-on-surface-variant hover:bg-surface-container'}`}>
                    {(t(s.labelKey as never) as string) || s.id}
                  </button>
                ))}
              </div>
            )}
            {docFmt && <p className="text-[11px] text-on-surface-variant/60">產檔較久（簡報約 3–8 分鐘），排程在背景執行，不影響信件寄送；完成後下載連結會附在信裡。</p>}
          </>
        )}

        {/* ── Step 3: 收件者（可多人）── */}
        {step === 3 && (
          <>
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <label className="text-xs font-bold text-on-surface-variant">
                收件者 <span className="text-error">*</span><span className="font-normal text-on-surface-variant/60">（可加入多位，報告會同時寄給所有人）</span>
                {recipients.length > 0 && <span className="ml-1 text-primary font-bold">· {recipients.length} 位</span>}
              </label>
              {/* Expand/collapse pinned top-right so it's always reachable, even when
                  the chip list is scrolled. */}
              {recipients.length > 2 && (
                <button type="button" onClick={() => setShowAllRecipients(v => !v)}
                  className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-outline-variant/30 bg-surface-container text-xs font-bold text-on-surface-variant hover:bg-surface-container-high transition-colors cursor-pointer">
                  <span className="material-symbols-outlined text-[14px]">{showAllRecipients ? 'unfold_less' : 'unfold_more'}</span>
                  {showAllRecipients ? '收合' : `全部 ${recipients.length} 位`}
                </button>
              )}
            </div>

            {/* Selected recipients — collapsed to a couple of chips; the rest fold
                away (toggle lives in the label row above). */}
            {recipients.length > 0 && (
              <div className={`flex flex-wrap gap-1.5 mb-2.5 ${showAllRecipients ? 'max-h-36 overflow-y-auto pr-1' : ''}`}>
                {(showAllRecipients ? recipients : recipients.slice(0, 2)).map(r => (
                  <span key={r.email} className="inline-flex items-center gap-1.5 max-w-full pl-2.5 pr-1.5 py-1 rounded-full border border-primary/30 bg-primary/5 text-sm text-on-surface">
                    <span className="material-symbols-outlined text-primary text-[15px] shrink-0">mark_email_read</span>
                    <span className="truncate">{r.name ? <b>{r.name} · </b> : null}{r.email}</span>
                    <button type="button" onClick={() => removeRecipient(r.email)} title="移除"
                      className="material-symbols-outlined text-[16px] text-on-surface-variant/60 hover:text-error shrink-0 cursor-pointer">close</button>
                  </span>
                ))}
                {!showAllRecipients && recipients.length > 2 && (
                  <button type="button" onClick={() => setShowAllRecipients(true)}
                    className="inline-flex items-center px-2.5 py-1 rounded-full border border-outline-variant/30 bg-surface-container text-sm font-bold text-on-surface-variant hover:bg-surface-container-high transition-colors cursor-pointer shrink-0">
                    +{recipients.length - 2}
                  </button>
                )}
              </div>
            )}

            {!IS_PANJIT ? (
              <div className="flex gap-2">
                <input value={emailInput} onChange={e => setEmailInput(e.target.value)} placeholder="you@example.com"
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addRecipient(emailInput); setEmailInput(''); } }}
                  className="flex-1 min-w-0 bg-surface-container border border-outline-variant/30 rounded-xl px-3 py-2.5 text-sm text-on-surface focus:outline-none focus:border-primary" />
                <button type="button" onClick={() => { addRecipient(emailInput); setEmailInput(''); }} disabled={!emailInput.trim()}
                  className="px-4 py-2.5 rounded-xl text-sm font-bold text-primary border border-primary/40 hover:bg-primary/5 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer shrink-0">加入</button>
              </div>
            ) : (
              <div>
                <p className="text-[11px] text-on-surface-variant/60 mb-2">從 AD 目錄選擇，點人員即加入收件清單（可重複選）。</p>
                <div className="flex gap-2 mb-2">
                  <Dropdown value={adDomain} onChange={v => { setAdDomain(v); setAdSearch(''); }} className="w-36 shrink-0"
                    options={AD_DOMAIN_LIST.map(d => ({ value: d.code, label: d.label }))} />
                  <input value={adSearch} onChange={e => setAdSearch(e.target.value)} placeholder="搜尋姓名或帳號"
                    className="flex-1 min-w-0 bg-surface-container border border-outline-variant/30 rounded-lg px-3 py-2.5 text-sm text-on-surface focus:outline-none focus:border-primary" />
                </div>
                <div className="max-h-48 overflow-y-auto rounded-xl border border-outline-variant/20 divide-y divide-outline-variant/10">
                  {adLoading ? (
                    <div className="flex items-center justify-center gap-1.5 py-6 text-xs text-on-surface-variant"><span className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>載入 AD 名單…</div>
                  ) : (() => {
                    const q = adSearch.trim().toLowerCase();
                    const list = adMembers.filter(m => !q || m.displayName.toLowerCase().includes(q) || m.username.toLowerCase().includes(q)).slice(0, 60);
                    if (!list.length) return <div className="py-6 text-center text-xs text-on-surface-variant/60">{adMembers.length ? '查無符合的人員' : '此網域無資料或未設定 AD'}</div>;
                    return list.map(m => {
                      const picked = recipients.some(r => r.name === m.displayName);
                      return (
                        <button key={m.username} type="button" onClick={() => pickAdUser(m)} disabled={resolving}
                          className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface-container transition-colors cursor-pointer disabled:opacity-50">
                          <span className={`material-symbols-outlined text-[16px] shrink-0 ${picked ? 'text-primary' : 'text-on-surface-variant/50'}`}>{picked ? 'check_circle' : 'person'}</span>
                          <span className="flex-1 min-w-0 text-sm text-on-surface truncate">{m.displayName}</span>
                          <span className="text-xs font-mono text-on-surface-variant/50 shrink-0">{m.username}</span>
                        </button>
                      );
                    });
                  })()}
                </div>
                {resolving && <div className="flex items-center gap-1.5 mt-1.5 text-xs text-primary"><span className="material-symbols-outlined animate-spin text-[14px]">progress_activity</span>解析信箱中…</div>}
              </div>
            )}
          </>
        )}

        {/* ── Step 4: 確認 ── */}
        {step === 4 && (
          <>
            <p className="text-sm text-on-surface-variant mb-3">請確認以下設定，沒問題就建立排程。</p>
            <div className="rounded-xl border border-outline-variant/20 divide-y divide-outline-variant/10 overflow-hidden">
              {[
                { icon: 'label', label: '排程名稱', value: name.trim(), onEdit: () => setStep(1) },
                { icon: 'target', label: '分析議題', value: question.trim(), onEdit: () => setStep(1) },
                { icon: 'schedule', label: '執行週期', value: scheduleText, onEdit: () => setStep(2) },
                { icon: 'description', label: '產出文件', value: docFmt ? `${docFmt.label}・${docStyleLabel}` : '不產生', onEdit: () => setStep(2) },
              ].map(row => (
                <div key={row.label} className="flex items-start gap-2.5 px-3 py-2.5">
                  <span className="material-symbols-outlined text-[18px] text-on-surface-variant/60 shrink-0 mt-0.5">{row.icon}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] font-bold text-on-surface-variant/70">{row.label}</div>
                    <div className="text-sm text-on-surface break-words whitespace-pre-wrap">{row.value || '—'}</div>
                  </div>
                  <button type="button" onClick={row.onEdit} className="text-xs font-bold text-primary hover:underline shrink-0 mt-0.5 cursor-pointer">編輯</button>
                </div>
              ))}
              <div className="flex items-start gap-2.5 px-3 py-2.5">
                <span className="material-symbols-outlined text-[18px] text-on-surface-variant/60 shrink-0 mt-0.5">group</span>
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] font-bold text-on-surface-variant/70">收件者 · {recipients.length} 位</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {recipients.map(r => (
                      <span key={r.email} className="inline-flex items-center gap-1 max-w-full px-2 py-0.5 rounded-full bg-primary/5 border border-primary/20 text-xs text-on-surface">
                        <span className="truncate">{r.name || r.email}</span>
                      </span>
                    ))}
                  </div>
                </div>
                <button type="button" onClick={() => setStep(3)} className="text-xs font-bold text-primary hover:underline shrink-0 mt-0.5 cursor-pointer">編輯</button>
              </div>
            </div>
          </>
        )}

        {error && (
          <div className="flex items-start gap-2 mt-4 px-3 py-2.5 rounded-xl bg-error-container/60 text-on-error-container text-sm">
            <span className="material-symbols-outlined text-base leading-5">error</span>
            <span>{error}</span>
          </div>
        )}

        {/* Footer nav */}
        <div className="flex items-center justify-between gap-2 pt-5 mt-5 border-t border-outline-variant/15">
          <button onClick={() => step === 1 ? onClose() : setStep(step - 1)}
            className="px-4 py-2 rounded-xl text-sm font-bold text-on-surface-variant hover:bg-surface-container-high transition-colors cursor-pointer flex items-center gap-1">
            {step > 1 && <span className="material-symbols-outlined text-[18px]">chevron_left</span>}
            {step === 1 ? '取消' : '上一步'}
          </button>
          {step < 4 ? (
            <button onClick={() => setStep(step + 1)} disabled={!canAdvance}
              className="px-5 py-2 rounded-xl text-sm font-bold text-on-primary cyber-gradient disabled:opacity-40 disabled:cursor-not-allowed transition-all cursor-pointer flex items-center gap-1">
              下一步<span className="material-symbols-outlined text-[18px]">chevron_right</span>
            </button>
          ) : (
            <button onClick={add} disabled={!question.trim() || !recipients.length || saving}
              className="px-5 py-2 rounded-xl text-sm font-bold text-on-primary cyber-gradient disabled:opacity-40 disabled:cursor-not-allowed transition-all cursor-pointer flex items-center gap-2">
              {saving && <span className="material-symbols-outlined animate-spin text-base">progress_activity</span>}
              建立排程
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
