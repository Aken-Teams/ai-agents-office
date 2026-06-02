'use client';

/**
 * Team collaboration run view. The user poses a topic, the team's members each
 * analyse it live (coordinator fan-out), then the coordinator synthesises a
 * final answer. Consumes the SSE stream from POST /api/teams/:id/run.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AuthProvider, useAuth } from '../../components/AuthProvider';
import { I18nProvider } from '../../../i18n';
import Navbar from '../../components/Navbar';
import { useSidebarMargin } from '../../hooks/useSidebarCollapsed';

const SSE_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

// Reuse the chat page's visualization components for chart code fences.
const ChatChart = dynamic(() => import('../../components/charts/ChatChart'), { ssr: false });
const ChatEChart = dynamic(() => import('../../components/charts/ChatEChart'), { ssr: false });
const ChatMermaid = dynamic(() => import('../../components/charts/ChatMermaid'), { ssr: false });
const ChatMindmap = dynamic(() => import('../../components/charts/ChatMindmap'), { ssr: false });
const ChatMap = dynamic(() => import('../../components/charts/ChatMap'), { ssr: false });

interface Agent { id: string; title: string; icon: string | null; skill_id: string | null }
interface TeamInfo { id: string; title: string; topic: string | null; icon: string | null }
interface Estimate { memberCount: number; inputTokens: number; outputTokens: number; costUsd: number }
interface RunRow { id: string; question: string; result: string | null; member_outputs: string | null; input_tokens: number; output_tokens: number; status: string; created_at: string }

type MemberStatus = 'pending' | 'running' | 'done' | 'failed';
interface MemberStream { name: string; icon: string | null; status: MemberStatus; text: string }

const STATUS_META: Record<MemberStatus, { label: string; cls: string; icon: string; spin?: boolean }> = {
  pending: { label: '等待中', cls: 'text-on-surface-variant bg-surface-container-high', icon: 'schedule' },
  running: { label: '分析中', cls: 'text-primary bg-primary/10', icon: 'progress_activity', spin: true },
  done:    { label: '完成',   cls: 'text-success bg-success/10', icon: 'check_circle' },
  failed:  { label: '失敗',   cls: 'text-error bg-error/10', icon: 'error' },
};

// Markdown rendering styled to match the rest of the app (headings, lists,
// tables, bold). Used for both member analyses and the coordinator synthesis.
const mdComponents: Record<string, any> = {
  h1: ({ children }: any) => <h1 className="text-[15px] font-bold text-on-surface mt-3 mb-1.5 first:mt-0">{children}</h1>,
  h2: ({ children }: any) => <h2 className="text-sm font-bold text-on-surface mt-3 mb-1.5 first:mt-0">{children}</h2>,
  h3: ({ children }: any) => <h3 className="text-sm font-semibold text-on-surface mt-2 mb-1 first:mt-0">{children}</h3>,
  p:  ({ children }: any) => <p className="mb-2 last:mb-0 leading-relaxed">{children}</p>,
  ul: ({ children }: any) => <ul className="list-disc pl-5 mb-2 space-y-1">{children}</ul>,
  ol: ({ children }: any) => <ol className="list-decimal pl-5 mb-2 space-y-1">{children}</ol>,
  li: ({ children }: any) => <li className="leading-relaxed">{children}</li>,
  strong: ({ children }: any) => <strong className="font-bold text-on-surface">{children}</strong>,
  em: ({ children }: any) => <em className="italic">{children}</em>,
  hr: () => <hr className="my-3 border-outline-variant/15" />,
  blockquote: ({ children }: any) => <blockquote className="border-l-2 border-primary/30 pl-3 my-2 text-on-surface-variant">{children}</blockquote>,
  a: ({ children, href }: any) => <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{children}</a>,
  pre: ({ children }: any) => <>{children}</>,
  code: ({ className, children }: any) => {
    const text = String(children).replace(/\n$/, '');
    if (className === 'language-chart') return <ChatChart rawJson={text} />;
    if (className === 'language-echart') return <ChatEChart rawJson={text} />;
    if (className === 'language-mermaid') return <ChatMermaid code={text} />;
    if (className === 'language-mindmap') return <ChatMindmap code={text} />;
    if (className === 'language-map') return <ChatMap rawJson={text} />;
    return <code className="px-1 py-0.5 rounded bg-surface-container-high text-[0.9em] font-mono">{children}</code>;
  },
  table: ({ children }: any) => <div className="overflow-x-auto my-2 rounded-lg border border-outline-variant/20"><table className="w-full text-xs border-collapse">{children}</table></div>,
  thead: ({ children }: any) => <thead className="bg-surface-container-high">{children}</thead>,
  th: ({ children }: any) => <th className="text-left px-2 py-1.5 font-semibold text-on-surface border-b border-outline-variant/20">{children}</th>,
  td: ({ children }: any) => <td className="px-2 py-1.5 align-top border-b border-outline-variant/10">{children}</td>,
};

function TeamRunContent() {
  const { token } = useAuth();
  const router = useRouter();
  const params = useParams();
  const teamId = String(params.id);
  const sidebarMargin = useSidebarMargin();

  const [team, setTeam] = useState<TeamInfo | null>(null);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [question, setQuestion] = useState('');
  const [running, setRunning] = useState(false);
  const [members, setMembers] = useState<Record<string, MemberStream>>({});
  const [memberOrder, setMemberOrder] = useState<string[]>([]);
  const [synthesis, setSynthesis] = useState('');
  const [synthRunning, setSynthRunning] = useState(false);
  const [totals, setTotals] = useState<{ inputTokens: number; outputTokens: number; costUsd: number } | null>(null);
  const [history, setHistory] = useState<RunRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [runDeleteTarget, setRunDeleteTarget] = useState<RunRow | null>(null);
  const [discussing, setDiscussing] = useState(false);
  const [expanded, setExpanded] = useState<{ title: string; icon: string; text: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const authHeaders = useCallback((): HeadersInit => (token ? { Authorization: `Bearer ${token}` } : {}), [token]);

  const loadHistory = useCallback(() => {
    fetch(`/api/teams/${teamId}/runs`, { headers: authHeaders() })
      .then(r => r.json()).then(d => setHistory(Array.isArray(d.runs) ? d.runs : [])).catch(() => {});
  }, [teamId, authHeaders]);

  const handleDeleteRun = useCallback(async () => {
    if (!runDeleteTarget) return;
    await fetch(`/api/teams/${teamId}/runs/${runDeleteTarget.id}`, { method: 'DELETE', headers: authHeaders() });
    setRunDeleteTarget(null);
    loadHistory();
  }, [runDeleteTarget, teamId, authHeaders, loadHistory]);

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
        d.agents.forEach(a => { map[a.id] = { name: a.title, icon: a.icon, status: 'pending', text: '' }; });
        setMembers(map);
      })
      .catch(() => router.replace('/assistant'));
    fetch(`/api/teams/${teamId}/estimate`, { headers: authHeaders() })
      .then(r => r.json()).then(setEstimate).catch(() => {});
    loadHistory();
  }, [token, teamId, authHeaders, router, loadHistory]);

  const resetRun = useCallback(() => {
    setError(null);
    setSynthesis('');
    setSynthRunning(false);
    setDiscussing(false);
    setTotals(null);
    setMembers(prev => {
      const next: Record<string, MemberStream> = {};
      for (const id of Object.keys(prev)) next[id] = { ...prev[id], status: 'pending', text: '' };
      return next;
    });
  }, []);

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
        body: JSON.stringify({ message: question.trim() }),
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
      loadHistory();
    }
  }, [question, running, token, teamId, authHeaders, resetRun, loadHistory]);

  function handleEvent(ev: { type: string; data?: any }) {
    const d = ev.data || {};
    switch (ev.type) {
      case 'member_status':
        setMembers(prev => prev[d.memberId] ? { ...prev, [d.memberId]: { ...prev[d.memberId], status: d.status } } : prev);
        break;
      case 'member_stream':
        setMembers(prev => prev[d.memberId] ? { ...prev, [d.memberId]: { ...prev[d.memberId], text: prev[d.memberId].text + d.content } } : prev);
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
    setSynthesis(run.result || '');
    setSynthRunning(false);
    setTotals({ inputTokens: run.input_tokens, outputTokens: run.output_tokens, costUsd: Math.round(((run.input_tokens / 1e6) * 3 + (run.output_tokens / 1e6) * 15) * 10 * 100) / 100 });
    setQuestion(run.question);
    let outs: Array<{ memberId: string; name: string; icon: string | null; text: string }> = [];
    try { outs = JSON.parse(run.member_outputs || '[]'); } catch { /* ignore */ }
    const map: Record<string, MemberStream> = {};
    const order: string[] = [];
    outs.forEach(o => { map[o.memberId] = { name: o.name, icon: o.icon, status: 'done', text: o.text }; order.push(o.memberId); });
    if (order.length) { setMembers(map); setMemberOrder(order); }
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
      <main className={`${sidebarMargin} md:pt-10 pb-16 px-4 md:px-10 transition-all duration-300`}>
        {/* Header */}
        <div className="mt-4 md:mt-0 mb-6 flex items-center gap-3">
          <Link href="/assistant" className="w-9 h-9 flex items-center justify-center rounded-lg text-on-surface-variant hover:bg-surface-container transition-colors no-underline">
            <span className="material-symbols-outlined">arrow_back</span>
          </Link>
          <div className="w-11 h-11 rounded-xl cyber-gradient flex items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-on-primary text-xl">{team.icon || 'groups'}</span>
          </div>
          <div className="min-w-0">
            <h1 className="font-headline text-xl md:text-2xl font-bold text-on-surface truncate">{team.title} · 團隊協作</h1>
            <p className="text-xs text-on-surface-variant">{memberOrder.length} 位助手協作分析，最後給你一份統整結論</p>
          </div>
        </div>

        {/* Question input */}
        <div className="mb-6">
          <div className="flex items-end gap-2">
            <textarea
              value={question}
              onChange={e => setQuestion(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); handleRun(); } }}
              disabled={running}
              placeholder="輸入要這個團隊一起分析的議題或問題…"
              rows={3}
              className="flex-1 bg-surface-container border-none focus:ring-1 focus:ring-primary/30 rounded-2xl py-3 px-4 text-sm text-on-surface placeholder:text-outline resize-none min-h-[88px] max-h-[200px] leading-snug"
            />
            <button
              onClick={handleRun}
              disabled={running || !question.trim()}
              title="跑團隊分析（⌘ / Ctrl + Enter）"
              className="shrink-0 w-11 h-11 cyber-gradient rounded-full flex items-center justify-center text-on-primary disabled:opacity-40 disabled:cursor-not-allowed active:scale-95 transition-all"
            >
              <span className={`material-symbols-outlined text-[22px] ${running ? 'animate-spin' : ''}`}>{running ? 'progress_activity' : 'play_arrow'}</span>
            </button>
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
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
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
                    <button onClick={() => setExpanded({ title: m.name, icon: m.icon || 'smart_toy', text: m.text })}
                      className="w-6 h-6 flex items-center justify-center rounded text-on-surface-variant hover:text-primary hover:bg-primary/10 transition-colors cursor-pointer shrink-0" title="放大檢視">
                      <span className="material-symbols-outlined text-[16px]">open_in_full</span>
                    </button>
                  )}
                </div>
                <div className="p-3 text-xs text-on-surface-variant leading-relaxed max-h-72 overflow-y-auto min-h-[80px]">
                  {m.text
                    ? <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{m.text}</ReactMarkdown>
                    : (m.status === 'pending' ? null : <span className="text-outline italic">分析中…</span>)}
                </div>
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
              {totals && <span className="ml-auto text-xs text-on-surface-variant">{(totals.inputTokens + totals.outputTokens).toLocaleString()} tokens · ${totals.costUsd}</span>}
              {synthesis && (
                <button onClick={() => setExpanded({ title: '協調者統整', icon: 'hub', text: synthesis })}
                  className={`w-7 h-7 flex items-center justify-center rounded text-on-surface-variant hover:text-primary hover:bg-primary/10 transition-colors cursor-pointer shrink-0 ${totals ? 'ml-1' : 'ml-auto'}`} title="放大檢視">
                  <span className="material-symbols-outlined text-[18px]">open_in_full</span>
                </button>
              )}
            </div>
            <div className="p-5 text-sm text-on-surface leading-relaxed">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{synthesis || '統整中…'}</ReactMarkdown>
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
                    <span className="material-symbols-outlined text-on-surface-variant shrink-0">history</span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm text-on-surface truncate">{run.question}</span>
                      <span className="block text-xs text-on-surface-variant">{new Date(run.created_at).toLocaleString()} · {(run.input_tokens + run.output_tokens).toLocaleString()} tokens</span>
                    </span>
                  </button>
                  {run.status !== 'done' && <span className="text-[11px] px-2 py-0.5 rounded-full bg-warning/10 text-warning shrink-0">{run.status}</span>}
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
