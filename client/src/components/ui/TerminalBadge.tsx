'use client';

import { HTMLAttributes, ReactNode } from 'react';

type Tone = 'primary' | 'success' | 'warning' | 'danger' | 'neutral';

interface TerminalBadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  children: ReactNode;
  tone?: Tone;
  /** 左側方括號前綴，預設 '$'。傳 '' 隱藏。 */
  prefix?: string;
  /** 是否顯示左側脈動圓點（status indicator 風格）。 */
  pulse?: boolean;
}

const TONE_CLASS: Record<Tone, string> = {
  primary: 'text-primary border-primary/30 bg-primary/8',
  success: 'text-[color:var(--th-success)] border-[color:var(--th-success)]/30 bg-[color:var(--th-success)]/10',
  warning: 'text-[color:var(--th-warning)] border-[color:var(--th-warning)]/30 bg-[color:var(--th-warning)]/10',
  danger:  'text-error border-error/30 bg-error/10',
  neutral: 'text-on-surface-variant border-outline-variant/40 bg-surface-container-high',
};

const PULSE_TONE: Record<Tone, string> = {
  primary: 'bg-primary',
  success: 'bg-[color:var(--th-success)]',
  warning: 'bg-[color:var(--th-warning)]',
  danger:  'bg-error',
  neutral: 'bg-on-surface-variant',
};

/**
 * 終端機風格 chip / 狀態小標。font-mono + uppercase + 主色描邊。
 * 用於 status pills、type badges、quick attribute 顯示。
 */
export function TerminalBadge({
  children,
  tone = 'primary',
  prefix = '$',
  pulse = false,
  className = '',
  ...rest
}: TerminalBadgeProps) {
  return (
    <span
      className={[
        'inline-flex items-center gap-1.5',
        'font-mono text-xs uppercase tracking-[var(--tracking-cyber)]',
        'px-2 py-0.5 rounded-sm border',
        TONE_CLASS[tone],
        className,
      ].join(' ')}
      {...rest}
    >
      {pulse && (
        <span aria-hidden className="relative flex h-1.5 w-1.5">
          <span className={`absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping ${PULSE_TONE[tone]}`} />
          <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${PULSE_TONE[tone]}`} />
        </span>
      )}
      {prefix && <span aria-hidden className="opacity-60">{prefix}</span>}
      <span>{children}</span>
    </span>
  );
}
