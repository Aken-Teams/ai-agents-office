'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from '../../i18n';
import { useAuth } from './AuthProvider';
import ConfirmDialog from './ConfirmDialog';

const SSE_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

const TYPES = ['bug', 'generation', 'feature', 'account', 'other'] as const;
const TYPE_ICON: Record<string, string> = { bug: 'bug_report', generation: 'description', feature: 'lightbulb', account: 'account_circle', other: 'help' };
const STATUS_STYLE: Record<string, string> = {
  open: 'bg-warning/15 text-warning',
  in_progress: 'bg-primary/15 text-primary',
  resolved: 'bg-success/15 text-success',
  rejected: 'bg-on-surface-variant/15 text-on-surface-variant',
};
const STATUS_BANNER: Record<string, string> = {
  open: 'bg-warning/10', in_progress: 'bg-primary/10', resolved: 'bg-success/10', rejected: 'bg-surface-container',
};
const STATUS_COLOR: Record<string, string> = {
  open: 'text-warning', in_progress: 'text-primary', resolved: 'text-success', rejected: 'text-on-surface-variant',
};
const STATUS_ICON: Record<string, string> = {
  open: 'schedule', in_progress: 'autorenew', resolved: 'check_circle', rejected: 'cancel',
};

interface Ticket {
  id: string; type: string; title: string; content: string | null; conversation_url: string | null;
  status: string; resolution_note: string | null; resolved_by: string | null; created_at: string; resolved_at: string | null;
  images: { id: string; role: string }[];
}

/** <img> for an auth-protected endpoint — fetches with the Bearer token, then
 *  shows it via an object URL (a plain <img src> can't send the auth header). */
function AuthImage({ src, token, className }: { src: string; token: string | null; className?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!token) return;
    let obj: string | null = null; let cancelled = false;
    fetch(src, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => (r.ok ? r.blob() : Promise.reject()))
      .then(b => { if (!cancelled) { obj = URL.createObjectURL(b); setUrl(obj); } })
      .catch(() => {});
    return () => { cancelled = true; if (obj) URL.revokeObjectURL(obj); };
  }, [src, token]);
  if (!url) return <div className={`${className} bg-surface-container animate-pulse`} />;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt="" className={`${className} cursor-zoom-in`} onClick={() => window.open(url, '_blank')} />
  );
}

