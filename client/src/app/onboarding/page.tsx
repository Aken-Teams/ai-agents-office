'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AuthProvider, useAuth } from '../components/AuthProvider';
import { LineQrPanel } from '../components/LineQrPanel';
import { I18nProvider, useTranslation } from '../../i18n';

type StepType = 'terms' | 'welcome' | 'company' | 'line' | 'features';

const FEATURES = [
  { key: 'ppt',    icon: 'slideshow',       color: 'text-amber-500',   bg: 'bg-amber-500/10',   border: 'border-amber-500/20' },
  { key: 'slides', icon: 'web_stories',     color: 'text-purple-500',  bg: 'bg-purple-500/10',  border: 'border-purple-500/20' },
  { key: 'word',   icon: 'description',     color: 'text-blue-500',    bg: 'bg-blue-500/10',    border: 'border-blue-500/20' },
  { key: 'excel',  icon: 'table_chart',     color: 'text-emerald-500', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20' },
  { key: 'pdf',    icon: 'picture_as_pdf',  color: 'text-red-500',     bg: 'bg-red-500/10',     border: 'border-red-500/20' },
  { key: 'webapp', icon: 'dashboard',       color: 'text-indigo-500',  bg: 'bg-indigo-500/10',  border: 'border-indigo-500/20' },
  { key: 'data',   icon: 'query_stats',     color: 'text-cyan-500',    bg: 'bg-cyan-500/10',    border: 'border-cyan-500/20' },
  { key: 'rag',    icon: 'find_in_page',    color: 'text-sky-500',     bg: 'bg-sky-500/10',     border: 'border-sky-500/20' },
  { key: 'chat',   icon: 'smart_toy',       color: 'text-primary',     bg: 'bg-primary/10',     border: 'border-primary/20' },
] as const;

function StepDots({ current, total }: { current: number; total: number }) {
  if (total <= 1) return null;
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
  const [authChecked, setAuthChecked] = useState(false);

  // Terms state
  const [needsTerms, setNeedsTerms] = useState(false);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [tosContent, setTosContent] = useState('');
  const [tosLoading, setTosLoading] = useState(false);
  const [hasScrolledToBottom, setHasScrolledToBottom] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Onboarding state
  const [featureIdx, setFeatureIdx] = useState(0);
  const [company, setCompany] = useState('');
  const [companyError, setCompanyError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [lineLinked, setLineLinked] = useState(false);

  // Dynamic steps
  const steps = useMemo<StepType[]>(() => {
    const s: StepType[] = [];
    if (needsTerms) s.push('terms');
    if (needsOnboarding) s.push('welcome', 'company', 'line', 'features');
    return s;
  }, [needsTerms, needsOnboarding]);

  const currentStepType = steps[step];

  // Auth check
  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) { router.replace('/login'); return; }
    fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(data => {
        if (!data.id) { router.replace('/login'); return; }
        const terms = !!data.termsRequired;
        const onboarding = !!data.onboardingRequired;
        if (!terms && !onboarding) { router.replace('/dashboard'); return; }
        setNeedsTerms(terms);
        setNeedsOnboarding(onboarding);
        setAuthChecked(true);
      })
      .catch(() => router.replace('/login'));
  }, [router]);

  // Fetch TOS content when needed
  useEffect(() => {
    if (!authChecked || !needsTerms) return;
    const token = localStorage.getItem('token');
    if (!token) return;
    setTosLoading(true);
    fetch('/api/auth/terms', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.content) setTosContent(data.content);
        setTosLoading(false);
      })
      .catch(() => setTosLoading(false));
  }, [authChecked, needsTerms]);

  // IntersectionObserver for terms scroll detection
  useEffect(() => {
    if (currentStepType !== 'terms' || !sentinelRef.current || tosLoading || !tosContent) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setHasScrolledToBottom(true);
      },
      { root: scrollContainerRef.current, threshold: 0.1 }
    );
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [currentStepType, tosLoading, tosContent]);

  async function handleAcceptTerms() {
    setAccepting(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch('/api/auth/accept-terms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        if (needsOnboarding) {
          setStep(s => s + 1);
        } else {
          router.replace('/dashboard');
        }
      }
    } finally {
      setAccepting(false);
    }
  }

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

      <main className="relative z-10 w-full max-w-2xl">
        {/* Logo */}
        <div className="flex items-center gap-3 mb-10">
          <div className="w-9 h-9 cyber-gradient flex items-center justify-center rounded">
            <span className="material-symbols-outlined text-on-primary text-lg">terminal</span>
          </div>
          <span className="font-headline text-xl font-bold tracking-tight text-on-surface">{t('common.appName')}</span>
        </div>

        <div className="bg-surface-container rounded-2xl shadow-2xl border border-outline-variant/20 p-8 md:p-10">
          <StepDots current={step} total={steps.length} />

          {/* === Terms Step === */}
          {currentStepType === 'terms' && (
            <div className="animate-in fade-in slide-in-from-right-4 duration-300">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                  <span className="material-symbols-outlined text-primary text-xl">gavel</span>
                </div>
                <div>
                  <h1 className="font-headline text-2xl md:text-3xl font-black text-on-surface">
                    {t('terms.title' as any) || '系統使用規範與管理辦法'}
                  </h1>
                </div>
              </div>
              <p className="text-sm text-on-surface-variant mb-5 ml-[52px]">
                {t('terms.subtitle' as any) || '請詳閱以下使用條款，捲動至底部後方可同意。'}
              </p>

              {tosLoading ? (
                <div className="flex items-center justify-center py-16">
                  <span className="material-symbols-outlined animate-spin text-primary text-3xl">progress_activity</span>
                </div>
              ) : (
                <>
                  <div
                    ref={scrollContainerRef}
                    className="max-h-[45vh] overflow-y-auto border border-outline-variant/15 rounded-xl p-5 md:p-6 bg-surface-container-high/50 scroll-smooth"
                  >
                    <div className="prose-terms text-sm text-on-surface leading-relaxed">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                          h1: ({ children, ...props }) => <h1 className="text-lg font-bold text-on-surface mt-0 mb-3 pb-2 border-b border-outline-variant/15" {...props}>{children}</h1>,
                          h2: ({ children, ...props }) => <h2 className="text-base font-bold text-on-surface mt-5 mb-2" {...props}>{children}</h2>,
                          h3: ({ children, ...props }) => <h3 className="text-sm font-semibold text-on-surface mt-3 mb-1.5" {...props}>{children}</h3>,
                          p: ({ children, ...props }) => <p className="mb-2.5 last:mb-0 leading-relaxed text-on-surface-variant" {...props}>{children}</p>,
                          ul: ({ children, ...props }) => <ul className="list-disc pl-5 mb-3 space-y-1" {...props}>{children}</ul>,
                          ol: ({ children, ...props }) => <ol className="list-decimal pl-5 mb-3 space-y-1" {...props}>{children}</ol>,
                          li: ({ children, ...props }) => <li className="leading-relaxed text-on-surface-variant" {...props}>{children}</li>,
                          strong: ({ children, ...props }) => <strong className="font-semibold text-on-surface" {...props}>{children}</strong>,
                          blockquote: ({ children, ...props }) => (
                            <blockquote className="border-l-3 border-primary/30 pl-3 my-3 text-on-surface-variant bg-primary/5 rounded-r-lg py-2 pr-3" {...props}>{children}</blockquote>
                          ),
                          table: ({ children, ...props }) => (
                            <div className="overflow-x-auto my-3 rounded-lg border border-outline-variant/20">
                              <table className="w-full text-sm border-collapse" {...props}>{children}</table>
                            </div>
                          ),
                          thead: ({ children, ...props }) => <thead className="bg-surface-container" {...props}>{children}</thead>,
                          th: ({ children, ...props }) => <th className="text-left px-3 py-2 font-semibold text-on-surface border-b border-outline-variant/20" {...props}>{children}</th>,
                          td: ({ children, ...props }) => <td className="px-3 py-2 text-on-surface-variant border-b border-outline-variant/10" {...props}>{children}</td>,
                          hr: (props) => <hr className="my-4 border-outline-variant/15" {...props} />,
                          a: ({ children, href, ...props }) => (
                            <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline" {...props}>{children}</a>
                          ),
                        }}
                      >
                        {tosContent}
                      </ReactMarkdown>
                    </div>
                    <div ref={sentinelRef} className="h-1" />
                  </div>

                  {/* Scroll hint */}
                  {!hasScrolledToBottom && (
                    <div className="flex items-center justify-center gap-2 mt-3 text-xs text-on-surface-variant/60 animate-bounce">
                      <span className="material-symbols-outlined text-sm">keyboard_double_arrow_down</span>
                      {t('terms.scrollHint' as any) || '請捲動閱讀完整條款'}
                    </div>
                  )}

                  {/* Accept button */}
                  <div className={`mt-5 transition-all duration-300 ${hasScrolledToBottom ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4 pointer-events-none'}`}>
                    <button
                      onClick={handleAcceptTerms}
                      disabled={accepting || !hasScrolledToBottom}
                      className="w-full py-3 rounded-xl font-bold text-on-primary bg-primary hover:brightness-110 transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
                    >
                      <span className="material-symbols-outlined text-lg">check_circle</span>
                      {accepting
                        ? (t('terms.accepting' as any) || '處理中...')
                        : (t('terms.agree' as any) || '我同意以上條款')}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* === Welcome Step === */}
          {currentStepType === 'welcome' && (
            <div className="animate-in fade-in slide-in-from-right-4 duration-300">
              <p className="text-xs font-bold uppercase tracking-widest text-primary mb-2">{t('onboarding.step1.title')}</p>
              <h1 className="font-headline text-3xl md:text-4xl font-black text-on-surface mb-4 leading-tight">
                {t('onboarding.step1.headline')}
              </h1>
              <p className="text-on-surface-variant leading-relaxed mb-8">
                {t('onboarding.step1.description')}
              </p>
              <button
                onClick={() => setStep(s => s + 1)}
                className="w-full py-3 rounded-xl font-bold text-on-primary bg-primary hover:brightness-110 transition-all flex items-center justify-center gap-2 cursor-pointer"
              >
                {t('onboarding.step1.next')}
                <span className="material-symbols-outlined text-[18px]">arrow_forward</span>
              </button>
            </div>
          )}

          {/* === Company Step === */}
          {currentStepType === 'company' && (
            <div className="animate-in fade-in slide-in-from-right-4 duration-300">
              <p className="text-xs font-bold uppercase tracking-widest text-primary mb-2">
                {step + 1} / {steps.length}
              </p>
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
                  onKeyDown={e => e.key === 'Enter' && !companyError && company.trim() && setStep(s => s + 1)}
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
                  onClick={() => setStep(s => s - 1)}
                  className="flex-1 py-3 rounded-xl font-bold text-on-surface-variant bg-surface-container-high hover:bg-surface-variant/50 transition-colors cursor-pointer"
                >
                  {t('onboarding.step2.back')}
                </button>
                <button
                  onClick={() => {
                    if (!company.trim()) { setCompanyError(t('onboarding.step2.companyRequired')); return; }
                    setStep(s => s + 1);
                  }}
                  className="flex-[2] py-3 rounded-xl font-bold text-on-primary bg-primary hover:brightness-110 transition-all flex items-center justify-center gap-2 cursor-pointer"
                >
                  {t('onboarding.step2.next')}
                  <span className="material-symbols-outlined text-[18px]">arrow_forward</span>
                </button>
              </div>
            </div>
          )}

          {/* === LINE Bind Step === */}
          {currentStepType === 'line' && (
            <div className="animate-in fade-in slide-in-from-right-4 duration-300">
              <p className="text-xs font-bold uppercase tracking-widest text-primary mb-2">
                {step + 1} / {steps.length}
              </p>
              <h1 className="font-headline text-2xl md:text-3xl font-black text-on-surface mb-3">
                綁定 LINE 機器人
              </h1>
              <p className="text-on-surface-variant text-sm leading-relaxed mb-6">
                掃描下方 QR Code 加入 LINE 好友，即可在 LINE 上直接使用 AI 助理，與您的網頁帳號共用額度與記憶。此步驟可略過，稍後也能在儀表板綁定。
              </p>

              <div className="flex justify-center mb-7 rounded-2xl border border-outline-variant/20 bg-surface-container-high px-6 md:px-8 py-8">
                <LineQrPanel
                  title="綁定 LINE"
                  caption="連結你的帳號"
                  onLinked={() => setLineLinked(true)}
                />
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => setStep(s => s - 1)}
                  className="flex-1 py-3 rounded-xl font-bold text-on-surface-variant bg-surface-container-high hover:bg-surface-variant/50 transition-colors cursor-pointer"
                >
                  {t('onboarding.step2.back')}
                </button>
                <button
                  onClick={() => setStep(s => s + 1)}
                  className="flex-[2] py-3 rounded-xl font-bold text-on-primary bg-primary hover:brightness-110 transition-all flex items-center justify-center gap-2 cursor-pointer"
                >
                  {lineLinked ? '已綁定，下一步' : '下一步'}
                  <span className="material-symbols-outlined text-[18px]">arrow_forward</span>
                </button>
              </div>
            </div>
          )}

          {/* === Features Step === */}
          {currentStepType === 'features' && (
            <div className="animate-in fade-in slide-in-from-right-4 duration-300">
              <p className="text-xs font-bold uppercase tracking-widest text-primary mb-2">
                {step + 1} / {steps.length}
              </p>
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
                      className={`rounded-full transition-all duration-300 cursor-pointer ${
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
                  onClick={() => setStep(s => s - 1)}
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
    <AuthProvider>
      <OnboardingWithI18n />
    </AuthProvider>
  );
}

function OnboardingWithI18n() {
  const { user } = useAuth();
  return (
    <I18nProvider initialLocale={user?.locale} initialTheme={user?.theme}>
      <OnboardingContent />
    </I18nProvider>
  );
}
