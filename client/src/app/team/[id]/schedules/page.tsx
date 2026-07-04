'use client';

/**
 * Schedule management + calendar view for one team. Shows every schedule (with
 * enable/run-now/delete controls), a month calendar marking days that actually
 * ran (green) vs. each schedule's next planned run (ring), and an execution log
 * showing whether scheduled runs fired on time and were emailed. Polls so newly
 * fired runs appear without a manual refresh.
 */

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { AuthProvider, useAuth } from '../../../components/AuthProvider';
import { I18nProvider } from '../../../../i18n';
import Navbar from '../../../components/Navbar';
import { useSidebarMargin } from '../../../hooks/useSidebarCollapsed';
import ScheduleCreateModal from '../../../components/ScheduleCreateModal';
import Dropdown from '../../../components/Dropdown';

const DOW = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

// In pro-panjit, scheduling is ADMIN ONLY for now (reviewers hidden pending some
// details before the production rollout); its emails go via the AD mail gateway.
// Other deploy modes: everyone.
const deployMode = process.env.NEXT_PUBLIC_DEPLOY_MODE || 'pro-panjit';
const isPanjit = deployMode === 'pro-panjit';

interface Schedule { id: string; name: string | null; question: string; frequency: 'daily' | 'weekly'; hour: number; minute: number; day_of_week: number | null; email: string; enabled: number; next_run_at: string; last_run_at: string | null; doc_format: string | null }

