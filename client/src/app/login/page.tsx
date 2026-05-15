'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { GoogleOAuthProvider, useGoogleLogin } from '@react-oauth/google';
import { AuthProvider, useAuth } from '../components/AuthProvider';
import { I18nProvider, useTranslation } from '../../i18n';

const googleClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
const deployMode = process.env.NEXT_PUBLIC_DEPLOY_MODE || 'pro-panjit';
const isPanjit = deployMode === 'pro-panjit';

const AD_DOMAINS = [
  { value: 'PANJIT', label: 'PANJIT（台灣）' },
  { value: 'PYNMAX', label: 'PYNMAX（環茂）' },
  { value: 'WXPJ', label: 'WXPJ（無錫強茂）' },
  { value: 'PJWS', label: 'PJWS（強茂深圳）' },
  { value: 'GDPJ', label: 'GDPJ（蘇州群鑫）' },
  { value: 'PJXZ', label: 'PJXZ（強茂徐州）' },
  { value: 'PJSD', label: 'PJSD（山東強茂）' },
];

/* ============================================================
   Google Button (non-panjit only)
   ============================================================ */
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

/* ============================================================
   AD Onboarding Wizard
   ============================================================ */
interface AdUserInfo {
  username: string;
  displayName: string;
  mail: string | null;
  domain: string;
  department: string | null;
}

type WizardStep = 'confirm' | 'inherit-choice' | 'inherit-email' | 'inherit-code' | 'done' | 'terms';

