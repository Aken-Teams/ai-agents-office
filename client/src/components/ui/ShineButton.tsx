'use client';

import { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'outline' | 'danger' | 'terminal' | 'ghost';
type Size = 'sm' | 'md' | 'lg';

interface ShineButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  children: ReactNode;
  variant?: Variant;
  size?: Size;
  /** 不要 100% 寬度，預設 true。 */
  fullWidth?: boolean;
  /** terminal variant 的左側前綴，預設 '>_'。 */
  prefix?: string;
}

const VARIANT_CLASS: Record<Variant, string> = {
  primary:  'cyber-gradient text-on-primary shadow-[var(--shadow-glow-sm)]',
  outline:  'bg-transparent text-on-surface border border-outline-variant/40 hover:border-primary/50 hover:text-primary',
  danger:   'bg-error text-on-error shadow-[var(--shadow-md)]',
  terminal: 'bg-surface-container-lowest text-primary border border-dashed border-primary/40 hover:border-primary/80 hover:bg-surface-container-low font-mono normal-case tracking-[var(--tracking-wide)] hover:shadow-[var(--shadow-glow-sm)]',
  ghost:    'bg-transparent text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high',
};

const SIZE_CLASS: Record<Size, string> = {
  sm: 'py-2.5 px-4 text-xs',
  md: 'py-3.5 px-5 text-sm',
  lg: 'py-4 px-6 text-sm',
};

export function ShineButton({
  children,
  variant = 'primary',
  size = 'lg',
  fullWidth = true,
  prefix = '>_',
  type = 'submit',
  className = '',
  ...rest
}: ShineButtonProps) {
  const base =
    'group/shine relative inline-flex justify-center items-center overflow-hidden rounded-sm font-headline font-bold uppercase tracking-widest transition-all duration-[var(--duration-normal)] [transition-timing-function:var(--ease-cyber)] hover:brightness-110 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed';
  const width = fullWidth ? 'w-full' : '';
  const isShineable = variant === 'primary' || variant === 'danger';

  return (
    <button
      type={type}
      className={[base, width, SIZE_CLASS[size], VARIANT_CLASS[variant], className].filter(Boolean).join(' ')}
      {...rest}
    >
      {variant === 'terminal' && (
        <span aria-hidden className="font-bold text-primary/90 mr-2">{prefix}</span>
      )}
      <span className="relative z-10">{children}</span>
      {isShineable && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 flex h-full w-full justify-center [transform:skew(-13deg)_translateX(-150%)] group-hover/shine:duration-1000 group-hover/shine:[transform:skew(-13deg)_translateX(150%)] transition-transform"
        >
          <span className="relative h-full w-12 bg-white/25" />
        </span>
      )}
    </button>
  );
}
