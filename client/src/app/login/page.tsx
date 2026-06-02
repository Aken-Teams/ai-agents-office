'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { GoogleOAuthProvider, useGoogleLogin } from '@react-oauth/google';
import { AuthProvider, useAuth } from '../components/AuthProvider';
import { LineQrPanel } from '../components/LineQrPanel';
import { I18nProvider, useTranslation } from '../../i18n';
import { AppInput, ShineButton } from '../../components/ui';

const googleClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
const deployMode = process.env.NEXT_PUBLIC_DEPLOY_MODE || 'pro-panjit';

// Login reads ?next=/redirect via useSearchParams; opt out of static prerender (Next 15 CSR bailout).
export const dynamic = 'force-dynamic';

function GoogleButton({ mode, onLoginSuccess, onError, onNeedsVerification }: {
  mode: 'signin' | 'signup';
  onLoginSuccess: () => void;
  onError: (msg: string) => void;
  onNeedsVerification?: (email: string) => void;
}) {
  const { loginWithGoogle } = useAuth();
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);

  const googleLogin = useGoogleLogin({
    onSuccess: async (tokenResponse) => {
      setBusy(true);
      try {
        const result = await loginWithGoogle(tokenResponse.access_token, 'access_token');
        if (result?.needsVerification && result.email) {
          onNeedsVerification?.(result.email);
        } else {
          onLoginSuccess();
        }
      } catch (err) {
        onError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    onError: () => onError(t('login.googleError')),
  });

  return (
    <button
      type="button"
      onClick={() => googleLogin()}
      disabled={busy}
      className="w-full flex items-center justify-center gap-3 bg-surface-container-highest hover:bg-surface-container-high border border-outline-variant/40 hover:border-outline-variant/70 text-on-surface font-headline font-medium text-sm py-3.5 rounded-sm transition-all duration-[var(--duration-normal)] [transition-timing-function:var(--ease-snap)] disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
        <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 01-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
        <path d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z" fill="#34A853"/>
        <path d="M3.964 10.706A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.706V4.962H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.038l3.007-2.332z" fill="#FBBC05"/>
        <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.962L3.964 7.294C4.672 5.166 6.656 3.58 9 3.58z" fill="#EA4335"/>
      </svg>
      {busy ? '...' : mode === 'signin' ? t('login.googleSignIn') : t('register.googleSignUp')}
    </button>
  );
}

function LoginForm() {
  const { login, loginWithGoogle, verifyEmail, resendCode } = useAuth();
  const { t } = useTranslation();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [errorType, setErrorType] = useState<'error' | 'warning' | 'info'>('error');
  const [loading, setLoading] = useState(false);
  const [verifyStep, setVerifyStep] = useState(false);
  const [verifyEmail_, setVerifyEmail_] = useState('');
  const [code, setCode] = useState('');
  const [verifyLoading, setVerifyLoading] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const searchParams = useSearchParams();

  // When AuthProvider's LIFF auto-login lands on /login?reason=liff_unlinked
  // the visitor has a valid LINE identity but no `line_users` mapping. Show
  // an editorial-styled banner with the exact `/link <碼>` instruction so
  // they don't try to scan the QR (LINE can't scan its own webview).
  useEffect(() => {
    if (searchParams?.get('reason') === 'liff_unlinked') {
      setError(t('login.liffUnlinked'));
      setErrorType('info');
    } else if (searchParams?.get('reason') === 'magic_expired') {
      setError(t('login.magicExpired'));
      setErrorType('warning');
    }
  }, [searchParams, t]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setErrorType('error');
    setLoading(true);
    try {
      await login(email, password);
      const storedToken = localStorage.getItem('token');
      if (storedToken) {
        try {
          const payload = JSON.parse(atob(storedToken.split('.')[1]));
          if (payload.role === 'admin') {
            router.push('/admin/overview');
            return;
          }
        } catch { /* ignore decode errors */ }
      }
      router.push('/dashboard');
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('審核') || msg.includes('等待')) {
        setErrorType('warning');
      } else if (msg.includes('鎖定') || msg.includes('頻繁')) {
        setErrorType('info');
      } else if (msg.includes('用量上限') || msg.includes('超過')) {
        setErrorType('warning');
      } else if (msg.includes('Google')) {
        setErrorType('info');
      } else {
        setErrorType('error');
      }
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setVerifyLoading(true);
    try {
      await verifyEmail(verifyEmail_, code);
      router.push('/dashboard');
    } catch (err) {
      setErrorType('error');
      setError((err as Error).message);
    } finally {
      setVerifyLoading(false);
    }
  }

  async function handleResend() {
    if (resendCooldown > 0) return;
    try {
      await resendCode(verifyEmail_);
      setResendCooldown(60);
      const timer = setInterval(() => {
        setResendCooldown(prev => { if (prev <= 1) { clearInterval(timer); return 0; } return prev - 1; });
      }, 1000);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function onGoogleNeedsVerification(email: string) {
    setVerifyEmail_(email);
    setVerifyStep(true);
    setError('');
    setResendCooldown(60);
    const timer = setInterval(() => {
      setResendCooldown(prev => { if (prev <= 1) { clearInterval(timer); return 0; } return prev - 1; });
    }, 1000);
  }

  // ─────────────────────────────────────────────────────────────
  // 文清 / Warm Parchment editorial layout.
  //   · LINE QR is the hero — primary auth path.
  //   · email/password + Google OAuth collapse into a <details> drawer
  //     below the divider so the secondary methods stay reachable but
  //     don't compete with the primary CTA.
  //   · brand reads consistently with the LINE rich-menu (Noto Serif TC,
  //     IBM Plex Mono, palette #FCFAF7 / #1F1B16 / #8B7D6A / #D9D3C5).
  // ─────────────────────────────────────────────────────────────
  return (
    <div className="min-h-[100svh] bg-[#FCFAF7] text-[#1F1B16] flex flex-col">
      {/* Top eyebrow — minimal brand mark in mono. */}
      <header className="px-6 md:px-10 py-5 flex items-center justify-between text-[#8B7D6A] text-[10px] md:text-[11px] uppercase tracking-[0.45em] font-[var(--font-editorial-mono)]">
        <span>{t('common.appName')}</span>
        <span className="hidden md:inline">{t(deployMode === 'pro-panjit' ? 'login.brandSubtitle' : 'login.brandSubtitleGeneric' as any)}</span>
      </header>

      {/* Hairline brand rule. */}
      <div aria-hidden className="h-px bg-[#D9D3C5] mx-6 md:mx-10" />

      <main className="flex-1 flex flex-col items-center justify-center px-6 md:px-10 py-10 md:py-16">
        <div className="w-full max-w-md">
        {verifyStep ? (
              /* ===== Verification Code Step (editorial styling) ===== */
              <>
                <div className="mb-8 md:mb-10">
                  <h3 className="font-headline text-2xl font-bold mb-1.5">{t('register.verifyTitle' as any)}</h3>
                  <p className="text-on-surface-variant text-sm">{t('register.verifyDescription' as any)}</p>
                  <p className="text-primary text-sm font-mono mt-2">{verifyEmail_}</p>
                </div>
                <form onSubmit={handleVerify} className="space-y-6">
                  {error && (
                    <div className="px-4 py-3 rounded text-sm flex items-start gap-3 bg-error-container/30 border border-error/20 text-on-error-container">
                      <span className="material-symbols-outlined text-sm mt-0.5 shrink-0">error</span>
                      {error}
                    </div>
                  )}
                  <AppInput
                    label={t('register.verifyCodeLabel' as any)}
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    value={code}
                    onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder={t('register.verifyCodePlaceholder' as any)}
                    required
                    autoFocus
                    className="text-center text-2xl font-mono tracking-[0.5em] placeholder:text-base placeholder:tracking-normal"
                  />
                  <ShineButton type="submit" disabled={verifyLoading || code.length !== 6}>
                    {verifyLoading ? t('register.verifyLoading' as any) : t('register.verifySubmit' as any)}
                  </ShineButton>
                  <div className="flex justify-between items-center">
                    <button
                      type="button"
                      onClick={() => { setVerifyStep(false); setError(''); setCode(''); }}
                      className="text-xs font-label text-on-surface-variant hover:text-primary transition-colors bg-transparent cursor-pointer"
                    >
                      &larr; {t('login.title')}
                    </button>
                    <button
                      type="button"
                      onClick={handleResend}
                      disabled={resendCooldown > 0}
                      className="text-xs font-label text-on-surface-variant hover:text-primary transition-colors bg-transparent cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {resendCooldown > 0 ? `${t('register.resendCooldown' as any)} (${resendCooldown}s)` : t('register.resendCooldown' as any)}
                    </button>
                  </div>
                </form>
              </>
            ) : (
              /* ===== Editorial Login — LINE QR hero + secondary drawer ===== */
              <>
                {/* Hero: LINE QR as the primary entry */}
                <LineQrPanel
                  title="登入"
                  caption="掃 QR Code · 用 LINE 登入"
                />

                {/* Error toast — sits between hero and drawer when something bad happened above. */}
                {error && (
                  <div className={`mt-8 px-4 py-3 rounded text-sm flex items-start gap-3 ${
                    errorType === 'warning'
                      ? 'bg-warning/10 border border-warning/20 text-warning'
                      : errorType === 'info'
                      ? 'bg-primary/10 border border-primary/20 text-primary'
                      : 'bg-error-container/30 border border-error/20 text-on-error-container'
                  }`}>
                    <span className="material-symbols-outlined text-sm mt-0.5 shrink-0">
                      {errorType === 'warning' ? 'hourglass_top' : errorType === 'info' ? 'lock' : 'error'}
                    </span>
                    {error}
                  </div>
                )}

                {/* Editorial divider rule with center label. */}
                <div aria-hidden className="mt-12 mb-4 flex items-center gap-4 text-[#8B7D6A]">
                  <span className="flex-1 h-px bg-[#D9D3C5]" />
                  <span className="text-[10px] uppercase tracking-[0.4em] font-[var(--font-editorial-mono)]">
                    Or · Sign in with email
                  </span>
                  <span className="flex-1 h-px bg-[#D9D3C5]" />
                </div>

                {/* Secondary auth methods — collapsed by default. */}
                <details className="group [&_summary::-webkit-details-marker]:hidden">
                  <summary className="list-none cursor-pointer select-none flex items-center justify-center gap-2 py-3 text-[11px] uppercase tracking-[0.4em] text-[#1F1B16] hover:text-[#1F1B16]/80 font-[var(--font-editorial-mono)] transition-colors">
                    <span>Expand</span>
                    <span className="material-symbols-outlined text-base transition-transform group-open:rotate-180">expand_more</span>
                  </summary>

                  <div className="mt-6 pt-6 border-t border-[#D9D3C5]/60 space-y-6">
                    <form onSubmit={handleSubmit} className="space-y-5">
                      <AppInput
                        label={t('login.emailLabel')}
                        type="email"
                        value={email}
                        onChange={e => setEmail(e.target.value)}
                        placeholder="your@email.com"
                        required
                        autoComplete="email"
                      />

                      <AppInput
                        label={t('login.passwordLabel')}
                        type="password"
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        placeholder="••••••••••••"
                        required
                        autoComplete="current-password"
                      />

                      <div className="flex justify-between text-[11px] font-[var(--font-editorial-mono)] uppercase tracking-[0.18em]">
                        <Link
                          href="/forgot-password"
                          className="text-[#8B7D6A] hover:text-[#1F1B16] transition-colors"
                        >
                          {t('login.forgotPassword' as any)}
                        </Link>
                        <Link
                          href="/register"
                          className="text-[#8B7D6A] hover:text-[#1F1B16] transition-colors"
                        >
                          {t('login.noAccount')} {t('login.createAccount')} &rarr;
                        </Link>
                      </div>

                      <button
                        type="submit"
                        disabled={loading}
                        className="w-full h-12 bg-[#1F1B16] text-[#FCFAF7] text-[11px] uppercase tracking-[0.4em] font-[var(--font-editorial-mono)] cursor-pointer hover:bg-[#1F1B16]/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {loading ? t('login.submitLoading') : t('login.submit')}
                      </button>
                    </form>

                    {/* Google OAuth — rendered inside the drawer at the very bottom. */}
                    {googleClientId && (
                      <div className="flex flex-col items-center gap-3 pt-2">
                        <div aria-hidden className="flex items-center gap-3 w-full text-[#8B7D6A]">
                          <span className="flex-1 h-px bg-[#D9D3C5]" />
                          <span className="text-[10px] uppercase tracking-[0.4em] font-[var(--font-editorial-mono)]">
                            {t('login.orDivider')}
                          </span>
                          <span className="flex-1 h-px bg-[#D9D3C5]" />
                        </div>
                        <GoogleButton
                          mode="signin"
                          onLoginSuccess={async () => {
                            const storedToken = localStorage.getItem('token');
                            if (storedToken) {
                              try {
                                const payload = JSON.parse(atob(storedToken.split('.')[1]));
                                if (payload.role === 'admin') {
                                  router.push('/admin/overview');
                                  return;
                                }
                              } catch { /* ignore */ }
                            }
                            router.push('/dashboard');
                          }}
                          onError={(msg) => { setErrorType('error'); setError(msg); }}
                          onNeedsVerification={onGoogleNeedsVerification}
                        />
                      </div>
                    )}
                  </div>
                </details>
              </>
            )}
        </div>
      </main>

      {/* Footer rule — keeps the page bottom anchored. */}
      <footer className="px-6 md:px-10 py-5 flex items-center justify-between text-[#8B7D6A]/70 text-[10px] uppercase tracking-[0.4em] font-[var(--font-editorial-mono)] border-t border-[#D9D3C5]/60">
        <span>{t('login.systemStatus')}</span>
        <span>{new Date().getFullYear()}</span>
      </footer>
    </div>
  );
}

function LoginPageInner() {
  return (
    <I18nProvider>
      <AuthProvider>
        <Suspense fallback={null}>
          <LoginForm />
        </Suspense>
      </AuthProvider>
    </I18nProvider>
  );
}

export default function LoginPage() {
  if (googleClientId) {
    return (
      <GoogleOAuthProvider clientId={googleClientId}>
        <LoginPageInner />
      </GoogleOAuthProvider>
    );
  }
  return <LoginPageInner />;
}
