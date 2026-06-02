'use client';

/**
 * "Bind my account to LINE" QR panel.
 *
 * Fetches a one-shot bind QR from /api/auth/line-bind-qr (authenticated) and
 * renders it. The logged-in user scans it, taps Send on the pre-filled
 * `/link <token>` message inside LINE, and the bot binds their LINE account to
 * THIS existing account. While the QR is shown we poll /api/auth/line-link-status
 * so the UI flips to a success state the moment the binding lands, and calls
 * `onLinked` (used by onboarding to advance automatically).
 *
 * Styling uses the app's design tokens (surface / on-surface / primary /
 * font-headline) so it matches the rest of the web UI.
 */

import { useEffect, useState, useCallback, useRef } from 'react';

interface QrResponse {
  alreadyLinked?: boolean;
  displayName?: string | null;
  code?: string;
  lineUrl?: string;
  qrDataUrl?: string;
}

interface Props {
  /** Hero heading, e.g. 「綁定 LINE」. */
  title: string;
  /** Single sentence above the QR. */
  caption: string;
  /** Short instruction below the QR. */
  hint?: string;
  /** Fired once the LINE account is detected as bound (initial or via polling). */
  onLinked?: (displayName: string | null) => void;
}

function authHeaders(): HeadersInit {
  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function LineQrPanel({ title, caption, hint = '請用手機的 LINE 掃描上方 QR Code', onLinked }: Props) {
  const [data, setData] = useState<QrResponse | null>(null);
  const [linked, setLinked] = useState(false);
  const [linkedName, setLinkedName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const onLinkedRef = useRef(onLinked);
  onLinkedRef.current = onLinked;

  const markLinked = useCallback((name: string | null) => {
    setLinked(true);
    setLinkedName(name);
    onLinkedRef.current?.(name);
  }, []);

  const fetchQr = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch('/api/auth/line-bind-qr', { headers: authHeaders() });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const json: QrResponse = await res.json();
      if (json.alreadyLinked) {
        markLinked(json.displayName ?? null);
      } else {
        setData(json);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [markLinked]);

  useEffect(() => { fetchQr(); }, [fetchQr]);

  // Poll for completion while the QR is on screen and not yet linked.
  useEffect(() => {
    if (linked || loading || error) return;
    const id = setInterval(async () => {
      try {
        const res = await fetch('/api/auth/line-link-status', { headers: authHeaders() });
        if (!res.ok) return;
        const json = await res.json();
        if (json.linked) {
          clearInterval(id);
          markLinked(json.displayName ?? null);
        }
      } catch { /* transient — keep polling */ }
    }, 3000);
    return () => clearInterval(id);
  }, [linked, loading, error, markLinked]);

  return (
    <section className="flex flex-col items-center gap-5 w-full" aria-labelledby="qr-hero-title">
      {/* Eyebrow caption — matches onboarding's primary eyebrow. */}
      <p className="text-xs font-bold uppercase tracking-widest text-primary">{caption}</p>

      {/* Hero heading — app headline font. */}
      <h1 id="qr-hero-title" className="font-headline text-3xl md:text-4xl font-black text-on-surface tracking-tight text-center">
        {title}
      </h1>

      <div aria-hidden className="w-16 h-px bg-outline-variant/40" />

      {/* Canvas — QR, spinner, error, or linked-success state. */}
      <div className="relative w-[260px] h-[260px] bg-white rounded-2xl border border-outline-variant/20 shadow-sm flex items-center justify-center">
        {linked ? (
          <div className="text-center px-6 space-y-3">
            <div className="mx-auto w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center">
              <span className="material-symbols-outlined text-primary text-3xl">check_circle</span>
            </div>
            <p className="text-base font-headline font-bold text-on-surface">已成功綁定 LINE</p>
            {linkedName && <p className="text-xs text-on-surface-variant">{linkedName}</p>}
          </div>
        ) : loading ? (
          <span className="material-symbols-outlined animate-spin text-primary text-3xl">progress_activity</span>
        ) : error ? (
          <div className="text-center px-5 space-y-3">
            <span className="material-symbols-outlined text-error text-3xl">error</span>
            <p className="text-xs text-on-surface-variant">{error}</p>
            <button
              onClick={fetchQr}
              className="text-xs font-bold text-primary hover:underline cursor-pointer"
            >
              重新產生
            </button>
          </div>
        ) : data?.qrDataUrl ? (
          <img src={data.qrDataUrl} alt="LINE 綁定 QR Code" className="w-[86%] h-[86%] object-contain" />
        ) : null}
      </div>

      {/* Hint + steps — hidden once linked. */}
      {!linked && (
        <div className="text-center space-y-1.5">
          <p className="text-sm text-on-surface-variant">{hint}</p>
          <p className="text-xs text-on-surface-variant/70">掃描後在 LINE 點「傳送」即可自動完成綁定</p>
        </div>
      )}

      {/* Bind-code receipt — easy to copy / open. */}
      {!linked && data?.code && (
        <div className="flex flex-col items-center gap-2">
          <div className="flex items-center gap-3">
            <span className="text-[11px] uppercase tracking-wider text-on-surface-variant/70 font-bold">綁定碼</span>
            <span className="text-sm font-mono text-on-surface tracking-[0.18em]">{data.code}</span>
          </div>
          {data.lineUrl && (
            <a
              href={data.lineUrl}
              className="text-xs font-bold text-primary hover:underline"
            >
              手機請點此開啟 LINE（桌機請改用掃描）
            </a>
          )}
        </div>
      )}
    </section>
  );
}
