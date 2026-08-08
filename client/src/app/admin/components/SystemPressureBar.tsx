'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

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

const LEVEL_STYLE: Record<Level, { dot: string; text: string; ring: string; iconText: string }> = {
  low:    { dot: 'bg-emerald-500', text: 'text-on-surface-variant', ring: 'ring-emerald-500/20', iconText: 'text-emerald-500' },
  medium: { dot: 'bg-amber-500',   text: 'text-amber-600',          ring: 'ring-amber-500/25', iconText: 'text-amber-500' },
  high:   { dot: 'bg-red-500',     text: 'text-red-600',            ring: 'ring-red-500/25', iconText: 'text-red-500' },
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

export default function SystemPressureBar({ compact = false }: { compact?: boolean }) {
  const [p, setP] = useState<Pressure | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // The popup renders in a PORTAL (document.body) with FIXED positioning so it escapes
  // the sidebar's stacking/overflow context. From the left sidebar it flies out to the
  // RIGHT of the button, vertically clamped so a tall popup near the sidebar bottom
  // still fits on screen.
  const openPopup = () => {
    clearTimeout(closeTimer.current);
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({
      left: Math.min(r.right + 8, window.innerWidth - 288 - 8),   // 288 = w-72; keep on screen
      top: Math.max(8, Math.min(r.top, window.innerHeight - 430)),
    });
    setOpen(true);
  };
  const closeSoon = () => { closeTimer.current = setTimeout(() => setOpen(false), 120); };

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
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => (open ? setOpen(false) : openPopup())}
        onMouseEnter={openPopup}
        onMouseLeave={closeSoon}
        className={`flex items-center gap-3 py-2 rounded-lg w-full text-sm transition-colors cursor-pointer
                    text-on-surface-variant hover:text-on-surface hover:bg-surface-container/50
                    ${compact ? 'justify-center px-0' : 'px-3'}`}
        title={compact ? `系統壓力 · ${p.reason}` : undefined}
      >
        <span className="relative flex items-center justify-center shrink-0">
          <span className={`material-symbols-outlined text-[20px] ${style.iconText}`}>monitoring</span>
          {p.level === 'high' && (
            <span className={`absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full ${style.dot} animate-ping`} />
          )}
        </span>
        {!compact && <span className="truncate">{p.reason}</span>}
        {!compact && failed && <span className="text-on-surface-variant/60 text-[11px] shrink-0">(連線中斷)</span>}
      </button>

      {open && createPortal(
        <div
          onMouseEnter={() => clearTimeout(closeTimer.current)}
          onMouseLeave={closeSoon}
          style={{ position: 'fixed', top: pos.top, left: pos.left }}
          className="w-72 z-[100] rounded-xl border border-outline-variant/20 overflow-hidden
                     bg-surface-container-highest shadow-2xl text-xs font-headline"
        >
          {/* Header bar — matches the admin card header style */}
          <div className="flex items-center gap-2 px-4 py-3 bg-surface-container-high">
            <span className="material-symbols-outlined text-primary text-[20px]">speed</span>
            <span className="flex-1 text-sm font-bold text-on-surface">系統壓力</span>
            <span className={`tabular-nums text-sm font-bold ${style.text}`}>
              {p.score}<span className="text-on-surface-variant/50 text-[11px] font-normal">/100</span>
            </span>
          </div>

          <div className="p-3">
          <div className="text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-wider mb-1">AI 併發閘門</div>
          <GateRow label="文件生成" s={p.gates.document} />
          <GateRow label="信件助手" s={p.gates.email} />
          <GateRow label="背景作業" s={p.gates.background} />

          <div className="h-px bg-outline-variant/10 my-2.5" />

          <div className="text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-wider mb-1">請求</div>
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

          <div className="h-px bg-outline-variant/10 my-2.5" />

          <div className="text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-wider mb-1">伺服器</div>
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
        </div>,
        document.body,
      )}
    </>
  );
}
