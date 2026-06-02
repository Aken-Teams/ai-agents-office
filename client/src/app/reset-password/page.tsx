'use client';

import { useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { I18nProvider, useTranslation } from '../../i18n';
import { AuthLayout } from '../components/AuthLayout';
import { AppInput, ShineButton } from '../../components/ui';

const deployMode = process.env.NEXT_PUBLIC_DEPLOY_MODE || 'pro-panjit';

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

  const layoutProps = {
    appName: t('common.appName'),
    subtitle: t(deployMode === 'pro-panjit' ? 'login.brandSubtitle' : 'login.brandSubtitleGeneric' as any),
    heroTitle: {
      prefix: t('login.heroTitle.prefix'),
      highlight: t('login.heroTitle.highlight'),
      suffix: t('login.heroTitle.suffix'),
    },
    heroDescription: t('login.heroDescription'),
    statusLabel: t('login.systemStatus'),
  };

  if (!token) {
    return (
      <AuthLayout {...layoutProps} panelIcon="link_off">
        <div className="text-center py-4">
          <div className="w-20 h-20 mx-auto mb-6 bg-error/10 rounded-full flex items-center justify-center ring-1 ring-error/30">
            <span className="material-symbols-outlined text-4xl text-error">link_off</span>
          </div>
          <h3 className="font-headline text-2xl font-bold mb-3">{t('resetPassword.invalidTitle' as any)}</h3>
          <p className="text-on-surface-variant text-sm mb-8">{t('resetPassword.invalidMessage' as any)}</p>
          <Link href="/forgot-password" className="inline-block no-underline">
            <ShineButton type="button" variant="primary" size="md" fullWidth={false}>
              {t('resetPassword.requestNew' as any)}
            </ShineButton>
          </Link>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout {...layoutProps} panelIcon="key">
      <>
        {success ? (
          <div className="text-center py-4">
            <div className="w-20 h-20 mx-auto mb-6 bg-[color:var(--th-success)]/10 rounded-full flex items-center justify-center ring-1 ring-[color:var(--th-success)]/30">
              <span className="material-symbols-outlined text-4xl text-[color:var(--th-success)]">check_circle</span>
            </div>
            <h3 className="font-headline text-2xl font-bold mb-3">{t('resetPassword.successTitle' as any)}</h3>
            <p className="text-on-surface-variant text-sm mb-8">{t('resetPassword.successMessage' as any)}</p>
            <Link href="/login" className="inline-block no-underline">
              <ShineButton type="button" variant="primary" size="md" fullWidth={false}>
                {t('resetPassword.goToLogin' as any)}
                <span className="material-symbols-outlined text-sm ml-2">arrow_forward</span>
              </ShineButton>
            </Link>
          </div>
        ) : (
          <>
            <div className="mb-8 md:mb-10">
              <h3 className="font-headline text-2xl font-bold mb-1.5">{t('resetPassword.title' as any)}</h3>
              <p className="text-on-surface-variant text-sm">{t('resetPassword.subtitle' as any)}</p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-6">
              {error && (
                <div className="bg-error-container/30 border border-error/20 text-on-error-container px-4 py-3 rounded text-sm flex items-start gap-3">
                  <span className="material-symbols-outlined text-sm mt-0.5 shrink-0">error</span>
                  {error}
                </div>
              )}

              <AppInput
                label={t('resetPassword.newPasswordLabel' as any)}
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder={t('resetPassword.newPasswordPlaceholder' as any)}
                minLength={8}
                required
                autoComplete="new-password"
                autoFocus
              />

              <AppInput
                label={t('resetPassword.confirmPasswordLabel' as any)}
                type="password"
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                placeholder={t('resetPassword.confirmPasswordPlaceholder' as any)}
                minLength={8}
                required
                autoComplete="new-password"
              />

              <ShineButton type="submit" variant="primary" size="lg" disabled={loading}>
                {loading ? t('resetPassword.submitLoading' as any) : t('resetPassword.submit' as any)}
              </ShineButton>
            </form>
          </>
        )}
      </>
    </AuthLayout>
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
