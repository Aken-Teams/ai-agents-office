'use client';

import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

/**
 * Fully-custom dropdown. A native <select>'s open list is drawn by the OS (cramped,
 * unstyleable), and an in-flow popup gets clipped by a scroll container's overflow.
 * So the menu is rendered in a portal on <body> with fixed positioning — it always
 * floats above the window, matches the app's styling, and sizes to its content.
 *
 * `compact` shrinks the trigger padding for dense toolbars (e.g. a filter chip).
 */
export default function Dropdown({ value, onChange, options, className, compact }: {
  value: string | number;
  onChange: (v: string) => void;
  options: { value: string | number; label: string }[];
  className?: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const b = btnRef.current?.getBoundingClientRect();
      if (b) setPos({ top: b.bottom + 4, left: b.left, width: b.width });
    };
    place();
    const onDoc = (e: MouseEvent) => {
      if (btnRef.current?.contains(e.target as Node) || menuRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    // Re-anchoring on every scroll is fiddly; closing keeps the menu from drifting.
    const close = () => setOpen(false);
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => { document.removeEventListener('mousedown', onDoc); window.removeEventListener('resize', close); window.removeEventListener('scroll', close, true); };
  }, [open]);

  const sel = options.find(o => String(o.value) === String(value));
  return (
    <div className={`relative ${className || ''}`}>
      <button ref={btnRef} type="button" onClick={() => setOpen(o => !o)}
        className={`w-full flex items-center justify-between gap-1.5 bg-surface-container border border-outline-variant/30 rounded-lg text-on-surface focus:outline-none focus:border-primary hover:border-outline-variant/50 transition-colors cursor-pointer ${compact ? 'pl-3 pr-2 py-1.5 text-xs' : 'pl-3 pr-2 py-2.5 text-sm'}`}>
        <span className="truncate">{sel?.label ?? ''}</span>
        <span className={`material-symbols-outlined text-on-surface-variant shrink-0 transition-transform ${compact ? 'text-[16px]' : 'text-[18px]'} ${open ? 'rotate-180' : ''}`}>expand_more</span>
      </button>
      {open && pos && createPortal(
        <div ref={menuRef} style={{ position: 'fixed', top: pos.top, left: pos.left, minWidth: pos.width, zIndex: 100 }}
          className="max-h-64 overflow-y-auto rounded-xl border border-outline-variant/30 bg-surface-container-lowest shadow-2xl py-1">
          {options.map(o => {
            const active = String(o.value) === String(value);
            return (
              <button key={String(o.value)} type="button" onClick={() => { onChange(String(o.value)); setOpen(false); }}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors cursor-pointer ${active ? 'text-primary font-bold bg-primary/10' : 'text-on-surface hover:bg-surface-container'}`}>
                <span className="flex-1 truncate">{o.label}</span>
                {active && <span className="material-symbols-outlined text-[16px] shrink-0">check</span>}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}
