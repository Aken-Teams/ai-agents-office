'use client';

/**
 * Admin view for the email assistant (信件助手), split out from the general
 * conversation list — just like 團隊協作. For each user it shows whether they are
 * doing per-email ANALYSIS (信件解析) vs. actual Q&A CONVERSATION (對話), and lets
 * you drill into both, so usage can be evaluated for optimisation.
 */

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import TeamMarkdown from '../../components/TeamMarkdown';
import { useAdminAuth } from '../components/AdminAuthProvider';

interface Row {
  id: string; user_id: string; created_at: string; status: string;
  user_email: string; user_display_name: string;
  question_count: number; message_count: number; analysis_count: number; deep_count: number;
  last_activity: string;
}
interface Analysis { email_id: string; email_subject: string | null; summary: string | null; priority: string | null; category: string | null; deep_analysis: string | null; created_at: string }
interface Message { id: string; role: string; content: string; created_at: string }
interface EmailBody { subject: string; from: { name: string; address: string } | null; to: { name: string; address: string }[]; receivedAt: string; body: string; bodyType: string }
type BodyState = { loading?: boolean; err?: string; data?: EmailBody };
interface Detail {
  conversation: { id: string; user_email: string; user_display_name: string; created_at: string };
  messages: Message[];
  analyses: Analysis[];
}

