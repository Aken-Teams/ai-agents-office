'use client';

import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface TermsModalProps {
  token: string;
  onAccepted: () => void;
}

export default function TermsModal({ token, onAccepted }: TermsModalProps) {
  const [tosContent, setTosContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [hasScrolledToBottom, setHasScrolledToBottom] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Fetch TOS content
  useEffect(() => {
    fetch('/api/auth/terms', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.content) setTosContent(data.content);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [token]);

  // IntersectionObserver for scroll-to-bottom detection
  useEffect(() => {
    if (loading || !tosContent || !sentinelRef.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setHasScrolledToBottom(true);
      },
      { root: scrollContainerRef.current, threshold: 0.1 }
    );
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [loading, tosContent]);

  async function handleAccept() {
    setAccepting(true);
    try {
      const res = await fetch('/api/auth/accept-terms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        onAccepted();
      }
    } finally {
      setAccepting(false);
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-end md:items-center justify-center md:p-8">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-md" />

      {/* Modal - full screen on mobile, centered card on desktop */}
      <div className="relative bg-surface-container-lowest w-full h-full md:h-auto md:rounded-3xl md:shadow-2xl md:border md:border-outline-variant/15 md:max-w-[680px] md:max-h-[88vh] flex flex-col overflow-hidden animate-in fade-in slide-in-from-bottom-4 md:zoom-in-95 duration-300 safe-area-top safe-area-bottom">

        {/* Header */}
        <div className="px-5 pt-5 pb-4 md:px-7 md:pt-7 md:pb-5 shrink-0">
          <div className="flex items-start gap-3 md:gap-4">
            <div className="w-10 h-10 md:w-12 md:h-12 rounded-xl md:rounded-2xl cyber-gradient flex items-center justify-center shrink-0 shadow-lg shadow-primary/20">
              <span className="material-symbols-outlined text-on-primary text-xl md:text-2xl">gavel</span>
            </div>
            <div className="pt-0.5 min-w-0">
              <h2 className="font-headline text-lg md:text-xl font-bold text-on-surface leading-tight">
                系統使用規範與管理辦法
              </h2>
              <p className="text-xs md:text-sm text-on-surface-variant mt-1 md:mt-1.5 leading-relaxed">
                請詳閱以下使用條款，捲動至底部後方可同意
              </p>
            </div>
          </div>
        </div>

        {/* Content */}
        {loading ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <span className="material-symbols-outlined animate-spin text-primary text-3xl">progress_activity</span>
            <span className="text-sm text-on-surface-variant">載入條款中...</span>
          </div>
        ) : (
          <>
            <div className="mx-5 md:mx-7 border-t border-outline-variant/12" />

            <div
              ref={scrollContainerRef}
              className="flex-1 overflow-y-auto px-5 py-4 md:px-7 md:py-5 scroll-smooth relative"
            >
              <div className="terms-prose text-[13px] md:text-[13.5px] text-on-surface leading-[1.75]">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    h1: ({ children, ...props }) => (
                      <h1 className="text-[15px] md:text-[17px] font-bold text-on-surface mt-0 mb-3 md:mb-4 pb-2 md:pb-2.5 border-b border-outline-variant/12 flex items-center gap-2" {...props}>
                        <span className="w-1 h-4 md:h-5 rounded-full bg-primary inline-block shrink-0" />
                        {children}
                      </h1>
                    ),
                    h2: ({ children, ...props }) => (
                      <h2 className="text-[14px] md:text-[15px] font-bold text-on-surface mt-5 md:mt-7 mb-2 md:mb-2.5 flex items-center gap-2" {...props}>
                        <span className="w-1.5 h-1.5 rounded-full bg-primary/60 inline-block shrink-0" />
                        {children}
                      </h2>
                    ),
                    h3: ({ children, ...props }) => (
                      <h3 className="text-[13px] md:text-[14px] font-semibold text-on-surface mt-3 md:mt-4 mb-1.5 md:mb-2" {...props}>{children}</h3>
                    ),
                    p: ({ children, ...props }) => (
                      <p className="mb-2.5 md:mb-3 last:mb-0 text-on-surface-variant" {...props}>{children}</p>
                    ),
                    ul: ({ children, ...props }) => (
                      <ul className="mb-2.5 md:mb-3 space-y-1 md:space-y-1.5 pl-1" {...props}>{children}</ul>
                    ),
                    ol: ({ children, ...props }) => (
                      <ol className="list-decimal pl-5 mb-2.5 md:mb-3 space-y-1 md:space-y-1.5" {...props}>{children}</ol>
                    ),
                    li: ({ children, ...props }) => (
                      <li className="text-on-surface-variant flex gap-2 items-baseline [&>ul]:mt-1.5 [&>ol]:mt-1.5" {...props}>
                        <span className="text-primary/40 text-[10px] mt-[5px] shrink-0 select-none">●</span>
                        <span>{children}</span>
                      </li>
                    ),
                    strong: ({ children, ...props }) => (
                      <strong className="font-semibold text-on-surface" {...props}>{children}</strong>
                    ),
                    blockquote: ({ children, ...props }) => (
                      <blockquote className="border-l-[3px] border-primary/25 pl-3 md:pl-4 my-3 md:my-4 text-on-surface-variant bg-primary/[0.04] rounded-r-xl py-2.5 md:py-3 pr-3 md:pr-4" {...props}>{children}</blockquote>
                    ),
                    table: ({ children, ...props }) => (
                      <div className="overflow-x-auto my-3 md:my-4 rounded-xl border border-outline-variant/15 bg-surface-container/50 -mx-1">
                        <table className="w-full text-[12px] md:text-[13px] min-w-[420px]" {...props}>{children}</table>
                      </div>
                    ),
                    thead: ({ children, ...props }) => (
                      <thead className="bg-surface-container-high/60" {...props}>{children}</thead>
                    ),
                    th: ({ children, ...props }) => (
                      <th className="text-left px-3 md:px-4 py-2 md:py-2.5 font-semibold text-on-surface text-[11px] md:text-xs uppercase tracking-wider border-b border-outline-variant/15 whitespace-nowrap" {...props}>{children}</th>
                    ),
                    td: ({ children, ...props }) => (
                      <td className="px-3 md:px-4 py-2 md:py-2.5 text-on-surface-variant border-b border-outline-variant/8" {...props}>{children}</td>
                    ),
                    tr: ({ children, ...props }) => (
                      <tr className="transition-colors hover:bg-surface-container-high/30" {...props}>{children}</tr>
                    ),
                    hr: (props) => <hr className="my-4 md:my-5 border-outline-variant/12" {...props} />,
                    a: ({ children, href, ...props }) => (
                      <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary hover:text-primary/80 underline underline-offset-2 decoration-primary/30 hover:decoration-primary/60 transition-colors" {...props}>{children}</a>
                    ),
                  }}
                >
                  {tosContent}
                </ReactMarkdown>
              </div>
              <div ref={sentinelRef} className="h-1" />
            </div>

            {/* Scroll fade overlay */}
            {!hasScrolledToBottom && (
              <div className="absolute bottom-[69px] md:bottom-[73px] left-0 right-0 h-10 md:h-12 bg-gradient-to-t from-surface-container-lowest to-transparent pointer-events-none z-10" />
            )}

            {/* Footer */}
            <div className="px-5 py-4 md:px-7 md:py-5 border-t border-outline-variant/12 shrink-0 bg-surface-container-lowest">
              {!hasScrolledToBottom && (
                <div className="flex items-center justify-center gap-2 mb-2.5 md:mb-3 text-xs text-on-surface-variant/50">
                  <span className="material-symbols-outlined text-base animate-bounce">keyboard_double_arrow_down</span>
                  請捲動閱讀完整條款
                </div>
              )}

              <button
                onClick={handleAccept}
                disabled={accepting || !hasScrolledToBottom}
                className={`w-full py-3 md:py-3.5 rounded-xl font-bold text-sm md:text-[15px] transition-all duration-200 flex items-center justify-center gap-2 md:gap-2.5 ${
                  hasScrolledToBottom
                    ? 'text-on-primary bg-primary hover:brightness-110 shadow-lg shadow-primary/25 cursor-pointer disabled:opacity-50 disabled:shadow-none'
                    : 'text-on-surface-variant/40 bg-surface-variant/20 cursor-default'
                }`}
              >
                <span className="material-symbols-outlined text-lg md:text-xl">
                  {accepting ? 'progress_activity' : 'check_circle'}
                </span>
                {accepting ? '處理中...' : '我同意以上條款'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}
