'use client';

/**
 * /auto-login?t=<magic-token>
 *
 * Receives a single-use, 5-minute LINE magic-link token, exchanges it for a
 * 7-day session token via /api/auth/line-magic, stores the session in
 * localStorage in the same shape AuthProvider expects, then redirects to
 * /dashboard. On any failure the user is sent to /login with a generic
 * "link expired" hint.
 */

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

export const dynamic = 'force-dynamic';

function AutoLoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = params.get('t');
    if (!token) {
      router.replace('/login?reason=missing_token');
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/auth/line-magic', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || 'Link invalid or expired');
        }
        const data = await res.json();
        if (cancelled) return;
        localStorage.setItem('token', data.token);
        localStorage.setItem('greeting_login_id', String(Date.now()));

        // Find out whether onboarding is still required before sending the
        // user to /dashboard. LINE-provisioned accounts always come back
        // with onboardingRequired=true on first login.
        let next = '/dashboard';
        try {
          const me = await fetch('/api/auth/me', {
            headers: { Authorization: `Bearer ${data.token}` },
          });
          if (me.ok) {
            const profile = await me.json();
            if (profile?.onboardingRequired) next = '/onboarding';
          }
        } catch { /* fall through to dashboard */ }

        if (cancelled) return;
        router.replace(next);
      } catch (err) {
        if (cancelled) return;
        setError((err as Error).message);
        setTimeout(() => router.replace('/login?reason=magic_expired'), 1500);
      }
    })();

    return () => { cancelled = true; };
  }, [params, router]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface text-on-surface">
      <div className="text-center space-y-2">
        <div className="text-base font-mono opacity-70">
          {error ? '連結已失效，將跳回登入頁…' : '正在從 LINE 自動登入…'}
        </div>
        {error ? (
          <div className="text-xs text-error font-mono">{error}</div>
        ) : (
          <div className="w-8 h-8 mx-auto border-2 border-on-surface/20 border-t-primary rounded-full animate-spin" />
        )}
      </div>
    </div>
  );
}

export default function AutoLoginPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-surface text-on-surface">
        <div className="w-8 h-8 border-2 border-on-surface/20 border-t-primary rounded-full animate-spin" />
      </div>
    }>
      <AutoLoginInner />
    </Suspense>
  );
}
