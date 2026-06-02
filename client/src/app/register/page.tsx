'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { GoogleOAuthProvider, useGoogleLogin } from '@react-oauth/google';
import { AuthProvider, useAuth } from '../components/AuthProvider';
import { AuthLayout } from '../components/AuthLayout';
import { LineQrPanel } from '../components/LineQrPanel';
import { I18nProvider, useTranslation } from '../../i18n';
import { AppInput, ShineButton } from '../../components/ui';

const googleClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
const deployMode = process.env.NEXT_PUBLIC_DEPLOY_MODE || 'pro-panjit';

function GoogleButton({ mode, onLoginSuccess, onError }: {
  mode: 'signin' | 'signup';
  onLoginSuccess: () => void;
  onError: (msg: string) => void;
}) {
  const { loginWithGoogle } = useAuth();
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);

  const googleLogin = useGoogleLogin({
    onSuccess: async (tokenResponse) => {
      setBusy(true);
      try {
        await loginWithGoogle(tokenResponse.access_token, 'access_token');
        onLoginSuccess();
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

function RegisterForm() {
  const { register, verifyEmail, resendCode } = useAuth();
  const { t, theme } = useTranslation();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [inviteCode, setInviteCode] = useState('');
  const [inviteCodeRequired, setInviteCodeRequired] = useState(false);
  // Verification code step
  const [step, setStep] = useState<'form' | 'verify'>('form');
  const [verifyEmail_, setVerifyEmail] = useState('');
  const [code, setCode] = useState('');
  const [resendCooldown, setResendCooldown] = useState(0);

  useEffect(() => {
    fetch('/api/auth/invite-code-required')
      .then(r => r.json())
      .then(d => { if (d.required) setInviteCodeRequired(true); })
      .catch(() => {});
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const result = await register(email, password, displayName, inviteCodeRequired ? inviteCode : undefined);
      if (result.needsVerification) {
        setVerifyEmail(result.email || email);
        setStep('verify');
        startResendCooldown();
      } else if (result.pending) {
        setSuccess(true);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await verifyEmail(verifyEmail_, code);
      router.push('/chat');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function handleResend() {
    if (resendCooldown > 0) return;
    setError('');
    try {
      await resendCode(verifyEmail_);
      startResendCooldown();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function startResendCooldown() {
    setResendCooldown(60);
    const timer = setInterval(() => {
      setResendCooldown(prev => {
        if (prev <= 1) { clearInterval(timer); return 0; }
        return prev - 1;
      });
    }, 1000);
  }

  return (
    <AuthLayout
      appName={t('common.appName')}
      subtitle={t(deployMode === 'pro-panjit' ? 'register.brandSubtitle' : 'register.brandSubtitleGeneric' as any)}
      heroTitle={{
        prefix: t('register.heroTitle.prefix'),
        highlight: t('register.heroTitle.highlight'),
        suffix: t('register.heroTitle.suffix'),
      }}
      heroDescription={t('register.heroDescription')}
      statusLabel={t('register.systemStatus')}
      panelIcon="group"
    >
      <>
        {success ? (
              /* ===== Registration Success — Pending Approval ===== */
              <div className="text-center py-8">
                <div className="w-20 h-20 mx-auto mb-6 bg-primary/10 rounded-full flex items-center justify-center ring-1 ring-primary/30">
                  <span className="material-symbols-outlined text-4xl text-primary">hourglass_top</span>
                </div>
                <h3 className="font-headline text-2xl font-bold mb-3">{t('register.successTitle')}</h3>
                <p className="text-on-surface-variant mb-2">{t('register.successMessage')}</p>
                <p className="text-on-surface-variant text-sm mb-8">
                  {t('register.successDetail')}<br />{t('register.successContact')}
                </p>
                <Link href="/login" className="inline-block no-underline">
                  <ShineButton type="button" variant="primary" size="md" fullWidth={false}>
                    {t('register.backToLogin')}
                    <span className="material-symbols-outlined text-sm ml-2">arrow_forward</span>
                  </ShineButton>
                </Link>
              </div>
            ) : step === 'verify' ? (
              /* ===== Email Verification Code ===== */
              <div className="py-4">
                <div className="text-center mb-8">
                  <div className="w-20 h-20 mx-auto mb-6 bg-primary/10 rounded-full flex items-center justify-center ring-1 ring-primary/30">
                    <span className="material-symbols-outlined text-4xl text-primary">mark_email_read</span>
                  </div>
                  <h3 className="font-headline text-2xl font-bold mb-2">{t('register.verifyTitle' as any)}</h3>
                  <p className="text-on-surface-variant text-sm">{t('register.verifyDescription' as any)}</p>
                  <p className="text-primary text-sm font-mono mt-2">{verifyEmail_}</p>
                </div>

                <form onSubmit={handleVerify} className="space-y-6">
                  {error && (
                    <div className="bg-error-container/30 border border-error/20 text-on-error-container px-4 py-3 rounded text-sm flex items-start gap-3">
                      <span className="material-symbols-outlined text-sm mt-0.5 shrink-0">error</span>
                      {error}
                    </div>
                  )}

                  <AppInput
                    label={t('register.verifyCodeLabel' as any)}
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    value={code}
                    onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder={t('register.verifyCodePlaceholder' as any)}
                    required
                    autoFocus
                    autoComplete="one-time-code"
                    className="text-center text-2xl font-mono tracking-[0.5em] placeholder:text-base placeholder:tracking-normal"
                  />

                  <ShineButton type="submit" variant="primary" size="lg" disabled={loading || code.length !== 6}>
                    {loading ? t('register.verifyLoading' as any) : t('register.verifySubmit' as any)}
                  </ShineButton>

                  <div className="text-center">
                    <button
                      type="button"
                      onClick={handleResend}
                      disabled={resendCooldown > 0}
                      className="text-sm text-on-surface-variant hover:text-primary transition-colors disabled:opacity-50 bg-transparent cursor-pointer"
                    >
                      {resendCooldown > 0
                        ? `${t('register.resendCooldown' as any)} (${resendCooldown}s)`
                        : t('register.resendCode' as any)}
                    </button>
                  </div>
                </form>
              </div>
            ) : (
              /* ===== Registration Form ===== */
              <>
                <div className="mb-8 md:mb-10">
                  <h3 className="font-headline text-2xl font-bold mb-1.5">{t('register.title')}</h3>
                  <p className="text-on-surface-variant text-sm">{t('register.subtitle')}</p>
                </div>

                <form onSubmit={handleSubmit} className="space-y-6">
                  {error && (
                    <div className="bg-error-container/30 border border-error/20 text-on-error-container px-4 py-3 rounded text-sm flex items-start gap-3">
                      <span className="material-symbols-outlined text-sm mt-0.5 shrink-0">error</span>
                      {error}
                    </div>
                  )}

                  {inviteCodeRequired && (
                    <AppInput
                      label={t('register.inviteCodeLabel' as any)}
                      type="text"
                      value={inviteCode}
                      onChange={e => setInviteCode(e.target.value)}
                      placeholder={t('register.inviteCodePlaceholder' as any)}
                      required
                      maxLength={50}
                      autoComplete="off"
                      className="font-mono tracking-widest placeholder:font-body placeholder:tracking-normal"
                    />
                  )}

                  <AppInput
                    label={t('register.displayNameLabel')}
                    type="text"
                    value={displayName}
                    onChange={e => setDisplayName(e.target.value)}
                    placeholder={t('register.displayNamePlaceholder')}
                    required
                    maxLength={50}
                    autoComplete="name"
                  />

                  <AppInput
                    label={t('register.emailLabel')}
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder="your@email.com"
                    required
                    autoComplete="email"
                  />

                  <AppInput
                    label={t('register.passwordLabel')}
                    type="password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder={t('register.passwordPlaceholder')}
                    minLength={8}
                    required
                    autoComplete="new-password"
                  />

                  {/* Login link — right below password */}
                  <div className="flex justify-end -mt-1">
                    <Link
                      href="/login"
                      className="text-xs font-label text-on-surface-variant hover:text-primary transition-colors"
                    >
                      {t('register.hasAccount')} {t('register.goToLogin')} &rarr;
                    </Link>
                  </div>

                  {/* Honeypot fields — invisible to humans, bots fill them */}
                  <div aria-hidden="true" style={{ position: 'absolute', left: '-9999px', top: '-9999px' }}>
                    <input type="text" name="website" tabIndex={-1} autoComplete="off" />
                    <input type="text" name="phone_number" tabIndex={-1} autoComplete="off" />
                  </div>

                  <ShineButton type="submit" variant="primary" size="lg" disabled={loading}>
                    {loading ? t('register.submitLoading') : t('register.submit')}
                  </ShineButton>
                </form>

                <div className="mt-6">
                  <LineQrPanel
                    title="或用 LINE 註冊"
                    caption="掃 QR Code · 免填表單"
                  />
                </div>
              </>
            )}
      </>
    </AuthLayout>
  );
}

function RegisterPageInner() {
  return (
    <I18nProvider>
      <AuthProvider>
        <RegisterForm />
      </AuthProvider>
    </I18nProvider>
  );
}

export default function RegisterPage() {
  if (googleClientId) {
    return (
      <GoogleOAuthProvider clientId={googleClientId}>
        <RegisterPageInner />
      </GoogleOAuthProvider>
    );
  }
  return <RegisterPageInner />;
}
