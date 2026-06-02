'use client';

import { MouseEvent, ReactNode, useRef, useState } from 'react';
import { CyberPanel } from '../../components/ui';

interface AuthLayoutProps {
  /** 表單區塊內容（左半邊）。 */
  children: ReactNode;
  /** 品牌名稱（右側 panel + 行動裝置 logo 列）。 */
  appName: string;
  /** 副標：例如 "智能文件平台" 或 "Document Generation Platform"。 */
  subtitle: string;
  /** Hero 標題三段式：prefix + highlight + suffix。 */
  heroTitle: {
    prefix: string;
    highlight: string;
    suffix: string;
  };
  /** Hero 描述文字。 */
  heroDescription: string;
  /** 右下角狀態指示文字（會自動加上 [ ... ]）。 */
  statusLabel: string;
  /** 右側 CyberPanel 的大型半透明圖示（material symbol 名）。預設 'smart_toy'。 */
  panelIcon?: string;
}

/**
 * Auth 頁面共用骨架：左表單、右 cyber 品牌面板。
 * 提供一致的雙欄佈局、動畫背景、行動 logo、scanline 效果。
 * 用於 login / register / forgot-password / reset-password 等頁面。
 */
export function AuthLayout({
  children,
  appName,
  subtitle,
  heroTitle,
  heroDescription,
  statusLabel,
  panelIcon = 'smart_toy',
}: AuthLayoutProps) {
  const formRef = useRef<HTMLElement>(null);
  const [blob, setBlob] = useState({ x: 0, y: 0 });
  const [blobActive, setBlobActive] = useState(false);

  const onFormMove = (e: MouseEvent<HTMLElement>) => {
    const rect = formRef.current?.getBoundingClientRect();
    if (!rect) return;
    setBlob({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  return (
    <div className="bg-surface-container-lowest text-on-surface font-body min-h-[100svh] flex flex-col items-center justify-center p-5 md:p-6 overflow-hidden relative selection:bg-primary/30">
      {/* Background atmosphere */}
      <div aria-hidden className="absolute inset-0 bg-pattern pointer-events-none opacity-40" />
      <div aria-hidden className="absolute top-[-10%] right-[-10%] w-[40%] h-[40%] bg-primary/5 rounded-full blur-[120px] pointer-events-none" />
      <div aria-hidden className="absolute bottom-[-5%] left-[-5%] w-[30%] h-[30%] bg-tertiary/5 rounded-full blur-[100px] pointer-events-none" />

      <main className="w-full max-w-6xl flex flex-col md:flex-row gap-0 shadow-[var(--shadow-xl)] z-10 rounded-lg overflow-hidden">
        {/* LEFT: Form section (with mouse-tracking gradient blob) */}
        <section
          ref={formRef}
          onMouseMove={onFormMove}
          onMouseEnter={() => setBlobActive(true)}
          onMouseLeave={() => setBlobActive(false)}
          className="relative flex-1 bg-surface-container-high p-8 md:p-16 flex flex-col justify-center overflow-hidden min-h-[640px]"
        >
          <div
            aria-hidden
            className="absolute pointer-events-none w-[500px] h-[500px] rounded-full blur-3xl transition-opacity duration-[var(--duration-slow)]"
            style={{
              opacity: blobActive ? 0.5 : 0,
              transform: `translate(${blob.x - 250}px, ${blob.y - 250}px)`,
              background:
                'radial-gradient(circle, color-mix(in oklab, var(--color-primary) 28%, transparent) 0%, color-mix(in oklab, var(--color-tertiary) 18%, transparent) 50%, transparent 70%)',
            }}
          />
          <div className="relative max-w-md mx-auto w-full z-10">
            {/* Mobile logo (hidden ≥md) */}
            <div className="md:hidden flex items-center gap-3 mb-8">
              <div className="w-10 h-10 cyber-gradient flex items-center justify-center rounded ring-1 ring-primary/20">
                <span className="material-symbols-outlined text-on-primary">terminal</span>
              </div>
              <div>
                <h1 className="font-headline text-xl font-bold tracking-[var(--tracking-tight)] leading-tight">{appName}</h1>
                <p className="font-mono text-[10px] uppercase tracking-[var(--tracking-cyber)] text-primary mt-0.5">
                  {subtitle}
                </p>
              </div>
            </div>

            {children}
          </div>
        </section>

        {/* RIGHT: Cyber brand panel (hidden on mobile) */}
        <section className="hidden md:flex relative w-1/2 has-scanline">
          <CyberPanel iconName={panelIcon} className="rounded-none">
            <div className="flex flex-col justify-between h-full w-full p-12 text-on-primary">
              <div className="space-y-12">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 bg-on-primary/15 backdrop-blur-sm flex items-center justify-center rounded ring-1 ring-on-primary/20">
                    <span className="material-symbols-outlined text-on-primary">terminal</span>
                  </div>
                  <div>
                    <h1 className="font-headline text-[var(--text-2xl)] font-bold leading-tight tracking-[var(--tracking-tight)]">
                      {appName}
                    </h1>
                    <p className="font-mono text-[var(--text-xs)] uppercase tracking-[var(--tracking-cyber)] text-on-primary/75 mt-0.5">
                      {subtitle}
                    </p>
                  </div>
                </div>

                <div className="space-y-5 mt-12">
                  <h2 className="font-headline text-[var(--text-3xl)] font-light leading-[1.15] tracking-[var(--tracking-tight)]">
                    {heroTitle.prefix}
                    <span className="font-medium">{heroTitle.highlight}</span>
                    <br />
                    {heroTitle.suffix}
                  </h2>
                  <p className="font-body leading-relaxed max-w-md text-on-primary/80 text-[var(--text-sm)]">
                    {heroDescription}
                  </p>
                </div>
              </div>

              <div className="space-y-3">
                <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-sm border border-on-primary/25 bg-on-primary/10 backdrop-blur-sm font-mono text-[var(--text-xs)] uppercase tracking-[var(--tracking-cyber)]">
                  <span className="relative flex h-1.5 w-1.5">
                    <span aria-hidden className="absolute inline-flex h-full w-full rounded-full bg-on-primary opacity-60 animate-ping" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-on-primary" />
                  </span>
                  <span className="text-on-primary/90">[ {statusLabel} ]</span>
                </div>
                <div className="flex gap-1">
                  <div className="h-0.5 w-12 bg-on-primary" />
                  <div className="h-0.5 w-6 bg-on-primary/50" />
                  <div className="h-0.5 w-3 bg-on-primary/30" />
                </div>
              </div>
            </div>
          </CyberPanel>
        </section>
      </main>
    </div>
  );
}
