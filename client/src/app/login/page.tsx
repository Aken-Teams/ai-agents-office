'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { GoogleOAuthProvider, GoogleLogin } from '@react-oauth/google';
import { AuthProvider, useAuth } from '../components/AuthProvider';
import { I18nProvider, useTranslation } from '../../i18n';

const googleClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

function LoginForm() {
  const { login, loginWithGoogle } = useAuth();
  const { t, theme } = useTranslation();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [errorType, setErrorType] = useState<'error' | 'warning' | 'info'>('error');
  const [loading, setLoading] = useState(false);

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

  return (
    <div className="bg-surface-container-lowest text-on-surface font-body min-h-screen flex flex-col items-center justify-center p-6 overflow-hidden relative selection:bg-primary/30">
      {/* Background Decoration */}
      <div className="absolute inset-0 bg-pattern pointer-events-none opacity-40" />
      <div className="absolute top-[-10%] right-[-10%] w-[40%] h-[40%] bg-primary/5 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-5%] left-[-5%] w-[30%] h-[30%] bg-tertiary/5 rounded-full blur-[100px] pointer-events-none" />

      {/* Main Container */}
      <main className="w-full max-w-6xl flex flex-col md:flex-row gap-0 shadow-2xl z-10">
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
                  {t('login.brandSubtitle')}
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
        <section className="flex-1 bg-surface-container-high p-8 md:p-16 flex flex-col justify-center">
          <div className="max-w-md mx-auto w-full">
            {/* Mobile Logo */}
            <div className="md:hidden flex items-center gap-3 mb-10">
              <div className="w-8 h-8 cyber-gradient flex items-center justify-center rounded">
                <span className="material-symbols-outlined text-on-primary text-sm">terminal</span>
              </div>
              <span className="font-headline text-xl font-bold tracking-tighter">{t('common.appName')}</span>
            </div>

            <div className="mb-10">
              <h3 className="font-headline text-2xl font-bold mb-2">{t('login.title')}</h3>
              <p className="text-on-surface-variant text-sm">{t('login.subtitle')}</p>
            </div>

            {/* Form */}
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
                  className="w-full bg-surface-container-highest border-none focus:ring-1 focus:ring-primary/40 text-on-surface py-3 px-4 text-sm font-body rounded placeholder:text-outline"
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
                  className="w-full bg-surface-container-highest border-none focus:ring-1 focus:ring-primary/40 text-on-surface py-3 px-4 text-sm font-body rounded placeholder:text-outline"
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                  required
                />
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
              <div className="mt-6 flex flex-col items-center gap-4">
                <div className="w-full h-px bg-outline-variant/20 relative">
                  <span className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-surface-container-high px-4 text-sm uppercase tracking-widest text-outline">
                    {t('login.orDivider')}
                  </span>
                </div>
                <div className="w-full flex justify-center">
                  <GoogleLogin
                    onSuccess={async (credentialResponse) => {
                      setError('');
                      setLoading(true);
                      try {
                        await loginWithGoogle(credentialResponse.credential!);
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
                      } catch (err) {
                        setErrorType('error');
                        setError((err as Error).message);
                      } finally {
                        setLoading(false);
                      }
                    }}
                    onError={() => {
                      setErrorType('error');
                      setError(t('login.googleError'));
                    }}
                    theme={theme === 'dark' ? 'filled_black' : 'outline'}
                    size="large"
                    width="400"
                    text="signin_with"
                  />
                </div>
              </div>
            )}

            {/* Toggle to Register */}
            <div className="mt-8 flex flex-col items-center gap-6">
              <div className="w-full h-px bg-outline-variant/20 relative">
                <span className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-surface-container-high px-4 text-sm uppercase tracking-widest text-outline">
                  {t('login.noAccount')}
                </span>
              </div>
              <Link
                href="/register"
                className="text-sm font-label text-on-surface-variant hover:text-primary transition-colors flex items-center gap-2 group"
              >
                {t('login.createAccount')}
                <span className="material-symbols-outlined text-sm group-hover:translate-x-1 transition-transform">
                  arrow_forward
                </span>
              </Link>
            </div>
          </div>
        </section>
      </main>

      {/* Footer Stats */}
      <footer className="mt-8 hidden md:flex gap-8 z-10">
        <div className="flex flex-col gap-1">
          <span className="text-[9px] uppercase tracking-widest text-outline">{t('login.footerFormats')}</span>
          <span className="font-headline font-bold text-tertiary">PPTX / DOCX / XLSX / PDF</span>
        </div>
        <div className="flex flex-col gap-1 border-l border-outline-variant/20 pl-8">
          <span className="text-[9px] uppercase tracking-widest text-outline">{t('login.footerEngine')}</span>
          <span className="font-headline font-bold text-on-surface">Claude Sonnet 4</span>
        </div>
        <div className="flex flex-col gap-1 border-l border-outline-variant/20 pl-8">
          <span className="text-[9px] uppercase tracking-widest text-outline">{t('login.footerCollaboration')}</span>
          <span className="font-headline font-bold text-on-surface">{t('login.footerCollaborationValue')}</span>
        </div>
      </footer>
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
