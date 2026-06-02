'use client';

/**
 * Editorial-style LINE QR hero panel.
 *
 * Fetches a one-shot invite QR from /api/auth/line-qr and renders it as the
 * primary entry point of the auth pages. The visual language matches the
 * 文清 / warm-parchment brand established by the LINE rich-menu (Noto Serif TC
 * + IBM Plex Mono on #FCFAF7). Email/Google sign-in lives below this panel
 * as a secondary, collapsible option — see login/page.tsx and
 * register/page.tsx for the wrapping flow.
 */

import { useEffect, useState, useCallback } from 'react';

interface QrResponse {
  code: string;
  lineUrl: string;
  qrDataUrl: string;
}

interface Props {
  /** Hero heading, Chinese, e.g. 「快速登入」 / 「快速註冊」. */
  title: string;
  /** Single sentence above the QR, sets context (mono caption styling). */
  caption: string;
  /** Short instruction below the QR, mono uppercase. */
  hint?: string;
}

export function LineQrPanel({ title, caption, hint = 'SCAN · TAP SEND · RETURN HERE' }: Props) {
  const [data, setData] = useState<QrResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchQr = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch('/api/auth/line-qr');
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setData(await res.json());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchQr(); }, [fetchQr]);

  return (
    <section
      className="flex flex-col items-center gap-6 md:gap-8"
      aria-labelledby="qr-hero-title"
    >
      {/* Eyebrow caption — IBM Plex Mono, wide tracking, small uppercase. */}
      <p className="text-[11px] md:text-xs uppercase tracking-[0.4em] text-[#8B7D6A] font-[var(--font-editorial-mono)]">
        {caption}
      </p>

      {/* Hero heading — Noto Serif TC, single line, generous letter-spacing. */}
      <h1
        id="qr-hero-title"
        className="text-[44px] md:text-[64px] leading-none font-[var(--font-editorial-serif)] font-medium text-[#1F1B16] tracking-[0.08em]"
      >
        {title}
      </h1>

      {/* Hairline divider — 1px parchment-grey. */}
      <div aria-hidden className="w-24 h-px bg-[#D9D3C5]" />

      {/* QR canvas — clean, framed, no decorative chrome. */}
      <div className="relative w-[280px] h-[280px] md:w-[320px] md:h-[320px] bg-[#FCFAF7] border border-[#D9D3C5]/60 flex items-center justify-center">
        {loading ? (
          <div className="w-8 h-8 border-2 border-[#1F1B16]/15 border-t-[#1F1B16] rounded-full animate-spin" />
        ) : error ? (
          <div className="text-center px-4 space-y-2">
            <p className="text-xs text-[#8B2635] font-[var(--font-editorial-mono)]">{error}</p>
            <button
              onClick={fetchQr}
              className="text-[11px] uppercase tracking-[0.3em] text-[#1F1B16] underline underline-offset-4 cursor-pointer"
            >
              Try Again
            </button>
          </div>
        ) : data ? (
          <img src={data.qrDataUrl} alt="LINE 登入 QR Code" className="w-[88%] h-[88%] object-contain" />
        ) : null}
      </div>

      {/* Mono hint — instructions in a wayfinding-label style. */}
      <p className="text-[10px] md:text-[11px] uppercase tracking-[0.45em] text-[#8B7D6A] font-[var(--font-editorial-mono)] text-center">
        {hint}
      </p>

      {/* Invite-code receipt — quiet, mechanical, easy to copy. */}
      {data && (
        <div className="flex items-baseline gap-3 font-[var(--font-editorial-mono)]">
          <span className="text-[10px] uppercase tracking-[0.3em] text-[#8B7D6A]/70">
            Invite
          </span>
          <span className="text-[13px] text-[#1F1B16] tracking-[0.18em]">
            {data.code}
          </span>
          {data.lineUrl && (
            <a
              href={data.lineUrl}
              className="text-[10px] uppercase tracking-[0.3em] text-[#1F1B16]/60 underline underline-offset-2 hover:text-[#1F1B16] transition-colors"
            >
              Open in LINE
            </a>
          )}
        </div>
      )}
    </section>
  );
}
