'use client';

/**
 * Admin view for the email assistant (信件助手), split out from the general
 * conversation list — like 團隊協作. Per user it shows whether they do per-email
 * ANALYSIS (信件解析) vs. actual Q&A CONVERSATION (對話). Clicking an analysis opens
 * a modal with the original email + AI summary + AI analysis, for technical review
 * of AI quality (recipient intentionally hidden — privacy).
 */

import { useState, useEffect, useCallback, type ReactNode } from 'react';
import Link from 'next/link';
import TeamMarkdown from '../../components/TeamMarkdown';
import { useAdminAuth } from '../components/AdminAuthProvider';

interface Row {
  id: string; user_id: string; created_at: string; status: string;
  user_email: string; user_display_name: string;
  question_count: number; message_count: number; analysis_count: number; deep_count: number; attachment_count: number;
  last_activity: string;
}
interface Analysis { email_id: string; email_subject: string | null; summary: string | null; priority: string | null; category: string | null; deep_analysis: string | null; attachment_analysis: string | null; created_at: string }
// Which analysis level an email reached: 附件分析 > 深度分析 > 一般解析.
function kindBadge(a: { deep_analysis: string | null; attachment_analysis: string | null }): { label: string; icon: string; cls: string } {
  if (a.attachment_analysis && a.attachment_analysis.trim()) return { label: '附件分析', icon: 'attach_file', cls: 'bg-tertiary/15 text-tertiary' };
  if (a.deep_analysis && a.deep_analysis.trim()) return { label: '深度分析', icon: 'psychology', cls: 'bg-primary/10 text-primary' };
  return { label: '一般解析', icon: 'summarize', cls: 'bg-surface-container text-on-surface-variant/60' };
}
interface Message { id: string; role: string; content: string; created_at: string }
interface Detail { conversation: { id: string; user_email: string; user_display_name: string; created_at: string }; messages: Message[]; analysisTotal: number }
interface Attachment { filename: string; contentType: string; size: number }
interface EmailBody { subject: string; from: { name: string; address: string } | null; receivedAt: string; body: string; bodyType: string; hasAttachments?: boolean; attachments?: Attachment[] }
type BodyState = { loading?: boolean; err?: string; data?: EmailBody };

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
// Pagination — matches the 對話管理 (conversations) page style: a "第 X-Y 筆，共 N"
// summary on the left, numbered page buttons (windowed to 5) + prev/next on the right.
const PG_EDGE = 'px-2.5 md:px-3 py-1.5 text-xs md:text-sm bg-surface-container text-on-surface-variant rounded disabled:opacity-30 cursor-pointer hover:bg-surface-container-high transition-colors';
function Pager({ page, totalPages, total, limit, onChange, unit = '筆' }: { page: number; totalPages: number; total: number; limit: number; onChange: (p: number) => void; unit?: string }) {
  if (totalPages <= 1) return null;
  const start = (page - 1) * limit + 1;
  const end = Math.min(page * limit, total);
  const nums = Array.from({ length: Math.min(totalPages, 5) }, (_, i) => (
    totalPages <= 5 ? i + 1 : page <= 3 ? i + 1 : page >= totalPages - 2 ? totalPages - 4 + i : page - 2 + i
  ));
  return (
    <div className="flex items-center justify-between pt-4 border-t border-outline-variant/20 mt-4 shrink-0">
      <span className="text-xs md:text-sm text-on-surface-variant hidden md:block">第 {start}-{end} 筆，共 {total} {unit}</span>
      <span className="text-xs text-on-surface-variant md:hidden">{page}/{totalPages}</span>
      <div className="flex gap-1">
        <button onClick={() => onChange(Math.max(1, page - 1))} disabled={page === 1} className={PG_EDGE}>上一頁</button>
        {nums.map(p => (
          <button key={p} onClick={() => onChange(p)}
            className={`px-2.5 md:px-3 py-1.5 text-xs md:text-sm rounded cursor-pointer transition-colors ${page === p ? 'bg-primary/15 text-primary font-bold' : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high'}`}>{p}</button>
        ))}
        <button onClick={() => onChange(Math.min(totalPages, page + 1))} disabled={page === totalPages} className={PG_EDGE}>下一頁</button>
      </div>
    </div>
  );
}

