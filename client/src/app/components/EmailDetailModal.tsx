'use client';

import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const SSE_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

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

interface MessageDetail {
  id: string;
  subject: string;
  from: { name: string; address: string };
  to?: Array<{ name: string; address: string }>;
  cc?: Array<{ name: string; address: string }>;
  received_at: string;
  is_read: boolean;
  has_attachments: boolean;
  body?: string;
  body_type?: string;
  attachments?: Array<{
    id: string;
    filename: string;
    content_type: string;
    size: number;
    is_inline: boolean;
  }>;
}

interface SecurityFlags {
  hasRisk: boolean;
  riskLevel: 'high' | 'medium' | 'none';
  flags: string[];
}

interface EmailDetailModalProps {
  email: EmailNotification;
  analysisMd: Record<string, React.ComponentType<any>>;
  onClose: () => void;
  onRequestAnalysis: (emailId: string, opts?: { withAttachments?: boolean; force?: boolean }) => void;
  onChatAboutEmail: (subject: string, from: string) => void;
}

// Detect security risks using the structured [RISK:...] tag from AI output.
// The AI prompt explicitly asks for [RISK:NONE] or [RISK:HIGH] on the last line.
// Falls back to keyword heuristic only if the tag is missing (legacy analyses).
function detectSecurityFlags(analysis: string | undefined): SecurityFlags {
  if (!analysis) return { hasRisk: false, riskLevel: 'none', flags: [] };

  // 1. Check for structured risk tag (preferred — most reliable)
  const tagMatch = analysis.match(/\[RISK:(NONE|HIGH)]/);
  if (tagMatch) {
    if (tagMatch[1] === 'NONE') return { hasRisk: false, riskLevel: 'none', flags: [] };
    // RISK:HIGH — extract specific risk types from the 資安標記 section
    const flags = new Set<string>();
    const section = analysis.match(/資安標記[\s\S]*?(?=\n##|\n\d+\.\s|\[RISK:|$)/i)?.[0] || analysis;
    if (/釣魚|phishing/i.test(section)) flags.add('釣魚風險');
    if (/惡意|malware|malicious/i.test(section)) flags.add('惡意內容');
    if (/詐騙|scam/i.test(section)) flags.add('詐騙風險');
    if (/偽造|spoofing|冒充/i.test(section)) flags.add('偽造寄件者');
    if (/可疑(?:連結|附件|網址)/i.test(section)) flags.add('可疑連結');
    if (flags.size === 0) flags.add('資安風險');
    return { hasRisk: true, riskLevel: 'high', flags: [...flags] };
  }

  // 2. Fallback: no tag found (legacy analyses before prompt update)
  //    Only flag if analysis does NOT contain common "safe" phrases
  const safePattern = /無資安風險|無明顯.*風險|低風險|安全無虞|正常信件/;
  if (safePattern.test(analysis)) return { hasRisk: false, riskLevel: 'none', flags: [] };
  return { hasRisk: false, riskLevel: 'none', flags: [] };
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function formatFullDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleString(undefined, {
      year: 'numeric', month: 'long', day: 'numeric',
      weekday: 'short', hour: '2-digit', minute: '2-digit',
    });
  } catch { return dateStr; }
}

function attIcon(contentType: string): string {
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.includes('pdf')) return 'picture_as_pdf';
  if (contentType.includes('sheet') || contentType.includes('excel')) return 'table_chart';
  return 'description';
}

