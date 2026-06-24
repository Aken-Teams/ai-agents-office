'use client';

import { ReactNode } from 'react';

/**
 * Lightweight hover tooltip — a styled replacement for the native `title=`
 * attribute (which is slow to appear and unstyled). Wrap any element; the
 * tooltip shows above it on hover. `align` controls horizontal anchoring so
 * tooltips on right-edge buttons grow inward instead of off-screen.
 */
export default function Tooltip({
  label,
  children,
  align = 'center',
  className = '',
}: {
  label: string;
  children: ReactNode;
  align?: 'left' | 'center' | 'right';
  className?: string;
}) {
  const posCls = align === 'right' ? 'right-0' : align === 'left' ? 'left-0' : 'left-1/2 -translate-x-1/2';
  const caretCls = align === 'right' ? 'right-3' : align === 'left' ? 'left-3' : 'left-1/2 -translate-x-1/2';
  return (
    <span className={`relative inline-flex group/tip ${className}`}>
      {children}
      <span
        role="tooltip"
        className={`pointer-events-none absolute bottom-full mb-2 ${posCls} z-[70] opacity-0 translate-y-1 group-hover/tip:opacity-100 group-hover/tip:translate-y-0 transition-all duration-150`}
      >
        <span className="relative block whitespace-nowrap rounded-lg bg-slate-800 text-slate-100 px-2.5 py-1.5 text-[11px] leading-snug shadow-xl ring-1 ring-black/10">
          {label}
          <span className={`absolute top-full ${caretCls} w-2 h-2 -translate-y-1/2 rotate-45 bg-slate-800`} />
        </span>
      </span>
    </span>
  );
}
