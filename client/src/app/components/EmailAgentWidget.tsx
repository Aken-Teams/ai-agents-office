'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
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

type TabId = 'mail' | 'chat';

export default function EmailAgentWidget() {
  const { t } = useTranslation();
  const [mounted, setMounted] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [connected, setConnected] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>('mail');
  const [notifications, setNotifications] = useState<EmailNotification[]>([]);
  const [overview, setOverview] = useState('');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [totalUnread, setTotalUnread] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [expandedAnalysis, setExpandedAnalysis] = useState<Set<string>>(new Set());
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const reconnectTimer = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => { setMounted(true); return () => setMounted(false); }, []);

  // Auto-scroll chat
  useEffect(() => {
    if (activeTab === 'chat') {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages, streamText, activeTab]);

  // Compact markdown components for widget
  const compactMd = useMemo<Record<string, React.ComponentType<any>>>(() => ({
    h1: ({ children, ...props }: any) => <p className="font-bold text-on-surface mt-2.5 mb-1 text-[13px]" {...props}>{children}</p>,
    h2: ({ children, ...props }: any) => <p className="font-bold text-on-surface mt-2.5 mb-1 text-[13px]" {...props}>{children}</p>,
    h3: ({ children, ...props }: any) => <p className="font-semibold text-on-surface mt-2 mb-0.5 text-xs" {...props}>{children}</p>,
    h4: ({ children, ...props }: any) => <p className="font-semibold text-on-surface mt-1.5 mb-0.5 text-xs" {...props}>{children}</p>,
    p: ({ children, ...props }: any) => <p className="mb-1.5 last:mb-0 leading-relaxed" {...props}>{children}</p>,
    ul: ({ children, ...props }: any) => <ul className="list-disc pl-4 mb-1.5 space-y-0.5" {...props}>{children}</ul>,
    ol: ({ children, ...props }: any) => <ol className="list-decimal pl-4 mb-1.5 space-y-0.5" {...props}>{children}</ol>,
    li: ({ children, ...props }: any) => <li className="leading-relaxed" {...props}>{children}</li>,
    strong: ({ children, ...props }: any) => <strong className="font-semibold text-on-surface" {...props}>{children}</strong>,
    blockquote: ({ children, ...props }: any) => (
      <blockquote className="border-l-2 border-primary/30 pl-2.5 my-1.5 text-on-surface-variant italic" {...props}>{children}</blockquote>
    ),
    pre: ({ children, ...props }: any) => (
      <pre className="bg-surface-container rounded-lg p-2 my-1.5 text-[11px] overflow-x-auto" {...props}>{children}</pre>
    ),
    code: ({ className, children, ...props }: any) => {
      if (className) return <code className={className} {...props}>{children}</code>;
      return <code className="bg-surface-container px-1 py-0.5 rounded text-[11px] text-primary" {...props}>{children}</code>;
    },
    a: ({ children, href, ...props }: any) => (
      <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline" {...props}>{children}</a>
    ),
    table: ({ children, ...props }: any) => (
      <div className="overflow-x-auto my-1.5 rounded-lg border border-outline-variant/20">
        <table className="w-full text-[11px] border-collapse" {...props}>{children}</table>
      </div>
    ),
    thead: ({ children, ...props }: any) => <thead className="bg-surface-container" {...props}>{children}</thead>,
    th: ({ children, ...props }: any) => <th className="text-left px-2 py-1 font-semibold text-on-surface border-b border-outline-variant/20 whitespace-nowrap" {...props}>{children}</th>,
    td: ({ children, ...props }: any) => <td className="px-2 py-1 text-on-surface-variant border-b border-outline-variant/10" {...props}>{children}</td>,
    tr: ({ children, ...props }: any) => <tr className="hover:bg-surface-container/50" {...props}>{children}</tr>,
    hr: (props: any) => <hr className="my-2 border-outline-variant/20" {...props} />,
  }), []);

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
    if (!signal.aborted) {
      reconnectTimer.current = setTimeout(() => {
        if (!signal.aborted) connectSSE(signal);
      }, 10_000);
    }
  }, []);

  const handleEvent = useCallback((event: { type: string; data?: any }) => {
    switch (event.type) {
      case 'new_emails': {
        const { emails, totalUnread: unread, overview: ov } = event.data;
        setNotifications(prev => {
          const existing = new Set(prev.map(n => n.emailId));
          const newOnes = (emails as EmailNotification[]).filter(e => !existing.has(e.emailId));
          return [...newOnes, ...prev].slice(0, 50);
        });
        if (unread !== undefined) setTotalUnread(unread);
        if (ov) setOverview(ov);
        setInitialLoading(false);
        break;
      }
      case 'ai_analysis': {
        const { emailId, analysis } = event.data;
        setNotifications(prev => prev.map(n =>
          n.emailId === emailId ? { ...n, analysis, analyzing: false } : n
        ));
        // Auto-expand the analysis
        setExpandedAnalysis(prev => new Set([...prev, emailId]));
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
        setInitialLoading(false);
        break;
      }
      case 'status': {
        if (event.data.connected) setConnected(true);
        if (event.data.totalUnread !== undefined) setTotalUnread(event.data.totalUnread);
        setInitialLoading(false);
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

  // Send chat message (direct, for chips)
  const sendMessageDirect = useCallback(async (msg: string) => {
    if (!msg.trim() || streaming) return;
    const token = localStorage.getItem('token');
    if (!token) return;

    setChatMessages(prev => [...prev, { role: 'user', content: msg.trim() }]);
    setStreaming(true);
    setStreamText('');

    // Build compact email context from current notifications
    const emailContext = notifications.slice(0, 10).map(n => ({
      subject: n.subject,
      from: n.from.name || n.from.address,
      summary: n.summary,
      priority: n.priority,
      category: n.category,
      receivedAt: n.receivedAt,
      hasAttachments: n.hasAttachments,
    }));

    try {
      await fetch(`${SSE_BASE}/api/email-agent/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ message: msg.trim(), emailContext }),
      });
    } catch {
      setStreaming(false);
    }
  }, [streaming, notifications]);

  // Send chat message (from input)
  const sendMessage = useCallback(async () => {
    const msg = chatInput.trim();
    if (!msg) return;
    setChatInput('');
    await sendMessageDirect(msg);
  }, [chatInput, sendMessageDirect]);

  // Quick chip click
  const handleChipClick = useCallback((message: string) => {
    setActiveTab('chat');
    sendMessageDirect(message);
  }, [sendMessageDirect]);

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

  const toggleAnalysis = (emailId: string) => {
    setExpandedAnalysis(prev => {
      const next = new Set(prev);
      if (next.has(emailId)) next.delete(emailId);
      else next.add(emailId);
      return next;
    });
  };

  if (!mounted) return null;

  const badgeCount = notifications.filter(n => !n.isRead).length || totalUnread;
  const highPriorityCount = notifications.filter(n => n.priority === '高').length;

  const priorityIcon = { '高': 'priority_high', '中': 'radio_button_checked', '低': 'radio_button_unchecked' };
  const priorityColor = { '高': 'text-error', '中': 'text-warning', '低': 'text-on-surface-variant/60' };
  const priorityBg = { '高': 'bg-error/10', '中': 'bg-warning/10', '低': 'bg-surface-container' };

  const quickChips = [
    { icon: 'summarize', label: '今天重點', message: '今天有什麼重要信件需要我注意的？請幫我整理重點。' },
    { icon: 'reply_all', label: '待回覆', message: '哪些信件需要我盡快回覆？幫我列出來並建議回覆方向。' },
    { icon: 'shield', label: '資安檢查', message: '最近收到的信件有沒有資安風險或可疑內容？' },
  ];

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
          {expanded ? 'close' : 'smart_toy'}
        </span>
        {!expanded && badgeCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[20px] h-5 flex items-center justify-center bg-error text-on-error text-xs font-bold rounded-full px-1 animate-in zoom-in duration-200">
            {badgeCount > 99 ? '99+' : badgeCount}
          </span>
        )}
        {!expanded && connected && (
          <span className="absolute bottom-0 right-0 w-3 h-3 bg-success rounded-full border-2 border-surface" />
        )}
      </button>

      {/* Expanded Panel */}
      {expanded && (
        <div className="fixed bottom-24 right-6 z-[95] w-[480px] max-h-[640px] bg-surface-container-high rounded-2xl shadow-2xl border border-outline-variant/10 flex flex-col overflow-hidden animate-in slide-in-from-bottom-4 duration-200">
          {/* Header */}
          <div className="flex items-center gap-3 px-4 py-3 border-b border-outline-variant/10 bg-surface-container-high">
            <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
              <span className="material-symbols-outlined text-primary text-lg">smart_toy</span>
            </div>
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-on-surface">
                {t('emailAgent.title' as any) || '信件助手'}
              </h3>
              <div className="flex items-center gap-2">
                <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-success' : 'bg-error'}`} />
                <span className="text-[11px] text-on-surface-variant">
                  {connected
                    ? (t('emailAgent.connected' as any) || '已連線')
                    : (t('emailAgent.disconnected' as any) || '未連線')}
                </span>
                {totalUnread > 0 && (
                  <>
                    <span className="text-[11px] text-on-surface-variant/40">·</span>
                    <span className="text-[11px] text-on-surface-variant">
                      {totalUnread} 封未讀
                    </span>
                  </>
                )}
              </div>
            </div>
            <button
              onClick={() => setExpanded(false)}
              className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-surface-container-highest transition-colors"
            >
              <span className="material-symbols-outlined text-base text-on-surface-variant">remove</span>
            </button>
          </div>

          {/* Tab Bar */}
          <div className="flex border-b border-outline-variant/10 bg-surface-container-high">
            {([
              { id: 'mail' as TabId, icon: 'inbox', label: '信件', badge: notifications.length },
              { id: 'chat' as TabId, icon: 'chat', label: '對話', badge: 0 },
            ]).map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-medium transition-colors relative ${
                  activeTab === tab.id
                    ? 'text-primary'
                    : 'text-on-surface-variant hover:text-on-surface'
                }`}
              >
                <span className="material-symbols-outlined text-base">{tab.icon}</span>
                {tab.label}
                {tab.badge > 0 && (
                  <span className="min-w-[16px] h-4 flex items-center justify-center bg-primary/15 text-primary text-[10px] font-bold rounded-full px-1">
                    {tab.badge}
                  </span>
                )}
                {activeTab === tab.id && (
                  <span className="absolute bottom-0 left-1/4 right-1/4 h-0.5 bg-primary rounded-full" />
                )}
              </button>
            ))}
          </div>

          {/* Error Banner */}
          {error && (
            <div className="px-4 py-2 bg-error/10 text-error text-xs flex items-center gap-2">
              <span className="material-symbols-outlined text-sm">warning</span>
              {error}
            </div>
          )}

          {/* Scrollable Content */}
          <div className="flex-1 overflow-y-auto min-h-0" ref={scrollRef}>

            {/* ─── Mail Tab ─── */}
            {activeTab === 'mail' && (
              <div className="px-3 pt-3 pb-2">
                {/* AI Overview Banner */}
                {overview && (
                  <div className="mb-3 bg-primary/5 border border-primary/10 rounded-xl p-3 flex gap-2.5">
                    <span className="material-symbols-outlined text-primary text-base mt-0.5 shrink-0">auto_awesome</span>
                    <p className="text-xs text-on-surface leading-relaxed flex-1">{overview}</p>
                  </div>
                )}

                {/* Priority Summary Chips */}
                {notifications.length > 0 && highPriorityCount > 0 && (
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-[10px] font-medium text-error bg-error/10 px-2 py-0.5 rounded-full flex items-center gap-1">
                      <span className="material-symbols-outlined text-[10px]">priority_high</span>
                      {highPriorityCount} 封高優先
                    </span>
                  </div>
                )}

                {/* Email Cards */}
                {notifications.length > 0 ? (
                  <div className="space-y-2">
                    {notifications.slice(0, 15).map(n => (
                      <div
                        key={n.emailId}
                        className="bg-surface-container rounded-xl p-3 hover:bg-surface-container-highest transition-colors group"
                      >
                        <div className="flex items-start gap-2.5">
                          {/* Priority indicator */}
                          <div className={`shrink-0 w-6 h-6 rounded-full flex items-center justify-center ${priorityBg[n.priority]}`}>
                            <span className={`material-symbols-outlined text-sm ${priorityColor[n.priority]}`}>
                              {priorityIcon[n.priority]}
                            </span>
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-[13px] text-on-surface font-medium leading-snug line-clamp-2">{n.summary}</p>
                            <div className="flex items-center gap-1.5 mt-1">
                              <span className="text-[11px] text-on-surface-variant truncate max-w-[140px]">
                                {n.from.name || n.from.address}
                              </span>
                              <span className="text-[11px] text-on-surface-variant/40">·</span>
                              <span className="text-[11px] text-on-surface-variant/60 shrink-0">
                                {formatTime(n.receivedAt)}
                              </span>
                              {n.hasAttachments && (
                                <span className="material-symbols-outlined text-[11px] text-on-surface-variant/60">attach_file</span>
                              )}
                              {n.category && (
                                <>
                                  <span className="text-[11px] text-on-surface-variant/40">·</span>
                                  <span className="text-[10px] text-on-surface-variant/60 bg-surface-container-highest px-1.5 py-0.5 rounded">
                                    {n.category}
                                  </span>
                                </>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Analysis result (collapsible, with markdown) */}
                        {n.analysis && (
                          <>
                            <button
                              onClick={() => toggleAnalysis(n.emailId)}
                              className="mt-2 ml-[34px] text-[11px] text-primary hover:text-primary/80 font-medium flex items-center gap-1"
                            >
                              <span className="material-symbols-outlined text-xs" style={{ transform: expandedAnalysis.has(n.emailId) ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>
                                expand_more
                              </span>
                              {expandedAnalysis.has(n.emailId) ? '收合分析' : '查看分析'}
                            </button>
                            {expandedAnalysis.has(n.emailId) && (
                              <div className="mt-2 text-xs text-on-surface-variant leading-relaxed border-l-2 border-primary/20 pl-3 overflow-x-auto">
                                <ReactMarkdown remarkPlugins={[remarkGfm]} components={compactMd}>
                                  {n.analysis}
                                </ReactMarkdown>
                              </div>
                            )}
                          </>
                        )}

                        {/* Action buttons */}
                        {!n.analysis && (
                          <div className="flex items-center gap-3 mt-2 ml-[34px]">
                            <button
                              onClick={() => requestAnalysis(n.emailId)}
                              disabled={n.analyzing}
                              className="text-[11px] text-primary hover:text-primary/80 font-medium flex items-center gap-1 disabled:opacity-50 transition-colors"
                            >
                              {n.analyzing ? (
                                <>
                                  <span className="material-symbols-outlined text-xs animate-spin">progress_activity</span>
                                  分析中...
                                </>
                              ) : (
                                <>
                                  <span className="material-symbols-outlined text-xs">auto_awesome</span>
                                  {t('emailAgent.analyze' as any) || 'AI 分析'}
                                </>
                              )}
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ) : !error ? (
                  initialLoading ? (
                    /* Loading state */
                    <div className="flex flex-col items-center justify-center py-12 text-on-surface-variant/60">
                      <span className="material-symbols-outlined text-3xl mb-3 animate-spin">progress_activity</span>
                      <span className="text-xs font-medium mb-1">正在連線信箱...</span>
                      <span className="text-[11px] text-on-surface-variant/40">AI 正在掃描你的最新信件</span>
                    </div>
                  ) : (
                    /* Truly empty — no new emails */
                    <div className="flex flex-col items-center justify-center py-10 text-on-surface-variant/50">
                      <span className="material-symbols-outlined text-4xl mb-3">mark_email_read</span>
                      <span className="text-xs mb-1">{t('emailAgent.noNotifications' as any) || '目前沒有新通知'}</span>
                      <span className="text-[11px] text-on-surface-variant/40">AI 正在持續監控你的信箱</span>
                    </div>
                  )
                ) : null}
              </div>
            )}

            {/* ─── Chat Tab ─── */}
            {activeTab === 'chat' && (
              <div className="px-3 pt-3 pb-2">
                {chatMessages.length === 0 && !streaming ? (
                  /* Empty chat — welcome + suggestions */
                  <div className="flex flex-col items-center py-6">
                    <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-3">
                      <span className="material-symbols-outlined text-primary text-2xl">smart_toy</span>
                    </div>
                    <p className="text-sm font-medium text-on-surface mb-1">有什麼我能幫你的？</p>
                    <p className="text-[11px] text-on-surface-variant/60 text-center mb-4 px-4">
                      我可以幫你分析信件、整理重點、識別資安風險、建議回覆方向
                    </p>
                    <div className="flex flex-wrap gap-2 justify-center">
                      {quickChips.map(chip => (
                        <button
                          key={chip.label}
                          onClick={() => handleChipClick(chip.message)}
                          disabled={streaming || !connected}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-surface-container hover:bg-surface-container-highest text-xs text-on-surface-variant hover:text-on-surface transition-colors disabled:opacity-40"
                        >
                          <span className="material-symbols-outlined text-sm">{chip.icon}</span>
                          {chip.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  /* Chat messages */
                  <div className="space-y-3">
                    {chatMessages.slice(-20).map((msg, i) => (
                      <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                        {msg.role === 'assistant' && (
                          <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center mr-2 mt-0.5 shrink-0">
                            <span className="material-symbols-outlined text-primary text-xs">smart_toy</span>
                          </div>
                        )}
                        <div className={`px-3 py-2 rounded-xl text-xs ${
                          msg.role === 'user'
                            ? 'max-w-[75%] bg-primary text-on-primary rounded-br-sm'
                            : 'flex-1 min-w-0 bg-surface-container text-on-surface rounded-bl-sm'
                        }`}>
                          {msg.role === 'assistant' ? (
                            <div className="leading-relaxed overflow-x-auto">
                              <ReactMarkdown remarkPlugins={[remarkGfm]} components={compactMd}>
                                {msg.content}
                              </ReactMarkdown>
                            </div>
                          ) : (
                            <p className="whitespace-pre-wrap leading-relaxed">{msg.content}</p>
                          )}
                        </div>
                      </div>
                    ))}
                    {streaming && streamText && (
                      <div className="flex justify-start">
                        <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center mr-2 mt-0.5 shrink-0">
                          <span className="material-symbols-outlined text-primary text-xs">smart_toy</span>
                        </div>
                        <div className="flex-1 min-w-0 px-3 py-2 rounded-xl rounded-bl-sm bg-surface-container text-on-surface text-xs">
                          <div className="leading-relaxed">
                            <ReactMarkdown remarkPlugins={[remarkGfm]} components={compactMd}>
                              {streamText}
                            </ReactMarkdown>
                            <span className="inline-block w-1.5 h-3.5 bg-primary/60 animate-pulse ml-0.5 -mb-0.5 rounded-sm" />
                          </div>
                        </div>
                      </div>
                    )}
                    {streaming && !streamText && (
                      <div className="flex justify-start">
                        <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center mr-2 mt-0.5 shrink-0">
                          <span className="material-symbols-outlined text-primary text-xs">smart_toy</span>
                        </div>
                        <div className="px-3 py-2 rounded-xl rounded-bl-sm bg-surface-container text-on-surface-variant text-xs flex items-center gap-2">
                          <span className="material-symbols-outlined text-sm animate-spin">progress_activity</span>
                          思考中...
                        </div>
                      </div>
                    )}
                    <div ref={chatEndRef} />
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Bottom Area: Quick Chips + Input */}
          <div className="border-t border-outline-variant/10 bg-surface-container-high">
            {/* Quick suggestion chips (only show when on mail tab or chat has messages) */}
            {activeTab === 'mail' && notifications.length > 0 && (
              <div className="px-3 pt-2.5 pb-0 flex gap-1.5 overflow-x-auto scrollbar-none">
                {quickChips.map(chip => (
                  <button
                    key={chip.label}
                    onClick={() => handleChipClick(chip.message)}
                    disabled={streaming || !connected}
                    className="shrink-0 flex items-center gap-1 px-2.5 py-1 rounded-full bg-surface-container hover:bg-surface-container-highest text-[11px] text-on-surface-variant hover:text-on-surface transition-colors disabled:opacity-40"
                  >
                    <span className="material-symbols-outlined text-xs">{chip.icon}</span>
                    {chip.label}
                  </button>
                ))}
              </div>
            )}

            {/* Chat Input */}
            <div className="p-3 pt-2">
              <div className="flex items-center gap-2">
                <input
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      sendMessage();
                    }
                  }}
                  onFocus={() => { if (activeTab !== 'chat') setActiveTab('chat'); }}
                  placeholder={t('emailAgent.placeholder' as any) || '問我任何信件相關問題...'}
                  disabled={streaming || !connected}
                  className="flex-1 bg-surface-container rounded-xl px-3.5 py-2 text-xs text-on-surface placeholder:text-on-surface-variant/40 outline-none focus:ring-1 focus:ring-primary/30 disabled:opacity-50 transition-shadow"
                />
                <button
                  onClick={sendMessage}
                  disabled={streaming || !chatInput.trim() || !connected}
                  className="w-8 h-8 flex items-center justify-center rounded-full bg-primary text-on-primary disabled:opacity-30 hover:bg-primary/90 transition-colors shrink-0"
                >
                  <span className="material-symbols-outlined text-base">
                    {streaming ? 'more_horiz' : 'arrow_upward'}
                  </span>
                </button>
              </div>
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
