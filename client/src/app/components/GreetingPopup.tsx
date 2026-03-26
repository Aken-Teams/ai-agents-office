'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from '../../i18n';

interface GreetingPopupProps {
  userName: string;
  userId: string;
  onClose: () => void;
}

export default function GreetingPopup({ userName, userId, onClose }: GreetingPopupProps) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState(false);
  const [visible, setVisible] = useState(false);
  const textRef = useRef('');

  // Animate in after mount
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 50);
    return () => clearTimeout(timer);
  }, []);

  const handleClose = useCallback(() => {
    setVisible(false);
    setTimeout(onClose, 200);
  }, [onClose]);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) { setError(true); return; }

    // Use fetch for SSE since EventSource doesn't support auth headers
    const controller = new AbortController();

    (async () => {
      try {
        // Connect directly to Express for SSE (Next.js proxy buffers responses)
        const sseBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:12054';
        const res = await fetch(`${sseBase}/api/greeting`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });

        if (!res.ok) {
          setError(true);
          return;
        }

        const reader = res.body?.getReader();
        if (!reader) { setError(true); return; }

        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done: streamDone, value } = await reader.read();
          if (streamDone) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const event = JSON.parse(line.slice(6));

              if (event.type === 'welcome') {
                // New/idle user — static onboarding message (no AI)
                localStorage.setItem('greeting_shown_for', localStorage.getItem('greeting_login_id') || '');
                let msg = t('greeting.welcome' as any, { name: event.userName || userName });
                if (event.announcements?.length) {
                  msg += '\n\n' + t('greeting.newFeatures' as any) + event.announcements.join('、') + '！';
                }
                textRef.current = msg;
                setText(msg);
              } else if (event.type === 'text_delta' && event.data) {
                if (!textRef.current) localStorage.setItem('greeting_shown_for', localStorage.getItem('greeting_login_id') || '');
                textRef.current += event.data;
                setText(textRef.current);
              } else if (event.type === 'text' && event.data) {
                // Full text block (fallback if no streaming deltas)
                if (!textRef.current) {
                  localStorage.setItem('greeting_shown_for', localStorage.getItem('greeting_login_id') || '');
                  textRef.current = event.data;
                  setText(event.data);
                }
              } else if (event.type === 'done') {
                setDone(true);
              } else if (event.type === 'error') {
                setError(true);
              }
            } catch { /* skip */ }
          }
        }
        setDone(true);
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setError(true);
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }, []);

  // If new user (no greeting returned), show nothing
  if (error) return null;

  return (
    <div className={`fixed inset-0 z-[100] flex items-end md:items-center justify-center transition-all duration-200 ${visible ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-scrim/40 backdrop-blur-sm"
        onClick={handleClose}
      />

      {/* Popup card */}
      <div className={`relative w-full max-w-lg mx-4 mb-4 md:mb-0 bg-surface-container-high rounded-2xl shadow-2xl overflow-hidden transition-all duration-300 ${visible ? 'translate-y-0 scale-100' : 'translate-y-8 scale-95'}`}>
        {/* Header */}
        <div className="flex items-center gap-3 px-5 pt-5 pb-3">
          <div className="w-10 h-10 cyber-gradient rounded-full flex items-center justify-center shrink-0 shadow-lg shadow-primary/20">
            <span className="material-symbols-outlined text-on-primary text-xl">smart_toy</span>
          </div>
          <div className="flex-1 min-w-0">
            <span className="text-sm font-headline font-bold text-on-surface">AI Assistant</span>
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
              <span className="text-[11px] text-on-surface-variant">{t('greeting.online' as any)}</span>
            </div>
          </div>
          <button
            onClick={handleClose}
            className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-surface-container transition-colors cursor-pointer text-on-surface-variant"
          >
            <span className="material-symbols-outlined text-lg">close</span>
          </button>
        </div>

        {/* Chat bubble */}
        <div className="px-5 pb-5">
          <div className="bg-surface-container rounded-2xl rounded-tl-sm px-4 py-3 text-sm text-on-surface leading-relaxed min-h-[60px]">
            {text ? (
              <span className="whitespace-pre-line">
                {text}
                {!done && <span className="inline-block w-0.5 h-4 bg-primary ml-0.5 animate-pulse align-text-bottom" />}
              </span>
            ) : (
              <div className="flex items-center gap-2 text-on-surface-variant">
                <span className="material-symbols-outlined text-sm animate-spin">progress_activity</span>
                <span className="text-xs">{t('greeting.thinking' as any)}</span>
              </div>
            )}
          </div>

          {/* Quick actions (show when done) */}
          {done && text && (
            <div className="flex gap-2 mt-3">
              <button
                onClick={handleClose}
                className="flex-1 py-2.5 bg-surface-container hover:bg-surface-container-highest rounded-xl text-xs font-headline font-bold text-on-surface-variant hover:text-on-surface transition-all cursor-pointer"
              >
                {t('greeting.dismiss' as any)}
              </button>
              <button
                onClick={() => {
                  localStorage.setItem(`greeting_muted_${userId}`, new Date().toISOString().slice(0, 10));
                  handleClose();
                }}
                className="py-2.5 px-4 rounded-xl text-xs font-headline font-bold text-on-surface-variant/60 hover:text-on-surface-variant transition-all cursor-pointer"
              >
                {t('greeting.muteToday' as any)}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
