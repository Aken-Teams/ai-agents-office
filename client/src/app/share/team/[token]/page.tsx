'use client';

/**
 * Public, read-only snapshot of a team collaboration run. No auth, no input —
 * just the question, each member's analysis, and the coordinator synthesis.
 */

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import TeamMarkdown from '../../../components/TeamMarkdown';

interface MemberOut { memberId: string; name: string; icon: string | null; text: string; text2?: string }
interface SharedRun {
  teamTitle: string;
  teamIcon: string | null;
  question: string;
  result: string | null;
  memberOutputs: MemberOut[];
  createdAt: string;
  docFormat: string | null;
  docStatus: string | null;   // null=no doc, 'pending'|'done'|'failed'
  docUrl: string | null;
}

const DOC_LABELS: Record<string, string> = { pptx: '簡報', docx: 'Word', pdf: 'PDF', html: '網頁簡報' };

export default function TeamSharePage() {
  const params = useParams();
  const token = String(params.token);
  const [data, setData] = useState<SharedRun | null>(null);
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState<{ title: string; icon: string; text: string } | null>(null);

  useEffect(() => {
    fetch(`/api/public/team-run/${token}`)
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then(setData)
      .catch(() => setError(true));
  }, [token]);

  if (error) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 bg-surface-container-lowest text-on-surface-variant">
        <span className="material-symbols-outlined text-5xl text-outline">link_off</span>
        <p className="text-sm">這個分享連結無效或已被移除。</p>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface-container-lowest">
        <span className="material-symbols-outlined animate-spin text-primary text-4xl">progress_activity</span>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface-container-lowest">
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

      <main className="max-w-6xl mx-auto px-4 md:px-8 py-8">
        {/* Header — on mobile the doc button drops to its own full-width row */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-6">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <div className="w-11 h-11 rounded-xl cyber-gradient flex items-center justify-center shrink-0">
              <span className="material-symbols-outlined text-on-primary text-xl">{data.teamIcon || 'groups'}</span>
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="font-headline text-xl md:text-2xl font-bold text-on-surface truncate">{data.teamTitle} · 團隊協作</h1>
              <p className="text-xs text-on-surface-variant">{new Date(data.createdAt).toLocaleString()} · 唯讀分享</p>
            </div>
          </div>
          {/* Document indicator: full-width tap target on mobile, chip on desktop */}
          {data.docStatus === 'done' && data.docUrl ? (
            <a href={data.docUrl} className="w-full sm:w-auto shrink-0 inline-flex items-center justify-center gap-1.5 px-4 h-11 sm:h-9 rounded-lg text-sm font-bold text-on-primary cyber-gradient hover:opacity-90 transition-opacity no-underline">
              <span className="material-symbols-outlined text-[18px]">download</span>
              下載文件{data.docFormat && DOC_LABELS[data.docFormat] ? `（${DOC_LABELS[data.docFormat]}）` : ''}
            </a>
          ) : data.docStatus === 'pending' ? (
            <span className="w-full sm:w-auto shrink-0 inline-flex items-center justify-center gap-1.5 px-4 h-11 sm:h-9 rounded-lg text-sm font-bold text-tertiary bg-tertiary/10">
              <span className="material-symbols-outlined text-[18px] animate-spin">progress_activity</span>文件生成中…
            </span>
          ) : data.docStatus === 'failed' ? (
            <span className="w-full sm:w-auto shrink-0 inline-flex items-center justify-center gap-1.5 px-4 h-11 sm:h-9 rounded-lg text-sm font-bold text-error bg-error/10" title="文件產生失敗，其餘分析結果仍可查看">
              <span className="material-symbols-outlined text-[18px]">error</span>文件產生失敗
            </span>
          ) : (
            <span className="shrink-0 hidden sm:inline-flex items-center gap-1.5 px-3.5 h-9 rounded-lg text-xs text-on-surface-variant bg-surface-container border border-outline-variant/20">
              <span className="material-symbols-outlined text-[16px]">block</span>此排程無產生文件
            </span>
          )}
        </div>

        {/* Question */}
        <div className="bg-surface-container rounded-2xl border border-outline-variant/15 p-4 mb-6">
          <p className="text-xs font-bold uppercase tracking-wider text-on-surface-variant mb-1">議題</p>
          <p className="text-sm text-on-surface">{data.question}</p>
        </div>

        {/* Members */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          {data.memberOutputs.map(m => (
            <div key={m.memberId} className="flex flex-col bg-surface-container rounded-2xl border border-outline-variant/10 overflow-hidden">
              <div className="flex items-center gap-2 p-3 border-b border-outline-variant/10">
                <div className="w-8 h-8 rounded-lg cyber-gradient flex items-center justify-center shrink-0">
                  <span className="material-symbols-outlined text-on-primary text-base">{m.icon || 'smart_toy'}</span>
                </div>
                <span className="text-sm font-bold text-on-surface truncate flex-1">{m.name}</span>
                <button onClick={() => setExpanded({ title: m.name, icon: m.icon || 'smart_toy', text: m.text + (m.text2 ? `\n\n---\n\n**回應其他成員**\n\n${m.text2}` : '') })}
                  className="w-5 h-5 flex items-center justify-center rounded text-on-surface-variant hover:text-primary hover:bg-primary/10 transition-colors cursor-pointer shrink-0" title="放大檢視">
                  <span className="material-symbols-outlined text-[14px]">open_in_full</span>
                </button>
              </div>
              <div className="relative">
                <div className="p-3 text-xs text-on-surface-variant leading-relaxed max-h-40 overflow-hidden md:max-h-80 md:overflow-y-auto">
                  <TeamMarkdown>{m.text}</TeamMarkdown>
                  {m.text2 && (
                    <div className="mt-3 rounded-lg bg-tertiary/5 border border-tertiary/15 p-2.5">
                      <div className="flex items-center gap-1 text-[11px] font-bold text-tertiary mb-1.5">
                        <span className="material-symbols-outlined text-[13px]">forum</span>回應其他成員
                      </div>
                      <TeamMarkdown>{m.text2}</TeamMarkdown>
                    </div>
                  )}
                </div>
                <button onClick={() => setExpanded({ title: m.name, icon: m.icon || 'smart_toy', text: m.text + (m.text2 ? `\n\n---\n\n**回應其他成員**\n\n${m.text2}` : '') })}
                  className="md:hidden relative w-full flex items-center justify-center gap-1 py-2 text-xs font-bold text-primary border-t border-outline-variant/10 bg-surface-container cursor-pointer">
                  <span className="pointer-events-none absolute -top-7 inset-x-0 h-7 bg-gradient-to-t from-surface-container to-transparent" />
                  查看完整分析<span className="material-symbols-outlined text-[15px]">open_in_full</span>
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Synthesis */}
        {data.result && (
          <div className="bg-surface-container rounded-2xl border border-primary/30 overflow-hidden mb-8">
            <div className="flex items-center gap-2 p-3.5 border-b border-outline-variant/10 bg-primary/5">
              <span className="material-symbols-outlined text-primary">hub</span>
              <span className="font-headline font-bold text-on-surface">協調者統整</span>
              <button onClick={() => setExpanded({ title: '協調者統整', icon: 'hub', text: data.result || '' })}
                className="w-7 h-7 flex items-center justify-center rounded text-on-surface-variant hover:text-primary hover:bg-primary/10 transition-colors cursor-pointer shrink-0 ml-auto" title="放大檢視">
                <span className="material-symbols-outlined text-[18px]">open_in_full</span>
              </button>
            </div>
            <div className="p-5 text-sm text-on-surface leading-relaxed">
              <TeamMarkdown>{data.result}</TeamMarkdown>
            </div>
          </div>
        )}

        <p className="text-center text-xs text-outline">由 AI Agents Office 團隊協作產生</p>
      </main>
    </div>
  );
}
