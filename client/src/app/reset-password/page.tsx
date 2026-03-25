'use client';

import { useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { I18nProvider, useTranslation } from '../../i18n';

function ResetPasswordForm() {
  const { t } = useTranslation();
  const searchParams = useSearchParams();
  const token = searchParams.get('token');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (password !== confirmPassword) {
      setError(t('resetPassword.mismatch' as any));
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword: password }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Reset failed');
      }
      setSuccess(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  if (!token) {
    return (
      <div className="bg-surface-container-lowest text-on-surface font-body min-h-[100svh] flex flex-col items-center justify-center p-5 md:p-6 overflow-hidden relative selection:bg-primary/30">
        <div className="absolute inset-0 bg-pattern pointer-events-none opacity-40" />
        <main className="w-full max-w-md z-10">
          <div className="bg-surface-container-high p-8 md:p-12 shadow-xl text-center">
            <div className="w-20 h-20 mx-auto mb-6 bg-error/10 rounded-full flex items-center justify-center">
              <span className="material-symbols-outlined text-4xl text-error">link_off</span>
            </div>
            <h3 className="font-headline text-2xl font-bold mb-3">{t('resetPassword.invalidTitle' as any)}</h3>
            <p className="text-on-surface-variant text-sm mb-8">{t('resetPassword.invalidMessage' as any)}</p>
            <Link
              href="/forgot-password"
              className="inline-flex items-center gap-2 cyber-gradient text-on-primary font-headline font-bold uppercase tracking-widest text-sm py-3 px-8 rounded-sm shadow-lg shadow-primary/10 hover:brightness-110 transition-all no-underline"
            >
              {t('resetPassword.requestNew' as any)}
            </Link>
          </div>
        </main>
      </div>
    );
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

          {success ? (
            <div className="text-center py-4">
              <div className="w-20 h-20 mx-auto mb-6 bg-success/10 rounded-full flex items-center justify-center">
                <span className="material-symbols-outlined text-4xl text-success">check_circle</span>
              </div>
              <h3 className="font-headline text-2xl font-bold mb-3">{t('resetPassword.successTitle' as any)}</h3>
              <p className="text-on-surface-variant text-sm mb-8">{t('resetPassword.successMessage' as any)}</p>
              <Link
                href="/login"
                className="inline-flex items-center gap-2 cyber-gradient text-on-primary font-headline font-bold uppercase tracking-widest text-sm py-3 px-8 rounded-sm shadow-lg shadow-primary/10 hover:brightness-110 transition-all no-underline"
              >
                {t('resetPassword.goToLogin' as any)}
                <span className="material-symbols-outlined text-sm">arrow_forward</span>
              </Link>
            </div>
          ) : (
            <>
              <div className="mb-8">
                <h3 className="font-headline text-2xl font-bold mb-1.5">{t('resetPassword.title' as any)}</h3>
                <p className="text-on-surface-variant text-sm">{t('resetPassword.subtitle' as any)}</p>
              </div>

              <form onSubmit={handleSubmit} className="space-y-6">
                {error && (
                  <div className="bg-error-container/30 border border-error/20 text-on-error-container px-4 py-3 rounded text-sm">
                    {error}
                  </div>
                )}

                <div className="space-y-1.5">
                  <label className="font-label text-sm uppercase tracking-widest text-on-surface-variant ml-1">
                    {t('resetPassword.newPasswordLabel' as any)}
                  </label>
                  <input
                    className="w-full bg-surface-container-highest border-none focus:ring-1 focus:ring-primary/40 text-on-surface py-3 px-4 text-base md:text-sm font-body rounded placeholder:text-outline"
                    type="password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder={t('resetPassword.newPasswordPlaceholder' as any)}
                    minLength={8}
                    required
                    autoComplete="new-password"
                    autoFocus
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="font-label text-sm uppercase tracking-widest text-on-surface-variant ml-1">
                    {t('resetPassword.confirmPasswordLabel' as any)}
                  </label>
                  <input
                    className="w-full bg-surface-container-highest border-none focus:ring-1 focus:ring-primary/40 text-on-surface py-3 px-4 text-base md:text-sm font-body rounded placeholder:text-outline"
                    type="password"
                    value={confirmPassword}
                    onChange={e => setConfirmPassword(e.target.value)}
                    placeholder={t('resetPassword.confirmPasswordPlaceholder' as any)}
                    minLength={8}
                    required
                    autoComplete="new-password"
                  />
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full cyber-gradient text-on-primary font-headline font-bold uppercase tracking-widest text-sm py-4 rounded-sm shadow-lg shadow-primary/10 hover:brightness-110 active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading ? t('resetPassword.submitLoading' as any) : t('resetPassword.submit' as any)}
                </button>
              </form>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <I18nProvider>
      <Suspense fallback={<div className="min-h-[100svh] bg-surface-container-lowest" />}>
        <ResetPasswordForm />
      </Suspense>
    </I18nProvider>
  );
}