// ── Structured AI-analysis rendering ───────────────────────────────
// Split the analysis into its named sections (摘要 / 行動建議 / 資安標記 /
// 緊急程度 / 建議回覆) so each renders as its own card instead of one long
// wall of text. Falls back to a plain render if the expected structure is absent.
function parseAnalysisSections(md: string): { key: string; body: string }[] {
  const text = md.replace(/\n?\[RISK:(?:NONE|HIGH)]\s*$/i, '').trim();
  const headerRe = /(?:^|\n)[ \t]*(?:#{1,4}[ \t]*)?(?:\d+\.[ \t]*)?\*{0,2}[ \t]*(摘要|行動建議|資安標記|緊急程度|建議回[覆復])\*{0,2}[ \t]*[：:]?[ \t]*/g;
  const marks: { key: string; headStart: number; bodyStart: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(text)) !== null) {
    marks.push({ key: m[1].replace('建議回復', '建議回覆'), headStart: m.index, bodyStart: headerRe.lastIndex });
  }
  if (marks.length < 2) return []; // not a recognisable multi-section structure
  const out: { key: string; body: string }[] = [];
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].headStart : text.length;
    out.push({ key: marks[i].key, body: text.slice(marks[i].bodyStart, end).trim() });
  }
  return out;
}

const SECTION_ICON: Record<string, string> = {
  '摘要': 'description', '行動建議': 'checklist', '資安標記': 'shield',
  '緊急程度': 'priority_high', '建議回覆': 'reply',
};

// Render **bold** key points as a yellow highlighter so they stand out.
function YellowStrong({ children, ...props }: any) {
  return <strong className="font-semibold text-on-surface bg-warning/25 rounded px-1 box-decoration-clone" {...props}>{children}</strong>;
}

function urgencyBadge(body: string): { label: string; cls: string } | null {
  const lv = (body.split('\n')[0].match(/[高中低]/) || [])[0];
  if (lv === '高') return { label: '高', cls: 'bg-error/15 text-error' };
  if (lv === '中') return { label: '中', cls: 'bg-warning/15 text-warning' };
  if (lv === '低') return { label: '低', cls: 'bg-success/15 text-success' };
  return null;
}