// ── Rich deep-analysis rendering (mirrors the user-facing EmailDetailModal) ──
// The deep analysis is markdown with named sections (摘要 / 行動建議 / 資安標記 /
// 緊急程度 / 建議回覆) plus a [RISK:NONE|HIGH] tag.
function detectRisk(analysis?: string): { hasRisk: boolean } {
  if (!analysis) return { hasRisk: false };
  const tag = analysis.match(/\[RISK:(NONE|HIGH)]/);
  if (tag) return { hasRisk: tag[1] === 'HIGH' };
  return { hasRisk: false };
}
function parseAnalysisSections(md: string): { key: string; body: string }[] {
  const text = md.replace(/\n?\[RISK:(?:NONE|HIGH)]\s*$/i, '').trim();
  const headerRe = /(?:^|\n)[ \t]*(?:#{1,4}[ \t]*)?(?:\d+\.[ \t]*)?\*{0,2}[ \t]*(摘要|行動建議|資安標記|緊急程度|建議回[覆復])\*{0,2}[ \t]*[：:]?[ \t]*/g;
  const marks: { key: string; headStart: number; bodyStart: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(text)) !== null) marks.push({ key: m[1].replace('建議回復', '建議回覆'), headStart: m.index, bodyStart: headerRe.lastIndex });
  if (marks.length < 2) return [];
  const out: { key: string; body: string }[] = [];
  for (let i = 0; i < marks.length; i++) { const end = i + 1 < marks.length ? marks[i + 1].headStart : text.length; out.push({ key: marks[i].key, body: text.slice(marks[i].bodyStart, end).trim() }); }
  return out;
}
const SECTION_ICON: Record<string, string> = { '摘要': 'description', '行動建議': 'checklist', '資安標記': 'shield', '緊急程度': 'priority_high', '建議回覆': 'reply' };
function urgencyBadge(body: string): { label: string; cls: string } | null {
  const lv = (body.split('\n')[0].match(/[高中低]/) || [])[0];
  if (lv === '高') return { label: '高', cls: 'bg-error/15 text-error' };
  if (lv === '中') return { label: '中', cls: 'bg-warning/15 text-warning' };
  if (lv === '低') return { label: '低', cls: 'bg-success/15 text-success' };
  return null;
}
const fmtSize = (b: number) => (b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : (b / 1048576).toFixed(1) + ' MB');
const attIcon = (ct: string) => (ct.startsWith('image/') ? 'image' : ct.includes('pdf') ? 'picture_as_pdf' : (ct.includes('sheet') || ct.includes('excel')) ? 'table_chart' : 'description');

