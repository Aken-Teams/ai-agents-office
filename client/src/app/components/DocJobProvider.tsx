'use client';

/**
 * Global background document-generation job.
 *
 * Team document generation takes 1–3 min (a doc-gen agent runs server-side). This
 * provider lives at the ROOT layout so the job — its polling loop AND its progress
 * pill — survive navigating between pages. The running job's id is also persisted to
 * localStorage so a full page reload resumes polling instead of losing the job.
 */

import { createContext, useContext, useState, useRef, useCallback, useEffect } from 'react';

const SSE_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';
const LS_KEY = 'docExportJob';

export type DocJobState = {
  teamId: string;
  runId: string;
  format: string;
  label: string;
  jobId?: string;
  status: 'running' | 'done' | 'error';
  stage: string;
  error?: string;
};

type StartArgs = { teamId: string; runId: string; format: string; stylePrompt: string; label: string };

type DocJobCtx = {
  job: DocJobState | null;
  jobRunning: boolean;
  startDocExport: (a: StartArgs) => void;
  dismissDocJob: () => void;
};

const DocJobContext = createContext<DocJobCtx | null>(null);

export function useDocJob(): DocJobCtx {
  const c = useContext(DocJobContext);
  if (!c) throw new Error('useDocJob must be used within DocJobProvider');
  return c;
}

function authHeaders(): HeadersInit {
  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function persist(j: DocJobState | null) {
  try {
    if (j && j.status === 'running' && j.jobId) localStorage.setItem(LS_KEY, JSON.stringify(j));
    else localStorage.removeItem(LS_KEY);
  } catch { /* ignore */ }
}

export function DocJobProvider({ children }: { children: React.ReactNode }) {
  const [job, setJob] = useState<DocJobState | null>(null);
  const cancelRef = useRef(false);
  const runningRef = useRef(false); // guards against two concurrent loops

  // Poll an already-created job to completion, then download. Caller must have set
  // runningRef.current = true; this clears it in the finally.
  const pollAndDownload = useCallback(async (state: DocJobState) => {
    const { teamId, runId, format, jobId } = state;
    // Generous cap: a first-time export runs the formal report (1–3 min) then the
    // doc-gen agent (PPTX can take 5–8 min). Give the server room before giving up.
    const deadline = Date.now() + 25 * 60_000;
    try {
      for (;;) {
        if (cancelRef.current) return;
        if (Date.now() > deadline) throw new Error('產生逾時，請稍後再試');
        await new Promise(r => setTimeout(r, 3000));
        if (cancelRef.current) return;
        const st = await fetch(`${SSE_BASE}/api/teams/${teamId}/runs/${runId}/document/${jobId}/status`, { headers: authHeaders() });
        if (!st.ok) throw new Error(`狀態查詢失敗 (${st.status})`);
        const d = await st.json() as { status: string; error?: string };
        if (d.status === 'error') throw new Error(d.error || '產生失敗');
        if (d.status === 'done') break;
      }
      if (cancelRef.current) return;
      setJob(j => j ? { ...j, stage: '下載中…' } : j);
      const dl = await fetch(`${SSE_BASE}/api/teams/${teamId}/runs/${runId}/document/${jobId}/download`, { headers: authHeaders() });
      if (!dl.ok) throw new Error(`下載失敗 (${dl.status})`);
      const blob = await dl.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `團隊報告.${format}`; a.click();
      URL.revokeObjectURL(url);
      if (cancelRef.current) return;
      setJob(j => { const next = j ? { ...j, status: 'done' as const, stage: '已完成，檔案已下載' } : j; persist(next); return next; });
      setTimeout(() => setJob(j => (j && j.status === 'done') ? null : j), 8000);
    } catch (e) {
      if (cancelRef.current) return;
      setJob(j => { const next = j ? { ...j, status: 'error' as const, error: e instanceof Error ? e.message : '產生失敗' } : j; persist(next); return next; });
    } finally {
      runningRef.current = false;
    }
  }, []);

  const startDocExport = useCallback(async (a: StartArgs) => {
    if (runningRef.current) return; // one at a time
    runningRef.current = true;
    cancelRef.current = false;
    const base: DocJobState = { teamId: a.teamId, runId: a.runId, format: a.format, label: a.label, status: 'running', stage: a.format === 'pptx' ? 'AI 正在製作簡報，約需 3–8 分鐘…' : 'AI 正在依報告內容產生文件，約需 2–5 分鐘…' };
    setJob(base);
    try {
      const startRes = await fetch(`${SSE_BASE}/api/teams/${a.teamId}/runs/${a.runId}/document`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ format: a.format, stylePrompt: a.stylePrompt }),
      });
      if (!startRes.ok) throw new Error(`啟動失敗 (${startRes.status})`);
      const { jobId } = await startRes.json();
      const withId: DocJobState = { ...base, jobId };
      setJob(withId); persist(withId);
      await pollAndDownload(withId); // clears runningRef in its finally
    } catch (e) {
      runningRef.current = false;
      setJob(j => { const next = j ? { ...j, status: 'error' as const, error: e instanceof Error ? e.message : '產生失敗' } : j; persist(next); return next; });
    }
  }, [pollAndDownload]);

  const dismissDocJob = useCallback(() => {
    cancelRef.current = true;
    runningRef.current = false;
    setJob(null);
    try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
  }, []);

  // Resume an in-flight job after a full page reload.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as DocJobState;
      if (saved && saved.status === 'running' && saved.jobId && !runningRef.current) {
        runningRef.current = true;
        cancelRef.current = false;
        setJob({ ...saved, stage: '繼續產生中…' });
        pollAndDownload(saved);
      }
    } catch { /* ignore */ }
  }, [pollAndDownload]);

  return (
    <DocJobContext.Provider value={{ job, jobRunning: job?.status === 'running', startDocExport, dismissDocJob }}>
      {children}
      {job && <DocJobPill job={job} onDismiss={dismissDocJob} />}
    </DocJobContext.Provider>
  );
}

// Small floating progress card for the background document-generation job.
function DocJobPill({ job, onDismiss }: { job: DocJobState; onDismiss: () => void }) {
  const running = job.status === 'running';
  const done = job.status === 'done';
  return (
    <div className="fixed bottom-4 right-4 z-[200] w-[300px] bg-surface border border-outline-variant/20 rounded-xl shadow-2xl overflow-hidden">
      <div className="flex items-start gap-2.5 p-3.5">
        <span className={`material-symbols-outlined text-[20px] ${done ? 'text-success' : running ? 'text-primary animate-spin' : 'text-error'}`}>
          {done ? 'check_circle' : running ? 'progress_activity' : 'error'}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-black text-on-surface truncate">{job.label}</p>
          <p className={`text-[11px] mt-0.5 ${done ? 'text-success' : running ? 'text-on-surface-variant' : 'text-error'}`}>
            {job.status === 'error' ? (job.error || '產生失敗') : job.stage}
          </p>
        </div>
        <button onClick={onDismiss} className="text-on-surface-variant hover:text-on-surface cursor-pointer shrink-0" title={running ? '取消' : '關閉'}>
          <span className="material-symbols-outlined text-[18px]">close</span>
        </button>
      </div>
      {running && <div className="h-0.5 bg-primary/20 overflow-hidden"><div className="h-full w-full bg-primary/70 animate-pulse" /></div>}
    </div>
  );
}