const DOC_LABELS: Record<string, string> = { docx: 'Word', pptx: '簡報', pdf: 'PDF', html: '網頁簡報' };
interface RunRow { id: string; question: string; status: string; created_at: string; input_tokens: number; output_tokens: number; share_token: string | null; schedule_id: string | null; emailed: number | null }
interface TeamInfo { id: string; title: string; icon: string | null }

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function SchedulesContent() {
  const { token, user } = useAuth();
  const router = useRouter();
  const params = useParams();
  const teamId = String(params.id);
  const sidebarMargin = useSidebarMargin();

  // In pro-panjit, only reviewers/admins may schedule — bounce everyone else back
  // to the team (wait until the user is loaded so we don't redirect prematurely).
  const canSchedule = !isPanjit || user?.role === 'admin';
  useEffect(() => {
    if (user && !canSchedule) router.replace(`/team/${teamId}`);
  }, [router, teamId, user, canSchedule]);

  const [team, setTeam] = useState<TeamInfo | null>(null);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [testing, setTesting] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  // Arriving from a team's detail page with ?q=<question> pre-fills + opens the
  // create modal, so scheduling the topic you just analysed needs no re-typing.
  const [prefillQuestion, setPrefillQuestion] = useState('');
  const [prefillHasFiles, setPrefillHasFiles] = useState(false);
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const q = sp.get('q');
    if (q && q.trim()) { setPrefillQuestion(q); setPrefillHasFiles(sp.get('hasFiles') === '1'); setCreateOpen(true); }
  }, []);
  const [delTarget, setDelTarget] = useState<Schedule | null>(null);
  const [editTarget, setEditTarget] = useState<Schedule | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [cursor, setCursor] = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; });
  const [scheduleSearch, setScheduleSearch] = useState('');
  const [runFilter, setRunFilter] = useState<string>('all');   // 'all' | schedule id
  const [runPage, setRunPage] = useState(0);
  const [dayDetail, setDayDetail] = useState<string | null>(null);   // calendar day key
  const [dayPage, setDayPage] = useState(0);                          // day-detail run pagination

  const authHeaders = useCallback((): HeadersInit => (token ? { Authorization: `Bearer ${token}` } : {}), [token]);

  const loadSchedules = useCallback(() => {
    fetch(`/api/teams/${teamId}/schedules`, { headers: authHeaders() })
      .then(r => r.json()).then(d => setSchedules(Array.isArray(d.schedules) ? d.schedules : [])).catch(() => {});
  }, [teamId, authHeaders]);
  const loadRuns = useCallback(() => {
    fetch(`/api/teams/${teamId}/runs`, { headers: authHeaders() })
      .then(r => r.json()).then(d => setRuns((Array.isArray(d.runs) ? d.runs : []).filter((r: RunRow) => r.schedule_id))).catch(() => {});
  }, [teamId, authHeaders]);

  useEffect(() => {
    if (!token) return;
    fetch(`/api/teams/${teamId}`, { headers: authHeaders() })
      .then(r => r.json()).then((d: { team: TeamInfo }) => { if (!d.team) { router.replace('/assistant'); return; } setTeam(d.team); })
      .catch(() => router.replace('/assistant'));
    loadSchedules();
    loadRuns();
  }, [token, teamId, authHeaders, router, loadSchedules, loadRuns]);

  // Poll so scheduled runs appear / complete without a manual refresh.
  const hasInflight = runs.some(r => r.status !== 'done' && r.status !== 'error' && r.status !== 'failed');
  useEffect(() => {
    if (!token) return;
    const period = hasInflight ? 3500 : 8000;
    const tick = () => { if (!document.hidden) { loadRuns(); loadSchedules(); } };
    const t = setInterval(tick, period);
    const onVisible = () => { if (!document.hidden) { loadRuns(); loadSchedules(); } };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVisible); };
  }, [hasInflight, token, loadRuns, loadSchedules]);

  const toggle = async (s: Schedule) => {
    await fetch(`/api/teams/${teamId}/schedules/${s.id}`, { method: 'PATCH', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !s.enabled }) });
    loadSchedules();
  };
  const del = async () => {
    if (!delTarget) return;
    await fetch(`/api/teams/${teamId}/schedules/${delTarget.id}`, { method: 'DELETE', headers: authHeaders() });
    setDelTarget(null);
    loadSchedules();
  };
  const runNow = async (s: Schedule) => {
    setTesting(s.id);
    try {
      await fetch(`/api/teams/${teamId}/schedules/${s.id}/run-now`, { method: 'POST', headers: authHeaders() });
      setToast('已觸發測試執行，約 1 分鐘後完成。下方「執行紀錄」與日曆會自動更新，並寄到信箱。');
      setTimeout(loadRuns, 1500);
    } finally { setTesting(null); }
  };

  const fmt = (s: Schedule) => `${s.frequency === 'weekly' && s.day_of_week != null ? DOW[s.day_of_week] : '每天'} ${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}`;

  // --- Calendar derivation ---
  const todayKey = ymd(new Date());
  const runsByDay: Record<string, RunRow[]> = {};
  runs.forEach(r => { const k = ymd(new Date(r.created_at)); (runsByDay[k] ||= []).push(r); });

  const first = new Date(cursor.y, cursor.m, 1);
  const startPad = first.getDay();
  const daysInMonth = new Date(cursor.y, cursor.m + 1, 0).getDate();
  const cells: Array<{ day: number; key: string } | null> = [];
  for (let i = 0; i < startPad; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push({ day: d, key: ymd(new Date(cursor.y, cursor.m, d)) });

  const monthLabel = `${cursor.y} 年 ${cursor.m + 1} 月`;
  const shiftMonth = (delta: number) => setCursor(c => { const d = new Date(c.y, c.m + delta, 1); return { y: d.getFullYear(), m: d.getMonth() }; });
  const schedName = (id: string | null) => schedules.find(s => s.id === id)?.name || null;

  // A run "failed" if it errored out OR ran but couldn't email (gateway/scope).
  const isFailRun = (r: RunRow) => r.status === 'error' || r.status === 'failed' || r.emailed === 0;
  // Which schedules are planned for each upcoming day (for the calendar tooltip/popup).
  const schedulesByNextDay: Record<string, Schedule[]> = {};
  schedules.filter(s => s.enabled).forEach(s => { (schedulesByNextDay[ymd(new Date(s.next_run_at))] ||= []).push(s); });
  const hhmm = (s: Schedule) => `${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}`;

  // Schedule-list search + run-log filter/pagination.
  const RUNS_PER_PAGE = 10;
  const sq = scheduleSearch.trim().toLowerCase();
  const filteredSchedules = sq
    ? schedules.filter(s => (s.name || '').toLowerCase().includes(sq) || s.question.toLowerCase().includes(sq) || s.email.toLowerCase().includes(sq))
    : schedules;
  const filteredRuns = runFilter === 'all' ? runs : runs.filter(r => r.schedule_id === runFilter);
  const runTotalPages = Math.max(1, Math.ceil(filteredRuns.length / RUNS_PER_PAGE));
  const runPageClamped = Math.min(runPage, runTotalPages - 1);
  const pagedRuns = filteredRuns.slice(runPageClamped * RUNS_PER_PAGE, runPageClamped * RUNS_PER_PAGE + RUNS_PER_PAGE);

  if (user && !canSchedule) return null; // disallowed in pro-panjit — redirecting away

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

      {createOpen && (
        <ScheduleCreateModal teamId={teamId} token={token} defaultEmail={user?.email || ''} defaultQuestion={prefillQuestion} sourceHasFiles={prefillHasFiles}
          onClose={() => { setCreateOpen(false); setPrefillHasFiles(false); }} onCreated={() => { loadSchedules(); }} />
      )}

      {editTarget && (
        <ScheduleCreateModal teamId={teamId} token={token} defaultEmail={user?.email || ''} existing={editTarget}
          onClose={() => setEditTarget(null)} onCreated={() => { setEditTarget(null); loadSchedules(); }} />
      )}

      {delTarget && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={() => setDelTarget(null)}>
          <div className="bg-surface-container-lowest rounded-2xl shadow-2xl w-full max-w-sm p-6" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-headline font-bold text-on-surface mb-2">刪除排程</h3>
            <p className="text-sm text-on-surface-variant mb-5">確定要刪除「{delTarget.name || delTarget.question}」這個排程嗎？此動作無法復原（已產生的執行紀錄會保留）。</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDelTarget(null)} className="px-4 py-2 rounded-xl text-sm font-bold text-on-surface-variant hover:bg-surface-container-high cursor-pointer">取消</button>
              <button onClick={del} className="px-5 py-2 rounded-xl text-sm font-bold text-on-error bg-error hover:bg-error/90 cursor-pointer">刪除</button>
            </div>
          </div>
        </div>
      )}

      <main className={`${sidebarMargin} md:pt-10 pb-16 px-4 md:px-10 transition-all duration-300`}>
        {/* Header */}
        <div className="mt-4 md:mt-0 mb-6 flex items-center gap-3">
          <Link href={`/team/${teamId}`} className="w-9 h-9 flex items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container-high transition-colors cursor-pointer shrink-0">
            <span className="material-symbols-outlined">arrow_back</span>
          </Link>
          <div className="flex-1 min-w-0">
            <h1 className="text-xl md:text-2xl font-headline font-bold text-on-surface truncate">排程管理</h1>
            <p className="text-sm text-on-surface-variant truncate">{team.title} · 排定時間、檢視是否如期執行</p>
          </div>
          <button onClick={() => setCreateOpen(true)}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-bold text-on-primary cyber-gradient transition-all cursor-pointer shrink-0">
            <span className="material-symbols-outlined text-[18px]">add</span><span className="hidden sm:inline">新增排程</span>
          </button>
        </div>

        {toast && (
          <div className="flex items-start gap-2.5 p-3 mb-5 rounded-xl border border-primary/30 bg-primary/[0.07]">
            <span className="material-symbols-outlined text-primary text-[20px] shrink-0">bolt</span>
            <p className="flex-1 text-sm text-on-surface leading-relaxed">{toast}</p>
            <button onClick={() => setToast(null)} className="text-on-surface-variant hover:text-on-surface cursor-pointer shrink-0">
              <span className="material-symbols-outlined text-[18px]">close</span>
            </button>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Schedule list */}
          <section>
            <h2 className="text-xs font-bold uppercase tracking-wider text-on-surface-variant mb-3">排程清單（{schedules.length}）</h2>
            {schedules.length > 3 && (
              <div className="relative mb-3">
                <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant/50 text-[18px] pointer-events-none">search</span>
                <input value={scheduleSearch} onChange={e => setScheduleSearch(e.target.value)} placeholder="搜尋排程名稱、議題或收件者"
                  className="w-full bg-surface-container border border-outline-variant/30 rounded-xl pl-10 pr-3 py-2 text-sm text-on-surface focus:outline-none focus:border-primary" />
              </div>
            )}
            {schedules.length === 0 ? (
              <div className="p-6 rounded-2xl border border-dashed border-outline-variant/30 text-center text-sm text-on-surface-variant">
                還沒有排程。按右上角「新增排程」設定團隊定時自動分析並寄信。
              </div>
            ) : filteredSchedules.length === 0 ? (
              <div className="p-6 rounded-2xl border border-dashed border-outline-variant/30 text-center text-sm text-on-surface-variant">
                查無符合「{scheduleSearch}」的排程。
              </div>
            ) : (
              <div className="space-y-2">
                {filteredSchedules.map(s => (
                  <div key={s.id} className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 p-3 rounded-xl border border-outline-variant/15 bg-surface-container">
                    <div className="flex items-start gap-3 flex-1 min-w-0">
                      <span className="material-symbols-outlined text-on-surface-variant shrink-0 mt-0.5">{s.enabled ? 'alarm' : 'alarm_off'}</span>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-bold text-on-surface truncate">{s.name || s.question}</div>
                        {s.name && <div className="text-xs text-on-surface-variant truncate">議題：{s.question}</div>}
                        <div className="text-xs text-on-surface-variant truncate flex items-center gap-1.5">
                          <span className="truncate">{fmt(s)} · {(() => { const list = s.email.split(',').map(e => e.trim()).filter(Boolean); return list.length > 1 ? `${list[0]} 等 ${list.length} 位` : list[0] || s.email; })()}</span>
                          {s.doc_format && DOC_LABELS[s.doc_format] && (
                            <span className="shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-primary/10 text-primary text-[10px] font-bold">
                              <span className="material-symbols-outlined text-[11px]">description</span>{DOC_LABELS[s.doc_format]}
                            </span>
                          )}
                        </div>
                        {s.enabled
                          ? <div className="text-[11px] text-tertiary">下次：{new Date(s.next_run_at).toLocaleString()}</div>
                          : <div className="text-[11px] text-on-surface-variant/60">已停用</div>}
                      </div>
                    </div>
                    {/* Controls drop to their own right-aligned row on mobile */}
                    <div className="flex items-center gap-1 shrink-0 justify-end pt-2 sm:pt-0 border-t sm:border-t-0 border-outline-variant/10">
                      <button onClick={() => runNow(s)} disabled={testing === s.id} title="立即測試執行（馬上跑一次並寄出）"
                        className="w-8 h-8 flex items-center justify-center rounded-lg text-on-surface-variant hover:text-primary hover:bg-primary/10 transition-colors cursor-pointer shrink-0 disabled:opacity-40">
                        <span className={`material-symbols-outlined text-[18px] ${testing === s.id ? 'animate-spin' : ''}`}>{testing === s.id ? 'progress_activity' : 'play_arrow'}</span>
                      </button>
                      <button onClick={() => setEditTarget(s)} title="編輯排程"
                        className="w-8 h-8 flex items-center justify-center rounded-lg text-on-surface-variant hover:text-primary hover:bg-primary/10 transition-colors cursor-pointer shrink-0">
                        <span className="material-symbols-outlined text-[18px]">edit</span>
                      </button>
                      <button onClick={() => toggle(s)} title={s.enabled ? '停用' : '啟用'}
                        className={`relative w-9 h-5 mx-1 rounded-full transition-colors shrink-0 cursor-pointer ${s.enabled ? 'bg-primary' : 'bg-outline-variant/40'}`}>
                        <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${s.enabled ? 'translate-x-4' : ''}`} />
                      </button>
                      <button onClick={() => setDelTarget(s)} title="刪除" className="w-8 h-8 flex items-center justify-center rounded-lg text-on-surface-variant hover:text-error hover:bg-error/10 transition-colors cursor-pointer shrink-0">
                        <span className="material-symbols-outlined text-[18px]">delete</span>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Calendar */}
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs font-bold uppercase tracking-wider text-on-surface-variant">執行日曆</h2>
              <div className="flex items-center gap-1">
                <button onClick={() => shiftMonth(-1)} className="w-7 h-7 flex items-center justify-center rounded-lg text-on-surface-variant hover:bg-surface-container-high cursor-pointer"><span className="material-symbols-outlined text-[18px]">chevron_left</span></button>
                <span className="text-sm font-bold text-on-surface w-28 text-center">{monthLabel}</span>
                <button onClick={() => shiftMonth(1)} className="w-7 h-7 flex items-center justify-center rounded-lg text-on-surface-variant hover:bg-surface-container-high cursor-pointer"><span className="material-symbols-outlined text-[18px]">chevron_right</span></button>
              </div>
            </div>
            <div className="p-3 rounded-2xl border border-outline-variant/15 bg-surface-container">
              <div className="grid grid-cols-7 gap-1 mb-1">
                {DOW.map(d => <div key={d} className="text-center text-[11px] font-bold text-on-surface-variant/70 py-1">{d.replace('週', '')}</div>)}
              </div>
              <div className="grid grid-cols-7 gap-1">
                {cells.map((c, i) => {
                  if (!c) return <div key={i} />;
                  const ran = runsByDay[c.key];
                  const okCount = ran ? ran.filter(r => !isFailRun(r)).length : 0;
                  const failCount = ran ? ran.filter(isFailRun).length : 0;
                  const isToday = c.key === todayKey;
                  const planned = schedulesByNextDay[c.key];
                  const isNext = !!planned?.length;
                  const clickable = !!ran || isNext;
                  return (
                    <button key={i} type="button" disabled={!clickable} onClick={() => { if (clickable) { setDayDetail(c.key); setDayPage(0); } }}
                      className={`aspect-square rounded-lg flex flex-col items-center justify-center relative transition-colors ${clickable ? 'cursor-pointer hover:ring-2 hover:ring-primary/40' : 'cursor-default'} ${isToday ? 'bg-primary/10 ring-1 ring-primary/40' : 'bg-surface-container-lowest'} ${isNext && !ran ? 'ring-1 ring-tertiary/50' : ''}`}>
                      <span className={`text-sm ${isToday ? 'font-bold text-primary' : 'text-on-surface'}`}>{c.day}</span>
                      {ran ? (
                        <span className="mt-0.5 flex items-center gap-1 text-[11px] font-bold">
                          {okCount > 0 && <span className="flex items-center gap-0.5 text-success"><span className="w-1.5 h-1.5 rounded-full bg-success" />{okCount}</span>}
                          {failCount > 0 && <span className="flex items-center gap-0.5 text-error"><span className="w-1.5 h-1.5 rounded-full bg-error" />{failCount}</span>}
                        </span>
                      ) : isNext ? <span className="mt-0.5 text-[10px] text-tertiary font-bold">預定 {planned.length}</span> : null}
                    </button>
                  );
                })}
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mt-3 pt-3 border-t border-outline-variant/15 text-[11px] text-on-surface-variant">
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-success" />已執行</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-error" />失敗</span>
                <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full ring-1 ring-tertiary/60" />下次預定</span>
                <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-primary/20 ring-1 ring-primary/40" />今天</span>
                <span className="ml-auto text-on-surface-variant/60">點日期看當天履歷</span>
              </div>
            </div>
          </section>
        </div>

        {/* Execution log */}
        <section className="mt-8">
          <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
            <h2 className="text-xs font-bold uppercase tracking-wider text-on-surface-variant">執行紀錄{filteredRuns.length > 0 && <span className="ml-1 normal-case tracking-normal text-on-surface-variant/60">（{filteredRuns.length}）</span>}</h2>
            {runs.length > 0 && (
              <Dropdown compact value={runFilter} onChange={v => { setRunFilter(v); setRunPage(0); }} className="min-w-[160px] max-w-[240px]"
                options={[{ value: 'all', label: '全部排程' }, ...schedules.map(s => ({ value: s.id, label: s.name || s.question.slice(0, 20) }))]} />
            )}
          </div>
          {runs.length === 0 ? (
            <div className="p-6 rounded-2xl border border-dashed border-outline-variant/30 text-center text-sm text-on-surface-variant">
              還沒有排程執行紀錄。時間到時，系統會自動跑分析、寄信，並把每次執行列在這裡。
            </div>
          ) : filteredRuns.length === 0 ? (
            <div className="p-6 rounded-2xl border border-dashed border-outline-variant/30 text-center text-sm text-on-surface-variant">
              這個排程還沒有執行紀錄。
            </div>
          ) : (
            <div className="space-y-2">
              {pagedRuns.map(r => {
                const inflight = r.status !== 'done' && r.status !== 'error' && r.status !== 'failed';
                const nm = schedName(r.schedule_id);
                return (
                  <div key={r.id} className="flex items-center gap-3 p-3 rounded-xl border border-outline-variant/15 bg-surface-container">
                    <span className={`material-symbols-outlined shrink-0 ${inflight ? 'text-primary animate-spin' : r.status === 'done' ? 'text-success' : 'text-error'}`}>
                      {inflight ? 'progress_activity' : r.status === 'done' ? 'check_circle' : 'error'}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-on-surface truncate">{nm ? `${nm}` : r.question}</div>
                      <div className="text-xs text-on-surface-variant truncate">
                        {new Date(r.created_at).toLocaleString()}
                        {!inflight && r.status === 'done' && ` · ${(r.input_tokens + r.output_tokens).toLocaleString()} tokens`}
                      </div>
                    </div>
                    {inflight
                      ? <span className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-primary/10 text-primary shrink-0"><span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />背景執行中</span>
                      : r.status === 'done'
                        ? <span title={r.emailed === 0 ? '寄信未成功，常見原因是內部郵件閘道尚未開放 mail:send 權限（請洽 IT）' : undefined}
                            className={`text-[11px] px-2 py-0.5 rounded-full shrink-0 whitespace-nowrap ${r.emailed === 1 ? 'bg-success/10 text-success' : r.emailed === 0 ? 'bg-error/10 text-error' : 'bg-tertiary/10 text-tertiary'}`}>如期執行{r.emailed === 1 ? ' · 已寄送' : r.emailed === 0 ? <> · 寄信失敗<span className="hidden sm:inline">（閘道未授權？）</span></> : ''}</span>
                        : <span className="text-[11px] px-2 py-0.5 rounded-full bg-error/10 text-error shrink-0">執行失敗</span>}
                    {r.share_token && !inflight && (
                      <a href={`/share/team/${r.share_token}`} target="_blank" rel="noreferrer" title="查看完整報告"
                        className="w-8 h-8 flex items-center justify-center rounded-lg text-on-surface-variant hover:text-primary hover:bg-primary/10 transition-colors cursor-pointer shrink-0">
                        <span className="material-symbols-outlined text-[18px]">open_in_new</span>
                      </a>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {runTotalPages > 1 && (
            <div className="flex items-center justify-center gap-2 mt-4">
              <button onClick={() => setRunPage(p => Math.max(0, p - 1))} disabled={runPageClamped === 0}
                className="w-8 h-8 flex items-center justify-center rounded-lg text-on-surface-variant hover:bg-surface-container-high disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer">
                <span className="material-symbols-outlined text-[18px]">chevron_left</span>
              </button>
              <span className="text-xs text-on-surface-variant">第 {runPageClamped + 1} / {runTotalPages} 頁</span>
              <button onClick={() => setRunPage(p => Math.min(runTotalPages - 1, p + 1))} disabled={runPageClamped >= runTotalPages - 1}
                className="w-8 h-8 flex items-center justify-center rounded-lg text-on-surface-variant hover:bg-surface-container-high disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer">
                <span className="material-symbols-outlined text-[18px]">chevron_right</span>
              </button>
            </div>
          )}
        </section>
      </main>

      {/* Calendar day detail — that day's run history + what's planned */}
      {dayDetail && (() => {
        const ran = (runsByDay[dayDetail] || []).slice().sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at));
        const DAY_PER_PAGE = 6;
        const dayTotalPages = Math.max(1, Math.ceil(ran.length / DAY_PER_PAGE));
        const dayPageClamped = Math.min(dayPage, dayTotalPages - 1);
        const pagedRan = ran.slice(dayPageClamped * DAY_PER_PAGE, dayPageClamped * DAY_PER_PAGE + DAY_PER_PAGE);
        const planned = schedulesByNextDay[dayDetail] || [];
        const dLabel = new Date(dayDetail + 'T00:00:00').toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
        return (
          <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm sm:p-4" onClick={() => setDayDetail(null)}>
            <div className="bg-surface-container-lowest rounded-t-2xl sm:rounded-2xl shadow-2xl w-full max-w-lg max-h-[88vh] sm:max-h-[85vh] overflow-y-auto p-5 sm:p-6" onClick={e => e.stopPropagation()}>
              <div className="flex items-center gap-2 mb-4">
                <span className="material-symbols-outlined text-primary">event</span>
                <h3 className="text-lg font-headline font-bold text-on-surface flex-1">{dLabel}</h3>
                <button onClick={() => setDayDetail(null)} className="w-8 h-8 flex items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container-high cursor-pointer">
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>

              {planned.length > 0 && (
                <div className="mb-4">
                  <p className="text-xs font-bold text-tertiary mb-2">預定執行（{planned.length}）</p>
                  <div className="space-y-1.5">
                    {planned.slice().sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute)).map(s => (
                      <div key={s.id} className="flex items-center gap-2 p-2.5 rounded-xl border border-tertiary/25 bg-tertiary/5">
                        <span className="text-sm font-bold text-tertiary tabular-nums shrink-0">{hhmm(s)}</span>
                        <span className="flex-1 min-w-0 text-sm text-on-surface truncate">{s.name || s.question}</span>
                        {s.doc_format && DOC_LABELS[s.doc_format] && <span className="text-[10px] font-bold text-primary shrink-0">{DOC_LABELS[s.doc_format]}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <p className="text-xs font-bold text-on-surface-variant mb-2">執行紀錄（{ran.length}）</p>
              {ran.length === 0 ? (
                <p className="text-sm text-on-surface-variant/60 py-4 text-center">這天還沒有執行紀錄。</p>
              ) : (
                <div className="space-y-1.5">
                  {pagedRan.map(r => {
                    const inflight = r.status !== 'done' && r.status !== 'error' && r.status !== 'failed';
                    const fail = isFailRun(r);
                    return (
                      <div key={r.id} className="flex items-center gap-2.5 p-2.5 rounded-xl border border-outline-variant/15 bg-surface-container">
                        <span className={`material-symbols-outlined text-[18px] shrink-0 ${inflight ? 'text-primary animate-spin' : fail ? 'text-error' : 'text-success'}`}>
                          {inflight ? 'progress_activity' : fail ? 'error' : 'check_circle'}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm text-on-surface truncate">{schedName(r.schedule_id) || r.question}</div>
                          <div className="text-xs text-on-surface-variant">{new Date(r.created_at).toLocaleTimeString()}{r.status === 'done' && r.emailed === 0 ? ' · 寄信失敗' : ''}</div>
                        </div>
                        {r.share_token && !inflight && (
                          <a href={`/share/team/${r.share_token}`} target="_blank" rel="noreferrer" title="查看完整報告"
                            className="w-8 h-8 flex items-center justify-center rounded-lg text-on-surface-variant hover:text-primary hover:bg-primary/10 cursor-pointer shrink-0">
                            <span className="material-symbols-outlined text-[18px]">open_in_new</span>
                          </a>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {dayTotalPages > 1 && (
                <div className="flex items-center justify-center gap-2 mt-3">
                  <button onClick={() => setDayPage(p => Math.max(0, p - 1))} disabled={dayPageClamped === 0}
                    className="w-8 h-8 flex items-center justify-center rounded-lg text-on-surface-variant hover:bg-surface-container-high disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer">
                    <span className="material-symbols-outlined text-[18px]">chevron_left</span>
                  </button>
                  <span className="text-xs text-on-surface-variant">第 {dayPageClamped + 1} / {dayTotalPages} 頁</span>
                  <button onClick={() => setDayPage(p => Math.min(dayTotalPages - 1, p + 1))} disabled={dayPageClamped >= dayTotalPages - 1}
                    className="w-8 h-8 flex items-center justify-center rounded-lg text-on-surface-variant hover:bg-surface-container-high disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer">
                    <span className="material-symbols-outlined text-[18px]">chevron_right</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );
}

export default function TeamSchedulesPage() {
  return (
    <AuthProvider>
      <SchedulesWithI18n />
    </AuthProvider>
  );
}

function SchedulesWithI18n() {
  const { user } = useAuth();
  return (
    <I18nProvider initialLocale={user?.locale} initialTheme={user?.theme}>
      <SchedulesContent />
    </I18nProvider>
  );
}
