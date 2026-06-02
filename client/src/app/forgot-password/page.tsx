'use client';

import { useState } from 'react';
import Link from 'next/link';
import { I18nProvider, useTranslation } from '../../i18n';
import { AuthLayout } from '../components/AuthLayout';
import { AppInput, ShineButton } from '../../components/ui';

const deployMode = process.env.NEXT_PUBLIC_DEPLOY_MODE || 'pro-panjit';

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
    <AuthLayout
      appName={t('common.appName')}
      subtitle={t(deployMode === 'pro-panjit' ? 'login.brandSubtitle' : 'login.brandSubtitleGeneric' as any)}
      heroTitle={{
        prefix: t('login.heroTitle.prefix'),
        highlight: t('login.heroTitle.highlight'),
        suffix: t('login.heroTitle.suffix'),
      }}
      heroDescription={t('login.heroDescription')}
      statusLabel={t('login.systemStatus')}
      panelIcon="lock_reset"
    >
      <>
        {sent ? (
            <div className="text-center py-4">
              <div className="w-20 h-20 mx-auto mb-6 bg-primary/10 rounded-full flex items-center justify-center">
                <span className="material-symbols-outlined text-4xl text-primary">forward_to_inbox</span>
              </div>
              <h3 className="font-headline text-2xl font-bold mb-3">{t('forgotPassword.sentTitle' as any)}</h3>
              <div className="max-w-[280px] mx-auto mb-8">
                <p className="text-on-surface-variant text-sm mb-3 text-balance leading-relaxed">{t('forgotPassword.sentMessage' as any)}</p>
                <p className="text-on-surface-variant text-xs text-balance leading-relaxed">{t('forgotPassword.sentDetail' as any)}</p>
              </div>
              <Link href="/login" className="inline-block no-underline">
                <ShineButton type="button" variant="primary" size="md" fullWidth={false}>
                  {t('forgotPassword.backToLogin' as any)}
                  <span className="material-symbols-outlined text-sm ml-2">arrow_forward</span>
                </ShineButton>
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

                <AppInput
                  label={t('forgotPassword.emailLabel' as any)}
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="your@email.com"
                  required
                  autoComplete="email"
                  autoFocus
                />

                <ShineButton type="submit" variant="primary" size="lg" disabled={loading}>
                  {loading ? t('forgotPassword.submitLoading' as any) : t('forgotPassword.submit' as any)}
                </ShineButton>

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
      </>
    </AuthLayout>
  );
}

export default function ForgotPasswordPage() {
  return (
    <I18nProvider>
      <ForgotPasswordForm />
    </I18nProvider>
  );
}
