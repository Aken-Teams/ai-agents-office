'use client';

import { useEffect, useState } from 'react';

const POLL_MS = 10_000;

type Level = 'low' | 'medium' | 'high';
interface SlotStats { active: number; max: number; queued: number }
interface Pressure {
  level: Level;
  score: number;
  reason: string;
  gates: { document: SlotStats; email: SlotStats; background: SlotStats };
  memory: { rssMb: number; heapUsedMb: number; heapLimitMb: number; heapPct: number };
  eventLoopLagMs: number;
  requests: { inFlight: number; peakInFlight: number; p50Ms: number; p95Ms: number };
  uptimeSec: number;
}

const LEVEL_STYLE: Record<Level, { dot: string; text: string; ring: string }> = {
  low:    { dot: 'bg-emerald-500', text: 'text-on-surface-variant', ring: 'ring-emerald-500/20' },
  medium: { dot: 'bg-amber-500',   text: 'text-amber-600',          ring: 'ring-amber-500/25' },
  high:   { dot: 'bg-red-500',     text: 'text-red-600',            ring: 'ring-red-500/25' },
};

function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小時`;
  if (h > 0) return `${h} 小時 ${m} 分`;
  return `${m} 分`;
}

/** One gate row: "4/4" plus the queue, which is what actually means "users are waiting". */
function GateRow({ label, s }: { label: string; s: SlotStats }) {
  const full = s.active >= s.max;
  return (
    <div className="flex items-center justify-between gap-6 py-1">
      <span className="text-on-surface-variant">{label}</span>
      <span className="flex items-center gap-2 tabular-nums">
        <span className={full ? 'text-amber-600 font-medium' : 'text-on-surface'}>
          {s.active}/{s.max}
        </span>
        {s.queued > 0 && (
          <span className="text-red-600 text-[11px]">· {s.queued} 排隊</span>
        )}
      </span>
    </div>
  );
}

export default function SystemPressureBar() {
  const [p, setP] = useState<Pressure | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      // Don't poll a load indicator while nobody is looking at it — the polling
      // would otherwise show up as load in the very number it reports.
      if (typeof document !== 'undefined' && document.hidden) {
        timer = setTimeout(tick, POLL_MS);
        return;
      }
      try {
        const token = localStorage.getItem('token');
        const res = await fetch('/api/admin/system/pressure', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(String(res.status));
        const data: Pressure = await res.json();
        if (!cancelled) { setP(data); setFailed(false); }
      } catch {
        // Keep the last good reading on screen rather than blanking the bar; a
        // transient failure is not the same as "no pressure".
        if (!cancelled) setFailed(true);
      }
      if (!cancelled) timer = setTimeout(tick, POLL_MS);
    };

    tick();
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  if (!p) return null;

  const style = LEVEL_STYLE[p.level];

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-headline
                    hover:bg-surface-container transition-colors cursor-pointer ${style.text}`}
        title="系統壓力"
      >
        <span className={`relative flex w-2 h-2`}>
          {p.level === 'high' && (
            <span className={`absolute inline-flex w-full h-full rounded-full opacity-60 animate-ping ${style.dot}`} />
          )}
          <span className={`relative inline-flex w-2 h-2 rounded-full ring-4 ${style.dot} ${style.ring}`} />
        </span>
        <span className="hidden sm:inline">{p.reason}</span>
        {failed && <span className="text-on-surface-variant/60 text-[11px]">(連線中斷)</span>}
      </button>

      {open && (
        <div
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          className="absolute right-0 top-full mt-1 w-72 z-50 rounded-xl border border-outline-variant/20
                     bg-surface-dim shadow-lg p-3 text-xs font-headline"
        >
          <div className="flex items-center justify-between mb-2">
            <span className="font-medium text-on-surface">系統壓力</span>
            <span className={`tabular-nums ${style.text}`}>{p.score}/100</span>
          </div>

          <div className="text-[11px] text-on-surface-variant/70 mb-1">AI 併發閘門</div>
          <GateRow label="文件生成" s={p.gates.document} />
          <GateRow label="信件助手" s={p.gates.email} />
          <GateRow label="背景作業" s={p.gates.background} />

          <div className="h-px bg-outline-variant/20 my-2" />

          <div className="text-[11px] text-on-surface-variant/70 mb-1">請求</div>
          <div className="flex items-center justify-between py-1">
            <span className="text-on-surface-variant">處理中</span>
            <span className="tabular-nums text-on-surface">
              {p.requests.inFlight}
              {p.requests.peakInFlight > p.requests.inFlight && (
                <span className="text-on-surface-variant/60"> · 尖峰 {p.requests.peakInFlight}</span>
              )}
            </span>
          </div>
          <div className="flex items-center justify-between py-1">
            <span className="text-on-surface-variant">回應延遲</span>
            <span className={`tabular-nums ${p.requests.p95Ms > 500 ? 'text-red-600' : p.requests.p95Ms > 100 ? 'text-amber-600' : 'text-on-surface'}`}>
              {Math.round(p.requests.p50Ms)} / {Math.round(p.requests.p95Ms)} ms
              <span className="text-on-surface-variant/60 text-[10px]"> p50/p95</span>
            </span>
          </div>

          <div className="h-px bg-outline-variant/20 my-2" />

          <div className="text-[11px] text-on-surface-variant/70 mb-1">伺服器</div>
          <div className="flex items-center justify-between py-1">
            <span className="text-on-surface-variant">記憶體</span>
            <span className="tabular-nums text-on-surface">
              {p.memory.rssMb} MB
              <span className="text-on-surface-variant/60"> · heap {p.memory.heapPct}%</span>
            </span>
          </div>
          <div className="flex items-center justify-between py-1">
            <span className="text-on-surface-variant">事件循環延遲</span>
            <span className={`tabular-nums ${p.eventLoopLagMs > 100 ? 'text-red-600' : p.eventLoopLagMs > 20 ? 'text-amber-600' : 'text-on-surface'}`}>
              {p.eventLoopLagMs} ms
            </span>
          </div>
          <div className="flex items-center justify-between py-1">
            <span className="text-on-surface-variant">已運行</span>
            <span className="tabular-nums text-on-surface">{fmtUptime(p.uptimeSec)}</span>
          </div>
        </div>
      )}
    </div>
  );
}