function AdWizard({
  adSessionToken,
  adUser,
  onComplete,
}: {
  adSessionToken: string;
  adUser: AdUserInfo;
  onComplete: (token: string, user: { id: string; email: string; displayName: string | null; role: string }) => void;
}) {
  const [step, setStep] = useState<WizardStep>('confirm');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [completedData, setCompletedData] = useState<{ token: string; user: { id: string; email: string; displayName: string | null; role: string } } | null>(null);
  const [isNewAccount, setIsNewAccount] = useState(false);

  // Terms state
  const [tosContent, setTosContent] = useState('');
  const [tosLoading, setTosLoading] = useState(false);
  const [hasScrolledToBottom, setHasScrolledToBottom] = useState(false);
  const [acceptingTerms, setAcceptingTerms] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // inherit flow
  const [claimEmail, setClaimEmail] = useState(adUser.mail || '');
  const [claimCode, setClaimCode] = useState('');
  const [resendCooldown, setResendCooldown] = useState(0);

  function startResendCooldown() {
    setResendCooldown(60);
    const timer = setInterval(() => {
      setResendCooldown(prev => { if (prev <= 1) { clearInterval(timer); return 0; } return prev - 1; });
    }, 1000);
  }

  async function handleNewAccount() {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/ad/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adSessionToken }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.code === 'USE_CLAIM_FLOW') {
          // Auto-redirect to inherit flow with the AD mail
          setClaimEmail(adUser.mail || '');
          setStep('inherit-email');
          return;
        }
        setError(data.error || '建立帳號失敗');
        return;
      }
      setIsNewAccount(true);
      setCompletedData({ token: data.token, user: data.user });
      setStep('done');
    } catch {
      setError('網路錯誤，請稍後再試');
    } finally {
      setLoading(false);
    }
  }

  async function handleClaimRequest() {
    if (!claimEmail) { setError('請輸入信箱'); return; }
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/ad/claim/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adSessionToken, claimEmail }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || '發送失敗'); return; }
      setStep('inherit-code');
      startResendCooldown();
    } catch {
      setError('網路錯誤，請稍後再試');
    } finally {
      setLoading(false);
    }
  }

  async function handleClaimVerify() {
    if (!claimCode) { setError('請輸入驗證碼'); return; }
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/ad/claim/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adSessionToken, claimEmail, code: claimCode }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || '驗證失敗'); return; }
      setIsNewAccount(false);
      setCompletedData({ token: data.token, user: data.user });
      setStep('done');
    } catch {
      setError('網路錯誤，請稍後再試');
    } finally {
      setLoading(false);
    }
  }

  // Fetch TOS content when registration completes
  useEffect(() => {
    if (!completedData) return;
    setTosLoading(true);
    fetch('/api/auth/terms', { headers: { Authorization: `Bearer ${completedData.token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.content) setTosContent(data.content); setTosLoading(false); })
      .catch(() => setTosLoading(false));
  }, [completedData]);

  // IntersectionObserver for terms scroll detection
  useEffect(() => {
    if (step !== 'terms' || !sentinelRef.current || tosLoading || !tosContent) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setHasScrolledToBottom(true); },
      { root: scrollContainerRef.current, threshold: 0.1 }
    );
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [step, tosLoading, tosContent]);

  async function handleAcceptTerms() {
    if (!completedData) return;
    setAcceptingTerms(true);
    try {
      await fetch('/api/auth/accept-terms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${completedData.token}` },
      });
      onComplete(completedData.token, completedData.user);
    } finally {
      setAcceptingTerms(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Progress dots */}
      <div className="flex gap-1.5 justify-center">
        {(['confirm', 'inherit-choice', 'inherit-email', 'inherit-code'] as WizardStep[]).map((s, i) => (
          <div key={s} className={`w-1.5 h-1.5 rounded-full transition-colors ${step === s ? 'bg-primary' : i < (['confirm', 'inherit-choice', 'inherit-email', 'inherit-code'] as WizardStep[]).indexOf(step) ? 'bg-primary/40' : 'bg-outline-variant/30'}`} />
        ))}
      </div>

      {/* Step: confirm AD identity */}
      {step === 'confirm' && (
        <>
          <div>
            <h3 className="font-headline text-2xl font-bold mb-1">歡迎首次登入</h3>
            <p className="text-on-surface-variant text-sm">請確認您的 AD 帳號資訊</p>
          </div>

          {/* User card */}
          <div className="bg-surface-container rounded-xl overflow-hidden">
            {/* Header: avatar + name */}
            <div className="flex items-center gap-4 px-5 py-4 border-b border-outline-variant/10">
              <div className="w-12 h-12 rounded-full cyber-gradient flex items-center justify-center shrink-0 shadow-md">
                <span className="text-on-primary text-lg font-bold font-headline select-none">
                  {(adUser.displayName || adUser.username).charAt(0).toUpperCase()}
                </span>
              </div>
              <div className="min-w-0">
                <div className="font-headline text-base font-bold leading-snug truncate">{adUser.displayName || adUser.username}</div>
                <div className="text-xs text-on-surface-variant mt-0.5 font-mono">{adUser.username} · {adUser.domain}</div>
              </div>
            </div>
            {/* Info rows */}
            <div className="px-5 py-3 space-y-2.5">
              <div className="flex items-center gap-3 text-sm">
                <span className="material-symbols-outlined text-[17px] text-outline shrink-0">domain</span>
                <span className="text-on-surface-variant text-xs w-10 shrink-0">組織</span>
                <span className="text-on-surface truncate">{AD_DOMAINS.find(d => d.value === adUser.domain)?.label || adUser.domain}</span>
              </div>
              {adUser.department && (
                <div className="flex items-center gap-3 text-sm">
                  <span className="material-symbols-outlined text-[17px] text-outline shrink-0">corporate_fare</span>
                  <span className="text-on-surface-variant text-xs w-10 shrink-0">部門</span>
                  <span className="text-on-surface truncate">{adUser.department}</span>
                </div>
              )}
              {adUser.mail && (
                <div className="flex items-center gap-3 text-sm">
                  <span className="material-symbols-outlined text-[17px] text-outline shrink-0">mail</span>
                  <span className="text-on-surface-variant text-xs w-10 shrink-0">信箱</span>
                  <span className="text-on-surface font-mono text-xs truncate">{adUser.mail}</span>
                </div>
              )}
            </div>
          </div>

          {error && <div className="px-4 py-3 rounded text-sm bg-error-container/30 border border-error/20 text-on-error-container flex items-start gap-2"><span className="material-symbols-outlined text-sm mt-0.5">error</span>{error}</div>}
          <button
            onClick={() => { setError(''); setStep('inherit-choice'); }}
            className="w-full cyber-gradient text-on-primary font-headline font-bold uppercase tracking-widest text-sm py-4 rounded-sm shadow-lg shadow-primary/10 hover:brightness-110 active:scale-[0.98] transition-all"
          >
            確認，繼續
          </button>
        </>
      )}

      {/* Step: new account or inherit */}
      {step === 'inherit-choice' && (
        <>
          <div>
            <h3 className="font-headline text-2xl font-bold mb-1.5">設定帳號</h3>
            <p className="text-on-surface-variant text-sm">您有使用過此系統的舊帳號嗎？</p>
          </div>
          {error && <div className="px-4 py-3 rounded text-sm bg-error-container/30 border border-error/20 text-on-error-container flex items-start gap-2"><span className="material-symbols-outlined text-sm mt-0.5">error</span>{error}</div>}
          <div className="space-y-3">
            <button
              onClick={() => { setError(''); setClaimEmail(adUser.mail || ''); setStep('inherit-email'); }}
              className="w-full flex items-center gap-4 p-4 bg-surface-container hover:bg-primary/5 border border-outline-variant/20 hover:border-primary/30 rounded-lg text-left transition-all group/btn"
            >
              <span className="material-symbols-outlined text-primary/60 group-hover/btn:text-primary transition-colors">link</span>
              <div>
                <div className="font-medium text-sm group-hover/btn:text-primary transition-colors">繼承舊帳號</div>
                <div className="text-xs text-on-surface-variant mt-0.5">將舊帳號的對話記錄、設定合併到此 AD 帳號</div>
              </div>
            </button>
            <button
              onClick={handleNewAccount}
              disabled={loading}
              className="w-full flex items-center gap-4 p-4 bg-surface-container hover:bg-surface-container-highest border border-outline-variant/20 hover:border-outline-variant/40 rounded-lg text-left transition-all disabled:opacity-50 group/btn2"
            >
              <span className="material-symbols-outlined text-on-surface-variant/50 group-hover/btn2:text-on-surface-variant transition-colors">person_add</span>
              <div>
                <div className="font-medium text-sm">建立新帳號</div>
                <div className="text-xs text-on-surface-variant mt-0.5">從頭開始，不繼承任何資料</div>
              </div>
            </button>
          </div>
          <button
            onClick={() => { setError(''); setStep('confirm'); }}
            className="text-xs font-label text-on-surface-variant hover:text-primary transition-colors bg-transparent cursor-pointer"
          >
            &larr; 返回
          </button>
        </>
      )}

      {/* Step: enter email to claim */}
      {step === 'inherit-email' && (
        <>
          <div>
            <h3 className="font-headline text-2xl font-bold mb-1.5">繼承帳號</h3>
            <p className="text-on-surface-variant text-sm">輸入舊帳號的電子信箱，我們將發送驗證碼</p>
          </div>
          <div className="space-y-1.5">
            <label className="font-label text-sm uppercase tracking-widest text-on-surface-variant ml-1">舊帳號信箱</label>
            <input
              className="w-full bg-surface-container-highest border-none focus:ring-1 focus:ring-primary/40 text-on-surface py-3 px-4 text-base md:text-sm font-body rounded placeholder:text-outline"
              type="email"
              value={claimEmail}
              onChange={e => setClaimEmail(e.target.value)}
              placeholder="old@example.com"
              autoFocus
            />
          </div>
          {error && <div className="px-4 py-3 rounded text-sm bg-error-container/30 border border-error/20 text-on-error-container flex items-start gap-2"><span className="material-symbols-outlined text-sm mt-0.5">error</span>{error}</div>}
          <button
            onClick={handleClaimRequest}
            disabled={loading || !claimEmail}
            className="w-full cyber-gradient text-on-primary font-headline font-bold uppercase tracking-widest text-sm py-4 rounded-sm shadow-lg shadow-primary/10 hover:brightness-110 active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? '發送中...' : '發送驗證碼'}
          </button>
          <div className="flex justify-between">
            <button
              onClick={() => { setError(''); setStep('inherit-choice'); }}
              className="text-xs font-label text-on-surface-variant hover:text-primary transition-colors bg-transparent cursor-pointer"
            >
              &larr; 返回
            </button>
          </div>
        </>
      )}

      {/* Step: enter verification code */}
      {step === 'inherit-code' && (
        <>
          <div>
            <h3 className="font-headline text-2xl font-bold mb-1.5">輸入驗證碼</h3>
            <p className="text-on-surface-variant text-sm">驗證碼已寄送至</p>
            <p className="text-primary text-sm font-mono mt-1">{claimEmail}</p>
          </div>
          <div className="space-y-1.5">
            <label className="font-label text-sm uppercase tracking-widest text-on-surface-variant ml-1">驗證碼</label>
            <input
              className="w-full bg-surface-container-highest border-none focus:ring-1 focus:ring-primary/40 text-on-surface py-3 px-4 text-center text-2xl font-mono tracking-[0.5em] rounded placeholder:text-outline placeholder:text-base placeholder:tracking-normal"
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={claimCode}
              onChange={e => setClaimCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="000000"
              autoFocus
            />
          </div>
          {error && <div className="px-4 py-3 rounded text-sm bg-error-container/30 border border-error/20 text-on-error-container flex items-start gap-2"><span className="material-symbols-outlined text-sm mt-0.5">error</span>{error}</div>}
          <button
            onClick={handleClaimVerify}
            disabled={loading || claimCode.length !== 6}
            className="w-full cyber-gradient text-on-primary font-headline font-bold uppercase tracking-widest text-sm py-4 rounded-sm shadow-lg shadow-primary/10 hover:brightness-110 active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? '驗證中...' : '完成繼承'}
          </button>
          <div className="flex justify-between items-center">
            <button
              onClick={() => { setError(''); setStep('inherit-email'); setClaimCode(''); }}
              className="text-xs font-label text-on-surface-variant hover:text-primary transition-colors bg-transparent cursor-pointer"
            >
              &larr; 返回
            </button>
            <button
              onClick={handleClaimRequest}
              disabled={resendCooldown > 0 || loading}
              className="text-xs font-label text-on-surface-variant hover:text-primary transition-colors bg-transparent cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {resendCooldown > 0 ? `重新發送 (${resendCooldown}s)` : '重新發送'}
            </button>
          </div>
        </>
      )}

      {/* Step: done — success screen */}
      {step === 'done' && completedData && (
        <>
          {/* Success icon */}
          <div className="flex flex-col items-center text-center gap-3 py-2">
            <div className="w-16 h-16 rounded-full bg-success/15 flex items-center justify-center">
              <span className="material-symbols-outlined text-success text-3xl">check_circle</span>
            </div>
            <div>
              <h3 className="font-headline text-2xl font-bold mb-1">
                {isNewAccount ? '帳號建立成功' : '帳號綁定成功'}
              </h3>
              <p className="text-on-surface-variant text-sm">
                {isNewAccount
                  ? `歡迎，${completedData.user.displayName || adUser.username}！`
                  : `已將 AD 帳號與舊帳號成功合併`}
              </p>
            </div>
          </div>

          {/* Feature highlights */}
          <div className="space-y-2.5">
            {[
              { icon: 'description', label: '智慧文件生成', desc: '一鍵生成 PPT、Word、Excel、PDF 等專業文件' },
              { icon: 'smart_toy', label: 'AI 助理', desc: '隨時提問、分析資料、協助撰寫各類內容' },
              { icon: 'hub', label: '多代理協作', desc: '複雜任務由多個 AI 代理協同完成' },
            ].map(f => (
              <div key={f.icon} className="flex items-start gap-3 px-4 py-3 bg-surface-container rounded-lg">
                <span className="material-symbols-outlined text-primary text-xl shrink-0 mt-0.5">{f.icon}</span>
                <div>
                  <div className="text-sm font-medium leading-snug">{f.label}</div>
                  <div className="text-xs text-on-surface-variant mt-0.5">{f.desc}</div>
                </div>
              </div>
            ))}
          </div>

          <button
            onClick={() => setStep('terms')}
            className="w-full cyber-gradient text-on-primary font-headline font-bold uppercase tracking-widest text-sm py-4 rounded-sm shadow-lg shadow-primary/10 hover:brightness-110 active:scale-[0.98] transition-all"
          >
            下一步
          </button>
        </>
      )}

      {/* Step: Terms of Service */}
      {step === 'terms' && completedData && (
        <>
          <div>
            <h3 className="font-headline text-2xl font-bold mb-1">系統使用規範</h3>
            <p className="text-on-surface-variant text-sm">請閱讀並同意以下使用條款，捲動至底部後方可同意</p>
          </div>

          {tosLoading ? (
            <div className="flex items-center justify-center py-12">
              <span className="material-symbols-outlined animate-spin text-primary text-3xl">progress_activity</span>
            </div>
          ) : (
            <>
              <div
                ref={scrollContainerRef}
                className="max-h-[40vh] overflow-y-auto bg-surface-container rounded-xl p-4 md:p-5 scroll-smooth"
              >
                <div className="text-sm text-on-surface leading-relaxed">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      h1: ({ children, ...props }) => <h1 className="text-base font-bold text-on-surface mt-0 mb-2.5 pb-1.5 border-b border-outline-variant/15" {...props}>{children}</h1>,
                      h2: ({ children, ...props }) => <h2 className="text-sm font-bold text-on-surface mt-4 mb-1.5" {...props}>{children}</h2>,
                      h3: ({ children, ...props }) => <h3 className="text-sm font-semibold text-on-surface mt-2.5 mb-1" {...props}>{children}</h3>,
                      p: ({ children, ...props }) => <p className="mb-2 last:mb-0 leading-relaxed text-on-surface-variant text-xs" {...props}>{children}</p>,
                      ul: ({ children, ...props }) => <ul className="list-disc pl-4 mb-2.5 space-y-0.5" {...props}>{children}</ul>,
                      ol: ({ children, ...props }) => <ol className="list-decimal pl-4 mb-2.5 space-y-0.5" {...props}>{children}</ol>,
                      li: ({ children, ...props }) => <li className="leading-relaxed text-on-surface-variant text-xs" {...props}>{children}</li>,
                      strong: ({ children, ...props }) => <strong className="font-semibold text-on-surface" {...props}>{children}</strong>,
                      blockquote: ({ children, ...props }) => (
                        <blockquote className="border-l-2 border-primary/30 pl-3 my-2.5 text-on-surface-variant bg-primary/5 rounded-r-lg py-1.5 pr-3 text-xs" {...props}>{children}</blockquote>
                      ),
                      table: ({ children, ...props }) => (
                        <div className="overflow-x-auto my-2.5 rounded-lg border border-outline-variant/20">
                          <table className="w-full text-xs border-collapse" {...props}>{children}</table>
                        </div>
                      ),
                      thead: ({ children, ...props }) => <thead className="bg-surface-container-high" {...props}>{children}</thead>,
                      th: ({ children, ...props }) => <th className="text-left px-2.5 py-1.5 font-semibold text-on-surface border-b border-outline-variant/20" {...props}>{children}</th>,
                      td: ({ children, ...props }) => <td className="px-2.5 py-1.5 text-on-surface-variant border-b border-outline-variant/10" {...props}>{children}</td>,
                      hr: (props) => <hr className="my-3 border-outline-variant/15" {...props} />,
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
                <div className="flex items-center justify-center gap-2 text-xs text-on-surface-variant/60 animate-bounce">
                  <span className="material-symbols-outlined text-sm">keyboard_double_arrow_down</span>
                  請捲動閱讀完整條款
                </div>
              )}

              {/* Accept button */}
              <div className={`transition-all duration-300 ${hasScrolledToBottom ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4 pointer-events-none'}`}>
                <button
                  onClick={handleAcceptTerms}
                  disabled={acceptingTerms || !hasScrolledToBottom}
                  className="w-full cyber-gradient text-on-primary font-headline font-bold uppercase tracking-widest text-sm py-4 rounded-sm shadow-lg shadow-primary/10 hover:brightness-110 active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {acceptingTerms ? '處理中...' : '同意並開始使用'}
                </button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

/* ============================================================
   AD Login Form (pro-panjit)
   ============================================================ */
function AdLoginForm({ onAdminMode }: { onAdminMode?: () => void }) {
  const { t } = useTranslation();
  const router = useRouter();
  const [domain, setDomain] = useState('PANJIT');
  const [domainOpen, setDomainOpen] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Wizard state
  const [wizardToken, setWizardToken] = useState<string | null>(null);
  const [wizardAdUser, setWizardAdUser] = useState<AdUserInfo | null>(null);

  function handleWizardComplete(token: string, user: { id: string; email: string; displayName: string | null; role: string }) {
    localStorage.setItem('token', token);
    localStorage.setItem('greeting_login_id', String(Date.now()));
    if (user.role === 'admin') {
      router.push('/admin/overview');
    } else {
      router.push('/dashboard');
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/ad/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password, domain }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || '登入失敗，請確認工號與密碼');
        return;
      }
      if (data.firstLogin) {
        setWizardToken(data.adSessionToken);
        setWizardAdUser(data.adUser);
        return;
      }
      // Returning user — direct login
      localStorage.setItem('token', data.token);
      localStorage.setItem('greeting_login_id', String(Date.now()));
      if (data.user.role === 'admin') {
        router.push('/admin/overview');
      } else {
        router.push('/dashboard');
      }
    } catch {
      setError('網路錯誤，請稍後再試');
    } finally {
      setLoading(false);
    }
  }

  // Show wizard if first-time login
  if (wizardToken && wizardAdUser) {
    return (
      <AdWizard
        adSessionToken={wizardToken}
        adUser={wizardAdUser}
        onComplete={handleWizardComplete}
      />
    );
  }

  return (
    <>
      <div className="mb-8 md:mb-10">
        <h3 className="font-headline text-2xl font-bold mb-1.5">員工登入</h3>
        <p className="text-on-surface-variant text-sm">使用 AD 工號登入系統</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        {error && (
          <div className="px-4 py-3 rounded text-sm flex items-start gap-3 bg-error-container/30 border border-error/20 text-on-error-container">
            <span className="material-symbols-outlined text-sm mt-0.5 shrink-0">error</span>
            {error}
          </div>
        )}

        {/* Domain selector */}
        <div className="space-y-1.5">
          <label className="font-label text-sm uppercase tracking-widest text-on-surface-variant ml-1">組織</label>
          <div className="relative">
            <button
              type="button"
              onClick={() => setDomainOpen(o => !o)}
              onBlur={e => { if (!e.currentTarget.parentElement?.contains(e.relatedTarget as Node)) setDomainOpen(false); }}
              className="w-full bg-surface-container-highest text-on-surface py-3 px-4 text-base md:text-sm font-body rounded flex items-center justify-between gap-2 focus:outline-none focus:ring-1 focus:ring-primary/40 transition-colors hover:bg-surface-container-high"
            >
              <span>{AD_DOMAINS.find(d => d.value === domain)?.label}</span>
              <span className={`material-symbols-outlined text-on-surface-variant text-lg transition-transform duration-150 ${domainOpen ? 'rotate-180' : ''}`}>expand_more</span>
            </button>
            {domainOpen && (
              <div className="absolute z-50 mt-1 w-full bg-surface-container rounded shadow-lg border border-outline-variant/10 overflow-hidden">
                {AD_DOMAINS.map(d => (
                  <button
                    key={d.value}
                    type="button"
                    tabIndex={0}
                    onMouseDown={e => { e.preventDefault(); setDomain(d.value); setDomainOpen(false); }}
                    className={`w-full text-left px-4 py-2.5 text-sm font-body transition-colors flex items-center gap-2 ${d.value === domain ? 'bg-primary/10 text-primary' : 'text-on-surface hover:bg-surface-container-high'}`}
                  >
                    {d.value === domain && <span className="material-symbols-outlined text-base shrink-0">check</span>}
                    {d.value !== domain && <span className="w-[18px] shrink-0" />}
                    {d.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Username */}
        <div className="space-y-1.5">
          <label className="font-label text-sm uppercase tracking-widest text-on-surface-variant ml-1">工號</label>
          <input
            className="w-full bg-surface-container-highest border-none focus:ring-1 focus:ring-primary/40 text-on-surface py-3 px-4 text-base md:text-sm font-body rounded placeholder:text-outline"
            type="text"
            value={username}
            onChange={e => setUsername(e.target.value)}
            autoComplete="username"
            required
          />
        </div>

        {/* Password */}
        <div className="space-y-1.5">
          <label className="font-label text-sm uppercase tracking-widest text-on-surface-variant ml-1">密碼</label>
          <input
            className="w-full bg-surface-container-highest border-none focus:ring-1 focus:ring-primary/40 text-on-surface py-3 px-4 text-base md:text-sm font-body rounded placeholder:text-outline"
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full cyber-gradient text-on-primary font-headline font-bold uppercase tracking-widest text-sm py-4 rounded-sm shadow-lg shadow-primary/10 hover:brightness-110 active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? '登入中...' : '登入'}
        </button>
      </form>

      {onAdminMode && (
        <div className="mt-8">
          <div className="w-full h-px bg-outline-variant/25 relative mb-5">
            <span className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-surface-container-high px-3 text-[10px] uppercase tracking-widest text-outline-variant/70">
              其他
            </span>
          </div>
          <button
            type="button"
            onClick={onAdminMode}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded text-sm text-on-surface-variant hover:text-on-surface border border-outline-variant/50 hover:border-outline-variant hover:bg-surface-container transition-colors bg-transparent cursor-pointer"
          >
            <span className="material-symbols-outlined text-sm">admin_panel_settings</span>
            管理員帳號登入
          </button>
        </div>
      )}
    </>
  );
}

/* ============================================================
   Standard Email/Password Login Form (non-panjit)
   ============================================================ */
function EmailLoginForm({ onBack }: { onBack?: () => void }) {
  const { login, verifyEmail, resendCode } = useAuth();
  const { t } = useTranslation();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [errorType, setErrorType] = useState<'error' | 'warning' | 'info'>('error');
  const [loading, setLoading] = useState(false);
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
      const storedToken = localStorage.getItem('token');
      if (storedToken) {
        try {
          const payload = JSON.parse(atob(storedToken.split('.')[1]));
          if (payload.role === 'admin') { router.push('/admin/overview'); return; }
        } catch { /* ignore */ }
      }
      router.push('/dashboard');
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('審核') || msg.includes('等待')) setErrorType('warning');
      else if (msg.includes('鎖定') || msg.includes('頻繁')) setErrorType('info');
      else if (msg.includes('用量上限') || msg.includes('超過')) setErrorType('warning');
      else if (msg.includes('Google')) setErrorType('info');
      else setErrorType('error');
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
    } catch (err) { setError((err as Error).message); }
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

  if (verifyStep) {
    return (
      <>
        <div className="mb-8 md:mb-10">
          <h3 className="font-headline text-2xl font-bold mb-1.5">{t('register.verifyTitle' as any)}</h3>
          <p className="text-on-surface-variant text-sm">{t('register.verifyDescription' as any)}</p>
          <p className="text-primary text-sm font-mono mt-2">{verifyEmail_}</p>
        </div>
        <form onSubmit={handleVerify} className="space-y-6">
          {error && <div className="px-4 py-3 rounded text-sm flex items-start gap-3 bg-error-container/30 border border-error/20 text-on-error-container"><span className="material-symbols-outlined text-sm mt-0.5 shrink-0">error</span>{error}</div>}
          <div className="space-y-1.5">
            <label className="font-label text-sm uppercase tracking-widest text-on-surface-variant ml-1">{t('register.verifyCodeLabel' as any)}</label>
            <input
              className="w-full bg-surface-container-highest border-none focus:ring-1 focus:ring-primary/40 text-on-surface py-3 px-4 text-center text-2xl font-mono tracking-[0.5em] rounded placeholder:text-outline placeholder:text-base placeholder:tracking-normal"
              type="text" inputMode="numeric" maxLength={6}
              value={code} onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder={t('register.verifyCodePlaceholder' as any)} required autoFocus
            />
          </div>
          <button type="submit" disabled={verifyLoading || code.length !== 6}
            className="w-full cyber-gradient text-on-primary font-headline font-bold uppercase tracking-widest text-sm py-4 rounded-sm shadow-lg shadow-primary/10 hover:brightness-110 active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed">
            {verifyLoading ? t('register.verifyLoading' as any) : t('register.verifySubmit' as any)}
          </button>
          <div className="flex justify-between items-center">
            <button type="button" onClick={() => { setVerifyStep(false); setError(''); setCode(''); }}
              className="text-xs font-label text-on-surface-variant hover:text-primary transition-colors bg-transparent cursor-pointer">
              &larr; {t('login.title')}
            </button>
            <button type="button" onClick={handleResend} disabled={resendCooldown > 0}
              className="text-xs font-label text-on-surface-variant hover:text-primary transition-colors bg-transparent cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">
              {resendCooldown > 0 ? `${t('register.resendCooldown' as any)} (${resendCooldown}s)` : t('register.resendCooldown' as any)}
            </button>
          </div>
        </form>
      </>
    );
  }

  return (
    <>
      <div className="mb-8 md:mb-10">
        <h3 className="font-headline text-2xl font-bold mb-1.5">{t('login.title')}</h3>
        <p className="text-on-surface-variant text-sm">{t('login.subtitle')}</p>
      </div>
      <form onSubmit={handleSubmit} className="space-y-6">
        {error && (
          <div className={`px-4 py-3 rounded text-sm flex items-start gap-3 ${
            errorType === 'warning' ? 'bg-warning/10 border border-warning/20 text-warning'
            : errorType === 'info' ? 'bg-primary/10 border border-primary/20 text-primary'
            : 'bg-error-container/30 border border-error/20 text-on-error-container'
          }`}>
            <span className="material-symbols-outlined text-sm mt-0.5 shrink-0">
              {errorType === 'warning' ? 'hourglass_top' : errorType === 'info' ? 'lock' : 'error'}
            </span>
            {error}
          </div>
        )}
        <div className="space-y-1.5">
          <label className="font-label text-sm uppercase tracking-widest text-on-surface-variant ml-1">{t('login.emailLabel')}</label>
          <input
            className="w-full bg-surface-container-highest border-none focus:ring-1 focus:ring-primary/40 text-on-surface py-3 px-4 text-base md:text-sm font-body rounded placeholder:text-outline"
            type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="your@email.com" required
          />
        </div>
        <div className="space-y-1.5">
          <label className="font-label text-sm uppercase tracking-widest text-on-surface-variant ml-1">{t('login.passwordLabel')}</label>
          <input
            className="w-full bg-surface-container-highest border-none focus:ring-1 focus:ring-primary/40 text-on-surface py-3 px-4 text-base md:text-sm font-body rounded placeholder:text-outline"
            type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••••••" required
          />
        </div>
        {!onBack && (
          <div className="flex justify-between -mt-1">
            <Link href="/forgot-password" className="text-xs font-label text-on-surface-variant hover:text-primary transition-colors">
              {t('login.forgotPassword' as any)}
            </Link>
            <Link href="/register" className="text-xs font-label text-on-surface-variant hover:text-primary transition-colors">
              {t('login.noAccount')} {t('login.createAccount')} &rarr;
            </Link>
          </div>
        )}
        <button type="submit" disabled={loading}
          className="w-full cyber-gradient text-on-primary font-headline font-bold uppercase tracking-widest text-sm py-4 rounded-sm shadow-lg shadow-primary/10 hover:brightness-110 active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed">
          {loading ? t('login.submitLoading') : t('login.submit')}
        </button>
        {onBack && (
          <button type="button" onClick={onBack}
            className="w-full text-xs font-label text-on-surface-variant hover:text-primary transition-colors bg-transparent cursor-pointer text-center">
            &larr; 返回 AD 登入
          </button>
        )}
      </form>
      {!onBack && googleClientId && (
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
                if (payload.role === 'admin') { router.push('/admin/overview'); return; }
              } catch { /* ignore */ }
            }
            router.push('/dashboard');
          }} onError={(msg) => { setErrorType('error'); setError(msg); }}
          onNeedsVerification={onGoogleNeedsVerification} />
        </div>
      )}
    </>
  );
}

