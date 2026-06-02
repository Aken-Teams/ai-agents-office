/**
 * LIFF (LINE Front-end Framework) bootstrap.
 *
 * Auth flow when a LINE user opens a rich-menu tile:
 *   1. LINE redirects them to liff.line.me/{liffId}/path → loads our Next.js
 *      app inside an in-app webview
 *   2. AuthProvider detects no stored JWT and calls `tryLiffAutoLogin()`
 *   3. We dynamically import `@line/liff`, call `liff.init({ liffId })`,
 *      then pull the LIFF ID token via `liff.getIDToken()`
 *   4. We POST that token to /api/auth/liff-login — the server validates it
 *      with LINE, looks up the linked internal user, and returns a normal JWT
 *   5. AuthProvider stores the JWT, completing auto-login
 *
 * If the LINE user isn't bound to an internal user yet, the server returns
 * 404 → AuthProvider routes the visitor to /login?reason=liff_unlinked so
 * the login page can explain how to bind (`/link <inviteCode>` inside LINE).
 *
 * SDK is dynamically imported because `@line/liff` touches `window` at module
 * load — keeping it out of the Next.js server bundle avoids SSR explosions.
 */

const LIFF_ID = (process.env.NEXT_PUBLIC_LINE_LIFF_ID || '').trim();

let initPromise: Promise<unknown | null> | null = null;

interface LiffMinimal {
  isInClient: () => boolean;
  isLoggedIn: () => boolean;
  login: (options?: { redirectUri?: string }) => void;
  getIDToken: () => string | null;
  init: (params: { liffId: string }) => Promise<void>;
}

/**
 * Initialize the LIFF SDK exactly once per page load. Subsequent calls return
 * the same SDK instance (or null if init failed / no LIFF ID configured).
 */
export function initLiff(): Promise<LiffMinimal | null> {
  if (!LIFF_ID) return Promise.resolve(null);
  if (typeof window === 'undefined') return Promise.resolve(null);

  if (initPromise) return initPromise as Promise<LiffMinimal | null>;

  initPromise = (async () => {
    try {
      const mod = await import('@line/liff');
      const liff = (mod.default ?? mod) as unknown as LiffMinimal;
      await liff.init({ liffId: LIFF_ID });
      return liff;
    } catch (err) {
      console.warn('[liff] init failed:', err);
      return null;
    }
  })();

  return initPromise as Promise<LiffMinimal | null>;
}

export interface LiffAutoLoginResult {
  status: 'ok' | 'unlinked' | 'not_liff' | 'error';
  token?: string;
  error?: string;
}

/**
 * One-shot LIFF auto-login attempt. Called by AuthProvider on mount when
 * there's no stored JWT. Safe to call when not in LIFF — returns
 * `{ status: 'not_liff' }` so the caller falls through to the normal
 * unauthenticated route.
 */
export async function tryLiffAutoLogin(): Promise<LiffAutoLoginResult> {
  const liff = await initLiff();
  if (!liff) return { status: 'not_liff' };

  // `isInClient()` is true inside the LINE app webview. Outside (e.g. a
  // regular desktop browser following the LIFF URL), we'd need
  // `liff.login()` to OAuth the user — that's a future enhancement; for now
  // we only auto-login inside the LINE app.
  if (!liff.isInClient()) return { status: 'not_liff' };

  // Even in-client, isLoggedIn can be false right after first install. The
  // SDK will silently log them in via the LINE session — re-check.
  if (!liff.isLoggedIn()) {
    try {
      liff.login();
    } catch (err) {
      console.warn('[liff] login() failed:', err);
    }
    return { status: 'error', error: 'not_logged_in' };
  }

  const idToken = liff.getIDToken();
  if (!idToken) return { status: 'error', error: 'no_id_token' };

  try {
    const res = await fetch('/api/auth/liff-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    });
    if (res.status === 404) {
      const body = await res.json().catch(() => ({}));
      return { status: 'unlinked', error: body.error || 'unlinked' };
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { status: 'error', error: body.error || `http_${res.status}` };
    }
    const body = (await res.json()) as { token: string };
    return { status: 'ok', token: body.token };
  } catch (err) {
    return { status: 'error', error: (err as Error).message };
  }
}