function AnalysisSections({ deep }: { deep: string }) {
  const sections = parseAnalysisSections(deep);
  const hasRisk = detectRisk(deep).hasRisk;
  if (sections.length === 0) {
    return <div className="text-sm text-on-surface-variant leading-relaxed"><TeamMarkdown>{deep.replace(/\n?\[RISK:(?:NONE|HIGH)]\s*$/, '')}</TeamMarkdown></div>;
  }
  return (
    <div className="space-y-2.5">
      {sections.map((s, i) => {
        const icon = SECTION_ICON[s.key] || 'article';
        let headerCls = 'bg-primary/[0.08]', iconCls = 'text-primary';
        let badge: ReactNode = null;
        if (s.key === '資安標記') {
          if (hasRisk) { headerCls = 'bg-error/10'; iconCls = 'text-error'; badge = <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-error/15 text-error">⚠ 注意風險</span>; }
          else { headerCls = 'bg-success/10'; iconCls = 'text-success'; badge = <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-success/15 text-success">✓ 無風險</span>; }
        } else if (s.key === '緊急程度') {
          headerCls = 'bg-warning/10'; iconCls = 'text-warning';
          const u = urgencyBadge(s.body); if (u) badge = <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${u.cls}`}>{u.label}</span>;
        } else if (s.key === '建議回覆') { headerCls = 'bg-secondary/[0.08]'; iconCls = 'text-secondary'; }
        return (
          <div key={i} className="rounded-xl border border-outline-variant/15 overflow-hidden bg-surface-container-low/30">
            <div className={`flex items-center gap-2 px-3 py-2 border-b border-outline-variant/10 ${headerCls}`}>
              <span className={`material-symbols-outlined text-base shrink-0 ${iconCls}`}>{icon}</span>
              <span className="font-semibold text-sm text-on-surface">{s.key}</span>
              {badge && <span className="ml-auto shrink-0">{badge}</span>}
            </div>
            <div className="px-3 py-2.5 text-sm text-on-surface-variant leading-relaxed"><TeamMarkdown>{s.body}</TeamMarkdown></div>
          </div>
        );
      })}
    </div>
  );
}

export default function AdminEmailAgentPage() {
  const { token } = useAdminAuth();
  const [items, setItems] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [tab, setTab] = useState<'analyses' | 'chat'>('analyses');

  const [analyses, setAnalyses] = useState<Analysis[]>([]);
  const [aPage, setAPage] = useState(1);
  const [aTotalPages, setATotalPages] = useState(1);
  const [aLoading, setALoading] = useState(false);

  const [modal, setModal] = useState<Analysis | null>(null);
  const [modalBody, setModalBody] = useState<BodyState>({});

  const load = useCallback(() => {
    if (!token) return;
    setLoading(true);
    const params = new URLSearchParams({ limit: '20', page: String(page) });
    if (search.trim()) params.set('search', search.trim());
    fetch(`/api/admin/email-agent?${params}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(d => { setItems(d.items || []); setTotal(d.total || 0); setTotalPages(d.totalPages || 1); })
      .catch(() => {}).finally(() => setLoading(false));
  }, [token, search, page]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  const loadAnalyses = useCallback((convId: string, p: number) => {
    if (!token) return;
    setALoading(true);
    fetch(`/api/admin/email-agent/${convId}/analyses?page=${p}&limit=20`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(d => { setAnalyses(d.analyses || []); setATotalPages(d.totalPages || 1); })
      .catch(() => {}).finally(() => setALoading(false));
  }, [token]);

  const open = (id: string) => {
    if (!token) return;
    setDetailLoading(true); setDetail(null); setTab('analyses'); setAnalyses([]); setAPage(1);
    fetch(`/api/admin/email-agent/${id}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then((d: Detail) => { setDetail(d); loadAnalyses(id, 1); })
      .catch(() => {}).finally(() => setDetailLoading(false));
  };
  const changeAPage = (p: number) => { if (detail) { setAPage(p); loadAnalyses(detail.conversation.id, p); } };

  const openModal = (a: Analysis) => {
    if (!detail) return;
    setModal(a); setModalBody({ loading: true });
    fetch(`/api/admin/email-agent/${detail.conversation.id}/email?emailId=${encodeURIComponent(a.email_id)}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async r => {
        // Parse defensively — the mail API sometimes returns non-JSON (e.g. a
        // plain "Internal Server Error"); never surface a raw JSON-parse error.
        const txt = await r.text();
        let d: any = null; try { d = txt ? JSON.parse(txt) : null; } catch { /* non-JSON */ }
        if (!r.ok) throw new Error((d && d.message) || '信箱 API 暫時異常，請稍後再試');
        if (!d) throw new Error('信箱 API 回應異常，請稍後再試');
        return d as EmailBody;
      })
      .then(d => setModalBody({ data: d })).catch(e => setModalBody({ err: e.message || '讀取失敗' }));
  };

  /* ---- Detail (full page) ---- */
  if (detail || detailLoading) {
    const questions = detail?.messages.filter(m => m.role === 'user').length ?? 0;
    // Prefer the attachment analysis (most complete) when present, else text deep analysis.
    const modalDeepText = (modal?.attachment_analysis && modal.attachment_analysis.trim()) || (modal?.deep_analysis && modal.deep_analysis.trim()) || '';
    const modalDeep = !!modalDeepText;
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
                  <div className="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center shrink-0"><span className="material-symbols-outlined text-primary text-[24px]">mail</span></div>
                  <div className="flex-1 min-w-0">
                    <h2 className="text-lg font-bold text-on-surface">{detail.conversation.user_display_name || detail.conversation.user_email}</h2>
                    <p className="text-xs text-on-surface-variant/70 mt-1 font-mono truncate">{detail.conversation.user_email}</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 md:flex md:flex-wrap md:justify-end shrink-0">
                  {[{ icon: 'forum', label: '對話提問', value: questions }, { icon: 'mark_email_read', label: '信件解析', value: detail.analysisTotal }].map(s => (
                    <span key={s.label} className="flex md:inline-flex flex-col md:flex-row items-center md:gap-1.5 bg-surface-container rounded-lg px-2 md:px-3 py-2 md:py-1.5 text-xs text-center">
                      <span className="inline-flex items-center gap-1 text-on-surface-variant"><span className="material-symbols-outlined text-[15px] text-primary">{s.icon}</span>{s.label}</span>
                      <span className="font-semibold text-on-surface mt-0.5 md:mt-0">{s.value}</span>
                    </span>
                  ))}
                </div>
              </div>

              {/* Tabs */}
              <div className="flex items-center gap-5 border-b border-outline-variant/10">
                {([['analyses', `信件解析 (${detail.analysisTotal})`], ['chat', `對話 (${detail.messages.length})`]] as const).map(([k, label]) => (
                  <button key={k} onClick={() => setTab(k)}
                    className={`pb-2.5 -mb-px text-sm border-b-2 transition-colors ${tab === k ? 'border-primary text-primary font-semibold' : 'border-transparent text-on-surface-variant hover:text-on-surface'}`}>{label}</button>
                ))}
              </div>

              {/* Analyses */}
              {tab === 'analyses' ? (
                aLoading ? <div className="py-10 text-center text-on-surface-variant">載入中…</div>
                : analyses.length === 0 ? <p className="text-sm text-on-surface-variant/60 py-10 text-center">尚無信件解析紀錄</p>
                : (
                  <>
                    <div className="space-y-2">
                      {analyses.map(a => {
                        const bd = kindBadge(a);
                        return (
                          <button key={a.email_id} onClick={() => openModal(a)}
                            className="w-full flex items-start gap-3 px-4 py-3 text-left border border-outline-variant/30 rounded-xl bg-surface-container-lowest hover:border-primary/40 hover:bg-surface-container/40 transition-colors cursor-pointer">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 flex-wrap mb-1">
                                <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded" style={{ color: priColor(a.priority), background: priColor(a.priority) + '18' }}>{a.priority || '中'}</span>
                                {a.category && <span className="text-[11px] px-1.5 py-0.5 rounded bg-surface-container text-on-surface-variant">{a.category}</span>}
                                <span className={`text-[11px] px-1.5 py-0.5 rounded inline-flex items-center gap-0.5 ${bd.cls}`}>
                                  <span className="material-symbols-outlined text-[12px]">{bd.icon}</span>{bd.label}
                                </span>
                                <span className="text-[11px] text-on-surface-variant/50 font-mono ml-auto">{fmtDateTime(a.created_at)}</span>
                              </div>
                              <p className="text-sm font-medium text-on-surface truncate">{a.email_subject || '（無主旨）'}</p>
                              {a.summary && <p className="text-xs text-on-surface-variant mt-0.5 line-clamp-2">{a.summary}</p>}
                            </div>
                            <span className="material-symbols-outlined text-[18px] text-on-surface-variant/50 shrink-0 mt-1">open_in_full</span>
                          </button>
                        );
                      })}
                    </div>
                    <Pager page={aPage} totalPages={aTotalPages} total={detail.analysisTotal} limit={20} unit="封信" onChange={changeAPage} />
                  </>
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

        {/* ---- Modal: LEFT = AI 分析 (含各段落) · RIGHT = 原信件 ---- */}
        {modal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 md:p-6" onClick={() => setModal(null)}>
            <div className="bg-surface w-full max-w-5xl h-[88vh] rounded-2xl shadow-2xl flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
              {/* Header (full width) */}
              <div className="flex items-start gap-3 px-5 py-4 border-b border-outline-variant/15 shrink-0">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap mb-1.5">
                    <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded" style={{ color: priColor(modal.priority), background: priColor(modal.priority) + '18' }}>{modal.priority || '中'}優先</span>
                    {modal.category && <span className="text-[11px] px-1.5 py-0.5 rounded bg-surface-container text-on-surface-variant">{modal.category}</span>}
                    {(() => { const bd = kindBadge(modal); return (
                      <span className={`text-[11px] px-1.5 py-0.5 rounded inline-flex items-center gap-0.5 ${bd.cls}`}>
                        <span className="material-symbols-outlined text-[12px]">{bd.icon}</span>{bd.label}
                      </span>
                    ); })()}
                  </div>
                  <h3 className="text-base font-bold text-on-surface leading-snug line-clamp-2">{modal.email_subject || '（無主旨）'}</h3>
                </div>
                <button onClick={() => setModal(null)} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-surface-container text-on-surface-variant cursor-pointer shrink-0"><span className="material-symbols-outlined">close</span></button>
              </div>

              {/* Two columns: LEFT = AI 分析, RIGHT = 原信件 */}
              <div className="flex-1 min-h-0 flex flex-col md:flex-row overflow-hidden">
                {/* LEFT — AI 分析 */}
                <div className="md:w-[400px] md:shrink-0 flex flex-col min-h-0 border-b md:border-b-0 md:border-r border-outline-variant/10">
                  <div className="flex items-center gap-2 px-4 py-3 border-b border-outline-variant/10 shrink-0 bg-surface-container-high/30">
                    <span className="material-symbols-outlined text-primary text-lg">auto_awesome</span>
                    <span className="text-sm font-semibold text-on-surface">AI 分析</span>
                  </div>
                  <div className="flex-1 min-h-0 overflow-y-auto p-4">
                    {modalDeep ? <AnalysisSections deep={modalDeepText} /> : (
                      <div className="space-y-3">
                        <div className="rounded-xl border border-outline-variant/15 overflow-hidden bg-surface-container-low/30">
                          <div className="flex items-center gap-2 px-3 py-2 border-b border-outline-variant/10 bg-primary/[0.08]">
                            <span className="material-symbols-outlined text-base text-primary">summarize</span>
                            <span className="font-semibold text-sm text-on-surface">AI 摘要</span>
                          </div>
                          <div className="px-3 py-2.5 text-sm text-on-surface-variant leading-relaxed whitespace-pre-wrap">{modal.summary || '（無摘要）'}</div>
                        </div>
                        <p className="text-xs text-on-surface-variant/50 px-1">此封信未做深度解析 —— 使用者只看了 AI 摘要，未觸發行動建議 / 資安標記 / 緊急程度 / 建議回覆。</p>
                      </div>
                    )}
                  </div>
                </div>

                {/* RIGHT — 原信件 */}
                <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                  <div className="flex items-center gap-2 px-4 py-3 border-b border-outline-variant/10 shrink-0 bg-surface-container-high/30">
                    <span className="material-symbols-outlined text-tertiary text-lg">mail</span>
                    <span className="text-sm font-semibold text-on-surface">原信件</span>
                  </div>
                  {modalBody.data && (
                    <div className="px-4 py-2.5 border-b border-outline-variant/10 shrink-0">
                      <p className="text-xs text-on-surface truncate"><span className="text-on-surface-variant/60">寄件者：</span>{modalBody.data.from?.name || modalBody.data.from?.address || '—'}{modalBody.data.from?.address ? ` <${modalBody.data.from.address}>` : ''}</p>
                      <p className="text-[11px] text-on-surface-variant/60 mt-0.5">{fmtDateTime(modalBody.data.receivedAt)}</p>
                      {modalBody.data.attachments && modalBody.data.attachments.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5 mt-2">
                          <span className="text-[11px] text-on-surface-variant/60 inline-flex items-center gap-1"><span className="material-symbols-outlined text-[14px]">attach_file</span>附件 {modalBody.data.attachments.length}</span>
                          {modalBody.data.attachments.map((a, i) => (
                            <span key={i} className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-surface-container text-on-surface-variant max-w-[190px]">
                              <span className="material-symbols-outlined text-[13px] text-tertiary">{attIcon(a.contentType)}</span>
                              <span className="truncate">{a.filename}</span>
                              <span className="text-on-surface-variant/50 shrink-0">{fmtSize(a.size)}</span>
                            </span>
                          ))}
                          <span className="text-[10px] text-on-surface-variant/40">（僅顯示，不提供下載）</span>
                        </div>
                      )}
                    </div>
                  )}
                  <div className="flex-1 min-h-0 overflow-y-auto bg-surface-container-lowest">
                    {modalBody.loading ? <div className="py-12 text-center text-sm text-on-surface-variant/70">讀取原信件中…</div>
                      : modalBody.err ? <div className="py-12 text-center text-sm text-error">{modalBody.err}</div>
                      : modalBody.data ? (
                        modalBody.data.bodyType === 'html'
                          ? <iframe sandbox="" srcDoc={modalBody.data.body} title="原信件" className="w-full h-full min-h-[300px] bg-white border-0" />
                          : <pre className="whitespace-pre-wrap text-xs text-on-surface-variant leading-relaxed p-4">{modalBody.data.body || '（無內文）'}</pre>
                      ) : null}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
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
          <input value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} placeholder="搜尋使用者 email 或名稱…"
            className="w-full bg-surface-container-highest border-none focus:ring-1 focus:ring-primary/40 rounded py-2.5 pl-10 pr-4 text-sm text-on-surface placeholder:text-outline font-body" />
        </div>

        {/* Table (desktop) */}
        <div className="hidden md:block flex-1 overflow-y-auto">
          {loading ? <div className="py-16 text-center text-on-surface-variant">載入中…</div>
          : items.length === 0 ? <div className="py-16 text-center text-on-surface-variant">目前沒有人使用信件助手</div>
          : (
            <table className="w-full">
              <thead className="sticky top-0 bg-surface-container-lowest">
                <tr className="text-left text-sm uppercase tracking-widest text-on-surface-variant">
                  <th className="py-3 px-4 font-bold">使用者</th>
                  <th className="py-3 px-4 font-bold text-center">對話提問</th>
                  <th className="py-3 px-4 font-bold text-center">信件解析</th>
                  <th className="py-3 px-4 font-bold text-center">深度分析</th>
                  <th className="py-3 px-4 font-bold text-center">附件分析</th>
                  <th className="py-3 px-4 font-bold">最近活動</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant/10">
                {items.map(it => (
                  <tr key={it.id} onClick={() => open(it.id)} className="hover:bg-surface-container/40 cursor-pointer">
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded bg-primary/15 flex items-center justify-center text-sm font-bold text-primary shrink-0">{(it.user_display_name || it.user_email || 'U')[0].toUpperCase()}</div>
                        <div className="min-w-0">
                          <p className="text-sm text-on-surface font-medium truncate">{it.user_display_name || it.user_email?.split('@')[0]}</p>
                          <p className="text-sm text-on-surface-variant font-mono truncate">{it.user_email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="py-3 px-4 text-center text-sm">{it.question_count ? <span className="text-primary font-medium">{it.question_count}</span> : <span className="text-on-surface-variant/50">0</span>}</td>
                    <td className="py-3 px-4 text-center text-sm">{it.analysis_count ? <span className="text-on-surface font-medium">{it.analysis_count}</span> : <span className="text-on-surface-variant/50">0</span>}</td>
                    <td className="py-3 px-4 text-center text-sm">{it.deep_count ? <span className="text-primary font-medium">{it.deep_count}</span> : <span className="text-on-surface-variant/50">0</span>}</td>
                    <td className="py-3 px-4 text-center text-sm">{it.attachment_count ? <span className="text-tertiary font-medium">{it.attachment_count}</span> : <span className="text-on-surface-variant/50">0</span>}</td>
                    <td className="py-3 px-4 text-sm text-on-surface-variant font-mono">{fmtDate(it.last_activity)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Card list (mobile) */}
        <div className="md:hidden flex-1 overflow-y-auto -mx-4 px-4 space-y-2">
          {loading ? <div className="py-16 text-center text-on-surface-variant">載入中…</div>
          : items.length === 0 ? <div className="py-16 text-center text-on-surface-variant">目前沒有人使用信件助手</div>
          : items.map(it => (
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
                <span className="inline-flex items-center gap-1 text-primary"><span className="material-symbols-outlined text-[13px]">psychology</span>{it.deep_count || 0}</span>
                <span className="inline-flex items-center gap-1 text-tertiary"><span className="material-symbols-outlined text-[13px]">attach_file</span>{it.attachment_count || 0}</span>
                <span className="ml-auto font-mono">{fmtDate(it.last_activity)}</span>
              </div>
            </div>
          ))}
        </div>

        <Pager page={page} totalPages={totalPages} total={total} limit={20} unit="位" onChange={setPage} />
      </div>
    </>
  );
}
