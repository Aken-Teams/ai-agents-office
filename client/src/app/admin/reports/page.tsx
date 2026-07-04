'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useAdminAuth } from '../components/AdminAuthProvider';
import ConfirmDialog from '../../components/ConfirmDialog';

const SSE_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

interface Ticket {
  id: string; deploy_mode: string | null; user_id: string; user_email: string | null; user_name: string | null;
  type: string; title: string; content: string | null; conversation_url: string | null;
  status: string; resolution_note: string | null; resolved_by: string | null; resolved_at: string | null;
  created_at: string; imageCount?: number; images?: { id: string; role: string }[];
}

const TYPE_LABEL: Record<string, string> = { bug: '系統錯誤', generation: '文件生成問題', feature: '功能建議', account: '帳號／額度', other: '其他' };
const TYPE_ICON: Record<string, string> = { bug: 'bug_report', generation: 'description', feature: 'lightbulb', account: 'account_circle', other: 'help' };
const STATUS_LABEL: Record<string, string> = { open: '待處理', in_progress: '處理中', resolved: '已解決', rejected: '不予處理' };
const STATUS_STYLE: Record<string, string> = {
  open: 'bg-warning/15 text-warning', in_progress: 'bg-primary/15 text-primary',
  resolved: 'bg-success/15 text-success', rejected: 'bg-on-surface-variant/15 text-on-surface-variant',
};
const STATUSES = ['open', 'in_progress', 'resolved', 'rejected'];

const HEADER = 'sticky top-0 h-14 md:h-16 bg-surface/80 backdrop-blur-xl flex items-center px-4 md:px-8 z-40 shadow-[0_1px_0_0_rgba(255,255,255,0.05)]';
function toUTC(s: string): Date { const x = s.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(s) ? s : s.replace(' ', 'T') + 'Z'; return new Date(x); }
const fmtDateTime = (s: string) => toUTC(s).toLocaleString('zh-TW', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Auth-protected image (the endpoint needs a Bearer token). */
function AuthImage({ src, token, className }: { src: string; token: string | null; className?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!token) return;
    let obj: string | null = null; let cancelled = false;
    fetch(src, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => (r.ok ? r.blob() : Promise.reject())).then(b => { if (!cancelled) { obj = URL.createObjectURL(b); setUrl(obj); } }).catch(() => {});
    return () => { cancelled = true; if (obj) URL.revokeObjectURL(obj); };
  }, [src, token]);
  if (!url) return <div className={`${className} bg-surface-container animate-pulse`} />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt="" className={`${className} cursor-zoom-in`} onClick={() => window.open(url, '_blank')} />;
}

