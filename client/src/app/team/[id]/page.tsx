'use client';

/**
 * Team collaboration run view. The user poses a topic, the team's members each
 * analyse it live (coordinator fan-out), then the coordinator synthesises a
 * final answer. Consumes the SSE stream from POST /api/teams/:id/run.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { AuthProvider, useAuth } from '../../components/AuthProvider';
import { I18nProvider } from '../../../i18n';
import Navbar from '../../components/Navbar';
import { useSidebarMargin } from '../../hooks/useSidebarCollapsed';
import TeamMarkdown from '../../components/TeamMarkdown';

const SSE_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

interface Agent { id: string; title: string; icon: string | null; skill_id: string | null }
interface TeamInfo { id: string; title: string; topic: string | null; icon: string | null }
interface Estimate { memberCount: number; inputTokens: number; outputTokens: number; costUsd: number }
interface RunRow { id: string; question: string; result: string | null; member_outputs: string | null; input_tokens: number; output_tokens: number; status: string; created_at: string; share_token: string | null; schedule_id: string | null; emailed: number | null }
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

const DOW = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
interface Schedule { id: string; name: string | null; question: string; frequency: 'daily' | 'weekly'; hour: number; minute: number; day_of_week: number | null; email: string; enabled: number; next_run_at: string }

function ScheduleModal({ teamId, token, defaultEmail, onClose }: { teamId: string; token: string | null; defaultEmail: string; onClose: () => void }) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [name, setName] = useState('');
  const [question, setQuestion] = useState('');
  const [frequency, setFrequency] = useState<'daily' | 'weekly'>('daily');
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [time, setTime] = useState('09:00');
  const [email, setEmail] = useState(defaultEmail);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const headers = (): HeadersInit => (token ? { Authorization: `Bearer ${token}` } : {});

  const load = useCallback(() => {
    fetch(`/api/teams/${teamId}/schedules`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(r => r.json()).then(d => setSchedules(Array.isArray(d.schedules) ? d.schedules : [])).catch(() => {});
  }, [teamId, token]);
  useEffect(() => { load(); }, [load]);

  const add = async () => {
    if (!question.trim() || !email.trim() || saving) return;
    const [h, m] = time.split(':').map(Number);
    setSaving(true);
    try {
      const res = await fetch(`/api/teams/${teamId}/schedules`, {
        method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), question: question.trim(), frequency, hour: h, minute: m, dayOfWeek, email: email.trim() }),
      });
      if (res.ok) { setName(''); setQuestion(''); load(); }
    } finally { setSaving(false); }
  };
  const toggle = async (s: Schedule) => {
    await fetch(`/api/teams/${teamId}/schedules/${s.id}`, { method: 'PATCH', headers: { ...headers(), 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !s.enabled }) });
    load();
  };
  const del = async (s: Schedule) => {
    await fetch(`/api/teams/${teamId}/schedules/${s.id}`, { method: 'DELETE', headers: headers() });
    load();
  };
  const runNow = async (s: Schedule) => {
    setTesting(s.id);
    try {
      await fetch(`/api/teams/${teamId}/schedules/${s.id}/run-now`, { method: 'POST', headers: headers() });
      setToast('已觸發測試執行，約 1 分鐘後完成並寄出，結果會出現在「歷史協作」（含寄送狀態）。');
    } finally { setTesting(null); }
  };
  const fmt = (s: Schedule) => `${s.frequency === 'weekly' && s.day_of_week != null ? DOW[s.day_of_week] : '每天'} ${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}`;

  return (
    <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-surface-container-lowest rounded-2xl shadow-2xl w-full max-w-lg max-h-[88vh] overflow-y-auto p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-1">
          <span className="material-symbols-outlined text-primary">schedule</span>
          <h3 className="text-lg font-headline font-bold text-on-surface">排程寄送</h3>
        </div>
        <p className="text-sm text-on-surface-variant mb-5">設定時間，團隊會自動跑分析、把結果寄到信箱，並記錄在下方「歷史協作」（含寄送狀態）。</p>

        {toast && (
          <div className="flex items-start gap-2.5 p-3 mb-4 rounded-xl border border-primary/30 bg-primary/[0.07] animate-[fadeIn_0.2s_ease-out]">
            <span className="material-symbols-outlined text-primary text-[20px] shrink-0">rocket_launch</span>
            <p className="flex-1 text-sm text-on-surface leading-relaxed">{toast}</p>
            <button onClick={() => setToast(null)} className="text-on-surface-variant hover:text-on-surface cursor-pointer shrink-0">
              <span className="material-symbols-outlined text-[18px]">close</span>
            </button>
          </div>
        )}

        {schedules.length > 0 && (
          <div className="space-y-2 mb-5">
            {schedules.map(s => (
              <div key={s.id} className="flex items-center gap-3 p-3 rounded-xl border border-outline-variant/15 bg-surface-container">
                <span className="material-symbols-outlined text-on-surface-variant shrink-0">{s.enabled ? 'alarm' : 'alarm_off'}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-bold text-on-surface truncate">{s.name || s.question}</div>
                  {s.name && <div className="text-xs text-on-surface-variant truncate">議題：{s.question}</div>}
                  <div className="text-xs text-on-surface-variant truncate">{fmt(s)} · {s.email}</div>
                  {s.enabled
                    ? <div className="text-[11px] text-tertiary">下次：{new Date(s.next_run_at).toLocaleString()}</div>
                    : <div className="text-[11px] text-on-surface-variant/60">已停用</div>}
                </div>
                <button onClick={() => runNow(s)} disabled={testing === s.id} title="立即測試執行（馬上跑一次並寄出）"
                  className="w-7 h-7 flex items-center justify-center rounded-lg text-on-surface-variant hover:text-primary hover:bg-primary/10 transition-colors cursor-pointer shrink-0 disabled:opacity-40">
                  <span className={`material-symbols-outlined text-[18px] ${testing === s.id ? 'animate-spin' : ''}`}>{testing === s.id ? 'progress_activity' : 'play_arrow'}</span>
                </button>
                <button onClick={() => toggle(s)} title={s.enabled ? '停用' : '啟用'}
                  className={`relative w-9 h-5 rounded-full transition-colors shrink-0 cursor-pointer ${s.enabled ? 'bg-primary' : 'bg-outline-variant/40'}`}>
                  <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${s.enabled ? 'translate-x-4' : ''}`} />
                </button>
                <button onClick={() => del(s)} title="刪除" className="w-7 h-7 flex items-center justify-center rounded-lg text-on-surface-variant hover:text-error hover:bg-error/10 transition-colors cursor-pointer shrink-0">
                  <span className="material-symbols-outlined text-[18px]">delete</span>
                </button>
              </div>
            ))}
          </div>
        )}

        <p className="text-[11px] font-bold uppercase tracking-wider text-on-surface-variant/70 mb-2">新增排程</p>
        <label className="block text-xs font-bold text-on-surface-variant mb-1.5">排程名稱<span className="font-normal text-on-surface-variant/60">（給這個排程取個好認的名字）</span></label>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="例如：每日台股盤勢"
          className="w-full bg-surface-container border border-outline-variant/30 rounded-xl px-3 py-2.5 text-sm text-on-surface focus:outline-none focus:border-primary mb-3" />
        <label className="block text-xs font-bold text-on-surface-variant mb-1.5">分析議題 / 需求<span className="font-normal text-on-surface-variant/60">（團隊真正要分析的內容）</span></label>
        <textarea value={question} onChange={e => setQuestion(e.target.value)} rows={2} placeholder="要團隊定期分析的議題，例如：今天的台股盤勢與我持股的風險"
          className="w-full bg-surface-container border border-outline-variant/30 rounded-xl px-3 py-2.5 text-sm text-on-surface resize-none focus:outline-none focus:border-primary mb-3" />
        <div className="flex flex-wrap items-center gap-3 mb-3">
          <div className="flex rounded-lg border border-outline-variant/30 overflow-hidden">
            <button onClick={() => setFrequency('daily')} className={`px-3 py-1.5 text-sm cursor-pointer ${frequency === 'daily' ? 'cyber-gradient text-on-primary' : 'text-on-surface-variant hover:bg-surface-container'}`}>每天</button>
            <button onClick={() => setFrequency('weekly')} className={`px-3 py-1.5 text-sm cursor-pointer ${frequency === 'weekly' ? 'cyber-gradient text-on-primary' : 'text-on-surface-variant hover:bg-surface-container'}`}>每週</button>
          </div>
          {frequency === 'weekly' && (
            <select value={dayOfWeek} onChange={e => setDayOfWeek(Number(e.target.value))}
              className="bg-surface-container border border-outline-variant/30 rounded-lg px-2 py-1.5 text-sm text-on-surface focus:outline-none focus:border-primary cursor-pointer">
              {DOW.map((d, i) => <option key={i} value={i}>{d}</option>)}
            </select>
          )}
          <input type="time" value={time} onChange={e => setTime(e.target.value)}
            className="bg-surface-container border border-outline-variant/30 rounded-lg px-2 py-1.5 text-sm text-on-surface focus:outline-none focus:border-primary" />
        </div>
        <label className="block text-xs font-bold uppercase tracking-wider text-on-surface-variant mb-1.5">收件 Email</label>
        <input value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com"
          className="w-full bg-surface-container border border-outline-variant/30 rounded-xl px-3 py-2.5 text-sm text-on-surface focus:outline-none focus:border-primary mb-5" />

        <div className="flex items-center justify-end gap-2 pt-4 border-t border-outline-variant/15">
          <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-bold text-on-surface-variant hover:bg-surface-container-high transition-colors cursor-pointer">關閉</button>
          <button onClick={add} disabled={!question.trim() || !email.trim() || saving}
            className="px-5 py-2 rounded-xl text-sm font-bold text-on-primary cyber-gradient disabled:opacity-40 disabled:cursor-not-allowed transition-all cursor-pointer flex items-center gap-2">
            {saving && <span className="material-symbols-outlined animate-spin text-base">progress_activity</span>}
            新增排程
          </button>
        </div>
      </div>
    </div>
  );
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
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const authHeaders = useCallback((): HeadersInit => (token ? { Authorization: `Bearer ${token}` } : {}), [token]);

  const loadHistory = useCallback(() => {
    fetch(`/api/teams/${teamId}/runs`, { headers: authHeaders() })
      .then(r => r.json())
      .then(d => { setHistory(Array.isArray(d.runs) ? d.runs : []); setTotal(d.total || null); })
      .catch(() => {});
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

  // Scheduled / background runs execute server-side with no SSE sink. Poll while
  // any run is still in progress so it flips to done (and tokens update) on its own.
  const hasInflight = history.some(r => r.status !== 'done' && r.status !== 'error' && r.status !== 'failed');
  useEffect(() => {
    if (!hasInflight || !token) return;
    const t = setInterval(() => { loadHistory(); }, 4000);
    return () => clearInterval(t);
  }, [hasInflight, token, loadHistory]);

  const resetRun = useCallback(() => {
    setError(null);
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
    // Still running in the background (scheduled / 立即測試) — no stored result yet.
    const inflight = run.status !== 'done' && run.status !== 'error' && run.status !== 'failed';
    if (inflight && !run.result) {
      setSynthesis('⏳ **此排程正在背景伺服器執行中**\n\n排程與「立即測試」是在伺服器背景跑的，無法即時逐字觀看。完成後這裡會自動顯示完整結果（畫面每 4 秒自動刷新），並寄到你設定的信箱。\n\n若想**即時觀看**整個協作過程，請直接在上方輸入議題、按 ▶ 執行——那是前景即時串流模式。');
      setSynthRunning(false);
      setTotals(null);
      setQuestion(run.question);
      setMembers({}); setMemberOrder([]);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    setSynthesis(run.result || '');
    setSynthRunning(false);
    setTotals({ inputTokens: run.input_tokens, outputTokens: run.output_tokens, costUsd: Math.round(((run.input_tokens / 1e6) * 3 + (run.output_tokens / 1e6) * 15) * 10 * 100) / 100 });
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
        <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={() => setExpanded(null)}>
          <div className="bg-surface-container-lowest rounded-2xl shadow-2xl w-full max-w-3xl max-h-[88vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 p-4 border-b border-outline-variant/10 shrink-0">
              <div className="w-9 h-9 rounded-lg cyber-gradient flex items-center justify-center shrink-0">
                <span className="material-symbols-outlined text-on-primary text-lg">{expanded.icon}</span>
              </div>
              <h3 className="font-headline font-bold text-on-surface flex-1 truncate">{expanded.title}</h3>
              <button onClick={() => setExpanded(null)} className="w-8 h-8 flex items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container-high transition-colors cursor-pointer shrink-0">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            <div className="p-6 overflow-y-auto text-sm text-on-surface leading-relaxed">
              <TeamMarkdown>{expanded.text}</TeamMarkdown>
            </div>
          </div>
        </div>
      )}

      {scheduleOpen && (
        <ScheduleModal teamId={teamId} token={token} defaultEmail={user?.email || ''} onClose={() => setScheduleOpen(false)} />
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
          <button onClick={() => setScheduleOpen(true)} title="排程寄送"
            className="shrink-0 flex items-center gap-1.5 px-3 h-9 rounded-lg text-sm font-bold border border-outline-variant/30 text-on-surface hover:border-primary/50 hover:text-primary transition-colors cursor-pointer">
            <span className="material-symbols-outlined text-[18px]">schedule</span>
            <span className="hidden md:inline">排程</span>
          </button>
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
                    <button onClick={() => setExpanded({ title: m.name, icon: m.icon || 'smart_toy', text: m.text + (m.text2 ? `\n\n---\n\n**💬 回應其他成員**\n\n${m.text2}` : '') })}
                      className="w-5 h-5 flex items-center justify-center rounded text-on-surface-variant hover:text-primary hover:bg-primary/10 transition-colors cursor-pointer shrink-0" title="放大檢視">
                      <span className="material-symbols-outlined text-[14px]">open_in_full</span>
                    </button>
                  )}
                </div>
                <div className="p-3 text-xs text-on-surface-variant leading-relaxed max-h-72 overflow-y-auto min-h-[80px]">
                  {m.text
                    ? <TeamMarkdown>{m.text}</TeamMarkdown>
                    : (m.status === 'pending' ? null : <span className="text-outline italic">分析中…</span>)}
                  {m.text2 && (
                    <div className="mt-3 rounded-lg bg-tertiary/5 border border-tertiary/15 p-2.5">
                      <div className="flex items-center gap-1 text-[11px] font-bold text-tertiary mb-1.5">
                        <span className="material-symbols-outlined text-[13px]">forum</span>回應其他成員
                      </div>
                      <TeamMarkdown>{m.text2}</TeamMarkdown>
                    </div>
                  )}
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
              {totals && <span className="ml-auto text-xs text-on-surface-variant">實際 {(totals.inputTokens + totals.outputTokens).toLocaleString()} tokens · ${totals.costUsd}</span>}
              {synthesis && (
                <button onClick={() => setExpanded({ title: '協調者統整', icon: 'hub', text: synthesis })}
                  className={`w-7 h-7 flex items-center justify-center rounded text-on-surface-variant hover:text-primary hover:bg-primary/10 transition-colors cursor-pointer shrink-0 ${totals ? 'ml-1' : 'ml-auto'}`} title="放大檢視">
                  <span className="material-symbols-outlined text-[18px]">open_in_full</span>
                </button>
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
                            📅 排程{run.emailed === 1 ? ' · 已寄送' : run.emailed === 0 ? ' · 寄送失敗' : ''}
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
