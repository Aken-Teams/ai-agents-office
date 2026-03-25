'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { GoogleOAuthProvider, useGoogleLogin } from '@react-oauth/google';
import { AuthProvider, useAuth } from '../components/AuthProvider';
import { I18nProvider, useTranslation } from '../../i18n';

const googleClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
const deployMode = process.env.NEXT_PUBLIC_DEPLOY_MODE || 'pro-panjit';

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
      className="w-full flex items-center justify-center gap-3 bg-white hover:bg-gray-50 border border-gray-300 text-gray-700 font-headline font-medium text-sm py-4 rounded-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed"
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
  const { t, theme } = useTranslation();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [errorType, setErrorType] = useState<'error' | 'warning' | 'info'>('error');
  const [loading, setLoading] = useState(false);
  // Verification state (for Google OAuth new users)
  const [verifyStep, setVerifyStep] = useState(false);
  const [verifyEmail_, setVerifyEmail_] = useState('');
  const [code, setCode] = useState('');
  const [verifyLoading, setVerifyLoading] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setErrorType('error');
    setLoading(true);
    try {
      await login(email, password);
      // Check JWT role to redirect admin users
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
      // Set visual style based on error type
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

  return (
    <div className="bg-surface-container-lowest text-on-surface font-body min-h-[100svh] flex flex-col items-center justify-center p-5 md:p-6 overflow-hidden relative selection:bg-primary/30">
      {/* Background Decoration */}
      <div className="absolute inset-0 bg-pattern pointer-events-none opacity-40" />
      <div className="absolute top-[-10%] right-[-10%] w-[40%] h-[40%] bg-primary/5 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-5%] left-[-5%] w-[30%] h-[30%] bg-tertiary/5 rounded-full blur-[100px] pointer-events-none" />

      {/* Main Container */}
      <main className="w-full max-w-6xl flex flex-col md:flex-row gap-0 shadow-xl md:shadow-2xl z-10">
        {/* Left Side: Branding */}
        <section className="hidden md:flex flex-col justify-between p-12 w-1/2 bg-surface-container-low relative overflow-hidden">
          <div className="space-y-8">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 cyber-gradient flex items-center justify-center rounded">
                <span className="material-symbols-outlined text-on-primary">terminal</span>
              </div>
              <div>
                <h1 className="font-headline text-2xl font-bold tracking-tighter text-on-surface">
                  {t('common.appName')}
                </h1>
                <p className="font-label text-sm uppercase tracking-[0.2em] text-primary">
                  {t(deployMode === 'pro-panjit' ? 'login.brandSubtitle' : 'login.brandSubtitleGeneric' as any)}
                </p>
              </div>
            </div>

            <div className="space-y-6 mt-16">
              <h2 className="font-headline text-4xl font-light leading-tight">
                {t('login.heroTitle.prefix')}<span className="text-primary font-medium">{t('login.heroTitle.highlight')}</span>
                <br />{t('login.heroTitle.suffix')}
              </h2>
              <p className="text-on-surface-variant font-body leading-relaxed max-w-md">
                {t('login.heroDescription')}
              </p>
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex items-center gap-4 p-4 bg-surface-container rounded-lg">
              <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
              <span className="font-label text-sm uppercase tracking-widest text-on-surface-variant">
                {t('login.systemStatus')}
              </span>
            </div>
            <div className="flex gap-2">
              <div className="h-1 w-8 bg-primary" />
              <div className="h-1 w-4 bg-surface-variant" />
              <div className="h-1 w-4 bg-surface-variant" />
            </div>
          </div>

          {/* Technical Decor */}
          <div className="absolute bottom-12 right-12 opacity-10 pointer-events-none">
            <span className="material-symbols-outlined text-[120px]">smart_toy</span>
          </div>
        </section>

        {/* Right Side: Login Form */}
        <section className="flex-1 bg-surface-container-high p-8 md:p-16 flex flex-col justify-center ">
          <div className="max-w-md mx-auto w-full">
            {/* Mobile Logo */}
            <div className="md:hidden flex items-center gap-3 mb-8">
              <div className="w-10 h-10 cyber-gradient flex items-center justify-center rounded">
                <span className="material-symbols-outlined text-on-primary">terminal</span>
              </div>
              <div>
                <h1 className="font-headline text-xl font-bold tracking-tighter leading-tight">{t('common.appName')}</h1>
                <p className="font-label text-[11px] uppercase tracking-[0.15em] text-primary">{t(deployMode === 'pro-panjit' ? 'login.brandSubtitle' : 'login.brandSubtitleGeneric' as any)}</p>
              </div>
            </div>

            {verifyStep ? (
              /* ===== Verification Code Step ===== */
              <>
                <div className="mb-8 md:mb-10">
                  <h3 className="font-headline text-2xl font-bold mb-1.5">{t('register.verifyTitle' as any)}</h3>
                  <p className="text-on-surface-variant text-sm">{t('register.verifySubtitle' as any)}</p>
                  <p className="text-primary text-sm font-mono mt-2">{verifyEmail_}</p>
                </div>
                <form onSubmit={handleVerify} className="space-y-6">
                  {error && (
                    <div className="px-4 py-3 rounded text-sm flex items-start gap-3 bg-error-container/30 border border-error/20 text-on-error-container">
                      <span className="material-symbols-outlined text-sm mt-0.5 shrink-0">error</span>
                      {error}
                    </div>
                  )}
                  <div className="space-y-1.5">
                    <label className="font-label text-sm uppercase tracking-widest text-on-surface-variant ml-1">
                      {t('register.verifyCodeLabel' as any)}
                    </label>
                    <input
                      className="w-full bg-surface-container-highest border-none focus:ring-1 focus:ring-primary/40 text-on-surface py-3 px-4 text-center text-2xl font-mono tracking-[0.5em] rounded placeholder:text-outline placeholder:text-base placeholder:tracking-normal"
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      value={code}
                      onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      placeholder={t('register.verifyCodePlaceholder' as any)}
                      required
                      autoFocus
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={verifyLoading || code.length !== 6}
                    className="w-full cyber-gradient text-on-primary font-headline font-bold uppercase tracking-widest text-sm py-4 rounded-sm shadow-lg shadow-primary/10 hover:brightness-110 active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {verifyLoading ? t('register.verifySubmitLoading' as any) : t('register.verifySubmit' as any)}
                  </button>
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
                      {resendCooldown > 0 ? `${t('register.verifyResend' as any)} (${resendCooldown}s)` : t('register.verifyResend' as any)}
                    </button>
                  </div>
                </form>
              </>
            ) : (
              /* ===== Normal Login Form ===== */
              <>
                <div className="mb-8 md:mb-10">
                  <h3 className="font-headline text-2xl font-bold mb-1.5">{t('login.title')}</h3>
                  <p className="text-on-surface-variant text-sm">{t('login.subtitle')}</p>
                </div>

                <form onSubmit={handleSubmit} className="space-y-6">
                  {error && (
                    <div className={`px-4 py-3 rounded text-sm flex items-start gap-3 ${
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

                  <div className="space-y-1.5">
                    <label className="font-label text-sm uppercase tracking-widest text-on-surface-variant ml-1">
                      {t('login.emailLabel')}
                    </label>
                    <input
                      className="w-full bg-surface-container-highest border-none focus:ring-1 focus:ring-primary/40 text-on-surface py-3 px-4 text-base md:text-sm font-body rounded placeholder:text-outline"
                      type="email"
                      value={email}
                      onChange={e => setEmail(e.target.value)}
                      placeholder="your@email.com"
                      required
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="font-label text-sm uppercase tracking-widest text-on-surface-variant ml-1">
                      {t('login.passwordLabel')}
                    </label>
                    <input
                      className="w-full bg-surface-container-highest border-none focus:ring-1 focus:ring-primary/40 text-on-surface py-3 px-4 text-base md:text-sm font-body rounded placeholder:text-outline"
                      type="password"
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      placeholder="••••••••••••"
                      required
                    />
                  </div>

                  {/* Links — below password */}
                  <div className="flex justify-between -mt-1">
                    <Link
                      href="/forgot-password"
                      className="text-xs font-label text-on-surface-variant hover:text-primary transition-colors"
                    >
                      {t('login.forgotPassword' as any)}
                    </Link>
                    <Link
                      href="/register"
                      className="text-xs font-label text-on-surface-variant hover:text-primary transition-colors"
                    >
                      {t('login.noAccount')} {t('login.createAccount')} &rarr;
                    </Link>
                  </div>

                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full cyber-gradient text-on-primary font-headline font-bold uppercase tracking-widest text-sm py-4 rounded-sm shadow-lg shadow-primary/10 hover:brightness-110 active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {loading ? t('login.submitLoading') : t('login.submit')}
                  </button>
                </form>

                {/* Google OAuth */}
                {googleClientId && (
                  <div className="mt-5 flex flex-col items-center gap-4">
                    <div className="w-full h-px bg-outline-variant/20 relative">
                      <span className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-surface-container-high px-4 text-xs uppercase tracking-widest text-outline">
                        {t('login.orDivider')}
                      </span>
                    </div>
                    <GoogleButton mode="signin" onLoginSuccess={async () => {
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
                    }} onError={(msg) => { setErrorType('error'); setError(msg); }}
                    onNeedsVerification={onGoogleNeedsVerification} />
                  </div>
                )}
              </>
            )}
          </div>
        </section>
      </main>

    </div>
  );
}

function LoginPageInner() {
  return (
    <I18nProvider>
      <AuthProvider>
        <LoginForm />
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
