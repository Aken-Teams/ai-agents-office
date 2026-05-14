'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from '../../i18n';

const SSE_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:12054';

interface EmailNotification {
  emailId: string;
  subject: string;
  from: { name: string; address: string };
  receivedAt: string;
  isRead: boolean;
  hasAttachments: boolean;
  summary: string;
  priority: '高' | '中' | '低';
  category: string;
  analysis?: string;
  analyzing?: boolean;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export default function EmailAgentWidget() {
  const { t } = useTranslation();
  const [mounted, setMounted] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [connected, setConnected] = useState(false);
  const [notifications, setNotifications] = useState<EmailNotification[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [totalUnread, setTotalUnread] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const notifListRef = useRef<HTMLDivElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const reconnectTimer = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => { setMounted(true); return () => setMounted(false); }, []);

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages, streamText]);

  // SSE connection
  const connectSSE = useCallback(async (signal: AbortSignal) => {
    const token = localStorage.getItem('token');
    if (!token) return;

    try {
      const res = await fetch(`${SSE_BASE}/api/email-agent/events`, {
        headers: { Authorization: `Bearer ${token}` },
        signal,
      });
      if (!res.ok || !res.body) return;

      setConnected(true);
      setError(null);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6));
            handleEvent(event);
          } catch { /* skip */ }
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      console.warn('[EmailAgent] SSE disconnected, reconnecting in 10s...');
    }

    setConnected(false);
    // Reconnect after 10s
    if (!signal.aborted) {
      reconnectTimer.current = setTimeout(() => {
        if (!signal.aborted) connectSSE(signal);
      }, 10_000);
    }
  }, []);

  const handleEvent = useCallback((event: { type: string; data?: any }) => {
    switch (event.type) {
      case 'new_emails': {
        const { emails, totalUnread: unread } = event.data;
        setNotifications(prev => {
          const existing = new Set(prev.map(n => n.emailId));
          const newOnes = (emails as EmailNotification[]).filter(e => !existing.has(e.emailId));
          return [...newOnes, ...prev].slice(0, 50);
        });
        if (unread !== undefined) setTotalUnread(unread);
        break;
      }
      case 'ai_analysis': {
        const { emailId, analysis } = event.data;
        setNotifications(prev => prev.map(n =>
          n.emailId === emailId ? { ...n, analysis, analyzing: false } : n
        ));
        break;
      }
      case 'ai_response_delta': {
        setStreamText(prev => prev + event.data.text);
        break;
      }
      case 'ai_response_done': {
        const text = event.data.text;
        setChatMessages(prev => [...prev, { role: 'assistant', content: text }]);
        setStreamText('');
        setStreaming(false);
        break;
      }
      case 'error': {
        setError(event.data.message || '連線錯誤');
        break;
      }
      case 'status': {
        if (event.data.connected) setConnected(true);
        if (event.data.totalUnread !== undefined) setTotalUnread(event.data.totalUnread);
        break;
      }
    }
  }, []);

  // Start SSE on mount
  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    connectSSE(controller.signal);

    // Load chat history
    const token = localStorage.getItem('token');
    if (token) {
      fetch(`${SSE_BASE}/api/email-agent/history`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (data?.messages?.length) {
            setChatMessages(data.messages.map((m: any) => ({
              role: m.role, content: m.content,
            })));
          }
        })
        .catch(() => {});
    }

    return () => {
      controller.abort();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };
  }, [connectSSE]);

  // Send chat message
  const sendMessage = async () => {
    const msg = chatInput.trim();
    if (!msg || streaming) return;

    const token = localStorage.getItem('token');
    if (!token) return;

    setChatInput('');
    setChatMessages(prev => [...prev, { role: 'user', content: msg }]);
    setStreaming(true);
    setStreamText('');

    try {
      await fetch(`${SSE_BASE}/api/email-agent/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ message: msg }),
      });
    } catch {
      setStreaming(false);
    }
  };

  // Request Layer 2 analysis
  const requestAnalysis = async (emailId: string) => {
    const token = localStorage.getItem('token');
    if (!token) return;

    setNotifications(prev => prev.map(n =>
      n.emailId === emailId ? { ...n, analyzing: true } : n
    ));

    try {
      await fetch(`${SSE_BASE}/api/email-agent/analyze/${emailId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      setNotifications(prev => prev.map(n =>
        n.emailId === emailId ? { ...n, analyzing: false } : n
      ));
    }
  };

  if (!mounted) return null;

  // Badge count = new unread notifications
  const badgeCount = notifications.filter(n => !n.isRead).length || totalUnread;

  const priorityStyle = {
    '高': 'bg-error/10 text-error',
    '中': 'bg-warning/10 text-warning',
    '低': 'bg-surface-container text-on-surface-variant',
  };

  const widget = (
    <>
      {/* Floating Bubble */}
      <button
        onClick={() => setExpanded(!expanded)}
        className={`fixed bottom-6 right-6 z-[90] w-14 h-14 rounded-full shadow-xl flex items-center justify-center transition-all duration-300 ${
          expanded ? 'bg-surface-container-high text-on-surface scale-90' : 'bg-primary text-on-primary hover:shadow-2xl hover:scale-105'
        }`}
        title={t('emailAgent.title' as any) || '信件助手'}
      >
        <span className="material-symbols-outlined text-2xl">
          {expanded ? 'close' : 'mail'}
        </span>
        {!expanded && badgeCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[20px] h-5 flex items-center justify-center bg-error text-on-error text-xs font-bold rounded-full px-1">
            {badgeCount > 99 ? '99+' : badgeCount}
          </span>
        )}
        {!expanded && connected && (
          <span className="absolute bottom-0 right-0 w-3 h-3 bg-success rounded-full border-2 border-surface" />
        )}
      </button>

      {/* Expanded Panel */}
      {expanded && (
        <div className="fixed bottom-24 right-6 z-[95] w-[380px] max-h-[600px] bg-surface-container-high rounded-2xl shadow-2xl border border-outline-variant/10 flex flex-col overflow-hidden animate-in slide-in-from-bottom-4 duration-200">
          {/* Header */}
          <div className="flex items-center gap-3 px-4 py-3 border-b border-outline-variant/10">
            <span className="material-symbols-outlined text-primary text-xl">smart_toy</span>
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-on-surface">
                {t('emailAgent.title' as any) || '信件助手'}
              </h3>
              <div className="flex items-center gap-1.5">
                <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-success' : 'bg-error'}`} />
                <span className="text-[11px] text-on-surface-variant">
                  {connected
                    ? (t('emailAgent.connected' as any) || '已連線')
                    : (t('emailAgent.disconnected' as any) || '未連線')}
                </span>
              </div>
            </div>
            <button
              onClick={() => setExpanded(false)}
              className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-surface-container-highest transition-colors"
            >
              <span className="material-symbols-outlined text-base text-on-surface-variant">remove</span>
            </button>
          </div>

          {/* Error Banner */}
          {error && (
            <div className="px-4 py-2 bg-error/10 text-error text-xs flex items-center gap-2">
              <span className="material-symbols-outlined text-sm">warning</span>
              {error}
            </div>
          )}

          {/* Scrollable Content */}
          <div className="flex-1 overflow-y-auto min-h-0" ref={notifListRef}>
            {/* Notifications */}
            {notifications.length > 0 && (
              <div className="px-3 pt-3 pb-1">
                <div className="text-[11px] font-medium text-on-surface-variant uppercase tracking-wider mb-2 px-1">
                  {t('emailAgent.notifications' as any) || '通知'}
                </div>
                <div className="space-y-2">
                  {notifications.slice(0, 10).map(n => (
                    <div
                      key={n.emailId}
                      className="bg-surface-container rounded-xl p-3 hover:bg-surface-container-highest transition-colors"
                    >
                      <div className="flex items-start gap-2">
                        <span className={`shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded ${priorityStyle[n.priority]}`}>
                          {n.priority}
                        </span>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-on-surface font-medium truncate">{n.summary}</p>
                          <div className="flex items-center gap-2 mt-1">
                            <span className="text-[11px] text-on-surface-variant truncate">{n.from.name || n.from.address}</span>
                            <span className="text-[11px] text-on-surface-variant/60">·</span>
                            <span className="text-[11px] text-on-surface-variant/60 shrink-0">
                              {formatTime(n.receivedAt)}
                            </span>
                            {n.hasAttachments && (
                              <span className="material-symbols-outlined text-[11px] text-on-surface-variant/60">attach_file</span>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Analysis result */}
                      {n.analysis && (
                        <div className="mt-2 pl-8 text-xs text-on-surface-variant leading-relaxed whitespace-pre-wrap border-l-2 border-primary/20 pl-3">
                          {n.analysis}
                        </div>
                      )}

                      {/* Action buttons */}
                      <div className="flex items-center gap-2 mt-2 pl-8">
                        {!n.analysis && (
                          <button
                            onClick={() => requestAnalysis(n.emailId)}
                            disabled={n.analyzing}
                            className="text-[11px] text-primary hover:text-primary/80 font-medium flex items-center gap-1 disabled:opacity-50"
                          >
                            {n.analyzing ? (
                              <>
                                <span className="material-symbols-outlined text-xs animate-spin">progress_activity</span>
                                分析中...
                              </>
                            ) : (
                              <>
                                <span className="material-symbols-outlined text-xs">analytics</span>
                                {t('emailAgent.analyze' as any) || '深度分析'}
                              </>
                            )}
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {notifications.length === 0 && !error && (
              <div className="flex flex-col items-center justify-center py-8 text-on-surface-variant/60">
                <span className="material-symbols-outlined text-3xl mb-2">inbox</span>
                <span className="text-xs">{t('emailAgent.noNotifications' as any) || '目前沒有新通知'}</span>
              </div>
            )}

            {/* Chat Messages */}
            {chatMessages.length > 0 && (
              <div className="px-3 pt-2 pb-1">
                <div className="text-[11px] font-medium text-on-surface-variant uppercase tracking-wider mb-2 px-1">
                  {t('emailAgent.showChat' as any) || '對話'}
                </div>
                <div className="space-y-2">
                  {chatMessages.slice(-10).map((msg, i) => (
                    <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[85%] px-3 py-2 rounded-xl text-sm ${
                        msg.role === 'user'
                          ? 'bg-primary text-on-primary rounded-br-sm'
                          : 'bg-surface-container text-on-surface rounded-bl-sm'
                      }`}>
                        <p className="whitespace-pre-wrap leading-relaxed">{msg.content}</p>
                      </div>
                    </div>
                  ))}
                  {streaming && streamText && (
                    <div className="flex justify-start">
                      <div className="max-w-[85%] px-3 py-2 rounded-xl rounded-bl-sm bg-surface-container text-on-surface text-sm">
                        <p className="whitespace-pre-wrap leading-relaxed">{streamText}<span className="animate-pulse">▊</span></p>
                      </div>
                    </div>
                  )}
                </div>
                <div ref={chatEndRef} />
              </div>
            )}
          </div>

          {/* Chat Input */}
          <div className="border-t border-outline-variant/10 p-3">
            <div className="flex items-center gap-2">
              <input
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
                placeholder={t('emailAgent.placeholder' as any) || '輸入信件相關問題...'}
                disabled={streaming || !connected}
                className="flex-1 bg-surface-container rounded-lg px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-variant/50 outline-none focus:ring-1 focus:ring-primary/30 disabled:opacity-50"
              />
              <button
                onClick={sendMessage}
                disabled={streaming || !chatInput.trim() || !connected}
                className="w-9 h-9 flex items-center justify-center rounded-full bg-primary text-on-primary disabled:opacity-40 hover:bg-primary/90 transition-colors"
              >
                <span className="material-symbols-outlined text-lg">
                  {streaming ? 'hourglass_empty' : 'send'}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );

  return createPortal(widget, document.body);
}

function formatTime(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    if (diff < 60_000) return '剛剛';
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)}分鐘前`;
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}小時前`;
    return `${d.getMonth() + 1}/${d.getDate()}`;
  } catch {
    return dateStr;
  }
}