/* ============================================================
   Main Login Form (container)
   ============================================================ */
function LoginForm() {
  const { t } = useTranslation();
  const [adminMode, setAdminMode] = useState(false);

  return (
    <div className="bg-surface-container-lowest text-on-surface font-body min-h-[100svh] flex flex-col items-center justify-center md:p-6 overflow-hidden relative selection:bg-primary/30">
      {/* Background Decoration */}
      <div className="absolute inset-0 bg-pattern pointer-events-none opacity-40" />
      <div className="absolute top-[-10%] right-[-10%] w-[40%] h-[40%] bg-primary/5 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-5%] left-[-5%] w-[30%] h-[30%] bg-tertiary/5 rounded-full blur-[100px] pointer-events-none" />

      <main className="w-full max-w-6xl flex flex-col md:flex-row gap-0 md:shadow-2xl z-10">
        {/* Left Side: Branding */}
        <section className="hidden md:flex flex-col justify-between p-12 w-1/2 bg-surface-container-low relative overflow-hidden">
          <div className="space-y-8">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 cyber-gradient flex items-center justify-center rounded">
                <span className="material-symbols-outlined text-on-primary">terminal</span>
              </div>
              <div>
                <h1 className="font-headline text-2xl font-bold tracking-tighter text-on-surface">{t('common.appName')}</h1>
                <p className="font-label text-sm uppercase tracking-[0.2em] text-primary">
                  {t(isPanjit ? 'login.brandSubtitle' : 'login.brandSubtitleGeneric' as any)}
                </p>
              </div>
            </div>
            <div className="space-y-6 mt-16">
              <h2 className="font-headline text-4xl font-light leading-tight">
                {t('login.heroTitle.prefix')}<span className="text-primary font-medium">{t('login.heroTitle.highlight')}</span>
                <br />{t('login.heroTitle.suffix')}
              </h2>
              <p className="text-on-surface-variant font-body leading-relaxed max-w-md">{t('login.heroDescription')}</p>
            </div>
          </div>
          <div className="space-y-4">
            <div className="flex items-center gap-4 p-4 bg-surface-container rounded-lg">
              <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
              <span className="font-label text-sm uppercase tracking-widest text-on-surface-variant">{t('login.systemStatus')}</span>
            </div>
            <div className="flex gap-2">
              <div className="h-1 w-8 bg-primary" />
              <div className="h-1 w-4 bg-surface-variant" />
              <div className="h-1 w-4 bg-surface-variant" />
            </div>
          </div>
          <div className="absolute bottom-12 right-12 opacity-10 pointer-events-none">
            <span className="material-symbols-outlined text-[120px]">smart_toy</span>
          </div>
        </section>

        {/* Right Side: Login Form */}
        <section className="flex-1 bg-surface-container-high px-5 py-10 sm:px-8 md:p-16 flex flex-col justify-center min-h-[100svh] md:min-h-0">
          <div className="max-w-md mx-auto w-full">
            {/* Mobile Logo */}
            <div className="md:hidden flex items-center gap-3 mb-8">
              <div className="w-10 h-10 cyber-gradient flex items-center justify-center rounded">
                <span className="material-symbols-outlined text-on-primary">terminal</span>
              </div>
              <div>
                <h1 className="font-headline text-xl font-bold tracking-tighter leading-tight">{t('common.appName')}</h1>
                <p className="font-label text-[11px] uppercase tracking-[0.15em] text-primary">{t(isPanjit ? 'login.brandSubtitle' : 'login.brandSubtitleGeneric' as any)}</p>
              </div>
            </div>

            {isPanjit && !adminMode
              ? <AdLoginForm onAdminMode={() => setAdminMode(true)} />
              : <EmailLoginForm onBack={isPanjit ? () => setAdminMode(false) : undefined} />
            }
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
  if (!isPanjit && googleClientId) {
    return (
      <GoogleOAuthProvider clientId={googleClientId}>
        <LoginPageInner />
      </GoogleOAuthProvider>
    );
  }
  return <LoginPageInner />;
}
