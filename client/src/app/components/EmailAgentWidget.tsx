'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTranslation } from '../../i18n';

const SSE_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:12054';
const STORAGE_KEY_POS = 'email_widget_pos';
const STORAGE_KEY_HIDDEN = 'email_widget_hidden';
const STORAGE_KEY_MUTE = 'email_widget_mute_sound';

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

// Play a short notification sound using Web Audio API
function playNotificationSound() {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    // Two-tone chime
    const playTone = (freq: number, start: number, dur: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.15, ctx.currentTime + start);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + dur);
    };
    playTone(880, 0, 0.15);
    playTone(1100, 0.12, 0.2);
    setTimeout(() => ctx.close(), 500);
  } catch { /* Audio not available */ }
}

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
  const [loadingStage, setLoadingStage] = useState(0);
  const [expandedAnalysis, setExpandedAnalysis] = useState<Set<string>>(new Set());
  const [bubbleBounce, setBubbleBounce] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [soundMuted, setSoundMuted] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimer = useRef<NodeJS.Timeout | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const reconnectTimer = useRef<NodeJS.Timeout | null>(null);
  const isInitialLoad = useRef(true);

  // Drag state
  const bubbleRef = useRef<HTMLButtonElement>(null);
  const [bubblePos, setBubblePos] = useState<{ x: number; y: number } | null>(null);
  const dragState = useRef<{ startX: number; startY: number; startBX: number; startBY: number; moved: boolean } | null>(null);

  useEffect(() => {
    setMounted(true);
    // Load persisted state
    try {
      const saved = localStorage.getItem(STORAGE_KEY_POS);
      if (saved) {
        const pos = JSON.parse(saved) as { x: number; y: number };
        // Validate position is within current viewport
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        if (pos.x > 20 && pos.x < vw - 20 && pos.y > 20 && pos.y < vh - 20) {
          setBubblePos(pos);
        } else {
          // Stored position is off-screen, discard it
          localStorage.removeItem(STORAGE_KEY_POS);
        }
      }
      setHidden(localStorage.getItem(STORAGE_KEY_HIDDEN) === 'true');
      setSoundMuted(localStorage.getItem(STORAGE_KEY_MUTE) === 'true');
    } catch {}
    return () => setMounted(false);
  }, []);

  // Cycle through loading stage messages while loading
  useEffect(() => {
    if (!initialLoading) return;
    const timer = setInterval(() => {
      setLoadingStage(prev => (prev + 1) % 3);
    }, 3000);
    return () => clearInterval(timer);
  }, [initialLoading]);

  // Auto-scroll chat
  useEffect(() => {
    if (activeTab === 'chat') {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages, streamText, activeTab]);

  // Markdown components for analysis reports (structured sections)
  const analysisMd = useMemo<Record<string, React.ComponentType<any>>>(() => {
    const sectionIcons: Record<string, string> = {
      '摘要': 'description', '行動建議': 'checklist', '行動': 'checklist',
      '資安標記': 'shield', '資安': 'shield', '緊急程度': 'priority_high', '緊急': 'priority_high',
      '建議回覆': 'reply', '回覆': 'reply', '風險': 'warning',
    };
    const getIcon = (text: string) => {
      const str = String(text).replace(/^\d+\.\s*/, '').replace(/\*\*/g, '');
      for (const [key, icon] of Object.entries(sectionIcons)) {
        if (str.includes(key)) return icon;
      }
      return 'article';
    };
    return {
      h1: ({ children, ...props }: any) => (
        <div className="flex items-center gap-2 mt-3 first:mt-0 mb-2 pb-1.5 border-b border-outline-variant/10" {...props}>
          <span className="material-symbols-outlined text-primary text-base shrink-0">{getIcon(children)}</span>
          <span className="font-bold text-on-surface text-[15px]">{children}</span>
        </div>
      ),
      h2: ({ children, ...props }: any) => (
        <div className="flex items-center gap-2 mt-3 first:mt-0 mb-2 pb-1.5 border-b border-outline-variant/10" {...props}>
          <span className="material-symbols-outlined text-primary text-base shrink-0">{getIcon(children)}</span>
          <span className="font-bold text-on-surface text-[15px]">{children}</span>
        </div>
      ),
      h3: ({ children, ...props }: any) => (
        <div className="flex items-center gap-1.5 mt-2.5 first:mt-0 mb-1.5" {...props}>
          <span className="material-symbols-outlined text-primary/70 text-sm shrink-0">{getIcon(children)}</span>
          <span className="font-semibold text-on-surface text-sm">{children}</span>
        </div>
      ),
      h4: ({ children, ...props }: any) => <p className="font-semibold text-on-surface mt-2 mb-1 text-[13px]" {...props}>{children}</p>,
      p: ({ children, ...props }: any) => <p className="mb-2 last:mb-0 leading-relaxed text-on-surface-variant text-sm break-words" {...props}>{children}</p>,
      ul: ({ children, ...props }: any) => <ul className="list-none pl-0 mb-2 space-y-1.5" {...props}>{children}</ul>,
      ol: ({ children, ...props }: any) => <ol className="list-none pl-0 mb-2 space-y-1.5 counter-reset-item" {...props}>{children}</ol>,
      li: ({ children, ...props }: any) => (
        <li className="flex gap-2 leading-relaxed text-on-surface-variant text-sm" {...props}>
          <span className="material-symbols-outlined text-primary/50 text-sm mt-0.5 shrink-0">arrow_right</span>
          <span className="flex-1 min-w-0 break-words">{children}</span>
        </li>
      ),
      strong: ({ children, ...props }: any) => <strong className="font-semibold text-on-surface" {...props}>{children}</strong>,
      blockquote: ({ children, ...props }: any) => (
        <blockquote className="border-l-2 border-primary/30 pl-2.5 my-2 text-on-surface-variant italic bg-primary/3 rounded-r-lg py-1.5 pr-2 text-sm" {...props}>{children}</blockquote>
      ),
      pre: ({ children, ...props }: any) => (
        <pre className="bg-surface-container rounded-lg p-2.5 my-2 text-xs overflow-x-auto" {...props}>{children}</pre>
      ),
      code: ({ className, children, ...props }: any) => {
        if (className) return <code className={className} {...props}>{children}</code>;
        return <code className="bg-surface-container px-1.5 py-0.5 rounded text-xs text-primary font-mono break-all" {...props}>{children}</code>;
      },
      a: ({ children, href, ...props }: any) => (
        <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline break-all text-sm" {...props}>{children}</a>
      ),
      table: ({ children }: any) => <div className="my-2 space-y-1.5">{children}</div>,
      thead: () => null,
      tbody: ({ children }: any) => <div className="space-y-1.5">{children}</div>,
      th: () => null,
      tr: ({ children }: any) => (
        <div className="bg-surface-container/60 rounded-lg px-3 py-2 space-y-0.5">{children}</div>
      ),
      td: ({ children }: any) => (
        <div className="text-xs leading-relaxed text-on-surface-variant break-words first:text-[13px] first:font-medium first:text-on-surface [&:nth-child(2)]:text-primary [&:nth-child(2)]:font-semibold last:text-[11px] last:text-on-surface-variant/70">{children}</div>
      ),
      hr: (props: any) => <hr className="my-3 border-outline-variant/15" {...props} />,
    };
  }, []);

  // Compact markdown components for widget (size = text-sm base)
  const compactMd = useMemo<Record<string, React.ComponentType<any>>>(() => ({
    h1: ({ children, ...props }: any) => <p className="font-bold text-on-surface mt-3 mb-1 text-[15px]" {...props}>{children}</p>,
    h2: ({ children, ...props }: any) => <p className="font-bold text-on-surface mt-3 mb-1 text-[15px]" {...props}>{children}</p>,
    h3: ({ children, ...props }: any) => <p className="font-semibold text-on-surface mt-2 mb-0.5 text-sm" {...props}>{children}</p>,
    h4: ({ children, ...props }: any) => <p className="font-semibold text-on-surface mt-1.5 mb-0.5 text-[13px]" {...props}>{children}</p>,
    p: ({ children, ...props }: any) => <p className="mb-1.5 last:mb-0 leading-relaxed text-sm break-words" {...props}>{children}</p>,
    ul: ({ children, ...props }: any) => <ul className="list-disc pl-4 mb-1.5 space-y-0.5" {...props}>{children}</ul>,
    ol: ({ children, ...props }: any) => <ol className="list-decimal pl-4 mb-1.5 space-y-0.5" {...props}>{children}</ol>,
    li: ({ children, ...props }: any) => <li className="leading-relaxed text-sm break-words" {...props}>{children}</li>,
    strong: ({ children, ...props }: any) => <strong className="font-semibold text-on-surface" {...props}>{children}</strong>,
    blockquote: ({ children, ...props }: any) => (
      <blockquote className="border-l-2 border-primary/30 pl-2.5 my-1.5 text-on-surface-variant italic text-sm" {...props}>{children}</blockquote>
    ),
    pre: ({ children, ...props }: any) => (
      <pre className="bg-surface-container rounded-lg p-2 my-1.5 text-xs overflow-x-auto" {...props}>{children}</pre>
    ),
    code: ({ className, children, ...props }: any) => {
      if (className) return <code className={className} {...props}>{children}</code>;
      return <code className="bg-surface-container px-1 py-0.5 rounded text-xs text-primary break-all" {...props}>{children}</code>;
    },
    a: ({ children, href, ...props }: any) => (
      <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline break-all text-sm" {...props}>{children}</a>
    ),
    table: ({ children }: any) => <div className="my-1.5 space-y-1">{children}</div>,
    thead: () => null,
    tbody: ({ children }: any) => <div className="space-y-1">{children}</div>,
    th: () => null,
    tr: ({ children }: any) => (
      <div className="bg-surface-container-high/60 rounded-lg px-2.5 py-1.5 space-y-0.5">{children}</div>
    ),
    td: ({ children }: any) => (
      <div className="text-[11px] md:text-xs leading-relaxed text-on-surface-variant break-words first:font-medium first:text-on-surface [&:nth-child(2)]:text-primary [&:nth-child(2)]:font-semibold">{children}</div>
    ),
    hr: (props: any) => <hr className="my-1.5 md:my-2 border-outline-variant/20" {...props} />,
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

  const soundMutedRef = useRef(soundMuted);
  useEffect(() => { soundMutedRef.current = soundMuted; }, [soundMuted]);

  // Generate a friendly AI toast message for new emails
  const generateToastMessage = useCallback((newEmails: EmailNotification[]) => {
    const count = newEmails.length;
    const highPri = newEmails.filter(e => e.priority === '高');
    const firstFrom = newEmails[0]?.from?.name || newEmails[0]?.from?.address || '';

    if (highPri.length > 0) {
      const msgs = [
        `⚡ 有 ${highPri.length} 封重要信件剛到！要不要先看一下？`,
        `🔔 注意！有封來自 ${highPri[0].from.name || highPri[0].from.address} 的重要信，建議優先處理～`,
        `📮 ${highPri.length} 封高優先信件進來了，幫你標記好了！`,
      ];
      return msgs[Math.floor(Math.random() * msgs.length)];
    }
    if (count === 1) {
      const msgs = [
        `📬 有你的信喔～ 來自 ${firstFrom}，要看一下嗎？`,
        `✉️ ${firstFrom} 寄了封信給你，我先幫你看過了～`,
        `💌 嘿！剛收到一封新信，寄件者是 ${firstFrom}`,
      ];
      return msgs[Math.floor(Math.random() * msgs.length)];
    }
    const msgs = [
      `📬 有 ${count} 封新信進來囉！我已經幫你整理好摘要了～`,
      `✉️ 收到 ${count} 封新郵件，要不要看一下重點？`,
      `💌 嘿！${count} 封新信到了，幫你標好優先級了！`,
    ];
    return msgs[Math.floor(Math.random() * msgs.length)];
  }, []);

  const showToast = useCallback((message: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToastMessage(message);
    toastTimer.current = setTimeout(() => setToastMessage(null), 8000);
  }, []);

  const handleEvent = useCallback((event: { type: string; data?: any }) => {
    switch (event.type) {
      case 'new_emails': {
        const { emails, totalUnread: unread, overview: ov } = event.data;
        setNotifications(prev => {
          const existing = new Set(prev.map(n => n.emailId));
          const newOnes = (emails as EmailNotification[]).filter(e => !existing.has(e.emailId));
          // Bounce bubble + play sound + show toast when new emails arrive (not initial load)
          if (!isInitialLoad.current && newOnes.length > 0) {
            setBubbleBounce(true);
            setTimeout(() => setBubbleBounce(false), 2000);
            if (!soundMutedRef.current) playNotificationSound();
            showToast(generateToastMessage(newOnes));
          }
          isInitialLoad.current = false;
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
        if (event.data.totalUnread !== undefined) {
          setTotalUnread(event.data.totalUnread);
          setInitialLoading(false);
          isInitialLoad.current = false;
        }
        break;
      }
    }
  }, []);

  // Start SSE on mount
  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    connectSSE(controller.signal);

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

  // ─── Drag handlers ───
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (expanded) return;
    const el = bubbleRef.current;
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    const rect = el.getBoundingClientRect();
    dragState.current = {
      startX: e.clientX, startY: e.clientY,
      startBX: rect.left + rect.width / 2,
      startBY: rect.top + rect.height / 2,
      moved: false,
    };
  }, [expanded]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const ds = dragState.current;
    if (!ds) return;
    const dx = e.clientX - ds.startX;
    const dy = e.clientY - ds.startY;
    if (!ds.moved && Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
    ds.moved = true;
    const size = window.innerWidth >= 768 ? 56 : 48;
    const half = size / 2;
    const nx = Math.max(half, Math.min(window.innerWidth - half, ds.startBX + dx));
    const ny = Math.max(half, Math.min(window.innerHeight - half, ds.startBY + dy));
    setBubblePos({ x: nx, y: ny });
  }, []);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    const ds = dragState.current;
    dragState.current = null;
    if (!ds) return;
    bubbleRef.current?.releasePointerCapture(e.pointerId);
    if (ds.moved) {
      // Snap to nearest edge (left or right)
      const size = window.innerWidth >= 768 ? 56 : 48;
      const margin = window.innerWidth >= 768 ? 24 : 16;
      const currentX = bubblePos?.x ?? ds.startBX;
      const currentY = bubblePos?.y ?? ds.startBY;
      const half = size / 2;
      const snapX = currentX < window.innerWidth / 2
        ? margin + half
        : window.innerWidth - margin - half;
      const snapY = Math.max(half + margin, Math.min(window.innerHeight - half - margin, currentY));
      const pos = { x: snapX, y: snapY };
      setBubblePos(pos);
      localStorage.setItem(STORAGE_KEY_POS, JSON.stringify(pos));
    } else {
      // It was a click, not a drag
      setExpanded(prev => !prev);
      setBubbleBounce(false);
    }
  }, [bubblePos]);

  // Toggle hidden state
  const toggleHidden = useCallback(() => {
    setHidden(prev => {
      const next = !prev;
      localStorage.setItem(STORAGE_KEY_HIDDEN, String(next));
      if (next) setExpanded(false);
      return next;
    });
  }, []);

  const toggleSoundMute = useCallback(() => {
    setSoundMuted(prev => {
      const next = !prev;
      localStorage.setItem(STORAGE_KEY_MUTE, String(next));
      return next;
    });
  }, []);

  // Send chat message (direct, for chips)
  const sendMessageDirect = useCallback(async (msg: string) => {
    if (!msg.trim() || streaming) return;
    const token = localStorage.getItem('token');
    if (!token) return;

    setChatMessages(prev => [...prev, { role: 'user', content: msg.trim() }]);
    setStreaming(true);
    setStreamText('');

    const emailContext = notifications.slice(0, 20).map(n => ({
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

  const sendMessage = useCallback(async () => {
    const msg = chatInput.trim();
    if (!msg) return;
    setChatInput('');
    await sendMessageDirect(msg);
  }, [chatInput, sendMessageDirect]);

  const handleChipClick = useCallback((message: string) => {
    setActiveTab('chat');
    sendMessageDirect(message);
  }, [sendMessageDirect]);

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

  // Compute bubble position style (mounted guard already ensures window is available)
  const isMd = window.innerWidth >= 768;
  const bubbleSize = isMd ? 56 : 48;
  const bubbleStyle: React.CSSProperties = bubblePos
    ? { left: bubblePos.x - bubbleSize / 2, top: bubblePos.y - bubbleSize / 2, right: 'auto', bottom: 'auto' }
    : {}; // use CSS classes for default position

  // Determine which side the bubble is on
  const isOnLeft = bubblePos ? bubblePos.x < window.innerWidth / 2 : false;

  // Hidden strip position
  const hiddenStripStyle: React.CSSProperties = bubblePos
    ? { top: bubblePos.y - 24, [isOnLeft ? 'left' : 'right']: 0 }
    : { bottom: isMd ? 48 : 40, right: 0 };

  const widget = (
    <>
      {/* Hidden mode: thin edge strip with badge */}
      {hidden && !expanded && (
        <div
          className={`fixed z-[90] group cursor-pointer`}
          style={hiddenStripStyle}
          onClick={() => { setHidden(false); localStorage.setItem(STORAGE_KEY_HIDDEN, 'false'); }}
        >
          <div className={`flex items-center gap-1 bg-primary/90 text-on-primary py-2 px-1.5 shadow-lg transition-all duration-200 group-hover:px-3 ${
            isOnLeft ? 'rounded-r-xl' : 'rounded-l-xl'
          }`}>
            <span className="material-symbols-outlined text-base">smart_toy</span>
            <span className="text-xs font-medium max-w-0 overflow-hidden group-hover:max-w-[80px] transition-all duration-200 whitespace-nowrap">
              信件助手
            </span>
            {badgeCount > 0 && (
              <span className="min-w-[16px] h-4 flex items-center justify-center bg-error text-on-error text-[9px] font-bold rounded-full px-0.5">
                {badgeCount > 99 ? '99+' : badgeCount}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Floating Bubble (visible when not hidden) */}
      {!hidden && (
        <>
          <button
            ref={bubbleRef}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            className={`fixed z-[90] w-12 h-12 md:w-14 md:h-14 rounded-full shadow-xl flex items-center justify-center transition-all duration-300 select-none touch-none ${
              bubblePos ? '' : 'bottom-4 right-4 md:bottom-6 md:right-6'
            } ${
              expanded ? 'bg-surface-container-high text-on-surface scale-90 max-md:hidden' : 'bg-primary text-on-primary hover:shadow-2xl'
            } ${bubbleBounce && !expanded ? 'animate-bounce' : ''}`}
            style={bubblePos ? bubbleStyle : undefined}
            title={t('emailAgent.title' as any) || '信件助手'}
          >
            <span className="material-symbols-outlined text-xl md:text-2xl pointer-events-none">
              {expanded ? 'close' : 'smart_toy'}
            </span>
            {!expanded && badgeCount > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] md:min-w-[20px] md:h-5 flex items-center justify-center bg-error text-on-error text-[10px] md:text-xs font-bold rounded-full px-1 animate-in zoom-in duration-200 pointer-events-none">
                {badgeCount > 99 ? '99+' : badgeCount}
              </span>
            )}
            {!expanded && connected && (
              <span className="absolute bottom-0 right-0 w-2.5 h-2.5 md:w-3 md:h-3 bg-success rounded-full border-2 border-surface pointer-events-none" />
            )}
          </button>

          {/* AI Toast Notification Bubble */}
          {toastMessage && !expanded && (
            <div
              className="fixed z-[91] animate-in slide-in-from-bottom-2 fade-in duration-300"
              style={bubblePos ? {
                ...(isOnLeft
                  ? { left: bubblePos.x + bubbleSize / 2 + 12 }
                  : { right: window.innerWidth - bubblePos.x + bubbleSize / 2 + 12 }),
                top: bubblePos.y - bubbleSize / 2,
              } : {
                right: bubbleSize + (isMd ? 24 + 12 : 16 + 12),
                bottom: isMd ? 24 : 16,
              }}
            >
              <div
                className="w-[260px] md:w-[300px] bg-surface-container-high border border-outline-variant/20 rounded-2xl shadow-xl px-3.5 py-2.5 cursor-pointer hover:bg-surface-container-highest transition-colors"
                onClick={() => { setToastMessage(null); setExpanded(true); }}
              >
                <div className="flex items-start gap-2">
                  <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                    <span className="material-symbols-outlined text-primary text-sm">smart_toy</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs md:text-sm text-on-surface leading-relaxed">{toastMessage}</p>
                    <p className="text-[10px] md:text-xs text-on-surface-variant/60 mt-1">點擊查看詳情</p>
                  </div>
                  <button
                    className="shrink-0 text-on-surface-variant/40 hover:text-on-surface-variant mt-0.5"
                    onClick={(e) => { e.stopPropagation(); setToastMessage(null); }}
                  >
                    <span className="material-symbols-outlined text-sm">close</span>
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* Expanded Panel */}
      {expanded && (
        <div className="fixed inset-0 md:inset-auto md:bottom-24 md:right-6 z-[95] md:w-[520px] md:max-h-[700px] bg-surface-container-high md:rounded-2xl shadow-2xl md:border md:border-outline-variant/10 flex flex-col overflow-hidden animate-in slide-in-from-bottom-4 duration-200 safe-area-top safe-area-bottom">
          {/* Header */}
          <div className="flex items-center gap-3 px-4 py-3 border-b border-outline-variant/10 bg-surface-container-high">
            <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
              <span className="material-symbols-outlined text-primary text-xl">smart_toy</span>
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-sm font-semibold text-on-surface">
                {t('emailAgent.title' as any) || '信件助手'}
              </h3>
              <div className="flex items-center gap-2">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${connected ? 'bg-success' : 'bg-error'}`} />
                <span className="text-xs text-on-surface-variant">
                  {connected
                    ? (t('emailAgent.connected' as any) || '已連線')
                    : (t('emailAgent.disconnected' as any) || '未連線')}
                </span>
                {totalUnread > 0 && (
                  <>
                    <span className="text-xs text-on-surface-variant/40">·</span>
                    <span className="text-xs text-on-surface-variant">
                      {totalUnread} 封未讀
                    </span>
                  </>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {/* Sound toggle */}
              <button
                onClick={toggleSoundMute}
                className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-surface-container-highest active:bg-surface-container-highest transition-colors"
                title={soundMuted ? '開啟音效' : '靜音'}
              >
                <span className="material-symbols-outlined text-lg text-on-surface-variant">
                  {soundMuted ? 'volume_off' : 'volume_up'}
                </span>
              </button>
              {/* Hide button */}
              <button
                onClick={toggleHidden}
                className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-surface-container-highest active:bg-surface-container-highest transition-colors"
                title="隱藏到側邊"
              >
                <span className="material-symbols-outlined text-lg text-on-surface-variant">
                  {isOnLeft ? 'left_panel_close' : 'right_panel_close'}
                </span>
              </button>
              {/* Close button */}
              <button
                onClick={() => setExpanded(false)}
                className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-surface-container-highest active:bg-surface-container-highest transition-colors"
              >
                <span className="material-symbols-outlined text-lg text-on-surface-variant">close</span>
              </button>
            </div>
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
                className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-sm font-medium transition-colors relative ${
                  activeTab === tab.id
                    ? 'text-primary'
                    : 'text-on-surface-variant active:text-on-surface md:hover:text-on-surface'
                }`}
              >
                <span className="material-symbols-outlined text-lg">{tab.icon}</span>
                {tab.label}
                {tab.badge > 0 && (
                  <span className="min-w-[18px] h-[18px] flex items-center justify-center bg-primary/15 text-primary text-[11px] font-bold rounded-full px-1">
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
            <div className="px-4 py-2 bg-error/10 text-error text-sm flex items-center gap-2">
              <span className="material-symbols-outlined text-base">warning</span>
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
                    <span className="material-symbols-outlined text-primary text-lg mt-0.5 shrink-0">auto_awesome</span>
                    <p className="text-sm text-on-surface leading-relaxed flex-1">{overview}</p>
                  </div>
                )}

                {/* Priority Summary Chips */}
                {notifications.length > 0 && highPriorityCount > 0 && (
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-xs font-medium text-error bg-error/10 px-2.5 py-1 rounded-full flex items-center gap-1">
                      <span className="material-symbols-outlined text-xs">priority_high</span>
                      {highPriorityCount} 封高優先
                    </span>
                  </div>
                )}

                {/* Email Cards */}
                {notifications.length > 0 ? (
                  <div className="space-y-2">
                    {notifications.slice(0, 30).map(n => (
                      <div
                        key={n.emailId}
                        className="bg-surface-container rounded-xl p-3 active:bg-surface-container-highest md:hover:bg-surface-container-highest transition-colors group"
                      >
                        <div className="flex items-start gap-2.5">
                          <div className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center ${priorityBg[n.priority]}`}>
                            <span className={`material-symbols-outlined text-base ${priorityColor[n.priority]}`}>
                              {priorityIcon[n.priority]}
                            </span>
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-on-surface font-medium leading-snug line-clamp-2">{n.summary}</p>
                            <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                              <span className="text-xs text-on-surface-variant truncate max-w-[120px] md:max-w-[160px]">
                                {n.from.name || n.from.address}
                              </span>
                              <span className="text-xs text-on-surface-variant/40">·</span>
                              <span className="text-xs text-on-surface-variant/60 shrink-0">
                                {formatTime(n.receivedAt)}
                              </span>
                              {n.hasAttachments && (
                                <span className="material-symbols-outlined text-xs text-on-surface-variant/60">attach_file</span>
                              )}
                              {n.category && (
                                <>
                                  <span className="text-xs text-on-surface-variant/40">·</span>
                                  <span className="text-[11px] text-on-surface-variant/60 bg-surface-container-highest px-1.5 py-0.5 rounded">
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
                              className="mt-2 ml-[38px] text-xs text-primary active:text-primary/80 md:hover:text-primary/80 font-medium flex items-center gap-1"
                            >
                              <span className="material-symbols-outlined text-sm" style={{ transform: expandedAnalysis.has(n.emailId) ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>
                                expand_more
                              </span>
                              {expandedAnalysis.has(n.emailId) ? '收合分析' : '查看分析'}
                            </button>
                            {expandedAnalysis.has(n.emailId) && (
                              <div className="mt-2.5 bg-surface-container-highest/50 rounded-xl border border-outline-variant/10 overflow-hidden">
                                {/* Analysis header */}
                                <div className="flex items-center gap-2 px-3.5 py-2 bg-primary/5 border-b border-outline-variant/10">
                                  <span className="material-symbols-outlined text-primary text-base">auto_awesome</span>
                                  <span className="text-xs font-semibold text-on-surface">AI 深度分析</span>
                                </div>
                                {/* Analysis body */}
                                <div className="px-3.5 py-3 text-sm text-on-surface-variant leading-relaxed overflow-x-hidden overflow-y-auto">
                                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={analysisMd}>
                                    {n.analysis}
                                  </ReactMarkdown>
                                </div>
                              </div>
                            )}
                          </>
                        )}

                        {/* Action buttons */}
                        {!n.analysis && (
                          <div className="flex items-center gap-3 mt-2 ml-[38px]">
                            <button
                              onClick={() => requestAnalysis(n.emailId)}
                              disabled={n.analyzing}
                              className="text-xs text-primary active:text-primary/80 md:hover:text-primary/80 font-medium flex items-center gap-1 disabled:opacity-50 transition-colors"
                            >
                              {n.analyzing ? (
                                <>
                                  <span className="material-symbols-outlined text-sm animate-spin">progress_activity</span>
                                  分析中...
                                </>
                              ) : (
                                <>
                                  <span className="material-symbols-outlined text-sm">auto_awesome</span>
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
                    <div className="flex flex-col items-center justify-center py-10">
                      {/* Animated scanning icon */}
                      <div className="relative w-16 h-16 mb-4">
                        <div className="absolute inset-0 rounded-full bg-primary/5 animate-ping" style={{ animationDuration: '2s' }} />
                        <div className="absolute inset-1 rounded-full bg-primary/10 animate-pulse" />
                        <div className="absolute inset-0 flex items-center justify-center">
                          <span className="material-symbols-outlined text-3xl text-primary animate-pulse">
                            {['mail', 'search', 'auto_awesome'][loadingStage]}
                          </span>
                        </div>
                      </div>
                      <p className="text-sm font-medium text-on-surface mb-1.5 transition-opacity duration-500">
                        {['正在連線 Outlook 信箱...', '掃描最新信件中...', 'AI 正在分析信件內容...'][loadingStage]}
                      </p>
                      <p className="text-xs text-on-surface-variant/50">
                        首次載入可能需要幾秒鐘
                      </p>
                      <div className="flex gap-1.5 mt-3">
                        {[0, 1, 2].map(i => (
                          <div
                            key={i}
                            className={`w-1.5 h-1.5 rounded-full transition-all duration-500 ${
                              i <= loadingStage ? 'bg-primary scale-100' : 'bg-on-surface-variant/20 scale-75'
                            }`}
                          />
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-10 text-on-surface-variant/50">
                      <span className="material-symbols-outlined text-4xl mb-3">mark_email_read</span>
                      <span className="text-sm mb-1">{t('emailAgent.noNotifications' as any) || '目前沒有新通知'}</span>
                      <span className="text-xs text-on-surface-variant/40">AI 正在持續監控你的信箱</span>
                    </div>
                  )
                ) : null}
              </div>
            )}

            {/* ─── Chat Tab ─── */}
            {activeTab === 'chat' && (
              <div className="px-3 pt-3 pb-2">
                {chatMessages.length === 0 && !streaming ? (
                  <div className="flex flex-col items-center py-6">
                    <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-3">
                      <span className="material-symbols-outlined text-primary text-2xl">smart_toy</span>
                    </div>
                    <p className="text-base font-medium text-on-surface mb-1">有什麼我能幫你的？</p>
                    <p className="text-xs text-on-surface-variant/60 text-center mb-4 px-4">
                      我可以幫你分析信件、整理重點、識別資安風險、建議回覆方向
                    </p>
                    <div className="flex flex-wrap gap-2 justify-center">
                      {quickChips.map(chip => (
                        <button
                          key={chip.label}
                          onClick={() => handleChipClick(chip.message)}
                          disabled={streaming || !connected}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-surface-container active:bg-surface-container-highest md:hover:bg-surface-container-highest text-sm text-on-surface-variant active:text-on-surface md:hover:text-on-surface transition-colors disabled:opacity-40"
                        >
                          <span className="material-symbols-outlined text-base">{chip.icon}</span>
                          {chip.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {chatMessages.slice(-20).map((msg, i) => (
                      <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                        {msg.role === 'assistant' && (
                          <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center mr-2 mt-0.5 shrink-0">
                            <span className="material-symbols-outlined text-primary text-sm">smart_toy</span>
                          </div>
                        )}
                        <div className={`px-3.5 py-2.5 rounded-xl text-sm ${
                          msg.role === 'user'
                            ? 'max-w-[80%] md:max-w-[75%] bg-primary text-on-primary rounded-br-sm'
                            : 'flex-1 min-w-0 bg-surface-container text-on-surface rounded-bl-sm'
                        }`}>
                          {msg.role === 'assistant' ? (
                            <div className="leading-relaxed overflow-x-hidden overflow-y-auto break-words">
                              <ReactMarkdown remarkPlugins={[remarkGfm]} components={compactMd}>
                                {msg.content}
                              </ReactMarkdown>
                            </div>
                          ) : (
                            <p className="whitespace-pre-wrap leading-relaxed break-words">{msg.content}</p>
                          )}
                        </div>
                      </div>
                    ))}
                    {streaming && streamText && (
                      <div className="flex justify-start">
                        <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center mr-2 mt-0.5 shrink-0">
                          <span className="material-symbols-outlined text-primary text-sm">smart_toy</span>
                        </div>
                        <div className="flex-1 min-w-0 px-3.5 py-2.5 rounded-xl rounded-bl-sm bg-surface-container text-on-surface text-sm">
                          <div className="leading-relaxed overflow-x-hidden overflow-y-auto break-words">
                            <ReactMarkdown remarkPlugins={[remarkGfm]} components={compactMd}>
                              {streamText}
                            </ReactMarkdown>
                            <span className="inline-block w-1.5 h-4 bg-primary/60 animate-pulse ml-0.5 -mb-0.5 rounded-sm" />
                          </div>
                        </div>
                      </div>
                    )}
                    {streaming && !streamText && (
                      <div className="flex justify-start">
                        <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center mr-2 mt-0.5 shrink-0">
                          <span className="material-symbols-outlined text-primary text-sm">smart_toy</span>
                        </div>
                        <div className="px-3.5 py-2.5 rounded-xl rounded-bl-sm bg-surface-container text-on-surface-variant text-sm flex items-center gap-2">
                          <span className="material-symbols-outlined text-base animate-spin">progress_activity</span>
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
            {activeTab === 'mail' && notifications.length > 0 && (
              <div className="px-3 pt-2.5 pb-0 flex gap-1.5 overflow-x-auto scrollbar-none">
                {quickChips.map(chip => (
                  <button
                    key={chip.label}
                    onClick={() => handleChipClick(chip.message)}
                    disabled={streaming || !connected}
                    className="shrink-0 flex items-center gap-1 px-3 py-1.5 rounded-full bg-surface-container active:bg-surface-container-highest md:hover:bg-surface-container-highest text-xs text-on-surface-variant active:text-on-surface md:hover:text-on-surface transition-colors disabled:opacity-40"
                  >
                    <span className="material-symbols-outlined text-sm">{chip.icon}</span>
                    {chip.label}
                  </button>
                ))}
              </div>
            )}

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
                  className="flex-1 bg-surface-container rounded-xl px-3.5 py-2.5 text-sm text-on-surface placeholder:text-on-surface-variant/40 outline-none focus:ring-1 focus:ring-primary/30 disabled:opacity-50 transition-shadow"
                />
                <button
                  onClick={sendMessage}
                  disabled={streaming || !chatInput.trim() || !connected}
                  className="w-9 h-9 flex items-center justify-center rounded-full bg-primary text-on-primary disabled:opacity-30 active:bg-primary/90 md:hover:bg-primary/90 transition-colors shrink-0"
                >
                  <span className="material-symbols-outlined text-lg">
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
