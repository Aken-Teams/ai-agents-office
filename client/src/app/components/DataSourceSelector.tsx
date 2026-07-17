'use client';

/**
 * Shared "資料源" (data source) multi-select — a Gemini-style dropdown that lets
 * the user grant a run read-access to internal sources (email now, KM later).
 * Used by every surface that kicks off an AI run: dashboard, AI team, (and the
 * chat page has its own inline copy for now). "資料源建一次、多介面共用."
 *
 * Selection is opt-in and explicit — nothing is read unless the user ticks it.
 * The backend resolves the actual credential from the run owner's own token, so
 * a source can only ever reach the signed-in user's own data (no cross-user).
 */

import { useState, useEffect, useRef } from 'react';

export interface DataSource {
  id: string;
  label: string;
  desc: string;
  icon: string;
}

// 'email' / 'km' only resolve in pro-panjit; elsewhere ticking them is a harmless
// no-op (the server can't mint the credential, so nothing is attached). Both read
// ONLY the signed-in user's own permitted data (email via their token, KM via their
// 員編 → KM enforces per-document permission).
export const DATA_SOURCES: DataSource[] = [
  { id: 'email', label: '我的信件', desc: 'Outlook 信箱（只讀自己的）', icon: 'mail' },
  { id: 'km', label: 'KM 知識庫', desc: '知識庫文件（依你的權限）', icon: 'menu_book' },
];

export function DataSourceSelector({
  selected,
  onToggle,
  disabled,
  round,
}: {
  selected: string[];
  onToggle: (id: string) => void;
  disabled?: boolean;
  /** round-full button to blend with pill-shaped toolbars (e.g. AI team) */
  round?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  const active = open || selected.length > 0;
  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        disabled={disabled}
        className={`w-9 h-9 flex items-center justify-center ${round ? 'rounded-full' : 'rounded'} transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${active ? 'bg-primary/15 text-primary' : 'hover:bg-surface-container-high text-on-surface-variant hover:text-primary'}`}
        title="資料源"
      >
        <span className="material-symbols-outlined text-[20px]">database</span>
      </button>
      {open && (
        <div className="absolute bottom-full left-0 mb-1 w-60 bg-surface-container border border-outline-variant/20 rounded-xl shadow-xl overflow-hidden z-50">
          <div className="px-3 py-2 border-b border-outline-variant/10">
            <p className="text-xs font-medium text-on-surface-variant">資料源（可多選）</p>
            <p className="text-[10px] text-on-surface-variant/60 mt-0.5">勾選後，AI 分析時可讀取這些來源</p>
          </div>
          <div className="max-h-48 overflow-y-auto">
            {DATA_SOURCES.map(ds => {
              const isSel = selected.includes(ds.id);
              return (
                <button
                  key={ds.id}
                  type="button"
                  onClick={() => onToggle(ds.id)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-left transition-colors cursor-pointer ${isSel ? 'bg-primary/10' : 'hover:bg-surface-container-high'}`}
                >
                  <span className={`material-symbols-outlined text-sm shrink-0 ${isSel ? 'text-primary' : 'text-on-surface-variant'}`}>{ds.icon}</span>
                  <div className="min-w-0 flex-1">
                    <p className={`text-xs font-medium ${isSel ? 'text-primary' : 'text-on-surface'}`}>{ds.label}</p>
                    <p className="text-[10px] text-on-surface-variant/60 truncate">{ds.desc}</p>
                  </div>
                  {isSel && <span className="material-symbols-outlined text-sm text-primary shrink-0">check</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
