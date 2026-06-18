'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import TeamMarkdown from '../../components/TeamMarkdown';
import { useAdminAuth } from '../components/AdminAuthProvider';

interface TeamRow {
  id: string; title: string; topic: string | null; icon: string | null; created_at: string;
  user_email: string; user_display_name: string;
  member_count: number; run_count: number; total_tokens: number; last_run_at: string | null;
}
interface TeamDetail {
  team: { id: string; title: string; topic: string | null; icon: string | null; user_email: string; user_display_name: string };
  members: { id: string; title: string; skill_id: string | null; icon: string | null; system_prompt: string | null }[];
  runs: { id: string; question: string; status: string; input_tokens: number; output_tokens: number; created_at: string; result_preview: string | null }[];
}
interface MemberAnswer { memberId: string; name: string; icon: string | null; text: string; text2: string }
interface RunDetail { id: string; question: string; result: string; members: MemberAnswer[]; input_tokens: number; output_tokens: number; created_at: string }

const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
function toUTC(s: string): Date {
  const x = s.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(s) ? s : s.replace(' ', 'T') + 'Z';
  return new Date(x);
}
const fmtDate = (s: string | null) => (s ? toUTC(s).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
const fmtDateTime = (s: string) => toUTC(s).toLocaleString('zh-TW', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

const HEADER = 'sticky top-0 h-14 md:h-16 bg-surface/80 backdrop-blur-xl flex items-center px-4 md:px-8 z-40 shadow-[0_1px_0_0_rgba(255,255,255,0.05)]';

const SKILL_LABELS: Record<string, string> = {
  research: '研究 / 網路查證', 'data-analyst': '資料分析', 'rag-analyst': '檔案分析',
  planner: '規劃', reviewer: '審閱', router: '協調',
  'pptx-gen': '簡報生成', 'docx-gen': 'Word 生成', 'xlsx-gen': 'Excel 生成', 'pdf-gen': 'PDF 生成', 'slides-gen': '網頁簡報',
};
const skillLabel = (s: string | null) => (s ? (SKILL_LABELS[s] || s) : '通用助手');

export default function AdminTeamsPage() {
  const { token } = useAdminAuth();
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [team, setTeam] = useState<TeamDetail | null>(null);
  const [teamLoading, setTeamLoading] = useState(false);
  const [run, setRun] = useState<RunDetail | null>(null);
  const [runLoading, setRunLoading] = useState(false);
  const [openMember, setOpenMember] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<'members' | 'runs'>('members');
  const [runTab, setRunTab] = useState<'report' | 'members'>('report');

  const load = useCallback(() => {
    if (!token) return;
    setLoading(true);
    const params = new URLSearchParams({ limit: '50' });
    if (search.trim()) params.set('search', search.trim());
    fetch(`/api/admin/teams?${params}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(d => { setTeams(d.teams || []); setTotal(d.total || 0); })
      .catch(() => {}).finally(() => setLoading(false));
  }, [token, search]);

  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  const openTeam = (id: string) => {
    if (!token) return;
    setTeamLoading(true); setTeam(null); setRun(null); setDetailTab('members');
    fetch(`/api/admin/teams/${id}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(d => setTeam(d)).catch(() => {}).finally(() => setTeamLoading(false));
  };
  const openRun = (runId: string) => {
    if (!token || !team) return;
    setRunLoading(true); setRun(null); setOpenMember(null); setRunTab('report');
    fetch(`/api/admin/teams/${team.team.id}/runs/${runId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(d => setRun(d)).catch(() => {}).finally(() => setRunLoading(false));
  };

  /* ---- Run detail (full page) ---- */
  if (run || runLoading) {
    return (
      <>
        <header className={HEADER + ' gap-3'}>
          <button onClick={() => setRun(null)} className="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-surface-container text-on-surface-variant cursor-pointer">
            <span className="material-symbols-outlined">arrow_back</span>
          </button>
          <span className="text-base md:text-lg font-black text-on-surface font-headline">協作紀錄</span>
        </header>
        <div className="flex-1 overflow-y-auto p-4 md:p-8">
          {runLoading || !run ? <div className="py-16 text-center text-on-surface-variant">載入中…</div> : (
            <div className="space-y-5">
              {/* Question */}
              <div className="bg-primary/5 border border-primary/15 rounded-xl p-4">
                <p className="text-xs text-on-surface-variant mb-1.5 flex items-center gap-1.5"><span className="material-symbols-outlined text-[14px] text-primary">help</span>使用者問題</p>
                <p className="text-sm text-on-surface whitespace-pre-wrap leading-relaxed">{run.question}</p>
                <p className="text-[11px] text-on-surface-variant/60 mt-2">{fmtDateTime(run.created_at)} · {fmtTokens(run.input_tokens + run.output_tokens)} tokens</p>
              </div>

              {/* Tabs */}
              <div className="flex items-center gap-5 border-b border-outline-variant/10">
                {([['report', '最終報告'], ['members', `各成員分析 (${run.members.length})`]] as const).map(([k, label]) => (
                  <button key={k} onClick={() => setRunTab(k)}
                    className={`pb-2.5 -mb-px text-sm border-b-2 transition-colors ${runTab === k ? 'border-primary text-primary font-semibold' : 'border-transparent text-on-surface-variant hover:text-on-surface'}`}>
                    {label}
                  </button>
                ))}
              </div>

              {/* Tab content */}
              {runTab === 'report' ? (
                <div className="bg-surface-container-lowest border border-outline-variant/30 rounded-xl p-4 md:p-6 text-sm text-on-surface-variant leading-relaxed">
                  <TeamMarkdown>{run.result}</TeamMarkdown>
                </div>
              ) : (
                <div className="space-y-2">
                  {run.members.map(m => {
                    const open = openMember === m.memberId;
                    return (
                      <div key={m.memberId} className="border border-outline-variant/30 rounded-xl overflow-hidden bg-surface-container-lowest">
                        <button onClick={() => setOpenMember(open ? null : m.memberId)} className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-surface-container/40 transition-colors">
                          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0"><span className="material-symbols-outlined text-[18px] text-primary">{m.icon || 'person'}</span></div>
                          <span className="text-sm font-semibold text-on-surface flex-1">{m.name}</span>
                          <span className={`material-symbols-outlined text-[18px] text-on-surface-variant transition-transform ${open ? 'rotate-180' : ''}`}>expand_more</span>
                        </button>
                        {open && (
                          <div className="px-4 pb-4 pt-3 text-sm text-on-surface-variant max-w-none border-t border-outline-variant/10">
                            <p className="text-[11px] font-semibold text-on-surface-variant/70 uppercase tracking-wide mb-2 flex items-center gap-1.5"><span className="material-symbols-outlined text-[14px]">person</span>第一輪分析</p>
                            <TeamMarkdown>{m.text || '（無分析）'}</TeamMarkdown>
                            {m.text2 && (
                              <div className="mt-4 rounded-xl bg-primary/[0.04] border border-primary/15 p-4">
                                <p className="text-[11px] font-semibold text-primary uppercase tracking-wide mb-2 flex items-center gap-1.5"><span className="material-symbols-outlined text-[14px]">forum</span>討論回合</p>
                                <TeamMarkdown>{m.text2}</TeamMarkdown>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </>
    );
  }

  /* ---- Team detail (full page) ---- */
  if (team || teamLoading) {
    return (
      <>
        <header className={HEADER + ' gap-3'}>
          <button onClick={() => setTeam(null)} className="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-surface-container text-on-surface-variant cursor-pointer">
            <span className="material-symbols-outlined">arrow_back</span>
          </button>
          <span className="text-base md:text-lg font-black text-on-surface font-headline truncate">{team?.team.title || '團隊'}</span>
        </header>
        <div className="flex-1 overflow-y-auto p-4 md:p-8">
          {teamLoading || !team ? <div className="py-16 text-center text-on-surface-variant">載入中…</div> : (
            <div className="space-y-5">
              {/* Title + description + owner + stats */}
              <div className="flex flex-col md:flex-row md:items-start gap-3">
                <div className="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                  <span className="material-symbols-outlined text-primary text-[24px]">{team.team.icon || 'groups'}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <h2 className="text-lg font-bold text-on-surface">{team.team.title}</h2>
                  {team.team.topic && <p className="text-sm text-on-surface-variant mt-0.5 leading-relaxed">{team.team.topic}</p>}
                  <p className="text-xs text-on-surface-variant/70 mt-1.5 flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-[14px]">person</span>{team.team.user_display_name} · {team.team.user_email}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2 md:justify-end shrink-0">
                  {[
                    { icon: 'group', label: '成員', value: team.members.length },
                    { icon: 'forum', label: '協作次數', value: team.runs.length },
                    { icon: 'toll', label: 'Tokens', value: fmtTokens(team.runs.reduce((a, r) => a + (r.input_tokens || 0) + (r.output_tokens || 0), 0)) },
                  ].map(s => (
                    <span key={s.label} className="inline-flex items-center gap-1.5 bg-surface-container rounded-lg px-3 py-1.5 text-xs">
                      <span className="material-symbols-outlined text-[15px] text-primary">{s.icon}</span>
                      <span className="text-on-surface-variant">{s.label}</span>
                      <span className="font-semibold text-on-surface">{s.value}</span>
                    </span>
                  ))}
                </div>
              </div>

              {/* Tabs */}
              <div className="flex items-center gap-5 border-b border-outline-variant/10">
                {([['members', `成員角色 (${team.members.length})`], ['runs', `協作紀錄 (${team.runs.length})`]] as const).map(([k, label]) => (
                  <button key={k} onClick={() => setDetailTab(k)}
                    className={`pb-2.5 -mb-px text-sm border-b-2 transition-colors ${detailTab === k ? 'border-primary text-primary font-semibold' : 'border-transparent text-on-surface-variant hover:text-on-surface'}`}>
                    {label}
                  </button>
                ))}
              </div>

              {/* Tab content */}
              {detailTab === 'members' ? (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                  {team.members.map(m => (
                    <div key={m.id} className="bg-surface-container-lowest border border-outline-variant/30 hover:border-primary/40 rounded-xl p-4 transition-colors flex flex-col">
                      <div className="flex items-center gap-2 mb-2">
                        <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                          <span className="material-symbols-outlined text-[18px] text-primary">{m.icon || 'person'}</span>
                        </div>
                        <span className="text-sm font-semibold text-on-surface flex-1 min-w-0 truncate">{m.title}</span>
                      </div>
                      <span className="inline-flex items-center gap-1 self-start text-[11px] px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium mb-2.5">
                        <span className="material-symbols-outlined text-[13px]">bolt</span>{skillLabel(m.skill_id)}
                      </span>
                      <p className="text-[11px] text-on-surface-variant/60 mb-1">角色定義</p>
                      <div className="text-xs text-on-surface-variant whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto">
                        {m.system_prompt || '（未設定角色定義）'}
                      </div>
                    </div>
                  ))}
                </div>
              ) : team.runs.length === 0 ? (
                <p className="text-sm text-on-surface-variant/60 py-10 text-center">尚無協作紀錄</p>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {team.runs.map(r => (
                    <button key={r.id} onClick={() => openRun(r.id)} className="text-left bg-surface-container-lowest border border-outline-variant/30 hover:border-primary/40 hover:bg-surface-container/40 rounded-xl p-4 transition-colors">
                      <div className="flex items-center gap-2 text-xs text-on-surface-variant mb-1.5">
                        <span className="material-symbols-outlined text-[15px] text-primary">forum</span>
                        <span>{fmtDateTime(r.created_at)}</span>
                        <span className="ml-auto">{fmtTokens((r.input_tokens || 0) + (r.output_tokens || 0))} tokens</span>
                        <span className="material-symbols-outlined text-[16px]">chevron_right</span>
                      </div>
                      <p className="text-sm text-on-surface font-medium line-clamp-3">議題：{r.question}</p>
                    </button>
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
          <span className="text-xs md:text-sm text-on-surface-variant font-mono">共 {total} 個團隊</span>
        </div>
      </header>

      <div className="flex-1 flex flex-col p-4 md:p-8 overflow-hidden">
        {/* Tabs */}
        <div className="flex items-center gap-1 mb-4 shrink-0">
          <Link href="/admin/conversations" className="px-3.5 py-1.5 rounded-full text-sm text-on-surface-variant hover:bg-surface-container transition-colors no-underline">對話管理</Link>
          <span className="px-3.5 py-1.5 rounded-full text-sm bg-primary text-on-primary font-medium">團隊協作</span>
        </div>

        {/* Search */}
        <div className="mb-4 md:mb-6 relative shrink-0">
          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline text-sm">search</span>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="搜尋團隊名稱、議題或擁有者…"
            className="w-full bg-surface-container-highest border-none focus:ring-1 focus:ring-primary/40 rounded py-2.5 pl-10 pr-4 text-sm text-on-surface placeholder:text-outline font-body" />
        </div>

        {/* Table */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="py-16 text-center text-on-surface-variant">載入中…</div>
          ) : teams.length === 0 ? (
            <div className="py-16 text-center text-on-surface-variant">目前沒有團隊協作</div>
          ) : (
            <table className="w-full">
              <thead className="sticky top-0 bg-surface-container-lowest">
                <tr className="text-left text-sm uppercase tracking-widest text-on-surface-variant">
                  <th className="py-3 px-4 font-bold">團隊</th>
                  <th className="py-3 px-4 font-bold">擁有者</th>
                  <th className="py-3 px-4 font-bold text-center">成員</th>
                  <th className="py-3 px-4 font-bold text-center">協作次數</th>
                  <th className="py-3 px-4 font-bold text-right">Tokens</th>
                  <th className="py-3 px-4 font-bold">最近協作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant/10">
                {teams.map(t => (
                  <tr key={t.id} onClick={() => openTeam(t.id)} className="hover:bg-surface-container/40 cursor-pointer">
                    <td className="py-3 px-4">
                      <div className="font-medium text-on-surface flex items-center gap-2">
                        <span className="material-symbols-outlined text-primary text-[18px]">{t.icon || 'groups'}</span>
                        <span className="truncate max-w-[260px]">{t.title}</span>
                      </div>
                      {t.topic && <div className="text-xs text-on-surface-variant truncate max-w-[320px] mt-0.5">{t.topic}</div>}
                    </td>
                    <td className="py-3 px-4"><div className="text-sm text-on-surface">{t.user_display_name || '—'}</div><div className="text-xs text-on-surface-variant">{t.user_email}</div></td>
                    <td className="py-3 px-4 text-center text-sm text-on-surface-variant">{t.member_count}</td>
                    <td className="py-3 px-4 text-center text-sm">{t.run_count ? <span className="text-primary font-medium">{t.run_count}</span> : <span className="text-on-surface-variant/50">0</span>}</td>
                    <td className="py-3 px-4 text-right text-sm text-on-surface-variant">{t.total_tokens ? fmtTokens(t.total_tokens) : '—'}</td>
                    <td className="py-3 px-4 text-sm text-on-surface-variant">{fmtDate(t.last_run_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}