const HEADER = 'sticky top-0 h-14 md:h-16 bg-surface/80 backdrop-blur-xl flex items-center px-4 md:px-8 z-40 shadow-[0_1px_0_0_rgba(255,255,255,0.05)]';
function toUTC(s: string): Date {
  const x = s.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(s) ? s : s.replace(' ', 'T') + 'Z';
  return new Date(x);
}
const fmtDate = (s: string | null) => (s ? toUTC(s).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
const fmtDateTime = (s: string) => toUTC(s).toLocaleString('zh-TW', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const priColor = (p: string | null) => (p === '高' ? '#dc2626' : p === '低' ? '#64748b' : '#d97706');

const TAB_ACTIVE = 'px-3.5 py-1.5 rounded-full text-sm bg-primary text-on-primary font-medium';
const TAB_IDLE = 'px-3.5 py-1.5 rounded-full text-sm text-on-surface-variant hover:bg-surface-container transition-colors no-underline';

export default function AdminEmailAgentPage() {
  const { token } = useAdminAuth();
  const [items, setItems] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [tab, setTab] = useState<'analyses' | 'chat'>('analyses');
  const [openEmail, setOpenEmail] = useState<string | null>(null);
  const [bodies, setBodies] = useState<Record<string, BodyState>>({});

  const viewEmail = (convId: string, emailId: string) => {
    if (!token || bodies[emailId]?.data || bodies[emailId]?.loading) return;
    setBodies(b => ({ ...b, [emailId]: { loading: true } }));
    fetch(`/api/admin/email-agent/${convId}/email?emailId=${encodeURIComponent(emailId)}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.message || '讀取失敗'); return d as EmailBody; })
      .then(d => setBodies(b => ({ ...b, [emailId]: { data: d } })))
      .catch(e => setBodies(b => ({ ...b, [emailId]: { err: e.message || '讀取失敗' } })));
  };

  const load = useCallback(() => {
    if (!token) return;
    setLoading(true);
    const params = new URLSearchParams({ limit: '50' });
    if (search.trim()) params.set('search', search.trim());
    fetch(`/api/admin/email-agent?${params}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(d => { setItems(d.items || []); setTotal(d.total || 0); })
      .catch(() => {}).finally(() => setLoading(false));
  }, [token, search]);

  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  const open = (id: string) => {
    if (!token) return;
    setDetailLoading(true); setDetail(null); setTab('analyses'); setOpenEmail(null); setBodies({});
    fetch(`/api/admin/email-agent/${id}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(d => setDetail(d)).catch(() => {}).finally(() => setDetailLoading(false));
  };

  /* ---- Detail (full page) ---- */
  if (detail || detailLoading) {
    const questions = detail?.messages.filter(m => m.role === 'user').length ?? 0;
    return (
      <>
        <header className={HEADER + ' gap-3'}>
          <button onClick={() => setDetail(null)} className="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-surface-container text-on-surface-variant cursor-pointer">
            <span className="material-symbols-outlined">arrow_back</span>
          </button>
          <span className="text-base md:text-lg font-black text-on-surface font-headline truncate">信件助手 · {detail?.conversation.user_display_name || detail?.conversation.user_email || ''}</span>
        </header>
        <div className="flex-1 overflow-y-auto p-4 md:p-8">
          {detailLoading || !detail ? <div className="py-16 text-center text-on-surface-variant">載入中…</div> : (
            <div className="space-y-5">
              {/* Owner + stats */}
              <div className="flex flex-col md:flex-row md:items-start gap-3">
                <div className="flex items-start gap-3 flex-1 min-w-0">
                  <div className="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                    <span className="material-symbols-outlined text-primary text-[24px]">mail</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <h2 className="text-lg font-bold text-on-surface">{detail.conversation.user_display_name || detail.conversation.user_email}</h2>
                    <p className="text-xs text-on-surface-variant/70 mt-1 font-mono truncate">{detail.conversation.user_email}</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 md:flex md:flex-wrap md:justify-end shrink-0">
                  {[
                    { icon: 'forum', label: '對話提問', value: questions },
                    { icon: 'mark_email_read', label: '信件解析', value: detail.analyses.length },
                  ].map(s => (
                    <span key={s.label} className="flex md:inline-flex flex-col md:flex-row items-center md:gap-1.5 bg-surface-container rounded-lg px-2 md:px-3 py-2 md:py-1.5 text-xs text-center">
                      <span className="inline-flex items-center gap-1 text-on-surface-variant"><span className="material-symbols-outlined text-[15px] text-primary">{s.icon}</span>{s.label}</span>
                      <span className="font-semibold text-on-surface mt-0.5 md:mt-0">{s.value}</span>
                    </span>
                  ))}
                </div>
              </div>

              {/* Tabs */}
              <div className="flex items-center gap-5 border-b border-outline-variant/10">
                {([['analyses', `信件解析 (${detail.analyses.length})`], ['chat', `對話 (${detail.messages.length})`]] as const).map(([k, label]) => (
                  <button key={k} onClick={() => setTab(k)}
                    className={`pb-2.5 -mb-px text-sm border-b-2 transition-colors ${tab === k ? 'border-primary text-primary font-semibold' : 'border-transparent text-on-surface-variant hover:text-on-surface'}`}>
                    {label}
                  </button>
                ))}
              </div>

              {/* Analyses */}
              {tab === 'analyses' ? (
                detail.analyses.length === 0 ? (
                  <p className="text-sm text-on-surface-variant/60 py-10 text-center">尚無信件解析紀錄</p>
                ) : (
                  <div className="space-y-2">
                    {detail.analyses.map(a => {
                      const opened = openEmail === a.email_id;
                      const hasDeep = !!(a.deep_analysis && a.deep_analysis.trim());
                      const b = bodies[a.email_id];
                      return (
                        <div key={a.email_id} className="border border-outline-variant/30 rounded-xl overflow-hidden bg-surface-container-lowest">
                          <button onClick={() => setOpenEmail(opened ? null : a.email_id)}
                            className="w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-surface-container/40 cursor-pointer transition-colors">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 flex-wrap mb-1">
                                <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded" style={{ color: priColor(a.priority), background: priColor(a.priority) + '18' }}>{a.priority || '中'}</span>
                                {a.category && <span className="text-[11px] px-1.5 py-0.5 rounded bg-surface-container text-on-surface-variant">{a.category}</span>}
                                {hasDeep && <span className="text-[11px] px-1.5 py-0.5 rounded bg-primary/10 text-primary inline-flex items-center gap-0.5"><span className="material-symbols-outlined text-[12px]">psychology</span>深度</span>}
                                <span className="text-[11px] text-on-surface-variant/50 font-mono ml-auto">{fmtDateTime(a.created_at)}</span>
                              </div>
                              <p className="text-sm font-medium text-on-surface truncate">{a.email_subject || '（無主旨）'}</p>
                              {a.summary && <p className="text-xs text-on-surface-variant mt-0.5 line-clamp-2">{a.summary}</p>}
                            </div>
                            <span className={`material-symbols-outlined text-[18px] text-on-surface-variant transition-transform shrink-0 ${opened ? 'rotate-180' : ''}`}>expand_more</span>
                          </button>
                          {opened && (
                            <div className="px-3 md:px-4 pb-4 pt-3 border-t border-outline-variant/10 space-y-3">
                              {/* AI summary (Layer 1) */}
                              <div>
                                <p className="text-[11px] font-semibold text-on-surface-variant/70 uppercase tracking-wide mb-1.5 flex items-center gap-1.5"><span className="material-symbols-outlined text-[14px]">summarize</span>AI 摘要</p>
                                <p className="text-sm text-on-surface-variant whitespace-pre-wrap leading-relaxed">{a.summary || '（無摘要）'}</p>
                              </div>
                              {/* Deep analysis (Layer 2) */}
                              {hasDeep && (
                                <div className="rounded-xl bg-primary/[0.04] border border-primary/15 p-3 md:p-4 text-sm text-on-surface-variant">
                                  <p className="text-[11px] font-semibold text-primary uppercase tracking-wide mb-2 flex items-center gap-1.5"><span className="material-symbols-outlined text-[14px]">psychology</span>深度解析</p>
                                  <TeamMarkdown>{a.deep_analysis!}</TeamMarkdown>
                                </div>
                              )}
                              {/* Original email (lazy-loaded live from the mailbox) */}
                              <div>
                                {!b ? (
                                  <button onClick={() => viewEmail(detail.conversation.id, a.email_id)}
                                    className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline cursor-pointer">
                                    <span className="material-symbols-outlined text-[15px]">mail</span>查看原信件內容
                                  </button>
                                ) : b.loading ? (
                                  <p className="text-xs text-on-surface-variant/70">讀取原信件中…</p>
                                ) : b.err ? (
                                  <p className="text-xs text-error">{b.err}</p>
                                ) : b.data ? (
                                  <div>
                                    <p className="text-[11px] font-semibold text-on-surface-variant/70 uppercase tracking-wide mb-1.5 flex items-center gap-1.5"><span className="material-symbols-outlined text-[14px]">mail</span>原信件</p>
                                    <p className="text-[11px] text-on-surface-variant/70 mb-2 truncate">
                                      寄件者：{b.data.from?.name || b.data.from?.address || '—'}{b.data.from?.address ? ` <${b.data.from.address}>` : ''} · {fmtDateTime(b.data.receivedAt)}
                                    </p>
                                    {b.data.bodyType === 'html'
                                      ? <iframe sandbox="" srcDoc={b.data.body} title="原信件" className="w-full h-96 bg-white rounded-lg border border-outline-variant/30" />
                                      : <pre className="whitespace-pre-wrap text-xs text-on-surface-variant leading-relaxed bg-surface-container rounded-lg p-3 max-h-96 overflow-y-auto">{b.data.body || '（無內文）'}</pre>}
                                  </div>
                                ) : null}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )
              ) : detail.messages.length === 0 ? (
                <p className="text-sm text-on-surface-variant/60 py-10 text-center">尚無對話紀錄（使用者點開了信件助手但沒有提問）</p>
              ) : (
                <div className="space-y-3">
                  {detail.messages.map(m => (
                    <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[85%] rounded-xl px-4 py-2.5 text-sm ${m.role === 'user' ? 'bg-primary/10 text-on-surface' : 'bg-surface-container-lowest border border-outline-variant/30 text-on-surface-variant'}`}>
                        <p className="text-[10px] uppercase tracking-wide mb-1 opacity-60">{m.role === 'user' ? '使用者' : '助手'} · {fmtDateTime(m.created_at)}</p>
                        {m.role === 'user' ? <p className="whitespace-pre-wrap leading-relaxed">{m.content}</p> : <TeamMarkdown>{m.content}</TeamMarkdown>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </>
    );
  }

  /* ---- List view ---- */
  return (
    <>
      <header className={HEADER + ' justify-between'}>
        <div className="flex items-center gap-2 md:gap-4">
          <span className="text-base md:text-lg font-black text-on-surface font-headline">用戶對話管理</span>
          <span className="text-xs md:text-sm text-on-surface-variant font-mono">共 {total} 位使用信件助手</span>
        </div>
      </header>

      <div className="flex-1 flex flex-col p-4 md:p-8 overflow-hidden">
        {/* Tabs */}
        <div className="flex items-center gap-1 mb-4 shrink-0">
          <Link href="/admin/conversations" className={TAB_IDLE}>對話管理</Link>
          <Link href="/admin/teams" className={TAB_IDLE}>團隊協作</Link>
          <span className={TAB_ACTIVE}>信件助手</span>
        </div>

        {/* Search */}
        <div className="mb-4 md:mb-6 relative shrink-0">
          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline text-sm">search</span>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="搜尋使用者 email 或名稱…"
            className="w-full bg-surface-container-highest border-none focus:ring-1 focus:ring-primary/40 rounded py-2.5 pl-10 pr-4 text-sm text-on-surface placeholder:text-outline font-body" />
        </div>

        {/* Table (desktop) */}
        <div className="hidden md:block flex-1 overflow-y-auto">
          {loading ? (
            <div className="py-16 text-center text-on-surface-variant">載入中…</div>
          ) : items.length === 0 ? (
            <div className="py-16 text-center text-on-surface-variant">目前沒有人使用信件助手</div>
          ) : (
            <table className="w-full">
              <thead className="sticky top-0 bg-surface-container-lowest">
                <tr className="text-left text-sm uppercase tracking-widest text-on-surface-variant">
                  <th className="py-3 px-4 font-bold">使用者</th>
                  <th className="py-3 px-4 font-bold text-center">對話提問</th>
                  <th className="py-3 px-4 font-bold text-center">信件解析</th>
                  <th className="py-3 px-4 font-bold text-center">深度解析</th>
                  <th className="py-3 px-4 font-bold">最近活動</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant/10">
                {items.map(it => (
                  <tr key={it.id} onClick={() => open(it.id)} className="hover:bg-surface-container/40 cursor-pointer">
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded bg-primary/15 flex items-center justify-center text-sm font-bold text-primary shrink-0">
                          {(it.user_display_name || it.user_email || 'U')[0].toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm text-on-surface font-medium truncate">{it.user_display_name || it.user_email?.split('@')[0]}</p>
                          <p className="text-sm text-on-surface-variant font-mono truncate">{it.user_email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="py-3 px-4 text-center text-sm">{it.question_count ? <span className="text-primary font-medium">{it.question_count}</span> : <span className="text-on-surface-variant/50">0</span>}</td>
                    <td className="py-3 px-4 text-center text-sm">{it.analysis_count ? <span className="text-on-surface font-medium">{it.analysis_count}</span> : <span className="text-on-surface-variant/50">0</span>}</td>
                    <td className="py-3 px-4 text-center text-sm text-on-surface-variant">{it.deep_count || 0}</td>
                    <td className="py-3 px-4 text-sm text-on-surface-variant font-mono">{fmtDate(it.last_activity)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Card list (mobile) */}
        <div className="md:hidden flex-1 overflow-y-auto -mx-4 px-4 space-y-2">
          {loading ? (
            <div className="py-16 text-center text-on-surface-variant">載入中…</div>
          ) : items.length === 0 ? (
            <div className="py-16 text-center text-on-surface-variant">目前沒有人使用信件助手</div>
          ) : items.map(it => (
            <div key={it.id} onClick={() => open(it.id)} className="bg-surface-container rounded-lg p-3 active:bg-surface-container-high transition-colors cursor-pointer">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0"><span className="material-symbols-outlined text-primary text-[20px]">mail</span></div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-on-surface truncate">{it.user_display_name || it.user_email?.split('@')[0]}</p>
                  <p className="text-xs text-on-surface-variant truncate">{it.user_email}</p>
                </div>
                <span className="material-symbols-outlined text-on-surface-variant/50 text-[18px] shrink-0">chevron_right</span>
              </div>
              <div className="flex items-center gap-3 mt-2 ml-[52px] text-[11px] text-on-surface-variant">
                <span className="inline-flex items-center gap-1"><span className="material-symbols-outlined text-[13px]">forum</span>{it.question_count || 0}</span>
                <span className="inline-flex items-center gap-1"><span className="material-symbols-outlined text-[13px]">mark_email_read</span>{it.analysis_count || 0}</span>
                <span className="ml-auto font-mono">{fmtDate(it.last_activity)}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