export default function ReportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { token } = useAuth();
  const { t } = useTranslation();
  const [tab, setTab] = useState<'new' | 'mine'>('new');

  const [type, setType] = useState<string>('bug');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [convUrl, setConvUrl] = useState('');
  const [images, setImages] = useState<{ id: string; name: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const [typeOpen, setTypeOpen] = useState(false);
  const typeRef = useRef<HTMLDivElement>(null);

  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loadingMine, setLoadingMine] = useState(false);
  const [minePage, setMinePage] = useState(1);
  const [detail, setDetail] = useState<Ticket | null>(null);
  const [detailTab, setDetailTab] = useState<'content' | 'result'>('content');
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const PAGE_SIZE = 10;

  // When opening a ticket, jump to the result tab if it's already been handled.
  useEffect(() => {
    if (detail) setDetailTab(detail.status === 'resolved' || detail.status === 'rejected' ? 'result' : 'content');
  }, [detail]);

  useEffect(() => {
    if (!typeOpen) return;
    const h = (e: MouseEvent) => { if (typeRef.current && !typeRef.current.contains(e.target as Node)) setTypeOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [typeOpen]);

  const reset = useCallback(() => {
    setType('bug'); setTitle(''); setContent(''); setConvUrl(''); setImages([]); setSubmitted(false); setError('');
  }, []);

  const loadMine = useCallback(() => {
    if (!token) return;
    setLoadingMine(true);
    setDetail(null); setMinePage(1);
    fetch(`${SSE_BASE}/api/reports`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then((d) => setTickets(Array.isArray(d) ? d : [])).catch(() => {}).finally(() => setLoadingMine(false));
  }, [token]);

  const withdraw = useCallback(async () => {
    if (!detail || !token || withdrawing) return;
    setWithdrawing(true);
    await fetch(`${SSE_BASE}/api/reports/${detail.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
    setWithdrawing(false); setConfirmWithdraw(false); setDetail(null); loadMine();
  }, [detail, token, withdrawing, loadMine]);

  useEffect(() => { if (open && tab === 'mine') loadMine(); }, [open, tab, loadMine]);
  useEffect(() => { if (!open) { setTab('new'); reset(); } }, [open, reset]);

  const handleUpload = useCallback(async (files: FileList | null) => {
    if (!files || !files.length || !token) return;
    setUploading(true);
    try {
      const fd = new FormData();
      for (const f of Array.from(files)) if (f.type.startsWith('image/')) fd.append('files', f);
      const res = await fetch(`${SSE_BASE}/api/uploads`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
      const data = await res.json();
      if (res.ok) {
        const ok = (data.uploads || []).filter((u: any) => u.scanStatus !== 'rejected').map((u: any) => ({ id: u.id, name: u.originalName }));
        setImages(prev => [...prev, ...ok].slice(0, 6));
      }
    } catch { /* ignore */ } finally { setUploading(false); }
  }, [token]);

  const submit = useCallback(async () => {
    if (!token || submitting || !title.trim()) return;
    setSubmitting(true); setError('');
    try {
      const res = await fetch(`${SSE_BASE}/api/reports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ type, title: title.trim(), content: content.trim(), conversationUrl: convUrl.trim(), imageUploadIds: images.map(i => i.id) }),
      });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || t('report.error' as any)); }
      setSubmitted(true);
      setTimeout(() => { reset(); setTab('mine'); }, 1400);
    } catch (e) { setError((e as Error).message); } finally { setSubmitting(false); }
  }, [token, submitting, title, content, convUrl, type, images, reset, t]);

  if (!open) return null;

  return (
    <>
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-surface-container-lowest rounded-2xl shadow-2xl w-full max-w-2xl max-h-[88vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
        {/* Header + tabs */}
        <div className="px-6 pt-5 shrink-0">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-lg font-headline font-bold text-on-surface flex items-center gap-2">
              <span className="material-symbols-outlined text-primary">feedback</span>{t('report.title' as any)}
            </h3>
            <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-surface-container text-on-surface-variant cursor-pointer">
              <span className="material-symbols-outlined text-lg">close</span>
            </button>
          </div>
          <div className="flex items-center gap-5 border-b border-outline-variant/10">
            {(['new', 'mine'] as const).map(k => (
              <button key={k} onClick={() => setTab(k)}
                className={`pb-2.5 -mb-px text-sm border-b-2 transition-colors ${tab === k ? 'border-primary text-primary font-semibold' : 'border-transparent text-on-surface-variant hover:text-on-surface'}`}>
                {t(`report.tab.${k}` as any)}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {tab === 'new' ? (
            submitted ? (
              <div className="py-10 flex flex-col items-center gap-3 text-center">
                <span className="material-symbols-outlined text-5xl text-success">check_circle</span>
                <p className="text-sm text-on-surface">{t('report.submitted' as any)}</p>
              </div>
            ) : (
              <div className="space-y-4">
                {/* Type */}
                <div>
                  <label className="block text-xs font-bold text-on-surface-variant mb-1.5">{t('report.type' as any)}</label>
                  <div className="relative" ref={typeRef}>
                    <button type="button" onClick={() => setTypeOpen(v => !v)}
                      className={`w-full flex items-center gap-2 bg-surface-container border rounded-lg py-2 px-3 text-sm transition-colors ${typeOpen ? 'border-primary ring-1 ring-primary/30' : 'border-outline-variant/20 hover:border-primary/40'}`}>
                      <span className="material-symbols-outlined text-[18px] text-primary">{TYPE_ICON[type]}</span>
                      <span className="flex-1 text-left text-on-surface">{t(`report.type.${type}` as any)}</span>
                      <span className={`material-symbols-outlined text-[18px] text-on-surface-variant transition-transform ${typeOpen ? 'rotate-180' : ''}`}>expand_more</span>
                    </button>
                    {typeOpen && (
                      <div className="absolute z-20 top-full mt-1 left-0 right-0 bg-surface-container-lowest border border-outline-variant/20 rounded-lg shadow-xl overflow-hidden py-1">
                        {TYPES.map(ty => (
                          <button key={ty} type="button" onClick={() => { setType(ty); setTypeOpen(false); }}
                            className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors ${type === ty ? 'bg-primary/5 text-primary font-medium' : 'text-on-surface hover:bg-surface-container'}`}>
                            <span className="material-symbols-outlined text-[18px]">{TYPE_ICON[ty]}</span>
                            <span className="flex-1">{t(`report.type.${ty}` as any)}</span>
                            {type === ty && <span className="material-symbols-outlined text-[16px]">check</span>}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                {/* Title */}
                <div>
                  <label className="block text-xs font-bold text-on-surface-variant mb-1.5">{t('report.titleField' as any)}</label>
                  <input value={title} onChange={e => setTitle(e.target.value)} maxLength={120} placeholder={t('report.titlePlaceholder' as any)}
                    className="w-full bg-surface-container border border-outline-variant/20 focus:border-primary focus:ring-1 focus:ring-primary/30 rounded-lg py-2 px-3 text-sm text-on-surface placeholder:text-outline outline-none" />
                </div>
                {/* Content */}
                <div>
                  <label className="block text-xs font-bold text-on-surface-variant mb-1.5">{t('report.content' as any)}</label>
                  <textarea value={content} onChange={e => setContent(e.target.value)} rows={4} placeholder={t('report.contentPlaceholder' as any)}
                    className="w-full bg-surface-container border border-outline-variant/20 focus:border-primary focus:ring-1 focus:ring-primary/30 rounded-lg py-2 px-3 text-sm text-on-surface placeholder:text-outline outline-none resize-none" />
                </div>
                {/* Conversation link */}
                <div>
                  <label className="block text-xs font-bold text-on-surface-variant mb-1.5">{t('report.convUrl' as any)}</label>
                  <input value={convUrl} onChange={e => setConvUrl(e.target.value)} placeholder={t('report.convUrlPlaceholder' as any)}
                    className="w-full bg-surface-container border border-outline-variant/20 focus:border-primary focus:ring-1 focus:ring-primary/30 rounded-lg py-2 px-3 text-sm text-on-surface placeholder:text-outline outline-none font-mono" />
                </div>
                {/* Images */}
                <div>
                  <label className="block text-xs font-bold text-on-surface-variant mb-1.5">{t('report.images' as any)}</label>
                  <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={e => { handleUpload(e.target.files); e.target.value = ''; }} />
                  <div className="flex flex-wrap items-center gap-1.5">
                    {images.map(im => (
                      <span key={im.id} className="inline-flex items-center gap-1 bg-surface-container-high rounded-lg pl-2 pr-1 py-1 text-xs text-on-surface">
                        <span className="material-symbols-outlined text-[14px] text-primary">image</span>
                        <span className="truncate max-w-[120px]">{im.name}</span>
                        <button onClick={() => setImages(prev => prev.filter(x => x.id !== im.id))} className="text-on-surface-variant hover:bg-surface-container-highest rounded p-0.5"><span className="material-symbols-outlined text-[13px]">close</span></button>
                      </span>
                    ))}
                    {images.length < 6 && (
                      <button onClick={() => fileRef.current?.click()} disabled={uploading} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-dashed border-outline-variant/40 text-xs text-on-surface-variant hover:border-primary/50 disabled:opacity-50">
                        <span className="material-symbols-outlined text-[15px]">{uploading ? 'progress_activity' : 'add_photo_alternate'}</span>{t('report.addImage' as any)}
                      </button>
                    )}
                  </div>
                </div>
                {error && <p className="text-xs text-error">{error}</p>}
                <button onClick={submit} disabled={submitting || !title.trim()}
                  className="w-full py-2.5 rounded-xl text-sm font-bold text-on-primary cyber-gradient disabled:opacity-40 disabled:cursor-not-allowed transition-all cursor-pointer">
                  {submitting ? t('report.submitting' as any) : t('report.submit' as any)}
                </button>
              </div>
            )
          ) : detail ? (
            // Ticket detail — read-only "filled form", mirroring the input screen
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <button onClick={() => setDetail(null)} className="flex items-center gap-1 text-sm text-on-surface-variant hover:text-on-surface cursor-pointer">
                  <span className="material-symbols-outlined text-[18px]">arrow_back</span>{t('report.backToList' as any)}
                </button>
                {detail.status === 'open' && (
                  <button onClick={() => setConfirmWithdraw(true)} className="inline-flex items-center gap-1 text-xs text-error hover:bg-error/10 rounded-lg px-2 py-1 transition-colors cursor-pointer">
                    <span className="material-symbols-outlined text-[15px]">delete</span>{t('report.withdraw' as any)}
                  </button>
                )}
              </div>

              {/* Status banner */}
              <div className={`flex items-center gap-3 rounded-xl p-3.5 ${STATUS_BANNER[detail.status] || 'bg-surface-container'}`}>
                <span className={`material-symbols-outlined ${STATUS_COLOR[detail.status] || ''}`}>{STATUS_ICON[detail.status] || 'help'}</span>
                <div className="flex-1 min-w-0">
                  <p className={`text-sm font-bold ${STATUS_COLOR[detail.status] || 'text-on-surface'}`}>{t(`report.bannerTitle.${detail.status}` as any)}</p>
                  <p className="text-xs text-on-surface-variant">{t(`report.statusDesc.${detail.status}` as any)}</p>
                </div>
                <span className="text-[11px] text-on-surface-variant/60 shrink-0 hidden sm:block">{new Date(detail.created_at).toLocaleString()}</span>
              </div>

              {/* Sub-tabs: my report content vs result */}
              <div className="flex items-center gap-5 border-b border-outline-variant/10">
                {(['content', 'result'] as const).map(k => (
                  <button key={k} onClick={() => setDetailTab(k)}
                    className={`pb-2 -mb-px text-sm border-b-2 transition-colors ${detailTab === k ? 'border-primary text-primary font-semibold' : 'border-transparent text-on-surface-variant hover:text-on-surface'}`}>
                    {t(`report.dtab.${k}` as any)}
                  </button>
                ))}
              </div>

              {detailTab === 'content' ? (
                <div className="space-y-4">
                  {/* 問題類型 */}
                  <div>
                    <label className="block text-xs font-bold text-on-surface-variant mb-1.5">{t('report.type' as any)}</label>
                    <div className="flex items-center gap-2 bg-surface-container border border-outline-variant/20 rounded-lg py-2 px-3 text-sm text-on-surface">
                      <span className="material-symbols-outlined text-[18px] text-primary">{TYPE_ICON[detail.type] || 'help'}</span>{t(`report.type.${detail.type}` as any)}
                    </div>
                  </div>
                  {/* 標題 */}
                  <div>
                    <label className="block text-xs font-bold text-on-surface-variant mb-1.5">{t('report.titleField' as any)}</label>
                    <div className="bg-surface-container border border-outline-variant/20 rounded-lg py-2 px-3 text-sm text-on-surface break-words">{detail.title}</div>
                  </div>
                  {/* 詳細內容 */}
                  <div>
                    <label className="block text-xs font-bold text-on-surface-variant mb-1.5">{t('report.content' as any)}</label>
                    <div className="bg-surface-container border border-outline-variant/20 rounded-lg py-2.5 px-3 text-sm text-on-surface whitespace-pre-wrap leading-relaxed min-h-[5rem]">{detail.content || '—'}</div>
                  </div>
                  {/* 相關對話連結 */}
                  {detail.conversation_url && (
                    <div>
                      <label className="block text-xs font-bold text-on-surface-variant mb-1.5">{t('report.field.convUrl' as any)}</label>
                      <a href={detail.conversation_url} target="_blank" rel="noopener noreferrer" title={detail.conversation_url}
                        className="flex items-center gap-1.5 bg-surface-container border border-outline-variant/20 rounded-lg py-2 px-3 text-sm text-primary hover:bg-surface-container-high transition-colors">
                        <span className="material-symbols-outlined text-[16px] shrink-0">link</span>
                        <span className="truncate flex-1">{t('report.viewConversation' as any)}</span>
                        <span className="material-symbols-outlined text-[15px] shrink-0">open_in_new</span>
                      </a>
                    </div>
                  )}
                  {/* 附加圖片 */}
                  {detail.images?.filter(i => i.role === 'report').length > 0 && (
                    <div>
                      <label className="block text-xs font-bold text-on-surface-variant mb-1.5">{t('report.field.images' as any)}</label>
                      <div className="flex flex-wrap gap-2">
                        {detail.images.filter(i => i.role === 'report').map(im => (
                          <AuthImage key={im.id} src={`${SSE_BASE}/api/reports/image/${im.id}`} token={token} className="w-[84px] h-[84px] object-cover rounded-lg border border-outline-variant/20" />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                // Result tab
                (detail.status === 'resolved' || detail.status === 'rejected' || detail.resolution_note) ? (
                  <div className="rounded-xl border border-success/25 bg-success/[0.04] overflow-hidden">
                    <div className="flex items-center gap-2.5 px-3.5 py-2.5 border-b border-success/15 bg-success/[0.07]">
                      <div className="w-7 h-7 rounded-full bg-success/15 flex items-center justify-center shrink-0">
                        <span className="material-symbols-outlined text-[16px] text-success">support_agent</span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-bold text-success leading-tight">{t('report.officialReply' as any)}</p>
                        {(detail.resolved_by || detail.resolved_at) && (
                          <p className="text-[11px] text-on-surface-variant truncate">{detail.resolved_by || ''}{detail.resolved_at ? ` · ${new Date(detail.resolved_at).toLocaleString()}` : ''}</p>
                        )}
                      </div>
                    </div>
                    <div className="p-3.5">
                      <p className="text-sm text-on-surface whitespace-pre-wrap leading-relaxed">{detail.resolution_note || '—'}</p>
                      {detail.images?.filter(i => i.role === 'resolution').length > 0 && (
                        <div className="flex flex-wrap gap-2 mt-3">
                          {detail.images.filter(i => i.role === 'resolution').map(im => (
                            <AuthImage key={im.id} src={`${SSE_BASE}/api/reports/image/${im.id}`} token={token} className="w-[84px] h-[84px] object-cover rounded-lg border border-outline-variant/20" />
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="py-12 flex flex-col items-center gap-2 text-center text-on-surface-variant">
                    <span className="material-symbols-outlined text-4xl text-on-surface-variant/40">hourglass_empty</span>
                    <p className="text-sm">{t('report.result.pending' as any)}</p>
                  </div>
                )
              )}
            </div>
          ) : (
            // My reports — table + pagination
            loadingMine ? (
              <div className="py-12 text-center text-sm text-on-surface-variant">{t('common.loading' as any)}</div>
            ) : tickets.length === 0 ? (
              <div className="py-12 text-center text-sm text-on-surface-variant">{t('report.empty' as any)}</div>
            ) : (
              <div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[11px] text-on-surface-variant border-b border-outline-variant/15">
                      <th className="text-left font-medium py-2">{t('report.col.title' as any)}</th>
                      <th className="text-left font-medium py-2 w-16">{t('report.col.status' as any)}</th>
                      <th className="text-right font-medium py-2 w-20">{t('report.col.date' as any)}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-outline-variant/10">
                    {tickets.slice((minePage - 1) * PAGE_SIZE, minePage * PAGE_SIZE).map(tk => (
                      <tr key={tk.id} onClick={() => setDetail(tk)} className="cursor-pointer hover:bg-surface-container/40 transition-colors">
                        <td className="py-2.5 pr-2">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="material-symbols-outlined text-[16px] text-on-surface-variant shrink-0">{TYPE_ICON[tk.type] || 'help'}</span>
                            <span className="text-on-surface truncate">{tk.title}</span>
                          </div>
                        </td>
                        <td className="py-2.5"><span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium whitespace-nowrap ${STATUS_STYLE[tk.status] || ''}`}>{t(`report.status.${tk.status}` as any)}</span></td>
                        <td className="py-2.5 text-right text-[11px] text-on-surface-variant whitespace-nowrap">{new Date(tk.created_at).toLocaleDateString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {tickets.length > PAGE_SIZE && (
                  <div className="flex items-center justify-between pt-3 mt-2 border-t border-outline-variant/10 text-xs text-on-surface-variant">
                    <button onClick={() => setMinePage(p => Math.max(1, p - 1))} disabled={minePage <= 1} className="px-2.5 py-1 rounded-lg hover:bg-surface-container disabled:opacity-30 cursor-pointer disabled:cursor-not-allowed inline-flex items-center gap-0.5"><span className="material-symbols-outlined text-[16px]">chevron_left</span></button>
                    <span>{minePage} / {Math.ceil(tickets.length / PAGE_SIZE)}</span>
                    <button onClick={() => setMinePage(p => Math.min(Math.ceil(tickets.length / PAGE_SIZE), p + 1))} disabled={minePage >= Math.ceil(tickets.length / PAGE_SIZE)} className="px-2.5 py-1 rounded-lg hover:bg-surface-container disabled:opacity-30 cursor-pointer disabled:cursor-not-allowed inline-flex items-center gap-0.5"><span className="material-symbols-outlined text-[16px]">chevron_right</span></button>
                  </div>
                )}
              </div>
            )
          )}
        </div>
      </div>
    </div>
    <ConfirmDialog
      open={confirmWithdraw}
      danger
      busy={withdrawing}
      title={t('report.withdraw' as any)}
      message={t('report.withdrawConfirm' as any)}
      confirmText={t('report.withdraw' as any)}
      cancelText={t('common.cancel' as any)}
      onConfirm={withdraw}
      onCancel={() => setConfirmWithdraw(false)}
    />
    </>
  );
}