function AnalysisView({ analysis, analysisMd, security }: { analysis: string; analysisMd: any; security: SecurityFlags }) {
  const sections = parseAnalysisSections(analysis);
  const bodyMd = { ...analysisMd, strong: YellowStrong };
  if (sections.length === 0) {
    return (
      <div className="text-sm text-on-surface-variant leading-relaxed">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={bodyMd}>
          {analysis.replace(/\n?\[RISK:(?:NONE|HIGH)]\s*$/, '')}
        </ReactMarkdown>
      </div>
    );
  }
  return (
    <div className="space-y-2.5">
      {sections.map((s, i) => {
        const icon = SECTION_ICON[s.key] || 'article';
        let headerCls = 'bg-primary/8';
        let iconCls = 'text-primary';
        let badge: any = null;
        if (s.key === '資安標記') {
          if (security.hasRisk) {
            headerCls = 'bg-error/10'; iconCls = 'text-error';
            badge = <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-error/15 text-error">⚠ 注意風險</span>;
          } else {
            headerCls = 'bg-success/10'; iconCls = 'text-success';
            badge = <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-success/15 text-success">✓ 無風險</span>;
          }
        } else if (s.key === '緊急程度') {
          headerCls = 'bg-warning/10'; iconCls = 'text-warning';
          const u = urgencyBadge(s.body);
          if (u) badge = <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${u.cls}`}>{u.label}</span>;
        } else if (s.key === '建議回覆') {
          headerCls = 'bg-secondary/8'; iconCls = 'text-secondary';
        }
        return (
          <div key={i} className="rounded-xl border border-outline-variant/15 overflow-hidden bg-surface-container-low/30">
            <div className={`flex items-center gap-2 px-3 py-2 border-b border-outline-variant/10 ${headerCls}`}>
              <span className={`material-symbols-outlined text-base shrink-0 ${iconCls}`}>{icon}</span>
              <span className="font-semibold text-sm text-on-surface">{s.key}</span>
              {badge && <span className="ml-auto shrink-0">{badge}</span>}
            </div>
            <div className="px-3 py-2.5 text-sm text-on-surface-variant leading-relaxed">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={bodyMd}>{s.body}</ReactMarkdown>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function EmailDetailModal({
  email, analysisMd, onClose, onRequestAnalysis, onChatAboutEmail,
}: EmailDetailModalProps) {
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<MessageDetail | null>(null);
  const [activePanel, setActivePanel] = useState<'body' | 'analysis'>('body');
  const [recipientsExpanded, setRecipientsExpanded] = useState(false);

  // Fetch full message detail
  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) { setLoading(false); return; }

    fetch(`${SSE_BASE}/api/outlook/messages/${encodeURIComponent(email.emailId)}?cid=true`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.message) setDetail(data.message);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [email.emailId]);

  // Escape to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const security = detectSecurityFlags(email.analysis);

  const handleDownload = useCallback((msgId: string, attId: string, filename: string, contentType: string) => {
    const token = localStorage.getItem('token');
    if (!token) return;
    fetch(`${SSE_BASE}/api/outlook/messages/${encodeURIComponent(msgId)}/attachments/${encodeURIComponent(attId)}?filename=${encodeURIComponent(filename)}&type=${encodeURIComponent(contentType)}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then(r => r.blob()).then(blob => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
    }).catch(() => {});
  }, []);

  const iframeOnLoad = useCallback((e: React.SyntheticEvent<HTMLIFrameElement>) => {
    const iframe = e.target as HTMLIFrameElement;
    const doc = iframe.contentDocument;
    if (!doc?.body) return;
    // Hide unresolved CID images
    doc.querySelectorAll('img').forEach(img => {
      if (img.src.startsWith('cid:')) { img.style.display = 'none'; return; }
      img.addEventListener('error', () => { img.style.display = 'none'; });
    });
    // Handle tables
    doc.querySelectorAll('table').forEach(table => {
      if (table.closest('.table-scroll')) return;
      const isDataTable = table.querySelector('th, thead');
      if (isDataTable) {
        table.removeAttribute('width');
        table.style.width = 'auto';
        table.style.maxWidth = 'none';
        table.style.tableLayout = 'auto';
        table.querySelectorAll('td, th').forEach(cell => {
          (cell as HTMLElement).style.whiteSpace = 'nowrap';
        });
        const wrapper = doc.createElement('div');
        wrapper.className = 'table-scroll';
        table.parentElement?.insertBefore(wrapper, table);
        wrapper.appendChild(table);
      } else {
        table.removeAttribute('width');
        table.style.width = '100%';
        table.style.maxWidth = '100%';
        table.style.tableLayout = 'auto';
        table.querySelectorAll('td').forEach(cell => {
          (cell as HTMLElement).removeAttribute('width');
          (cell as HTMLElement).style.width = '';
        });
      }
    });
    // Collapse quoted replies
    const replySelectors = ['blockquote', '.gmail_quote', '[id^="divRplyFwdMsg"]', '#appendonsend', 'div.OutlookMessageHeader'];
    const replyEl = doc.querySelector(replySelectors.join(','));
    if (replyEl) {
      const wrapper = doc.createElement('div');
      wrapper.className = 'reply-content';
      wrapper.style.display = 'none';
      const toggle = doc.createElement('div');
      toggle.className = 'reply-collapsed';
      toggle.textContent = '⋯ 顯示引用內容';
      toggle.addEventListener('click', () => {
        const show = wrapper.style.display === 'none';
        wrapper.style.display = show ? '' : 'none';
        toggle.textContent = show ? '⋯ 隱藏引用內容' : '⋯ 顯示引用內容';
        iframe.style.height = doc.body.scrollHeight + 20 + 'px';
      });
      replyEl.parentElement?.insertBefore(toggle, replyEl);
      replyEl.parentElement?.insertBefore(wrapper, replyEl);
      let node = wrapper.nextSibling;
      while (node) { const next = node.nextSibling; wrapper.appendChild(node); node = next; }
    }
    // Add target=_blank to links
    doc.querySelectorAll('a[href]').forEach(a => {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    });
    // Auto-size height
    const updateHeight = () => { iframe.style.height = doc.body.scrollHeight + 20 + 'px'; };
    updateHeight();
    doc.querySelectorAll('img').forEach(img => {
      if (!img.complete) img.addEventListener('load', updateHeight);
    });
  }, []);

  const nonInlineAttachments = detail?.attachments?.filter(a => !a.is_inline) ?? [];
  const hasBody = detail?.body;
  const isHtml = hasBody && (detail.body_type === 'html' || /<(?:div|table|html|head|body|span|p|br|a|img|style|td|tr|th)\b/i.test(detail.body!));

  // Build iframe srcdoc
  const srcdoc = hasBody && isHtml
    ? `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;padding:16px;overflow-x:hidden;word-break:break-word;overflow-wrap:break-word;-webkit-text-size-adjust:100%;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:14px;line-height:1.5;color:#1a1a1a;}img[src^="cid:"]{display:none!important;width:0!important;height:0!important;}img{max-width:100%!important;height:auto!important;}.table-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;max-width:100%;margin:8px 0;}.reply-collapsed{border-left:3px solid #c4c4c4;margin:16px 0;padding:4px 12px;border-radius:4px;background:#f5f5f5;cursor:pointer;font-size:12px;color:#666;}.reply-content{border-left:3px solid #ddd;margin:16px 0;padding:8px 12px;opacity:0.7;font-size:13px;}</style></head><body>${detail.body}</body></html>`
    : undefined;

  const modal = (
    <div className="fixed inset-0 z-[100] flex items-end md:items-center justify-center md:p-6">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div className="relative bg-surface-container-lowest w-full h-full md:h-auto md:rounded-2xl md:shadow-2xl md:border md:border-outline-variant/15 md:max-w-[940px] md:max-h-[88vh] flex flex-col overflow-hidden animate-in fade-in slide-in-from-bottom-4 md:zoom-in-95 duration-300 safe-area-top safe-area-bottom">

        {/* Security Banner */}
        {security.hasRisk && (
          <div className={`flex items-center gap-2.5 md:gap-3 px-4 md:px-5 py-2.5 md:py-3 border-b shrink-0 ${
            security.riskLevel === 'high'
              ? 'bg-error/10 border-b-error/20'
              : 'bg-warning/10 border-b-warning/20'
          }`}>
            <span className={`material-symbols-outlined text-lg md:text-xl ${
              security.riskLevel === 'high' ? 'text-error' : 'text-warning'
            }`}>shield</span>
            <div className="flex-1 min-w-0">
              <p className={`text-[13px] md:text-sm font-semibold ${
                security.riskLevel === 'high' ? 'text-error' : 'text-warning'
              }`}>
                {security.riskLevel === 'high' ? '高風險警告' : '安全提醒'}
              </p>
              <div className="flex flex-wrap gap-1 md:gap-1.5 mt-0.5 md:mt-1">
                {security.flags.map(flag => (
                  <span key={flag} className={`text-[10px] md:text-[11px] font-medium px-1.5 md:px-2 py-0.5 rounded-full ${
                    security.riskLevel === 'high'
                      ? 'bg-error/15 text-error'
                      : 'bg-warning/15 text-warning'
                  }`}>{flag}</span>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Email Header */}
        <div className="px-4 py-2.5 md:px-5 md:py-4 border-b border-outline-variant/10 shrink-0">
          {/* Top row: subject + close */}
          <div className="flex items-start gap-2">
            <h2 className="flex-1 min-w-0 text-[15px] md:text-lg font-bold text-on-surface leading-snug line-clamp-2 md:line-clamp-none">{email.subject}</h2>
            <div className="flex items-center gap-1 shrink-0 -mt-0.5">
              <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
                email.priority === '高' ? 'bg-error/10 text-error' : email.priority === '中' ? 'bg-warning/10 text-warning' : 'bg-surface-container text-on-surface-variant/60'
              }`}>{email.priority}優先</span>
              <button onClick={onClose} className="w-8 h-8 md:w-9 md:h-9 flex items-center justify-center rounded-full hover:bg-surface-container-highest transition-colors">
                <span className="material-symbols-outlined text-xl text-on-surface-variant">close</span>
              </button>
            </div>
          </div>
          {/* Sender row */}
          <div className="flex items-center gap-2.5 mt-2">
            <div className="w-8 h-8 md:w-10 md:h-10 rounded-full bg-tertiary/15 flex items-center justify-center shrink-0">
              <span className="material-symbols-outlined text-tertiary text-lg md:text-xl">person</span>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-1.5 flex-wrap">
                <span className="text-sm font-bold text-on-surface">{email.from.name || email.from.address}</span>
                <span className="text-[11px] text-on-surface-variant/60 truncate max-w-[160px] md:max-w-[200px] hidden md:inline">{'<'}{email.from.address}{'>'}</span>
              </div>
              <p className="text-[11px] text-on-surface-variant/60 mt-px">{formatFullDate(email.receivedAt)}</p>
            </div>
            {/* Mobile: expandable recipients toggle */}
            {(detail?.to?.length || detail?.cc?.length) ? (
              <button
                onClick={() => setRecipientsExpanded(v => !v)}
                className="md:hidden shrink-0 flex items-center gap-0.5 text-[11px] text-on-surface-variant/70 hover:text-on-surface-variant transition-colors px-1.5 py-1 -mr-1"
              >
                <span className="material-symbols-outlined text-sm" style={{ transform: recipientsExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 150ms' }}>expand_more</span>
              </button>
            ) : null}
          </div>
          {/* Recipients: always visible on desktop, collapsible on mobile */}
          {(detail?.to?.length || detail?.cc?.length) ? (
            <div className={`mt-1.5 ml-[42px] md:ml-[52px] space-y-1 ${recipientsExpanded ? '' : 'hidden md:block'}`}>
              {detail?.to && detail.to.length > 0 && (
                <div className="flex items-start gap-1.5">
                  <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide bg-tertiary/10 text-tertiary px-1.5 py-0.5 rounded mt-px">To</span>
                  <p className="text-[11px] md:text-xs text-on-surface-variant leading-relaxed line-clamp-1 md:line-clamp-2">{detail.to.map(r => r.name || r.address).join(', ')}</p>
                </div>
              )}
              {detail?.cc && detail.cc.length > 0 && (
                <div className="flex items-start gap-1.5">
                  <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide bg-warning/10 text-warning px-1.5 py-0.5 rounded mt-px">CC</span>
                  <p className="text-[11px] md:text-xs text-on-surface-variant leading-relaxed line-clamp-1 md:line-clamp-2">{detail.cc.map(r => r.name || r.address).join(', ')}</p>
                </div>
              )}
            </div>
          ) : null}
        </div>

        {/* Attachments bar */}
        {nonInlineAttachments.length > 0 && (
          <div className="px-4 md:px-5 py-2 md:py-2.5 border-b border-outline-variant/10 shrink-0">
            <div className="flex gap-2 overflow-x-auto md:flex-wrap md:overflow-x-visible scrollbar-none">
              {nonInlineAttachments.map(att => (
                <button
                  key={att.id}
                  onClick={() => handleDownload(email.emailId, att.id, att.filename, att.content_type)}
                  className="flex items-center gap-1.5 md:gap-2 px-2.5 md:px-3 py-1.5 md:py-2 rounded-lg border border-outline-variant/20 bg-surface-container-high/30 hover:bg-surface-container-high/60 active:bg-surface-container-high/60 transition-colors cursor-pointer max-w-[160px] md:max-w-[200px] shrink-0 md:shrink"
                >
                  <span className="material-symbols-outlined text-tertiary text-base shrink-0">{attIcon(att.content_type)}</span>
                  <div className="min-w-0 flex-1 text-left">
                    <p className="text-[11px] md:text-xs font-medium text-on-surface truncate">{att.filename}</p>
                    <p className="text-[10px] text-on-surface-variant/60">{formatFileSize(att.size)}</p>
                  </div>
                  <span className="material-symbols-outlined text-on-surface-variant/50 text-sm shrink-0">download</span>
                </button>
              ))}
            </div>
            {/* Deep-read the attachment contents (text + images via vision) */}
            <button
              onClick={() => onRequestAnalysis(email.emailId, { withAttachments: true, force: true })}
              disabled={email.analyzing}
              className="mt-2 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-primary/10 hover:bg-primary/20 active:bg-primary/20 text-primary text-[12px] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 15 }}>find_in_page</span>
              {email.analyzing ? '分析中…' : '深入分析附件內容'}
            </button>
          </div>
        )}

        {/* Mobile tab bar */}
        <div className="flex md:hidden border-b border-outline-variant/10 shrink-0">
          {([
            { id: 'body' as const, icon: 'mail', label: '原始信件' },
            { id: 'analysis' as const, icon: 'auto_awesome', label: 'AI 分析' },
          ]).map(tab => (
            <button
              key={tab.id}
              onClick={() => setActivePanel(tab.id)}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-[13px] font-medium transition-colors relative ${
                activePanel === tab.id ? 'text-primary' : 'text-on-surface-variant'
              }`}
            >
              <span className="material-symbols-outlined text-[17px]">{tab.icon}</span>
              {tab.label}
              {tab.id === 'analysis' && email.analyzing && (
                <span className="material-symbols-outlined text-sm text-primary animate-spin">progress_activity</span>
              )}
              {activePanel === tab.id && (
                <span className="absolute bottom-0 left-1/4 right-1/4 h-0.5 bg-primary rounded-full" />
              )}
            </button>
          ))}
        </div>

        {/* Main content: two-column (desktop) / tabbed (mobile) */}
        <div className="flex-1 min-h-0 flex flex-col md:flex-row overflow-hidden">
          {/* Email body panel */}
          <div
            className={`${activePanel === 'body' ? 'flex' : 'hidden'} md:flex flex-col flex-1 min-h-0 min-w-0 overflow-y-auto md:border-r md:border-outline-variant/10`}
            style={{ WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain' }}
          >
            {loading ? (
              <div className="flex flex-col items-center justify-center py-16 gap-3">
                <span className="material-symbols-outlined animate-spin text-primary text-2xl">progress_activity</span>
                <span className="text-sm text-on-surface-variant">載入信件內容...</span>
              </div>
            ) : srcdoc ? (
              <iframe
                srcDoc={srcdoc}
                className="w-full border-0 flex-1 min-h-[200px] md:min-h-[300px]"
                sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
                title="Email body"
                onLoad={iframeOnLoad}
              />
            ) : hasBody ? (
              <div className="p-5">
                <pre className="text-sm text-on-surface whitespace-pre-wrap font-sans leading-relaxed break-words">{detail!.body}</pre>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-16 text-on-surface-variant/50">
                <span className="material-symbols-outlined text-4xl mb-3">mail</span>
                <span className="text-sm">無法載入信件內容</span>
              </div>
            )}
          </div>

          {/* AI Analysis panel */}
          <div className={`${activePanel === 'analysis' ? 'flex' : 'hidden'} md:flex flex-col flex-1 md:flex-initial min-h-0 md:w-[380px] md:shrink-0 overflow-hidden`}>
            <div className="flex items-center gap-2 px-4 py-3 border-b border-outline-variant/10 shrink-0 bg-surface-container-high/30">
              <span className="material-symbols-outlined text-primary text-lg">auto_awesome</span>
              <span className="text-sm font-semibold text-on-surface">AI 深度分析</span>
              {email.analysis && !email.analyzing && (
                <div className="ml-auto flex items-center gap-1.5">
                  <span className="text-[10px] font-medium text-primary bg-primary/10 px-2 py-0.5 rounded-full">已完成</span>
                  <button
                    onClick={() => onRequestAnalysis(email.emailId, { withAttachments: email.hasAttachments, force: true })}
                    className="flex items-center gap-1 text-[11px] font-medium text-on-surface-variant hover:text-primary px-1.5 py-0.5 rounded-full hover:bg-primary/10 transition-colors"
                    title={email.hasAttachments ? '重新分析（含讀取附件）' : '重新分析'}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 14 }}>refresh</span>
                    重新分析
                  </button>
                </div>
              )}
            </div>
            <div
              className="flex-1 min-h-0 overflow-y-auto p-4"
              style={{ WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain' }}
            >
              {email.analyzing ? (
                <div className="flex flex-col items-center justify-center py-12 gap-3">
                  <span className="material-symbols-outlined animate-spin text-primary text-2xl">progress_activity</span>
                  <span className="text-sm text-on-surface-variant">AI 正在分析中...</span>
                  <span className="text-xs text-on-surface-variant/50">分析完成後會自動顯示</span>
                </div>
              ) : email.analysis ? (
                <AnalysisView analysis={email.analysis} analysisMd={analysisMd} security={security} />
              ) : (
                <div className="flex flex-col items-center justify-center py-12 gap-4">
                  <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center">
                    <span className="material-symbols-outlined text-primary text-3xl">auto_awesome</span>
                  </div>
                  <div className="text-center">
                    <p className="text-sm font-medium text-on-surface mb-1">尚未進行 AI 分析</p>
                    <p className="text-xs text-on-surface-variant/60">AI 會分析信件內容、判斷風險、提供行動建議</p>
                  </div>
                  <button
                    onClick={() => onRequestAnalysis(email.emailId, { withAttachments: email.hasAttachments })}
                    className="flex items-center gap-2 px-5 py-2.5 rounded-full bg-primary text-on-primary text-sm font-medium hover:bg-primary/90 active:bg-primary/90 transition-colors"
                  >
                    <span className="material-symbols-outlined text-lg">auto_awesome</span>
                    AI 深度分析
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Bottom action bar */}
        <div className="border-t border-outline-variant/10 px-3 py-2 md:px-5 md:py-3 flex items-center gap-2 md:gap-3 shrink-0 bg-surface-container-high/30">
          <button
            onClick={() => onChatAboutEmail(email.subject, email.from.name || email.from.address)}
            className="flex items-center gap-1.5 md:gap-2 px-3 md:px-4 py-2 rounded-full bg-surface-container hover:bg-surface-container-highest active:bg-surface-container-highest text-[13px] md:text-sm font-medium text-on-surface transition-colors"
          >
            <span className="material-symbols-outlined text-lg">chat</span>
            聊聊這封信
          </button>
          {!email.analysis && !email.analyzing && (
            <button
              onClick={() => onRequestAnalysis(email.emailId, { withAttachments: email.hasAttachments })}
              className="flex items-center gap-1.5 md:gap-2 px-3 md:px-4 py-2 rounded-full bg-surface-container hover:bg-surface-container-highest active:bg-surface-container-highest text-[13px] md:text-sm font-medium text-primary transition-colors"
            >
              <span className="material-symbols-outlined text-lg">auto_awesome</span>
              <span className="hidden md:inline">AI 分析</span>
              <span className="md:hidden">分析</span>
            </button>
          )}
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="px-3 md:px-4 py-2 rounded-full text-[13px] md:text-sm text-on-surface-variant hover:bg-surface-container active:bg-surface-container transition-colors"
          >
            關閉
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
