'use client';

import { useState } from 'react';
import Link from 'next/link';
import { I18nProvider, useTranslation } from '../../i18n';

function ForgotPasswordForm() {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Request failed');
      }
      setSent(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="bg-surface-container-lowest text-on-surface font-body min-h-[100svh] flex flex-col items-center justify-center p-5 md:p-6 overflow-hidden relative selection:bg-primary/30">
      <div className="absolute inset-0 bg-pattern pointer-events-none opacity-40" />
      <div className="absolute top-[-10%] right-[-10%] w-[40%] h-[40%] bg-primary/5 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-5%] left-[-5%] w-[30%] h-[30%] bg-tertiary/5 rounded-full blur-[100px] pointer-events-none" />

      <main className="w-full max-w-md z-10">
        <div className="bg-surface-container-high p-8 md:p-12 shadow-xl md:shadow-2xl">
          {/* Logo */}
          <div className="flex items-center gap-3 mb-8">
            <div className="w-10 h-10 cyber-gradient flex items-center justify-center rounded">
              <span className="material-symbols-outlined text-on-primary">terminal</span>
            </div>
            <div>
              <h1 className="font-headline text-xl font-bold tracking-tighter leading-tight">{t('common.appName')}</h1>
            </div>
          </div>

          {sent ? (
            <div className="text-center py-4">
              <div className="w-20 h-20 mx-auto mb-6 bg-primary/10 rounded-full flex items-center justify-center">
                <span className="material-symbols-outlined text-4xl text-primary">forward_to_inbox</span>
              </div>
              <h3 className="font-headline text-2xl font-bold mb-3">{t('forgotPassword.sentTitle' as any)}</h3>
              <p className="text-on-surface-variant text-sm mb-2">{t('forgotPassword.sentMessage' as any)}</p>
              <p className="text-on-surface-variant text-xs mb-8">{t('forgotPassword.sentDetail' as any)}</p>
              <Link
                href="/login"
                className="inline-flex items-center gap-2 cyber-gradient text-on-primary font-headline font-bold uppercase tracking-widest text-sm py-3 px-8 rounded-sm shadow-lg shadow-primary/10 hover:brightness-110 transition-all no-underline"
              >
                {t('forgotPassword.backToLogin' as any)}
                <span className="material-symbols-outlined text-sm">arrow_forward</span>
              </Link>
            </div>
          ) : (
            <>
              <div className="mb-8">
                <h3 className="font-headline text-2xl font-bold mb-1.5">{t('forgotPassword.title' as any)}</h3>
                <p className="text-on-surface-variant text-sm">{t('forgotPassword.subtitle' as any)}</p>
              </div>

              <form onSubmit={handleSubmit} className="space-y-6">
                {error && (
                  <div className="bg-error-container/30 border border-error/20 text-on-error-container px-4 py-3 rounded text-sm">
                    {error}
                  </div>
                )}

                <div className="space-y-1.5">
                  <label className="font-label text-sm uppercase tracking-widest text-on-surface-variant ml-1">
                    {t('forgotPassword.emailLabel' as any)}
                  </label>
                  <input
                    className="w-full bg-surface-container-highest border-none focus:ring-1 focus:ring-primary/40 text-on-surface py-3 px-4 text-base md:text-sm font-body rounded placeholder:text-outline"
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder="your@email.com"
                    required
                    autoComplete="email"
                    autoFocus
                  />
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full cyber-gradient text-on-primary font-headline font-bold uppercase tracking-widest text-sm py-4 rounded-sm shadow-lg shadow-primary/10 hover:brightness-110 active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading ? t('forgotPassword.submitLoading' as any) : t('forgotPassword.submit' as any)}
                </button>

                <div className="text-center">
                  <Link
                    href="/login"
                    className="text-xs font-label text-on-surface-variant hover:text-primary transition-colors"
                  >
                    &larr; {t('forgotPassword.backToLogin' as any)}
                  </Link>
                </div>
              </form>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

export default function ForgotPasswordPage() {
  return (
    <I18nProvider>
      <ForgotPasswordForm />
    </I18nProvider>
  );
}
