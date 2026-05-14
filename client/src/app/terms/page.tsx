'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AuthProvider, useAuth } from '../components/AuthProvider';
import { I18nProvider, useTranslation } from '../../i18n';

function TermsContent() {
  const { t } = useTranslation();
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [hasScrolledToBottom, setHasScrolledToBottom] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Auth check: must be logged in and terms not yet accepted
  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) { router.replace('/login'); return; }
    fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(data => {
        if (!data.id) { router.replace('/login'); return; }
        if (!data.termsRequired) { router.replace('/dashboard'); return; }
        setAuthChecked(true);
      })
      .catch(() => router.replace('/login'));
  }, [router]);

  // Fetch TOS content
  useEffect(() => {
    if (!authChecked) return;
    const token = localStorage.getItem('token');
    if (!token) return;
    fetch('/api/auth/terms', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.content) setContent(data.content);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [authChecked]);

  // IntersectionObserver for scroll-to-bottom detection
  useEffect(() => {
    if (!sentinelRef.current || loading || !content) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setHasScrolledToBottom(true);
      },
      { root: scrollContainerRef.current, threshold: 0.1 }
    );
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [loading, content]);

  async function handleAccept() {
    setAccepting(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch('/api/auth/accept-terms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      });
      if (res.ok) router.replace('/dashboard');
    } finally {
      setAccepting(false);
    }
  }

  if (!authChecked) {
    return (
      <div className="min-h-[100svh] flex items-center justify-center bg-surface-container-lowest">
        <span className="material-symbols-outlined animate-spin text-primary text-4xl">progress_activity</span>
      </div>
    );
  }

  return (
    <div className="bg-surface-container-lowest text-on-surface font-body min-h-[100svh] flex flex-col items-center justify-center p-5 md:p-6 relative overflow-hidden selection:bg-primary/30">
      {/* Background decorations */}
      <div className="absolute inset-0 bg-pattern pointer-events-none opacity-30" />
      <div className="absolute top-[-10%] right-[-10%] w-[40%] h-[40%] bg-primary/5 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-5%] left-[-5%] w-[30%] h-[30%] bg-tertiary/5 rounded-full blur-[100px] pointer-events-none" />

      <main className="relative z-10 w-full max-w-2xl">
        {/* Logo */}
        <div className="flex items-center gap-3 mb-8">
          <div className="w-9 h-9 cyber-gradient flex items-center justify-center rounded">
            <span className="material-symbols-outlined text-on-primary text-lg">terminal</span>
          </div>
          <span className="font-headline text-xl font-bold tracking-tight text-on-surface">
            {t('common.appName' as any) || 'AI Agents Office'}
          </span>
        </div>

        <div className="bg-surface-container rounded-2xl shadow-2xl border border-outline-variant/20 p-6 md:p-8">
          {/* Header */}
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
              <span className="material-symbols-outlined text-primary text-xl">gavel</span>
            </div>
            <div>
              <h1 className="font-headline text-xl md:text-2xl font-bold text-on-surface">
                {t('terms.title' as any) || '系統使用規範與管理辦法'}
              </h1>
            </div>
          </div>
          <p className="text-sm text-on-surface-variant mb-5 ml-[52px]">
            {t('terms.subtitle' as any) || '請詳閱以下使用條款，捲動至底部後方可同意。'}
          </p>

          {/* Scrollable TOS content */}
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <span className="material-symbols-outlined animate-spin text-primary text-3xl">progress_activity</span>
            </div>
          ) : (
            <>
              <div
                ref={scrollContainerRef}
                className="max-h-[50vh] overflow-y-auto border border-outline-variant/15 rounded-xl p-5 md:p-6 bg-surface-container-high/50 scroll-smooth"
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
                    {content}
                  </ReactMarkdown>
                </div>
                {/* Sentinel for IntersectionObserver */}
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
              <div className={`mt-4 transition-all duration-300 ${hasScrolledToBottom ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4 pointer-events-none'}`}>
                <button
                  onClick={handleAccept}
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
      </main>
    </div>
  );
}

export default function TermsPage() {
  return (
    <AuthProvider>
      <TermsWithI18n />
    </AuthProvider>
  );
}

function TermsWithI18n() {
  const { user } = useAuth();
  return (
    <I18nProvider initialLocale={user?.locale} initialTheme={user?.theme}>
      <TermsContent />
    </I18nProvider>
  );
}
