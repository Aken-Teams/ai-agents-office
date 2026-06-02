'use client';

import { InputHTMLAttributes, ReactNode } from 'react';
import { useMouseGlow } from './useMouseGlow';

interface AppInputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  icon?: ReactNode;
  containerClassName?: string;
}

export function AppInput({
  label,
  icon,
  className = '',
  containerClassName = '',
  ...rest
}: AppInputProps) {
  const { ref, pos, active, bind } = useMouseGlow();

  return (
    <div className={`w-full relative ${containerClassName}`}>
      {label && (
        <label className="font-label text-xs uppercase tracking-[var(--tracking-cyber)] text-on-surface-variant ml-1 mb-1.5 block">
          {label}
        </label>
      )}
      <div
        ref={ref}
        className="relative w-full"
        {...bind}
        onFocus={() => bind.onMouseEnter()}
        onBlur={() => bind.onMouseLeave()}
      >
        <input
          {...rest}
          className={
            'peer relative z-10 h-12 w-full rounded border border-outline-variant/30 bg-surface-container-highest px-4 text-on-surface text-base md:text-sm font-body outline-none transition-colors duration-[var(--duration-normal)] [transition-timing-function:var(--ease-snap)] placeholder:text-outline focus:border-primary/50 ' +
            className
          }
        />

        <div
          aria-hidden
          className="pointer-events-none absolute top-0 left-0 right-0 h-[2px] z-20 rounded-t overflow-hidden transition-opacity duration-[var(--duration-normal)]"
          style={{
            opacity: active ? 1 : 0,
            background: `radial-gradient(40px circle at ${pos.x}px 0px, var(--color-primary) 0%, transparent 70%)`,
          }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute bottom-0 left-0 right-0 h-[2px] z-20 rounded-b overflow-hidden transition-opacity duration-[var(--duration-normal)]"
          style={{
            opacity: active ? 1 : 0,
            background: `radial-gradient(40px circle at ${pos.x}px 2px, var(--color-primary) 0%, transparent 70%)`,
          }}
        />

        {icon && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2 z-20 text-on-surface-variant">
            {icon}
          </div>
        )}
      </div>
    </div>
  );
}
