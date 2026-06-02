'use client';

import { HTMLAttributes, ReactNode } from 'react';
import { useMouseGlow } from './useMouseGlow';

interface SurfaceCardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  children: ReactNode;
  /** 滑鼠 hover 時顯示 cyber 邊光。給 dashboard/admin 卡片使用。預設 false。 */
  glow?: boolean;
  padded?: boolean;
}

/**
 * 統一的卡片容器:Material Design 3 surface-container-high + outline-variant 邊。
 * glow=true 啟用滑鼠跟隨 cyan 邊光,適合 dashboard 互動性卡片。
 */
export function SurfaceCard({
  children,
  glow = false,
  padded = true,
  className = '',
  ...rest
}: SurfaceCardProps) {
  const { ref, pos, active, bind } = useMouseGlow();
  const padding = padded ? 'p-6' : '';
  const base = 'relative rounded-lg bg-surface-container-high border border-outline-variant/30 ' + padding + ' ' + className;

  if (!glow) {
    return (
      <div className={base} {...rest}>
        {children}
      </div>
    );
  }

  return (
    <div ref={ref} className={base + ' overflow-hidden transition-colors hover:border-primary/30'} {...bind} {...rest}>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 transition-opacity duration-200"
        style={{
          opacity: active ? 1 : 0,
          background: `radial-gradient(180px circle at ${pos.x}px ${pos.y}px, color-mix(in oklab, var(--color-primary) 12%, transparent), transparent 60%)`,
        }}
      />
      <div className="relative z-10">{children}</div>
    </div>
  );
}
