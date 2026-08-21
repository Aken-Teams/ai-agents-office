'use client';

import { useState, useCallback, useRef, useEffect } from 'react';

/**
 * Copy a message to the clipboard, with the confirmation people look for.
 *
 * `getText` is a function rather than a string so the text is read at click
 * time — a message that is still streaming would otherwise copy whatever it
 * happened to contain when the button first rendered.
 *
 * navigator.clipboard needs a secure context; this app is served over plain HTTP
 * on the LAN in some deployments, so there is a textarea+execCommand fallback.
 * Without it the button would look broken for exactly those users.
 */
export default function CopyButton({ getText, className = '' }: { getText: () => string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const copy = useCallback(async () => {
    const text = (getText() || '').trim();
    if (!text) return;
    let ok = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch { /* fall through to the legacy path */ }
    if (!ok) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        // Keep it off-screen but focusable — display:none would not be selectable.
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        ta.remove();
      } catch { ok = false; }
    }
    if (!ok) return;
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1600);
  }, [getText]);

  return (
    <button
      onClick={copy}
      title={copied ? '已複製' : '複製這則回覆'}
      aria-label={copied ? '已複製' : '複製這則回覆'}
      // A filled chip rather than bare text: sitting alone in the corner of a
      // large bubble, an unfilled icon reads as decoration and gets missed.
      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md border text-[11px] md:text-xs font-medium transition-colors cursor-pointer
        ${copied
          ? 'bg-success/15 border-success/30 text-success'
          : 'bg-primary/10 border-primary/20 text-primary hover:bg-primary/20 hover:border-primary/40'} ${className}`}
    >
      <span className="material-symbols-outlined text-[14px]">{copied ? 'check' : 'content_copy'}</span>
      {copied ? '已複製' : '複製'}
    </button>
  );
}
