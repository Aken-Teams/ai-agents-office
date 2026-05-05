'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { I18nProvider, useTranslation } from '../../i18n';

const FEATURES = [
  { key: 'ppt',  icon: 'slideshow',       color: 'text-amber-500',   bg: 'bg-amber-500/10',   border: 'border-amber-500/20' },
  { key: 'word', icon: 'description',     color: 'text-blue-500',    bg: 'bg-blue-500/10',    border: 'border-blue-500/20' },
  { key: 'excel',icon: 'table_chart',     color: 'text-emerald-500', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20' },
  { key: 'pdf',  icon: 'picture_as_pdf',  color: 'text-red-500',     bg: 'bg-red-500/10',     border: 'border-red-500/20' },
  { key: 'chat', icon: 'smart_toy',       color: 'text-primary',     bg: 'bg-primary/10',     border: 'border-primary/20' },
] as const;

function StepDots({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center gap-2 mb-8">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={`rounded-full transition-all duration-300 ${
            i === current ? 'w-6 h-2 bg-primary' : i < current ? 'w-2 h-2 bg-primary/40' : 'w-2 h-2 bg-surface-variant'
          }`}
        />
      ))}
    </div>
  );
}

function OnboardingContent() {
  const { t } = useTranslation();
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [featureIdx, setFeatureIdx] = useState(0);
  const [company, setCompany] = useState('');
  const [companyError, setCompanyError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) { router.replace('/login'); return; }
    fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(data => {
        if (!data.id) { router.replace('/login'); return; }
        if (!data.onboardingRequired) { router.replace('/dashboard'); return; }
        setAuthChecked(true);
      })
      .catch(() => router.replace('/login'));
  }, [router]);

  async function handleFinish() {
    if (!company.trim()) { setCompanyError(t('onboarding.step2.companyRequired')); return; }
    setSubmitting(true);
    try {
      const token = localStorage.getItem('token');
      await fetch('/api/auth/onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ company: company.trim() }),
      });
      router.replace('/dashboard');
    } finally {
      setSubmitting(false);
    }
  }

  if (!authChecked) {
    return (
      <div className="min-h-[100svh] flex items-center justify-center bg-surface-container-lowest">
        <span className="material-symbols-outlined animate-spin text-primary text-4xl">progress_activity</span>
      </div>
    );
  }

  const currentFeature = FEATURES[featureIdx];

  return (
    <div className="bg-surface-container-lowest text-on-surface font-body min-h-[100svh] flex flex-col items-center justify-center p-5 md:p-6 relative overflow-hidden selection:bg-primary/30">
      {/* Background decorations */}
      <div className="absolute inset-0 bg-pattern pointer-events-none opacity-30" />
      <div className="absolute top-[-10%] right-[-10%] w-[40%] h-[40%] bg-primary/5 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-5%] left-[-5%] w-[30%] h-[30%] bg-tertiary/5 rounded-full blur-[100px] pointer-events-none" />

      <main className="relative z-10 w-full max-w-lg">
        {/* Logo */}
        <div className="flex items-center gap-3 mb-10">
          <div className="w-9 h-9 cyber-gradient flex items-center justify-center rounded">
            <span className="material-symbols-outlined text-on-primary text-lg">terminal</span>
          </div>
          <span className="font-headline text-xl font-bold tracking-tight text-on-surface">{t('common.appName')}</span>
        </div>

        <div className="bg-surface-container rounded-2xl shadow-2xl border border-outline-variant/20 p-8 md:p-10">
          <StepDots current={step} total={3} />

          {/* Step 1: Welcome */}
          {step === 0 && (
            <div className="animate-in fade-in slide-in-from-right-4 duration-300">
              <p className="text-xs font-bold uppercase tracking-widest text-primary mb-2">{t('onboarding.step1.title')}</p>
              <h1 className="font-headline text-3xl md:text-4xl font-black text-on-surface mb-4 leading-tight">
                {t('onboarding.step1.headline')}
              </h1>
              <p className="text-on-surface-variant leading-relaxed mb-8">
                {t('onboarding.step1.description')}
              </p>
              <button
                onClick={() => setStep(1)}
                className="w-full py-3 rounded-xl font-bold text-on-primary bg-primary hover:brightness-110 transition-all flex items-center justify-center gap-2 cursor-pointer"
              >
                {t('onboarding.step1.next')}
                <span className="material-symbols-outlined text-[18px]">arrow_forward</span>
              </button>
            </div>
          )}

          {/* Step 2: Company */}
          {step === 1 && (
            <div className="animate-in fade-in slide-in-from-right-4 duration-300">
              <p className="text-xs font-bold uppercase tracking-widest text-primary mb-2">2 / 3</p>
              <h1 className="font-headline text-2xl md:text-3xl font-black text-on-surface mb-3">
                {t('onboarding.step2.title')}
              </h1>
              <p className="text-on-surface-variant text-sm leading-relaxed mb-7">
                {t('onboarding.step2.description')}
              </p>
              <div className="mb-6">
                <label className="block text-xs font-bold uppercase tracking-wider text-on-surface-variant mb-2">
                  {t('onboarding.step2.companyLabel')}
                </label>
                <input
                  type="text"
                  value={company}
                  onChange={e => { setCompany(e.target.value); setCompanyError(''); }}
                  placeholder={t('onboarding.step2.companyPlaceholder')}
                  className={`w-full bg-surface-container-high border rounded-xl px-4 py-3 text-sm text-on-surface focus:outline-none focus:border-primary transition-colors ${companyError ? 'border-error' : 'border-outline-variant/30'}`}
                  onKeyDown={e => e.key === 'Enter' && !companyError && company.trim() && setStep(2)}
                  autoFocus
                />
                {companyError && (
                  <p className="text-xs text-error mt-1.5 flex items-center gap-1">
                    <span className="material-symbols-outlined text-[13px]">error</span>
                    {companyError}
                  </p>
                )}
              </div>
              <div className="flex gap-3">
                <button
                  onClick={() => setStep(0)}
                  className="flex-1 py-3 rounded-xl font-bold text-on-surface-variant bg-surface-container-high hover:bg-surface-variant/50 transition-colors cursor-pointer"
                >
                  {t('onboarding.step2.back')}
                </button>
                <button
                  onClick={() => {
                    if (!company.trim()) { setCompanyError(t('onboarding.step2.companyRequired')); return; }
                    setStep(2);
                  }}
                  className="flex-[2] py-3 rounded-xl font-bold text-on-primary bg-primary hover:brightness-110 transition-all flex items-center justify-center gap-2 cursor-pointer"
                >
                  {t('onboarding.step2.next')}
                  <span className="material-symbols-outlined text-[18px]">arrow_forward</span>
                </button>
              </div>
            </div>
          )}

          {/* Step 3: Feature carousel */}
          {step === 2 && (
            <div className="animate-in fade-in slide-in-from-right-4 duration-300">
              <p className="text-xs font-bold uppercase tracking-widest text-primary mb-2">3 / 3</p>
              <h1 className="font-headline text-2xl md:text-3xl font-black text-on-surface mb-1">
                {t('onboarding.step3.title')}
              </h1>
              <p className="text-on-surface-variant text-sm leading-relaxed mb-6">
                {t('onboarding.step3.description')}
              </p>

              {/* Feature card */}
              <div className={`rounded-2xl border ${currentFeature.border} bg-surface-container-high p-6 mb-4 transition-all duration-300`}>
                <div className={`w-14 h-14 rounded-2xl ${currentFeature.bg} flex items-center justify-center mb-5`}>
                  <span className={`material-symbols-outlined text-[32px] ${currentFeature.color}`}>{currentFeature.icon}</span>
                </div>
                <div className="text-lg font-bold text-on-surface mb-1">
                  {t(`onboarding.feature.${currentFeature.key}` as any)}
                </div>
                <div className="text-sm text-on-surface-variant mb-4">
                  {t(`onboarding.feature.${currentFeature.key}Desc` as any)}
                </div>
                <ul className="space-y-2">
                  {(['Bullet1', 'Bullet2', 'Bullet3'] as const).map(b => (
                    <li key={b} className="flex items-start gap-2 text-sm text-on-surface-variant">
                      <span className={`material-symbols-outlined text-[16px] mt-0.5 shrink-0 ${currentFeature.color}`}>check_circle</span>
                      {t(`onboarding.feature.${currentFeature.key}${b}` as any)}
                    </li>
                  ))}
                </ul>
              </div>

              {/* Feature navigation */}
              <div className="flex items-center justify-between mb-7">
                <div className="flex gap-1.5 items-center">
                  {FEATURES.map((_, i) => (
                    <button
                      key={i}
                      onClick={() => setFeatureIdx(i)}
                      className={`rounded-full transition-all duration-300 ${
                        i === featureIdx ? 'w-5 h-2 bg-primary' : 'w-2 h-2 bg-surface-variant hover:bg-outline-variant'
                      }`}
                    />
                  ))}
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setFeatureIdx(i => Math.max(0, i - 1))}
                    disabled={featureIdx === 0}
                    className="w-8 h-8 rounded-lg flex items-center justify-center text-on-surface-variant hover:bg-surface-variant/50 disabled:opacity-30 transition-colors cursor-pointer disabled:cursor-default"
                  >
                    <span className="material-symbols-outlined text-[20px]">chevron_left</span>
                  </button>
                  <span className="text-xs text-on-surface-variant w-8 text-center tabular-nums">
                    {featureIdx + 1} / {FEATURES.length}
                  </span>
                  <button
                    onClick={() => setFeatureIdx(i => Math.min(FEATURES.length - 1, i + 1))}
                    disabled={featureIdx === FEATURES.length - 1}
                    className="w-8 h-8 rounded-lg flex items-center justify-center text-on-surface-variant hover:bg-surface-variant/50 disabled:opacity-30 transition-colors cursor-pointer disabled:cursor-default"
                  >
                    <span className="material-symbols-outlined text-[20px]">chevron_right</span>
                  </button>
                </div>
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => setStep(1)}
                  className="flex-1 py-3 rounded-xl font-bold text-on-surface-variant bg-surface-container-high hover:bg-surface-variant/50 transition-colors cursor-pointer"
                >
                  {t('onboarding.step3.back')}
                </button>
                <button
                  onClick={handleFinish}
                  disabled={submitting}
                  className="flex-[2] py-3 rounded-xl font-bold text-on-primary bg-primary hover:brightness-110 transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
                >
                  <span className={`material-symbols-outlined text-[18px] ${submitting ? 'animate-spin' : ''}`}>
                    {submitting ? 'progress_activity' : 'rocket_launch'}
                  </span>
                  {t('onboarding.step3.start')}
                </button>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

export default function OnboardingPage() {
  return (
    <I18nProvider>
      <OnboardingContent />
    </I18nProvider>
  );
}
