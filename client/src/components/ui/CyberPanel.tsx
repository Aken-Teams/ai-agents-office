'use client';

import { ReactNode } from 'react';

interface CyberPanelProps {
  children?: ReactNode;
  /** 大型半透明 material icon overlay (e.g. "smart_toy")。傳空字串隱藏。 */
  iconName?: string;
  /** 額外右側內容裝飾 (浮動小圓點等)。預設 true。 */
  showFloaters?: boolean;
  className?: string;
}

/**
 * 右側 cyber-gradient 設計面板:點陣紋 + 兩個發光圓 + 浮動小點 + 大 icon overlay。
 * 用於 auth pages、onboarding、hero areas 等需要視覺重量的場景。
 */
export function CyberPanel({
  children,
  iconName = 'smart_toy',
  showFloaters = true,
  className = '',
}: CyberPanelProps) {
  return (
    <div className={'relative h-full w-full overflow-hidden rounded-lg ' + className}>
      <div aria-hidden className="absolute inset-0 cyber-gradient" />

      {/* 點陣紋 */}
      <div
        aria-hidden
        className="absolute inset-0 opacity-20"
        style={{
          backgroundImage:
            'radial-gradient(circle at 1px 1px, rgba(255,255,255,0.5) 1px, transparent 0)',
          backgroundSize: '24px 24px',
        }}
      />

      {/* 兩個發光圓 */}
      <div
        aria-hidden
        className="absolute -top-32 -right-32 w-96 h-96 rounded-full bg-on-primary/10 blur-3xl"
      />
      <div
        aria-hidden
        className="absolute -bottom-24 -left-24 w-72 h-72 rounded-full bg-on-primary/15 blur-3xl"
      />

      {/* 浮動小圓點 */}
      {showFloaters && (
        <>
          <div aria-hidden className="absolute top-12 right-16 w-2 h-2 rounded-full bg-on-primary/60 animate-pulse" />
          <div aria-hidden className="absolute top-1/3 right-8 w-1.5 h-1.5 rounded-full bg-on-primary/50" />
          <div aria-hidden className="absolute bottom-24 right-24 w-1 h-1 rounded-full bg-on-primary/40" />
        </>
      )}

      {/* 大型半透明 icon overlay */}
      {iconName && (
        <div
          aria-hidden
          className="pointer-events-none absolute right-[-30px] top-[40%] -translate-y-1/2 opacity-15"
        >
          <span className="material-symbols-outlined text-on-primary" style={{ fontSize: '160px' }}>
            {iconName}
          </span>
        </div>
      )}

      {/* 內容 slot */}
      {children && <div className="relative z-10 h-full w-full">{children}</div>}
    </div>
  );
}
