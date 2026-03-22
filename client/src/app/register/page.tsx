'use client';

import { useState } from 'react';
import Link from 'next/link';
import { AuthProvider, useAuth } from '../components/AuthProvider';
import { I18nProvider, useTranslation } from '../../i18n';

function RegisterForm() {
  const { register } = useAuth();
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const result = await register(email, password, displayName);
      if (result.pending) {
        setSuccess(true);
      }
    } catch (err) {
      setError((err as Error).message);
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
                  {t('register.brandSubtitle')}
                </p>
              </div>
            </div>

            <div className="space-y-6 mt-16">
              <h2 className="font-headline text-4xl font-light leading-tight">
                {t('register.heroTitle.prefix')}<span className="text-primary font-medium">{t('register.heroTitle.highlight')}</span>
                <br />{t('register.heroTitle.suffix')}
              </h2>
              <p className="text-on-surface-variant font-body leading-relaxed max-w-md">
                {t('register.heroDescription')}
              </p>
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex items-center gap-4 p-4 bg-surface-container rounded-lg">
              <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
              <span className="font-label text-sm uppercase tracking-widest text-on-surface-variant">
                {t('register.systemStatus')}
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
            <span className="material-symbols-outlined text-[120px]">group</span>
          </div>
        </section>

        {/* Right Side: Register Form */}
        <section className="flex-1 bg-surface-container-high p-8 md:p-16 flex flex-col justify-center">
          <div className="max-w-md mx-auto w-full">
            {/* Mobile Logo */}
            <div className="md:hidden flex items-center gap-3 mb-10">
              <div className="w-8 h-8 cyber-gradient flex items-center justify-center rounded">
                <span className="material-symbols-outlined text-on-primary text-sm">terminal</span>
              </div>
              <span className="font-headline text-xl font-bold tracking-tighter">{t('common.appName')}</span>
            </div>

            {success ? (
              /* ===== Registration Success — Pending Approval ===== */
              <div className="text-center py-8">
                <div className="w-20 h-20 mx-auto mb-6 bg-primary/10 rounded-full flex items-center justify-center">
                  <span className="material-symbols-outlined text-4xl text-primary">hourglass_top</span>
                </div>
                <h3 className="font-headline text-2xl font-bold mb-3">{t('register.successTitle')}</h3>
                <p className="text-on-surface-variant mb-2">{t('register.successMessage')}</p>
                <p className="text-on-surface-variant text-sm mb-8">
                  {t('register.successDetail')}<br />{t('register.successContact')}
                </p>
                <Link
                  href="/login"
                  className="inline-flex items-center gap-2 cyber-gradient text-on-primary font-headline font-bold uppercase tracking-widest text-sm py-3 px-8 rounded-sm shadow-lg shadow-primary/10 hover:brightness-110 transition-all no-underline"
                >
                  {t('register.backToLogin')}
                  <span className="material-symbols-outlined text-sm">arrow_forward</span>
                </Link>
              </div>
            ) : (
              /* ===== Registration Form ===== */
              <>
                <div className="mb-10">
                  <h3 className="font-headline text-2xl font-bold mb-2">{t('register.title')}</h3>
                  <p className="text-on-surface-variant text-sm">{t('register.subtitle')}</p>
                </div>

                <form onSubmit={handleSubmit} className="space-y-6">
                  {error && (
                    <div className="bg-error-container/30 border border-error/20 text-on-error-container px-4 py-3 rounded text-sm">
                      {error}
                    </div>
                  )}

                  <div className="space-y-1.5">
                    <label className="font-label text-sm uppercase tracking-widest text-on-surface-variant ml-1">
                      {t('register.displayNameLabel')}
                    </label>
                    <input
                      className="w-full bg-surface-container-highest border-none focus:ring-1 focus:ring-primary/40 text-on-surface py-3 px-4 text-sm font-body rounded placeholder:text-outline"
                      type="text"
                      value={displayName}
                      onChange={e => setDisplayName(e.target.value)}
                      placeholder={t('register.displayNamePlaceholder')}
                      required
                      maxLength={50}
                      autoComplete="name"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="font-label text-sm uppercase tracking-widest text-on-surface-variant ml-1">
                      {t('register.emailLabel')}
                    </label>
                    <input
                      className="w-full bg-surface-container-highest border-none focus:ring-1 focus:ring-primary/40 text-on-surface py-3 px-4 text-sm font-body rounded placeholder:text-outline"
                      type="email"
                      value={email}
                      onChange={e => setEmail(e.target.value)}
                      placeholder="your@email.com"
                      required
                      autoComplete="email"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="font-label text-sm uppercase tracking-widest text-on-surface-variant ml-1">
                      {t('register.passwordLabel')}
                    </label>
                    <input
                      className="w-full bg-surface-container-highest border-none focus:ring-1 focus:ring-primary/40 text-on-surface py-3 px-4 text-sm font-body rounded placeholder:text-outline"
                      type="password"
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      placeholder={t('register.passwordPlaceholder')}
                      minLength={8}
                      required
                      autoComplete="new-password"
                    />
                  </div>

                  {/* Honeypot fields — invisible to humans, bots fill them */}
                  <div aria-hidden="true" style={{ position: 'absolute', left: '-9999px', top: '-9999px' }}>
                    <input type="text" name="website" tabIndex={-1} autoComplete="off" />
                    <input type="text" name="phone_number" tabIndex={-1} autoComplete="off" />
                  </div>

                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full cyber-gradient text-on-primary font-headline font-bold uppercase tracking-widest text-sm py-4 rounded-sm shadow-lg shadow-primary/10 hover:brightness-110 active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {loading ? t('register.submitLoading') : t('register.submit')}
                  </button>
                </form>

                {/* Toggle to Login */}
                <div className="mt-12 flex flex-col items-center gap-6">
                  <div className="w-full h-px bg-outline-variant/20 relative">
                    <span className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-surface-container-high px-4 text-sm uppercase tracking-widest text-outline">
                      {t('register.hasAccount')}
                    </span>
                  </div>
                  <Link
                    href="/login"
                    className="text-sm font-label text-on-surface-variant hover:text-primary transition-colors flex items-center gap-2 group"
                  >
                    {t('register.goToLogin')}
                    <span className="material-symbols-outlined text-sm group-hover:translate-x-1 transition-transform">
                      arrow_forward
                    </span>
                  </Link>
                </div>
              </>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}

export default function RegisterPage() {
  return (
    <I18nProvider>
      <AuthProvider>
        <RegisterForm />
      </AuthProvider>
    </I18nProvider>
  );
}