export default function AdminReportsPage() {
  const { token, canOperate } = useAdminAuth();
  const canEdit = canOperate('reports');
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [stats, setStats] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [search, setSearch] = useState('');

  const [detail, setDetail] = useState<Ticket | null>(null);
  const [detailTab, setDetailTab] = useState<'report' | 'action'>('report'); // mobile-only: content vs handling
  const [confirmDel, setConfirmDel] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [editStatus, setEditStatus] = useState('open');
  const [editNote, setEditNote] = useState('');
  const [pendingImgs, setPendingImgs] = useState<{ id: string; name: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const auth = useCallback(() => ({ Authorization: `Bearer ${token}` }), [token]);

  const loadStats = useCallback(() => {
    if (!token) return;
    fetch(`${SSE_BASE}/api/admin/reports/stats`, { headers: auth() }).then(r => r.json()).then(setStats).catch(() => {});
  }, [token, auth]);

  const loadList = useCallback(() => {
    if (!token) return;
    setLoading(true);
    const params = new URLSearchParams();
    if (statusFilter) params.set('status', statusFilter);
    if (search.trim()) params.set('q', search.trim());
    fetch(`${SSE_BASE}/api/admin/reports?${params}`, { headers: auth() })
      .then(r => r.json()).then(d => setTickets(Array.isArray(d) ? d : [])).catch(() => {}).finally(() => setLoading(false));
  }, [token, statusFilter, search, auth]);

  useEffect(() => { loadStats(); }, [loadStats]);
  useEffect(() => { const t = setTimeout(loadList, search ? 300 : 0); return () => clearTimeout(t); }, [loadList, search]);

  const openDetail = useCallback((id: string) => {
    fetch(`${SSE_BASE}/api/admin/reports/${id}`, { headers: auth() })
      .then(r => r.json()).then((d: Ticket) => {
        setDetail(d); setEditStatus(d.status); setEditNote(d.resolution_note || ''); setPendingImgs([]); setSavedMsg(false);
      }).catch(() => {});
  }, [auth]);

  const handleUpload = useCallback(async (files: FileList | null) => {
    if (!files || !files.length || !token) return;
    setUploading(true);
    try {
      const fd = new FormData();
      for (const f of Array.from(files)) if (f.type.startsWith('image/')) fd.append('files', f);
      const res = await fetch(`${SSE_BASE}/api/uploads`, { method: 'POST', headers: auth(), body: fd });
      const data = await res.json();
      if (res.ok) setPendingImgs(prev => [...prev, ...(data.uploads || []).filter((u: any) => u.scanStatus !== 'rejected').map((u: any) => ({ id: u.id, name: u.originalName }))]);
    } catch { /* ignore */ } finally { setUploading(false); }
  }, [token, auth]);

  const save = useCallback(async () => {
    if (!detail || saving) return;
    setSaving(true);
    try {
      await fetch(`${SSE_BASE}/api/admin/reports/${detail.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', ...auth() },
        body: JSON.stringify({ status: editStatus, resolutionNote: editNote }),
      });
      if (pendingImgs.length) {
        await fetch(`${SSE_BASE}/api/admin/reports/${detail.id}/images`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', ...auth() },
          body: JSON.stringify({ imageUploadIds: pendingImgs.map(i => i.id) }),
        });
      }
      setSavedMsg(true);
      openDetail(detail.id); loadList(); loadStats();
      setTimeout(() => setSavedMsg(false), 2000);
    } catch { /* ignore */ } finally { setSaving(false); }
  }, [detail, saving, editStatus, editNote, pendingImgs, auth, openDetail, loadList, loadStats]);

  const del = useCallback(async () => {
    if (!detail || deleting) return;
    setDeleting(true);
    await fetch(`${SSE_BASE}/api/admin/reports/${detail.id}`, { method: 'DELETE', headers: auth() }).catch(() => {});
    setDeleting(false); setConfirmDel(false); setDetail(null); loadList(); loadStats();
  }, [detail, deleting, auth, loadList, loadStats]);

  const clearResolution = useCallback(async () => {
    if (!detail || clearing) return;
    setClearing(true);
    await fetch(`${SSE_BASE}/api/admin/reports/${detail.id}/resolution`, { method: 'DELETE', headers: auth() }).catch(() => {});
    setClearing(false); setConfirmClear(false);
    setEditNote('');
    openDetail(detail.id); loadList();
  }, [detail, clearing, auth, openDetail, loadList]);

  // ── Detail view ──────────────────────────────────────────────────────────
  if (detail) {
    const reportImgs = detail.images?.filter(i => i.role === 'report') || [];
    const resolutionImgs = detail.images?.filter(i => i.role === 'resolution') || [];
    return (
      <>
        <header className={HEADER + ' gap-3'}>
          <button onClick={() => setDetail(null)} className="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-surface-container text-on-surface-variant cursor-pointer">
            <span className="material-symbols-outlined">arrow_back</span>
          </button>
          <span className="text-base md:text-lg font-black text-on-surface font-headline truncate">{detail.title}</span>
          <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium shrink-0 ${STATUS_STYLE[detail.status]}`}>{STATUS_LABEL[detail.status]}</span>
          {canEdit && (
            <button onClick={() => setConfirmDel(true)} className="ml-auto inline-flex items-center gap-1 text-xs text-error hover:bg-error/10 rounded-lg px-2.5 py-1.5 transition-colors cursor-pointer shrink-0">
              <span className="material-symbols-outlined text-[16px]">delete</span>刪除
            </button>
          )}
        </header>
        <div className="flex-1 overflow-y-auto p-4 md:p-8">
          {/* Mobile-only tab: report content vs handling (desktop shows both) */}
          <div className="lg:hidden grid grid-cols-2 gap-1 mb-4 p-1 bg-surface-container rounded-xl">
            {([['report', '回報內容', 'description'], ['action', '處理', 'support_agent']] as const).map(([key, label, icon]) => (
              <button key={key} onClick={() => setDetailTab(key)}
                className={`flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-bold transition-colors cursor-pointer ${detailTab === key ? 'cyber-gradient text-on-primary' : 'text-on-surface-variant hover:bg-surface-container-high'}`}>
                <span className="material-symbols-outlined text-[18px]">{icon}</span>{label}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
            {/* Report (read-only) */}
            <div className={`lg:col-span-3 space-y-4 ${detailTab === 'report' ? '' : 'hidden lg:block'}`}>
              <Field label="回報者">
                <div className="flex items-center gap-2"><span className="material-symbols-outlined text-[18px] text-on-surface-variant">person</span>
                  <span>{detail.user_name || '—'}</span><span className="text-on-surface-variant/60 text-xs">{detail.user_email}</span>
                  {detail.deploy_mode && <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-surface-container-high text-on-surface-variant">{detail.deploy_mode}</span>}
                </div>
              </Field>
              <Field label="問題類型"><div className="flex items-center gap-2"><span className="material-symbols-outlined text-[18px] text-primary">{TYPE_ICON[detail.type] || 'help'}</span>{TYPE_LABEL[detail.type] || detail.type}</div></Field>
              <Field label="標題"><span className="break-words">{detail.title}</span></Field>
              <Field label="詳細內容"><div className="whitespace-pre-wrap leading-relaxed min-h-[4rem]">{detail.content || '—'}</div></Field>
              {detail.conversation_url && (
                <Field label="相關對話連結">
                  <a href={detail.conversation_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-primary hover:underline break-all">
                    <span className="material-symbols-outlined text-[16px]">link</span>{detail.conversation_url}
                  </a>
                </Field>
              )}
              {reportImgs.length > 0 && (
                <div>
                  <p className="text-xs font-bold text-on-surface-variant mb-1.5">附加圖片</p>
                  <div className="flex flex-wrap gap-2">{reportImgs.map(im => <AuthImage key={im.id} src={`${SSE_BASE}/api/admin/reports/image/${im.id}`} token={token} className="w-24 h-24 object-cover rounded-lg border border-outline-variant/20" />)}</div>
                </div>
              )}
              <p className="text-[11px] text-on-surface-variant/50">回報時間：{fmtDateTime(detail.created_at)}</p>
            </div>

            {/* Admin actions */}
            <div className={`lg:col-span-2 space-y-4 ${detailTab === 'action' ? '' : 'hidden lg:block'}`}>
              <div className="rounded-xl border border-outline-variant/20 bg-surface-container/30 p-4 space-y-4 lg:sticky lg:top-0">
                <p className="text-sm font-bold text-on-surface flex items-center gap-1.5"><span className="material-symbols-outlined text-[18px] text-primary">support_agent</span>處理{!canEdit && <span className="ml-1 text-[11px] font-normal text-on-surface-variant">（檢閱者唯讀）</span>}</p>
                {canEdit ? (
                  <>
                    <div>
                      <label className="block text-xs font-bold text-on-surface-variant mb-1.5">狀態</label>
                      <div className="grid grid-cols-2 gap-1.5">
                        {STATUSES.map(s => (
                          <button key={s} onClick={() => setEditStatus(s)} className={`py-1.5 rounded-lg text-xs font-medium border transition-colors ${editStatus === s ? 'border-primary bg-primary/5 text-primary' : 'border-outline-variant/30 text-on-surface-variant hover:border-primary/40'}`}>{STATUS_LABEL[s]}</button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-on-surface-variant mb-1.5">處理說明</label>
                      <textarea value={editNote} onChange={e => setEditNote(e.target.value)} rows={5} placeholder="說明處理結果，會顯示給回報者…"
                        className="w-full bg-surface-container border border-outline-variant/20 focus:border-primary focus:ring-1 focus:ring-primary/30 rounded-lg py-2 px-3 text-sm text-on-surface placeholder:text-outline outline-none resize-none" />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-on-surface-variant mb-1.5">處理附圖（選填）</label>
                      <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={e => { handleUpload(e.target.files); e.target.value = ''; }} />
                      <div className="flex flex-wrap gap-1.5">
                        {resolutionImgs.map(im => <AuthImage key={im.id} src={`${SSE_BASE}/api/admin/reports/image/${im.id}`} token={token} className="w-14 h-14 object-cover rounded-lg border border-outline-variant/20" />)}
                        {pendingImgs.map(im => (
                          <span key={im.id} className="inline-flex items-center gap-1 bg-surface-container-high rounded-lg pl-2 pr-1 py-1 text-xs"><span className="material-symbols-outlined text-[14px] text-primary">image</span><span className="truncate max-w-[80px]">{im.name}</span><button onClick={() => setPendingImgs(p => p.filter(x => x.id !== im.id))}><span className="material-symbols-outlined text-[13px]">close</span></button></span>
                        ))}
                        <button onClick={() => fileRef.current?.click()} disabled={uploading} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-dashed border-outline-variant/40 text-xs text-on-surface-variant hover:border-primary/50 disabled:opacity-50"><span className="material-symbols-outlined text-[15px]">{uploading ? 'progress_activity' : 'add_photo_alternate'}</span>加圖片</button>
                      </div>
                    </div>
                    <button onClick={save} disabled={saving} className="w-full py-2.5 rounded-xl text-sm font-bold text-on-primary cyber-gradient disabled:opacity-40 transition-all cursor-pointer">
                      {saving ? '儲存中…' : savedMsg ? '已儲存 ✓' : '儲存'}
                    </button>
                    {(detail.resolution_note || resolutionImgs.length > 0) && (
                      <button onClick={() => setConfirmClear(true)} className="w-full inline-flex items-center justify-center gap-1 py-1.5 text-xs text-error hover:bg-error/10 rounded-lg transition-colors cursor-pointer">
                        <span className="material-symbols-outlined text-[15px]">backspace</span>清除官方回覆
                      </button>
                    )}
                  </>
                ) : (
                  <>
                    <div><label className="block text-xs font-bold text-on-surface-variant mb-1.5">狀態</label><span className={`text-xs px-2.5 py-1 rounded-full font-medium ${STATUS_STYLE[detail.status]}`}>{STATUS_LABEL[detail.status]}</span></div>
                    <div>
                      <label className="block text-xs font-bold text-on-surface-variant mb-1.5">處理說明</label>
                      <div className="bg-surface-container border border-outline-variant/20 rounded-lg py-2 px-3 text-sm text-on-surface whitespace-pre-wrap leading-relaxed min-h-[3rem]">{detail.resolution_note || '尚未處理'}</div>
                    </div>
                    {resolutionImgs.length > 0 && <div className="flex flex-wrap gap-1.5">{resolutionImgs.map(im => <AuthImage key={im.id} src={`${SSE_BASE}/api/admin/reports/image/${im.id}`} token={token} className="w-14 h-14 object-cover rounded-lg border border-outline-variant/20" />)}</div>}
                  </>
                )}
                {detail.resolved_by && <p className="text-[11px] text-on-surface-variant/60 text-center">處理人：{detail.resolved_by}</p>}
              </div>
            </div>
          </div>
        </div>
        <ConfirmDialog
          open={confirmDel}
          danger
          busy={deleting}
          title="刪除回報"
          message="確定刪除整則回報嗎？刪除後前台使用者與後台都不會再看到（資料仍保留）。"
          confirmText="刪除"
          onConfirm={del}
          onCancel={() => setConfirmDel(false)}
        />
        <ConfirmDialog
          open={confirmClear}
          danger
          busy={clearing}
          title="清除官方回覆"
          message="確定清除這則回報的官方回覆嗎？處理說明與附圖會被移除，但回報本身保留。"
          confirmText="清除"
          onConfirm={clearResolution}
          onCancel={() => setConfirmClear(false)}
        />
      </>
    );
  }

  // ── List view ────────────────────────────────────────────────────────────
  const total = Object.values(stats).reduce((a, b) => a + b, 0);
  return (
    <>
      <header className={HEADER + ' justify-between'}>
        <div className="flex items-center gap-2 md:gap-4">
          <span className="text-base md:text-lg font-black text-on-surface font-headline">回報管理</span>
          <span className="text-xs md:text-sm text-on-surface-variant font-mono">共 {total} 筆</span>
        </div>
      </header>

      <div className="flex-1 flex flex-col p-4 md:p-8 overflow-hidden">
        {/* Status filter + search */}
        <div className="flex flex-wrap items-center gap-2 mb-4 shrink-0">
          <button onClick={() => setStatusFilter('')} className={`px-3 py-1.5 rounded-full text-sm transition-colors ${!statusFilter ? 'bg-primary text-on-primary font-medium' : 'text-on-surface-variant hover:bg-surface-container'}`}>全部 {total}</button>
          {STATUSES.map(s => (
            <button key={s} onClick={() => setStatusFilter(s)} className={`px-3 py-1.5 rounded-full text-sm transition-colors ${statusFilter === s ? 'bg-primary text-on-primary font-medium' : 'text-on-surface-variant hover:bg-surface-container'}`}>{STATUS_LABEL[s]} {stats[s] || 0}</button>
          ))}
          <div className="relative w-full sm:w-auto sm:ml-auto">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline text-sm">search</span>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="搜尋標題／內容／使用者…" className="bg-surface-container-highest border-none focus:ring-1 focus:ring-primary/40 rounded py-2 pl-9 pr-4 text-sm text-on-surface placeholder:text-outline w-full sm:w-56" />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? <div className="py-16 text-center text-on-surface-variant">載入中…</div>
            : tickets.length === 0 ? <div className="py-16 text-center text-on-surface-variant">沒有回報紀錄</div>
            : (
              <>
                {/* Mobile: card list (the 5-column table can't fit a phone) */}
                <div className="md:hidden divide-y divide-outline-variant/10">
                  {tickets.map(tk => (
                    <button key={tk.id} onClick={() => { setDetailTab('report'); openDetail(tk.id); }} className="w-full text-left px-4 py-3 hover:bg-surface-container/40 cursor-pointer">
                      <div className="flex items-start gap-2">
                        <span className="material-symbols-outlined text-on-surface-variant text-[18px] mt-0.5 shrink-0">{TYPE_ICON[tk.type] || 'help'}</span>
                        <span className="flex-1 min-w-0 font-medium text-on-surface break-words">{tk.title}</span>
                        {!!tk.imageCount && <span className="inline-flex items-center gap-0.5 text-[11px] text-on-surface-variant/60 shrink-0 mt-0.5"><span className="material-symbols-outlined text-[14px]">image</span>{tk.imageCount}</span>}
                        <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium shrink-0 mt-0.5 ${STATUS_STYLE[tk.status]}`}>{STATUS_LABEL[tk.status]}</span>
                      </div>
                      <div className="mt-1 pl-7 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-on-surface-variant">
                        <span>{TYPE_LABEL[tk.type] || tk.type}</span>
                        <span className="text-outline">·</span>
                        <span className="truncate max-w-[180px]">{tk.user_name || tk.user_email || '—'}</span>
                        <span className="text-outline">·</span>
                        <span className="whitespace-nowrap">{fmtDateTime(tk.created_at)}</span>
                      </div>
                    </button>
                  ))}
                </div>

                {/* Desktop: full table */}
                <table className="w-full hidden md:table">
                  <thead className="sticky top-0 bg-surface-container-lowest">
                    <tr className="text-left text-sm uppercase tracking-widest text-on-surface-variant">
                      <th className="py-3 px-4 font-bold">標題</th>
                      <th className="py-3 px-4 font-bold">回報者</th>
                      <th className="py-3 px-4 font-bold">類型</th>
                      <th className="py-3 px-4 font-bold text-center">狀態</th>
                      <th className="py-3 px-4 font-bold">時間</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-outline-variant/10">
                    {tickets.map(tk => (
                      <tr key={tk.id} onClick={() => { setDetailTab('report'); openDetail(tk.id); }} className="hover:bg-surface-container/40 cursor-pointer">
                        <td className="py-3 px-4">
                          <div className="font-medium text-on-surface flex items-center gap-2">
                            <span className="material-symbols-outlined text-on-surface-variant text-[18px]">{TYPE_ICON[tk.type] || 'help'}</span>
                            <span className="truncate max-w-[280px]">{tk.title}</span>
                            {!!tk.imageCount && <span className="inline-flex items-center gap-0.5 text-[11px] text-on-surface-variant/60"><span className="material-symbols-outlined text-[14px]">image</span>{tk.imageCount}</span>}
                          </div>
                        </td>
                        <td className="py-3 px-4"><div className="text-sm text-on-surface">{tk.user_name || '—'}</div><div className="text-xs text-on-surface-variant">{tk.user_email}</div></td>
                        <td className="py-3 px-4 text-sm text-on-surface-variant">{TYPE_LABEL[tk.type] || tk.type}</td>
                        <td className="py-3 px-4 text-center"><span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${STATUS_STYLE[tk.status]}`}>{STATUS_LABEL[tk.status]}</span></td>
                        <td className="py-3 px-4 text-sm text-on-surface-variant whitespace-nowrap">{fmtDateTime(tk.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
        </div>
      </div>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-bold text-on-surface-variant mb-1.5">{label}</label>
      <div className="bg-surface-container border border-outline-variant/20 rounded-lg py-2 px-3 text-sm text-on-surface">{children}</div>
    </div>
  );
}
