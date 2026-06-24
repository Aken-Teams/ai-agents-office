'use client';

/**
 * Team collaboration run view. The user poses a topic, the team's members each
 * analyse it live (coordinator fan-out), then the coordinator synthesises a
 * final answer. Consumes the SSE stream from POST /api/teams/:id/run.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkCjkFriendly from 'remark-cjk-friendly';
import remarkFlexibleMarkers from 'remark-flexible-markers';
import { AuthProvider, useAuth } from '../../components/AuthProvider';
import { I18nProvider } from '../../../i18n';
import Navbar from '../../components/Navbar';
import { useSidebarMargin } from '../../hooks/useSidebarCollapsed';
import TeamMarkdown from '../../components/TeamMarkdown';
import { calcCostUsd } from '../../../lib/pricing';

const SSE_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

// Scheduling is hidden in pro-panjit for now (pending AD-email integration).
const deployMode = process.env.NEXT_PUBLIC_DEPLOY_MODE || 'pro-panjit';
const isPanjit = deployMode === 'pro-panjit';

interface Agent { id: string; title: string; icon: string | null; skill_id: string | null }
interface TeamInfo { id: string; title: string; topic: string | null; icon: string | null }
interface Estimate { memberCount: number; inputTokens: number; outputTokens: number; costUsd: number }
interface RunRow { id: string; question: string; result: string | null; member_outputs: string | null; input_tokens: number; output_tokens: number; status: string; created_at: string; share_token: string | null; schedule_id: string | null; emailed: number | null; attachments: string | null }
interface TeamTotal { count: number; inputTokens: number; outputTokens: number; costUsd: number }

type MemberStatus = 'pending' | 'running' | 'responding' | 'done' | 'failed';
interface MemberStream { name: string; icon: string | null; status: MemberStatus; text: string; text2: string; inRound2: boolean }

const STATUS_META: Record<MemberStatus, { label: string; cls: string; icon: string; spin?: boolean }> = {
  pending:    { label: '等待中', cls: 'text-on-surface-variant bg-surface-container-high', icon: 'schedule' },
  running:    { label: '分析中', cls: 'text-primary bg-primary/10', icon: 'progress_activity', spin: true },
  responding: { label: '回應中', cls: 'text-tertiary bg-tertiary/10', icon: 'forum' },
  done:       { label: '完成',   cls: 'text-success bg-success/10', icon: 'check_circle' },
  failed:     { label: '失敗',   cls: 'text-error bg-error/10', icon: 'error' },
};

// ---- Report PDF helpers (render markdown → HTML → browser print/Save-as-PDF) ----
function escapeHtml(s: string): string {
  return (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || c));
}

// Interactive chart/diagram fences can't render in a static PDF — replace with a note.
function stripChartFences(md: string): string {
  return (md || '').replace(/```(chart|echart|mermaid|mindmap|map)[\s\S]*?```/g, '_（互動圖表，請至系統線上檢視）_');
}

function mdToHtml(md: string): string {
  if (!md?.trim()) return '<p style="color:#888">（無內容）</p>';
  return renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkCjkFriendly, remarkFlexibleMarkers]}>{stripChartFences(md)}</ReactMarkdown>
  );
}

const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
function isImageAttachment(a: { name?: string; mime?: string | null }): boolean {
  return !!(a.mime?.startsWith('image/')) || IMG_EXT.test(a.name || '');
}

// Fetch a (possibly auth-protected) file and inline it as a data URL so it can be
// embedded directly in the printable report window.
async function fetchAsDataUrl(url: string, headers: HeadersInit): Promise<string | null> {
  try {
    const r = await fetch(url, { headers });
    if (!r.ok) return null;
    const blob = await r.blob();
    return await new Promise<string>((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result));
      fr.onerror = rej;
      fr.readAsDataURL(blob);
    });
  } catch { return null; }
}

interface ReportAttachment { name: string; isImage: boolean; dataUrl?: string | null }

function buildReportHtml(opts: {
  teamTitle: string;
  question: string;
  createdAt?: string;
  members: { name: string; text: string; text2?: string }[];
  synthesis: string;
  attachments?: ReportAttachment[];
}): string {
  const when = (opts.createdAt ? new Date(opts.createdAt) : new Date()).toLocaleString();
  const atts = opts.attachments || [];
  const attHtml = atts.length
    ? `<h2>分析附件</h2><div class="attachments">${atts.map(a =>
        a.isImage && a.dataUrl
          ? `<figure class="att-img"><img src="${a.dataUrl}" alt="${escapeHtml(a.name)}"/><figcaption>${escapeHtml(a.name)}</figcaption></figure>`
          : `<div class="att-file"><span class="att-ico">📎</span>${escapeHtml(a.name)}</div>`
      ).join('')}</div>`
    : '';
  const memberHtml = opts.members
    .filter(m => (m.text || '').trim())
    .map(m => `<section class="member"><h3>${escapeHtml(m.name)}</h3>${mdToHtml(m.text)}${
      m.text2?.trim() ? `<div class="round2"><div class="round2-label">回應其他成員</div>${mdToHtml(m.text2)}</div>` : ''
    }</section>`)
    .join('');
  return `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8">
<title>${escapeHtml(opts.teamTitle || 'AI 團隊協作報告')}</title>
<style>
  @page { margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body { font-family: "Microsoft JhengHei","PingFang TC","Heiti TC","Noto Sans CJK TC",sans-serif; color:#1c1c1c; line-height:1.75; font-size:13px; margin:0; }
  h1 { font-size:22px; margin:0 0 6px; }
  h2 { font-size:16px; margin:22px 0 8px; padding-bottom:5px; border-bottom:2px solid #0b6; color:#0b6; }
  h3 { font-size:14px; margin:14px 0 6px; }
  .meta { color:#666; font-size:12px; margin:2px 0; }
  hr { border:none; border-top:1px solid #ddd; margin:14px 0; }
  table { border-collapse:collapse; width:100%; margin:8px 0; font-size:12px; }
  th,td { border:1px solid #ccc; padding:6px 8px; text-align:left; vertical-align:top; }
  th { background:#f3f4f6; font-weight:bold; }
  code { background:#f3f4f6; padding:1px 4px; border-radius:3px; font-family:Consolas,monospace; font-size:.9em; }
  pre { background:#f6f8fa; padding:10px; border-radius:6px; overflow:auto; }
  blockquote { border-left:3px solid #0b6; margin:8px 0; padding:2px 12px; color:#555; }
  mark, .flexible-marker { background:#fde68a; color:#1c1c1c; padding:0 2px; border-radius:2px; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  ul,ol { padding-left:22px; }
  .member { margin-top:6px; page-break-inside:avoid; }
  .round2 { background:#f7f9f8; border:1px solid #e2eae6; border-radius:6px; padding:8px 12px; margin-top:8px; }
  .round2-label { font-weight:bold; color:#0b6; font-size:12px; margin-bottom:4px; }
  .footer { margin-top:24px; padding-top:10px; border-top:1px solid #eee; color:#999; font-size:11px; }
  .attachments { display:flex; flex-wrap:wrap; gap:12px; margin:8px 0; }
  .att-img { margin:0; max-width:48%; page-break-inside:avoid; }
  .att-img img { max-width:100%; max-height:340px; border:1px solid #ddd; border-radius:6px; }
  .att-img figcaption { font-size:11px; color:#666; margin-top:4px; text-align:center; }
  .att-file { display:flex; align-items:center; gap:6px; font-size:12px; background:#f3f4f6; border:1px solid #e2e2e2; border-radius:6px; padding:6px 12px; }
  @media print { a { color:#0b6; text-decoration:none; } }
</style></head>
<body>
  <h1>${escapeHtml(opts.teamTitle || 'AI 團隊協作報告')}</h1>
  ${opts.question ? `<p class="meta"><b>主題／提問：</b>${escapeHtml(opts.question)}</p>` : ''}
  <p class="meta"><b>產生時間：</b>${escapeHtml(when)}</p>
  <hr>
  ${attHtml}
  <h2>協調者統整</h2>
  ${mdToHtml(opts.synthesis)}
  ${memberHtml ? `<h2>各成員分析</h2>${memberHtml}` : ''}
  <div class="footer">本報告由 AI Agents Office · 團隊協作產生</div>
</body></html>`;
}

// Fill an already-opened window with the report and trigger print/Save-as-PDF.
// The window must be opened synchronously in the click handler (before any await)
// so popup blockers don't kill it; we then fill it after images are fetched.
function fillReportWindow(w: Window, html: string): void {
  w.document.open();
  w.document.write(html);
  w.document.close();
  const go = () => { w.focus(); w.print(); };
  if (w.document.readyState === 'complete') setTimeout(go, 350);
  else w.onload = () => setTimeout(go, 350);
}

function TeamRunContent() {
  const { token, user } = useAuth();
  const router = useRouter();
  const params = useParams();
  const teamId = String(params.id);
  const sidebarMargin = useSidebarMargin();

  const [team, setTeam] = useState<TeamInfo | null>(null);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [question, setQuestion] = useState('');
  const [running, setRunning] = useState(false);
  // File-based analysis: attach files → team analyses them; default no web (file-only).
  const [attachedFiles, setAttachedFiles] = useState<{ id: string; name: string }[]>([]);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [imageWarn, setImageWarn] = useState<string | null>(null);
  const [allowWeb, setAllowWeb] = useState(true);   // no file → web on; file → defaults off (effect below)
  const [showWebWarn, setShowWebWarn] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragCounter = useRef(0);
  const hasFiles = attachedFiles.length > 0;
  // Default the web toggle off the moment a file is attached (file-only), back on when removed.
  useEffect(() => { setAllowWeb(!hasFiles); }, [hasFiles]);
  const [members, setMembers] = useState<Record<string, MemberStream>>({});
  const [memberOrder, setMemberOrder] = useState<string[]>([]);
  const [synthesis, setSynthesis] = useState('');
  const [synthRunning, setSynthRunning] = useState(false);
  const [totals, setTotals] = useState<{ inputTokens: number; outputTokens: number; costUsd: number } | null>(null);
  const [history, setHistory] = useState<RunRow[]>([]);
  const [total, setTotal] = useState<TeamTotal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runDeleteTarget, setRunDeleteTarget] = useState<RunRow | null>(null);
  const [discussing, setDiscussing] = useState(false);
  const [expanded, setExpanded] = useState<{ title: string; icon: string; text: string } | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // The run currently shown in the synthesis panel (a loaded past run, or the
  // just-finished live run) — lets share/download act on the report up front.
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const authHeaders = useCallback((): HeadersInit => (token ? { Authorization: `Bearer ${token}` } : {}), [token]);

  const loadHistory = useCallback(async (): Promise<RunRow[]> => {
    try {
      const r = await fetch(`/api/teams/${teamId}/runs`, { headers: authHeaders() });
      const d = await r.json();
      const runs: RunRow[] = Array.isArray(d.runs) ? d.runs : [];
      setHistory(runs);
      setTotal(d.total || null);
      return runs;
    } catch { return []; }
  }, [teamId, authHeaders]);

  const handleDeleteRun = useCallback(async () => {
    if (!runDeleteTarget) return;
    await fetch(`/api/teams/${teamId}/runs/${runDeleteTarget.id}`, { method: 'DELETE', headers: authHeaders() });
    setRunDeleteTarget(null);
    loadHistory();
  }, [runDeleteTarget, teamId, authHeaders, loadHistory]);

  const handleShareRun = useCallback(async (run: RunRow) => {
    const res = await fetch(`/api/teams/${teamId}/runs/${run.id}/share`, { method: 'POST', headers: authHeaders() });
    if (!res.ok) return;
    const { token } = await res.json();
    const url = `${window.location.origin}/share/team/${token}`;
    setShareUrl(url);
    setCopied(false);
    try { await navigator.clipboard.writeText(url); setCopied(true); } catch { /* ignore */ }
  }, [teamId, authHeaders]);

  // Resolve a list of {id, name, mime} into report attachments, inlining images.
  const resolveAttachments = useCallback(async (
    items: { id: string; name: string; mime?: string | null }[],
  ): Promise<ReportAttachment[]> => {
    return Promise.all(items.map(async a => {
      const isImage = isImageAttachment(a);
      const dataUrl = isImage ? await fetchAsDataUrl(`${SSE_BASE}/api/uploads/${a.id}/download`, authHeaders()) : null;
      // If an image can't be fetched, fall back to showing it as a named file.
      return { name: a.name, isImage: isImage && !!dataUrl, dataUrl };
    }));
  }, [authHeaders]);

  // Download a specific history run as PDF, built straight from its stored data.
  const handleDownloadRun = useCallback(async (run: RunRow) => {
    const w = window.open('', '_blank');
    if (!w) { alert('請允許彈出視窗，才能下載 PDF'); return; }
    w.document.write('<!DOCTYPE html><meta charset="utf-8"><body style="font-family:sans-serif;padding:40px;color:#666">報告產生中，請稍候…</body>');
    let outs: Array<{ name: string; text: string; text2?: string }> = [];
    try { outs = JSON.parse(run.member_outputs || '[]'); } catch { /* ignore */ }
    let attItems: { id: string; name: string; mime?: string | null }[] = [];
    try { attItems = JSON.parse(run.attachments || '[]'); } catch { /* ignore */ }
    const attachments = await resolveAttachments(attItems);
    fillReportWindow(w, buildReportHtml({
      teamTitle: team?.title || '', question: run.question, createdAt: run.created_at,
      members: outs.map(o => ({ name: o.name, text: o.text, text2: o.text2 })), synthesis: run.result || '', attachments,
    }));
  }, [team, resolveAttachments]);

  // Download the report shown in the synthesis panel. If it's a saved run (loaded
  // past run or the just-finished one), use its stored data + attachments; during
  // a still-streaming live run, build from in-memory state + current attachments.
  const handleDownloadCurrent = useCallback(async () => {
    const activeRun = activeRunId ? history.find(r => r.id === activeRunId) : null;
    if (activeRun) { handleDownloadRun(activeRun); return; }
    const w = window.open('', '_blank');
    if (!w) { alert('請允許彈出視窗，才能下載 PDF'); return; }
    w.document.write('<!DOCTYPE html><meta charset="utf-8"><body style="font-family:sans-serif;padding:40px;color:#666">報告產生中，請稍候…</body>');
    const ms = memberOrder.map(id => members[id]).filter(Boolean).map(m => ({ name: m.name, text: m.text, text2: m.text2 }));
    const attachments = await resolveAttachments(attachedFiles.map(f => ({ id: f.id, name: f.name })));
    fillReportWindow(w, buildReportHtml({ teamTitle: team?.title || '', question, members: ms, synthesis, attachments }));
  }, [activeRunId, history, handleDownloadRun, members, memberOrder, team, question, synthesis, attachedFiles, resolveAttachments]);

  useEffect(() => {
    if (!token) return;
    fetch(`/api/teams/${teamId}`, { headers: authHeaders() })
      .then(r => r.json())
      .then((d: { team: TeamInfo; agents: Agent[] }) => {
        if (!d.team) { router.replace('/assistant'); return; }
        setTeam(d.team);
        const order = d.agents.map(a => a.id);
        setMemberOrder(order);
        const map: Record<string, MemberStream> = {};
        d.agents.forEach(a => { map[a.id] = { name: a.title, icon: a.icon, status: 'pending', text: '', text2: '', inRound2: false }; });
        setMembers(map);
      })
      .catch(() => router.replace('/assistant'));
    fetch(`/api/teams/${teamId}/estimate`, { headers: authHeaders() })
      .then(r => r.json()).then(setEstimate).catch(() => {});
    loadHistory();
  }, [token, teamId, authHeaders, router, loadHistory]);

  // Scheduled / background runs execute server-side with no SSE sink, so we poll
  // the runs list to reflect them live. Poll ALWAYS (not just when something is
  // already in progress) so a run that the scheduler kicks off appears on its own
  // the moment its time arrives; poll faster while a run is in progress so it
  // flips to "done" without a manual refresh. Pause while the tab is hidden.
  const hasInflight = history.some(r => r.status !== 'done' && r.status !== 'error' && r.status !== 'failed');
  useEffect(() => {
    if (!token) return;
    const period = hasInflight ? 3500 : 8000;
    const tick = () => { if (!document.hidden && !running) loadHistory(); };
    const t = setInterval(tick, period);
    const onVisible = () => { if (!document.hidden) loadHistory(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVisible); };
  }, [hasInflight, token, running, loadHistory]);

  const resetRun = useCallback(() => {
    setError(null);
    setActiveRunId(null);
    setSynthesis('');
    setSynthRunning(false);
    setDiscussing(false);
    setTotals(null);
    setMembers(prev => {
      const next: Record<string, MemberStream> = {};
      for (const id of Object.keys(prev)) next[id] = { ...prev[id], status: 'pending', text: '', text2: '', inRound2: false };
      return next;
    });
  }, []);

  const handleAttach = useCallback(async (fileList: FileList | null) => {
    if (!fileList || !fileList.length || !token) return;
    // Images over 5MB are skipped by the team's vision reader — warn up front
    // instead of letting the upload look successful but go unanalysed.
    const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
    const tooBig = Array.from(fileList).filter(f => f.type.startsWith('image/') && f.size > MAX_IMAGE_BYTES);
    setImageWarn(tooBig.length
      ? `圖片「${tooBig.map(f => f.name).join('、')}」超過 5MB，團隊將無法分析此圖片內容，請壓縮後再上傳。`
      : null);
    setUploadingFile(true);
    try {
      const formData = new FormData();
      for (const f of Array.from(fileList)) formData.append('files', f);
      const resp = await fetch('/api/uploads', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: formData });
      const data = await resp.json();
      if (resp.ok) {
        const ok = (data.uploads || [])
          .filter((u: any) => u.scanStatus !== 'rejected')
          .map((u: any) => ({ id: u.id, name: u.originalName }));
        setAttachedFiles(prev => [...prev, ...ok]);
      }
    } catch { /* ignore */ } finally {
      setUploadingFile(false);
    }
  }, [token]);

  const handleRun = useCallback(async () => {
    if (!question.trim() || running || !token) return;
    resetRun();
    setRunning(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch(`${SSE_BASE}/api/teams/${teamId}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          message: question.trim(),
          ...(attachedFiles.length ? { uploadIds: attachedFiles.map(f => f.id) } : {}),
          allowWeb,
        }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let ev: { type: string; data?: any };
          try { ev = JSON.parse(line.slice(6)); } catch { continue; }
          handleEvent(ev);
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError((err as Error).message);
    } finally {
      setRunning(false);
      setSynthRunning(false);
      // Adopt the just-finished run (newest) so share/download up front act on it.
      const runs = await loadHistory();
      if (runs[0]) setActiveRunId(runs[0].id);
    }
  }, [question, running, token, teamId, authHeaders, resetRun, loadHistory, attachedFiles, allowWeb]);

  function handleEvent(ev: { type: string; data?: any }) {
    const d = ev.data || {};
    switch (ev.type) {
      case 'member_status':
        setMembers(prev => prev[d.memberId] ? { ...prev, [d.memberId]: { ...prev[d.memberId], status: d.status } } : prev);
        break;
      case 'member_stream':
        setMembers(prev => {
          const m = prev[d.memberId];
          if (!m) return prev;
          return m.inRound2
            ? { ...prev, [d.memberId]: { ...m, text2: m.text2 + d.content } }
            : { ...prev, [d.memberId]: { ...m, text: m.text + d.content } };
        });
        break;
      case 'member_round2':
        setMembers(prev => prev[d.memberId] ? { ...prev, [d.memberId]: { ...prev[d.memberId], inRound2: true, status: 'responding' } } : prev);
        break;
      case 'member_done':
        setMembers(prev => prev[d.memberId] ? { ...prev, [d.memberId]: { ...prev[d.memberId], status: d.status === 'failed' ? 'failed' : 'done' } } : prev);
        break;
      case 'discussion_start':
        setDiscussing(true);
        break;
      case 'synthesis_status':
        setDiscussing(false);
        setSynthRunning(true);
        break;
      case 'synthesis_stream':
        setSynthesis(prev => prev + (d.content || ''));
        break;
      case 'synthesis_done':
        setSynthRunning(false);
        if (d.result) setSynthesis(d.result);
        break;
      case 'team_run_done':
        setTotals({ inputTokens: d.inputTokens, outputTokens: d.outputTokens, costUsd: d.costUsd });
        break;
      case 'error':
        setError(typeof d === 'string' ? d : d.error || '發生錯誤');
        break;
    }
  }

  const loadPastRun = (run: RunRow) => {
    setError(null);
    setActiveRunId(run.id);
    // Still running in the background (scheduled / 立即測試) — no stored result yet.
    const inflight = run.status !== 'done' && run.status !== 'error' && run.status !== 'failed';
    if (inflight && !run.result) {
      setSynthesis('**此排程正在背景伺服器執行中**\n\n排程與「立即測試」是在伺服器背景跑的，無法即時逐字觀看。完成後這裡會自動顯示完整結果（畫面會自動刷新，不用手動重整），並寄到你設定的信箱。\n\n若想**即時觀看**整個協作過程，請直接在上方輸入議題、按執行鍵——那是前景即時串流模式。');
      setSynthRunning(false);
      setTotals(null);
      setQuestion(run.question);
      setMembers({}); setMemberOrder([]);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    setSynthesis(run.result || '');
    setSynthRunning(false);
    setTotals({ inputTokens: run.input_tokens, outputTokens: run.output_tokens, costUsd: Math.round(calcCostUsd(run.input_tokens, run.output_tokens) * 100) / 100 });
    setQuestion(run.question);
    let outs: Array<{ memberId: string; name: string; icon: string | null; text: string; text2?: string }> = [];
    try { outs = JSON.parse(run.member_outputs || '[]'); } catch { /* ignore */ }
    const map: Record<string, MemberStream> = {};
    const order: string[] = [];
    outs.forEach(o => { map[o.memberId] = { name: o.name, icon: o.icon, status: 'done', text: o.text, text2: o.text2 || '', inRound2: false }; order.push(o.memberId); });
    if (order.length) { setMembers(map); setMemberOrder(order); }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  if (!team) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface-container-lowest">
        <span className="material-symbols-outlined animate-spin text-primary text-4xl">progress_activity</span>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface-container-lowest">
      <Navbar />
      {runDeleteTarget && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={() => setRunDeleteTarget(null)}>
          <div className="bg-surface-container-lowest rounded-2xl shadow-2xl w-full max-w-sm p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-xl bg-error/10 flex items-center justify-center shrink-0">
                <span className="material-symbols-outlined text-error">delete</span>
              </div>
              <div className="min-w-0">
                <h3 className="text-base font-headline font-bold text-on-surface">刪除這筆協作紀錄？</h3>
                <p className="text-xs text-on-surface-variant truncate">{runDeleteTarget.question}</p>
              </div>
            </div>
            <p className="text-sm text-on-surface-variant mb-5">刪除後無法復原。</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setRunDeleteTarget(null)} className="px-4 py-2 rounded-xl text-sm font-bold text-on-surface-variant hover:bg-surface-container-high transition-colors cursor-pointer">取消</button>
              <button onClick={handleDeleteRun} className="px-4 py-2 rounded-xl text-sm font-bold text-on-primary bg-error hover:brightness-110 transition-all cursor-pointer">刪除</button>
            </div>
          </div>
        </div>
      )}
      {shareUrl && (
        <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={() => setShareUrl(null)}>
          <div className="bg-surface-container-lowest rounded-2xl shadow-2xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                <span className="material-symbols-outlined text-primary">share</span>
              </div>
              <div className="min-w-0">
                <h3 className="text-base font-headline font-bold text-on-surface">分享這次協作</h3>
                <p className="text-xs text-on-surface-variant">任何人開啟此連結皆可唯讀檢視</p>
              </div>
            </div>
            <div className="flex items-center gap-2 mb-5">
              <input readOnly value={shareUrl} onFocus={e => e.currentTarget.select()}
                className="flex-1 min-w-0 bg-surface-container border border-outline-variant/30 rounded-xl px-3 py-2.5 text-sm text-on-surface focus:outline-none focus:border-primary" />
              <button onClick={async () => { try { await navigator.clipboard.writeText(shareUrl); setCopied(true); } catch { /* ignore */ } }}
                className="shrink-0 px-3 py-2.5 rounded-xl text-sm font-bold text-on-primary cyber-gradient hover:brightness-110 transition-all cursor-pointer flex items-center gap-1.5">
                <span className="material-symbols-outlined text-[18px]">{copied ? 'check' : 'content_copy'}</span>
                {copied ? '已複製' : '複製'}
              </button>
            </div>
            <div className="flex justify-end gap-2">
              <a href={shareUrl} target="_blank" rel="noopener noreferrer" className="px-4 py-2 rounded-xl text-sm font-bold text-primary hover:bg-primary/10 transition-colors cursor-pointer no-underline flex items-center gap-1">
                <span className="material-symbols-outlined text-[18px]">open_in_new</span>開啟預覽
              </a>
              <button onClick={() => setShareUrl(null)} className="px-4 py-2 rounded-xl text-sm font-bold text-on-surface-variant hover:bg-surface-container-high transition-colors cursor-pointer">關閉</button>
            </div>
          </div>
        </div>
      )}
      {expanded && (
        <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/50 backdrop-blur-sm p-2 md:p-4" onClick={() => setExpanded(null)}>
          <div className="bg-surface-container-lowest rounded-2xl shadow-2xl w-full max-w-3xl max-h-[92vh] md:max-h-[88vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 p-4 border-b border-outline-variant/10 shrink-0">
              <div className="w-9 h-9 rounded-lg cyber-gradient flex items-center justify-center shrink-0">
                <span className="material-symbols-outlined text-on-primary text-lg">{expanded.icon}</span>
              </div>
              <h3 className="font-headline font-bold text-on-surface flex-1 truncate">{expanded.title}</h3>
              <button onClick={() => setExpanded(null)} className="w-8 h-8 flex items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container-high transition-colors cursor-pointer shrink-0">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            <div className="p-4 md:p-6 overflow-y-auto text-sm text-on-surface leading-relaxed">
              <TeamMarkdown>{expanded.text}</TeamMarkdown>
            </div>
          </div>
        </div>
      )}

      <main className={`${sidebarMargin} md:pt-10 pb-16 px-4 md:px-10 transition-all duration-300`}>
        {/* Header */}
        <div className="mt-4 md:mt-0 mb-6 flex items-center gap-3">
          <Link href="/assistant" className="w-9 h-9 flex items-center justify-center rounded-lg text-on-surface-variant hover:bg-surface-container transition-colors no-underline">
            <span className="material-symbols-outlined">arrow_back</span>
          </Link>
          <div className="w-11 h-11 rounded-xl cyber-gradient flex items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-on-primary text-xl">{team.icon || 'groups'}</span>
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="font-headline text-xl md:text-2xl font-bold text-on-surface truncate">{team.title} · 團隊協作</h1>
            <p className="text-xs text-on-surface-variant">{memberOrder.length} 位助手協作分析，最後給你一份統整結論</p>
          </div>
          {total && total.count > 0 && (
            <span className="shrink-0 hidden lg:inline-flex items-center gap-1.5 text-xs text-tertiary bg-tertiary/10 px-3 py-1.5 rounded-full">
              <span className="material-symbols-outlined text-[15px]">payments</span>
              已協作 {total.count} 次 · 累計 {(total.inputTokens + total.outputTokens).toLocaleString()} tokens · ${total.costUsd}
            </span>
          )}
          {!isPanjit && (
            <Link href={`/team/${teamId}/schedules`} title="排程管理"
              className="shrink-0 flex items-center gap-1.5 px-3 h-9 rounded-lg text-sm font-bold border border-outline-variant/30 text-on-surface hover:border-primary/50 hover:text-primary transition-colors cursor-pointer no-underline">
              <span className="material-symbols-outlined text-[18px]">schedule</span>
              <span className="hidden md:inline">排程</span>
            </Link>
          )}
        </div>

        {/* Question input */}
        <div className="mb-6">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={e => { handleAttach(e.target.files); e.target.value = ''; }}
          />
          {showWebWarn && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setShowWebWarn(false)}>
              <div className="bg-surface rounded-2xl shadow-xl max-w-sm w-full p-5" onClick={e => e.stopPropagation()}>
                <div className="flex items-center gap-2 mb-3">
                  <span className="material-symbols-outlined text-primary">public</span>
                  <h3 className="font-semibold text-on-surface">開啟上網查找？</h3>
                </div>
                <p className="text-sm text-on-surface-variant leading-relaxed mb-4">
                  開啟後，團隊除了分析你上傳的檔案，也會<span className="text-error font-semibold">連上網路查資料</span>。網路查到的資料會標明來源、並與你的檔案資料分開呈現，不會混進你的檔案數字。
                  <br /><br />
                  若你的檔案屬於<span className="text-error font-semibold">機密／內部資料</span>，建議維持「只看檔案」，<span className="text-error font-semibold">避免資料外傳</span>。
                </p>
                <div className="flex justify-end gap-2">
                  <button onClick={() => setShowWebWarn(false)} className="px-4 py-2 rounded-full text-sm text-on-surface-variant hover:bg-surface-container transition-colors">取消</button>
                  <button onClick={() => { setAllowWeb(true); setShowWebWarn(false); }} className="px-4 py-2 rounded-full text-sm bg-primary text-on-primary font-medium hover:bg-primary/90 transition-colors">確定開啟</button>
                </div>
              </div>
            </div>
          )}
          {(attachedFiles.length > 0 || uploadingFile) && (
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              {attachedFiles.map(f => (
                <span key={f.id} className="inline-flex items-center gap-1.5 bg-surface-container-high rounded-lg pl-2 pr-1 py-1 text-xs text-on-surface">
                  <span className="material-symbols-outlined text-[15px] text-primary">description</span>
                  <span className="truncate max-w-[180px]">{f.name}</span>
                  <button onClick={() => { setAttachedFiles(prev => prev.filter(x => x.id !== f.id)); setImageWarn(null); }} className="text-on-surface-variant hover:bg-surface-container-highest rounded p-0.5" title="移除">
                    <span className="material-symbols-outlined text-[14px]">close</span>
                  </button>
                </span>
              ))}
              {uploadingFile && (
                <span className="text-xs text-on-surface-variant inline-flex items-center gap-1">
                  <span className="material-symbols-outlined text-[14px] animate-spin">progress_activity</span>上傳中…
                </span>
              )}
            </div>
          )}
          {imageWarn && (
            <div className="mb-2 flex items-start gap-1.5 text-xs text-error">
              <span className="material-symbols-outlined text-[15px] shrink-0">warning</span>
              <span className="leading-relaxed">{imageWarn}</span>
            </div>
          )}
          <div
            className={`relative flex flex-col bg-surface-container rounded-2xl ring-1 transition-shadow ${isDragging ? 'ring-2 ring-primary' : 'ring-transparent focus-within:ring-primary/30'}`}
            onDragEnter={e => { e.preventDefault(); e.stopPropagation(); dragCounter.current++; setIsDragging(true); }}
            onDragOver={e => { e.preventDefault(); e.stopPropagation(); }}
            onDragLeave={e => { e.preventDefault(); e.stopPropagation(); dragCounter.current--; if (dragCounter.current <= 0) { dragCounter.current = 0; setIsDragging(false); } }}
            onDrop={e => { e.preventDefault(); e.stopPropagation(); dragCounter.current = 0; setIsDragging(false); if (e.dataTransfer.files.length > 0) handleAttach(e.dataTransfer.files); }}
          >
            {isDragging && (
              <div className="absolute inset-0 z-10 rounded-2xl border-2 border-dashed border-primary bg-primary/5 flex items-center justify-center pointer-events-none">
                <span className="text-sm text-primary font-medium inline-flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-[18px]">upload_file</span>放開以上傳檔案
                </span>
              </div>
            )}
            <textarea
              value={question}
              onChange={e => setQuestion(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); handleRun(); } }}
              disabled={running}
              placeholder="輸入要這個團隊一起分析的議題或問題…"
              rows={3}
              className="w-full bg-transparent border-none outline-none focus:ring-0 resize-none pt-3 px-4 pb-2 text-sm text-on-surface placeholder:text-outline min-h-[88px] max-h-[220px] leading-snug"
            />
            {/* Toolbar row below the textarea — its own flex row so it can never cover the text */}
            <div className="flex items-center gap-0.5 px-2.5 pt-1 pb-2.5">
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={running || uploadingFile}
                title="附加檔案讓團隊依據檔案分析"
                className="w-9 h-9 rounded-full flex items-center justify-center text-on-surface-variant hover:bg-surface-container-high disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <span className="material-symbols-outlined text-[20px]">attach_file</span>
              </button>
              <button
                onClick={() => { if (!allowWeb && hasFiles) setShowWebWarn(true); else setAllowWeb(v => !v); }}
                disabled={running}
                title={allowWeb ? '上網查找：開啟（按一下關閉）' : '上網查找：關閉（按一下開啟）'}
                className={`w-9 h-9 rounded-full flex items-center justify-center transition-colors disabled:opacity-40 ${allowWeb ? 'bg-primary/15 text-primary' : 'text-on-surface-variant hover:bg-surface-container-high'}`}
              >
                <span className="material-symbols-outlined text-[20px]">{allowWeb ? 'public' : 'public_off'}</span>
              </button>
              <button
                onClick={handleRun}
                disabled={running || !question.trim()}
                title="跑團隊分析（⌘ / Ctrl + Enter）"
                className="ml-auto w-9 h-9 cyber-gradient rounded-full flex items-center justify-center text-on-primary disabled:opacity-40 disabled:cursor-not-allowed active:scale-95 transition-all"
              >
                <span className={`material-symbols-outlined text-[20px] ${running ? 'animate-spin' : ''}`}>{running ? 'progress_activity' : 'play_arrow'}</span>
              </button>
            </div>
          </div>
          <div className="flex items-center gap-1.5 mt-2 px-1 text-xs text-on-surface-variant">
            <span className="material-symbols-outlined text-[14px] text-primary">bolt</span>
            <span>{running ? '協作分析中…' : (estimate ? `預估 ~${(estimate.inputTokens + estimate.outputTokens).toLocaleString()} tokens · 約 $${estimate.costUsd}` : ' ')}</span>
            <span className="ml-auto text-outline hidden sm:inline">⌘ / Ctrl + Enter 送出</span>
          </div>
          {history.length > 0 && !running && (
            <p className="mt-1.5 px-1 text-xs text-tertiary flex items-center gap-1">
              <span className="material-symbols-outlined text-[14px]">psychology</span>
              團隊會記得先前的協作結論，可直接接續提問
            </p>
          )}
        </div>

        {error && (
          <div className="flex items-center gap-2 p-3 mb-6 rounded-xl bg-error/5 border border-error/20 text-sm text-error">
            <span className="material-symbols-outlined text-base">error</span>{error}
          </div>
        )}

        {discussing && (
          <div className="flex items-center gap-2 p-3 mb-4 rounded-xl bg-tertiary/5 border border-tertiary/20 text-sm text-tertiary">
            <span className="material-symbols-outlined text-base animate-pulse">forum</span>
            第二輪：成員正在互相討論、回應彼此的觀點…
          </div>
        )}

        {/* Member streams */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4 mb-6">
          {memberOrder.map(id => {
            const m = members[id];
            if (!m) return null;
            const meta = STATUS_META[m.status];
            return (
              <div key={id} className="flex flex-col bg-surface-container rounded-2xl border border-outline-variant/10 overflow-hidden">
                <div className="flex items-center gap-2 p-3 border-b border-outline-variant/10">
                  <div className="w-8 h-8 rounded-lg cyber-gradient flex items-center justify-center shrink-0">
                    <span className="material-symbols-outlined text-on-primary text-base">{m.icon || 'smart_toy'}</span>
                  </div>
                  <span className="text-sm font-bold text-on-surface truncate flex-1">{m.name}</span>
                  <span className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full ${meta.cls}`}>
                    <span className={`material-symbols-outlined text-[13px] ${meta.spin ? 'animate-spin' : ''}`}>{meta.icon}</span>
                    {meta.label}
                  </span>
                  {m.text && (
                    <button onClick={() => setExpanded({ title: m.name, icon: m.icon || 'smart_toy', text: m.text + (m.text2 ? `\n\n---\n\n**回應其他成員**\n\n${m.text2}` : '') })}
                      className="w-5 h-5 flex items-center justify-center rounded text-on-surface-variant hover:text-primary hover:bg-primary/10 transition-colors cursor-pointer shrink-0" title="放大檢視">
                      <span className="material-symbols-outlined text-[14px]">open_in_full</span>
                    </button>
                  )}
                </div>
                {/* Body — pending members stay compact (header only). On mobile
                    we show a short preview + "查看完整分析"; desktop keeps the
                    scrollable card so the 4-column grid stays uniform. */}
                {(m.text || m.text2 || m.status !== 'pending') && (
                  <div className="relative">
                    <div className="p-3 text-xs text-on-surface-variant leading-relaxed max-h-40 overflow-hidden md:max-h-72 md:overflow-y-auto min-h-[56px]">
                      {m.text
                        ? <TeamMarkdown>{m.text}</TeamMarkdown>
                        : <span className="text-outline italic">分析中…</span>}
                      {m.text2 && (
                        <div className="mt-3 rounded-lg bg-tertiary/5 border border-tertiary/15 p-2.5">
                          <div className="flex items-center gap-1 text-[11px] font-bold text-tertiary mb-1.5">
                            <span className="material-symbols-outlined text-[13px]">forum</span>回應其他成員
                          </div>
                          <TeamMarkdown>{m.text2}</TeamMarkdown>
                        </div>
                      )}
                    </div>
                    {m.text && (
                      <button onClick={() => setExpanded({ title: m.name, icon: m.icon || 'smart_toy', text: m.text + (m.text2 ? `\n\n---\n\n**回應其他成員**\n\n${m.text2}` : '') })}
                        className="md:hidden relative w-full flex items-center justify-center gap-1 py-2 text-xs font-bold text-primary border-t border-outline-variant/10 bg-surface-container cursor-pointer">
                        <span className="pointer-events-none absolute -top-7 inset-x-0 h-7 bg-gradient-to-t from-surface-container to-transparent" />
                        查看完整分析<span className="material-symbols-outlined text-[15px]">open_in_full</span>
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Synthesis */}
        {(synthesis || synthRunning) && (
          <div className="bg-surface-container rounded-2xl border border-primary/30 overflow-hidden mb-6">
            <div className="flex items-center gap-2 p-3.5 border-b border-outline-variant/10 bg-primary/5">
              <span className="material-symbols-outlined text-primary">hub</span>
              <span className="font-headline font-bold text-on-surface">協調者統整</span>
              {synthRunning && <span className="material-symbols-outlined animate-spin text-primary text-base ml-1">progress_activity</span>}
              {totals && <span className="ml-auto text-xs text-on-surface-variant">實際 {(totals.inputTokens + totals.outputTokens).toLocaleString()} tokens · ${totals.costUsd}</span>}
              {synthesis && (
                <div className={`flex items-center gap-1 shrink-0 ${totals ? 'ml-1' : 'ml-auto'}`}>
                  <button onClick={handleDownloadCurrent}
                    className="w-7 h-7 flex items-center justify-center rounded text-on-surface-variant hover:text-primary hover:bg-primary/10 transition-colors cursor-pointer" title="下載報告（PDF）">
                    <span className="material-symbols-outlined text-[18px]">download</span>
                  </button>
                  {activeRunId && (
                    <button onClick={() => handleShareRun({ id: activeRunId } as RunRow)}
                      className="w-7 h-7 flex items-center justify-center rounded text-on-surface-variant hover:text-primary hover:bg-primary/10 transition-colors cursor-pointer" title="分享（唯讀）">
                      <span className="material-symbols-outlined text-[18px]">share</span>
                    </button>
                  )}
                  <button onClick={() => setExpanded({ title: '協調者統整', icon: 'hub', text: synthesis })}
                    className="w-7 h-7 flex items-center justify-center rounded text-on-surface-variant hover:text-primary hover:bg-primary/10 transition-colors cursor-pointer" title="放大檢視">
                    <span className="material-symbols-outlined text-[18px]">open_in_full</span>
                  </button>
                </div>
              )}
            </div>
            <div className="p-5 text-sm text-on-surface leading-relaxed">
              <TeamMarkdown>{synthesis || '統整中…'}</TeamMarkdown>
            </div>
          </div>
        )}

        {/* History */}
        {history.length > 0 && (
          <div className="mt-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-on-surface-variant mb-3">歷史協作</h3>
            <div className="space-y-2">
              {history.map(run => (
                <div key={run.id}
                  className="w-full flex items-center gap-2 p-3 rounded-xl border border-outline-variant/15 bg-surface-container hover:border-primary/40 transition-colors">
                  <button onClick={() => loadPastRun(run)} className="flex items-center gap-3 flex-1 min-w-0 text-left cursor-pointer">
                    <span className="material-symbols-outlined text-on-surface-variant shrink-0">{run.schedule_id ? 'schedule' : 'history'}</span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm text-on-surface truncate">{run.question}</span>
                      <span className="flex items-center gap-1.5 text-xs text-on-surface-variant flex-wrap">
                        <span>{new Date(run.created_at).toLocaleString()} · {(run.input_tokens + run.output_tokens).toLocaleString()} tokens</span>
                        {run.schedule_id && (
                          <span className={`px-1.5 py-0.5 rounded-full ${run.emailed === 1 ? 'bg-success/10 text-success' : run.emailed === 0 ? 'bg-error/10 text-error' : 'bg-tertiary/10 text-tertiary'}`}>
                            <span className="material-symbols-outlined text-[12px] align-middle">schedule</span> 排程{run.emailed === 1 ? ' · 已寄送' : run.emailed === 0 ? ' · 寄送失敗' : ''}
                          </span>
                        )}
                      </span>
                    </span>
                  </button>
                  {run.status !== 'done' && run.status !== 'error' && run.status !== 'failed'
                    ? <span className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-primary/10 text-primary shrink-0">
                        <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />背景執行中
                      </span>
                    : run.status !== 'done' && <span className="text-[11px] px-2 py-0.5 rounded-full bg-error/10 text-error shrink-0">{run.status}</span>}
                  {run.status === 'done' && (
                    <button onClick={() => handleDownloadRun(run)} title="下載報告（PDF）"
                      className="w-8 h-8 flex items-center justify-center rounded-lg text-on-surface-variant hover:text-primary hover:bg-primary/10 transition-colors cursor-pointer shrink-0">
                      <span className="material-symbols-outlined text-[18px]">download</span>
                    </button>
                  )}
                  <button onClick={() => handleShareRun(run)} title="分享（唯讀）"
                    className="w-8 h-8 flex items-center justify-center rounded-lg text-on-surface-variant hover:text-primary hover:bg-primary/10 transition-colors cursor-pointer shrink-0">
                    <span className="material-symbols-outlined text-[18px]">share</span>
                  </button>
                  <button onClick={() => setRunDeleteTarget(run)} title="刪除此協作紀錄"
                    className="w-8 h-8 flex items-center justify-center rounded-lg text-on-surface-variant hover:text-error hover:bg-error/10 transition-colors cursor-pointer shrink-0">
                    <span className="material-symbols-outlined text-[18px]">delete</span>
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default function TeamRunPage() {
  return (
    <AuthProvider>
      <TeamRunWithI18n />
    </AuthProvider>
  );
}

function TeamRunWithI18n() {
  const { user } = useAuth();
  return (
    <I18nProvider initialLocale={user?.locale} initialTheme={user?.theme}>
      <TeamRunContent />
    </I18nProvider>
  );
}
