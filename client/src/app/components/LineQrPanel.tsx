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
  addFriendUrl?: string;
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
        } else if (json.conflict) {
          clearInterval(id);
          setError('此 LINE 已綁定其他帳號，無法綁定。\n請改用其他 LINE，或先到原帳號解除綁定後再試。');
        }
      } catch { /* transient — keep polling */ }
    }, 3000);
    return () => clearInterval(id);
  }, [linked, loading, error, markLinked]);

  return (
    <div className="@container w-full">
    <section
      className="flex flex-col @xl:flex-row @xl:items-center justify-center gap-6 @xl:gap-9 w-full"
      aria-labelledby="qr-hero-title"
    >
      {/* Left column — copy + step list. Centered when narrow, left when wide. */}
      <div className="flex flex-col items-center @xl:items-start text-center @xl:text-left gap-4 w-full @xl:max-w-sm">
        <div className="@xl:self-start">
          <p className="text-xs font-bold uppercase tracking-widest text-primary mb-1">{caption}</p>
          <h1 id="qr-hero-title" className="font-headline text-2xl @xl:text-3xl font-black text-on-surface tracking-tight">
            {title}
          </h1>
        </div>

        {!linked && (
          <div className="w-full space-y-3 text-left">
            {/* Step 1 — add friend */}
            <div className="flex items-start gap-2.5">
              <span className="shrink-0 w-5 h-5 mt-0.5 rounded-full bg-primary/15 text-primary text-xs font-bold flex items-center justify-center">1</span>
              <div className="flex-1">
                <p className="text-sm text-on-surface leading-relaxed">還不是好友？先加入機器人</p>
                {data?.addFriendUrl && (
                  <a href={data.addFriendUrl} target="_blank" rel="noopener noreferrer"
                    className="mt-1.5 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-bold text-white bg-[#06C755] hover:brightness-95 transition-all no-underline">
                    <span className="material-symbols-outlined text-[16px]">person_add</span>加入好友
                  </a>
                )}
              </div>
            </div>
            {/* Step 2 — scan & bind */}
            <div className="flex items-start gap-2.5">
              <span className="shrink-0 w-5 h-5 mt-0.5 rounded-full bg-primary/15 text-primary text-xs font-bold flex items-center justify-center">2</span>
              <p className="flex-1 text-sm text-on-surface leading-relaxed">用手機 LINE 掃描右方 QR，點「傳送」即完成綁定</p>
            </div>

            {data?.code && (
              <div className="flex items-center gap-2 pt-2.5 mt-1 border-t border-outline-variant/10">
                <span className="text-[11px] uppercase tracking-wider text-on-surface-variant/70 font-bold">綁定碼</span>
                <span className="text-sm font-mono text-on-surface tracking-[0.18em]">{data.code}</span>
                {data.lineUrl && (
                  <a href={data.lineUrl} className="ml-auto text-xs font-bold text-primary hover:underline">手機開啟</a>
                )}
              </div>
            )}
          </div>
        )}

        {linked && linkedName && (
          <p className="text-sm text-on-surface-variant mt-1">{linkedName}</p>
        )}
      </div>

      {/* Right column — QR / spinner / error / linked-success canvas. */}
      <div className="relative w-[220px] h-[220px] shrink-0 mx-auto @xl:mx-0 bg-white rounded-2xl border border-outline-variant/20 shadow-sm flex items-center justify-center">
        {linked ? (
          <div className="text-center px-6 space-y-3">
            <div className="mx-auto w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center">
              <span className="material-symbols-outlined text-primary text-3xl">check_circle</span>
            </div>
            <p className="text-base font-headline font-bold text-on-surface">已成功綁定 LINE</p>
          </div>
        ) : loading ? (
          <span className="material-symbols-outlined animate-spin text-primary text-3xl">progress_activity</span>
        ) : error ? (
          <div className="text-center px-5 space-y-3">
            <span className="material-symbols-outlined text-error text-3xl">error</span>
            <p className="text-xs text-on-surface-variant whitespace-pre-line leading-relaxed">{error}</p>
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
    </section>
    </div>
  );
}
