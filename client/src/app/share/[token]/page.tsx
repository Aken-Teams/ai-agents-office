'use client';

import { useState, useEffect, useMemo } from 'react';
import { useParams } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import dynamic from 'next/dynamic';

const ChatChart = dynamic(() => import('../../components/charts/ChatChart'), { ssr: false });
const ChatEChart = dynamic(() => import('../../components/charts/ChatEChart'), { ssr: false });
const ChatVisual = dynamic(() => import('../../components/charts/ChatVisual'), { ssr: false });
const ChatMermaid = dynamic(() => import('../../components/charts/ChatMermaid'), { ssr: false });
const ChatMindmap = dynamic(() => import('../../components/charts/ChatMindmap'), { ssr: false });
const ChatMap = dynamic(() => import('../../components/charts/ChatMap'), { ssr: false });

function convertMermaidMindmapToMarkdown(mermaidCode: string): string {
  const lines = mermaidCode.split('\n');
  const result: string[] = [];
  let baseIndent = -1;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || /^mindmap\b/i.test(trimmed)) continue;

    const match = line.match(/^(\s*)/);
    const indent = match ? match[1].length : 0;
    if (baseIndent < 0) baseIndent = indent;

    const level = Math.max(1, Math.floor((indent - baseIndent) / 2) + 1);

    let text = trimmed
      .replace(/^root\(\((.+?)\)\)$/, '$1')
      .replace(/^\(\((.+?)\)\)$/, '$1')
      .replace(/^\((.+?)\)$/, '$1')
      .replace(/^\[(.+?)\]$/, '$1')
      .replace(/^"(.+?)"$/, '$1');

    if (!text) continue;
    result.push(`${'#'.repeat(Math.min(level, 6))} ${text}`);
  }

  return result.join('\n');
}

interface SharedMessage {
  id: string;
  role: string;
  content: string;
  created_at: string;
}

interface SharedData {
  conversation: {
    id: string;
    title: string;
    skill_id: string | null;
    created_at: string;
  };
  messages: SharedMessage[];
  sharedBy: string;
}

const SKILL_META: Record<string, { icon: string; color: string; label: string }> = {
  'pptx-gen': { icon: 'present_to_all', color: '#FF8A65', label: 'PPTX' },
  'docx-gen': { icon: 'description', color: '#2196F3', label: 'DOCX' },
  'xlsx-gen': { icon: 'table_chart', color: '#4CAF50', label: 'XLSX' },
  'pdf-gen': { icon: 'picture_as_pdf', color: '#FF5252', label: 'PDF' },
  'data-analyst': { icon: 'analytics', color: '#00dbe9', label: 'DATA' },
  'research': { icon: 'travel_explore', color: '#8f9097', label: 'RESEARCH' },
};

function extractSources(text: string): { title: string; url: string }[] {
  const urlRegex = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  const sources: { title: string; url: string }[] = [];
  const seen = new Set<string>();
  let match;
  while ((match = urlRegex.exec(text)) !== null) {
    const url = match[2];
    if (!seen.has(url)) {
      seen.add(url);
      sources.push({ title: match[1], url });
    }
  }
  return sources;
}

export default function SharedConversationPage() {
  const params = useParams();
  const shareToken = params.token as string;
  const [data, setData] = useState<SharedData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!shareToken) return;
    fetch(`/api/share/view/${shareToken}`)
      .then(r => {
        if (!r.ok) throw new Error('not_found');
        return r.json();
      })
      .then(setData)
      .catch(() => setError('not_found'))
      .finally(() => setLoading(false));
  }, [shareToken]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const markdownComponents = useMemo(() => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pre({ children, node, ...props }: any) {
      const codeEl = node?.children?.[0];
      const cls = codeEl?.properties?.className?.[0] || '';
      if (cls === 'language-chart' || cls === 'language-echart' || cls === 'language-visual' || cls === 'language-mermaid' || cls === 'language-mindmap' || cls === 'language-map') {
        return <>{children}</>;
      }
      return <pre {...props}>{children}</pre>;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    code({ className, children, ...props }: any) {
      const text = String(children).trim();
      if (className === 'language-chart') {
        return <ChatChart rawJson={text} />;
      }
      if (className === 'language-echart') {
        return <ChatEChart rawJson={text} />;
      }
      if (className === 'language-visual') {
        return <ChatVisual rawHtml={text} />;
      }
      if (className === 'language-mermaid') {
        if (/^\s*mindmap\b/i.test(text)) {
          return <ChatMindmap code={convertMermaidMindmapToMarkdown(text)} />;
        }
        return <ChatMermaid code={text} />;
      }
      if (className === 'language-mindmap') {
        return <ChatMindmap code={text} />;
      }
      if (className === 'language-map') {
        return <ChatMap rawJson={text} />;
      }
      return <code className={className} {...props}>{children}</code>;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    table({ children, ...props }: any) {
      return <div className="table-wrapper"><table {...props}>{children}</table></div>;
    },
  }), []);

  if (loading) {
    return (
      <div className="min-h-screen bg-surface-container-lowest flex items-center justify-center">
        <span className="text-sm opacity-50 animate-pulse">Loading...</span>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-surface-container-lowest flex flex-col items-center justify-center gap-4 p-4">
        <div className="w-16 h-16 rounded-full bg-surface-container flex items-center justify-center">
          <span className="material-symbols-outlined text-on-surface-variant text-3xl">link_off</span>
        </div>
        <h1 className="text-lg font-bold text-on-surface">分享連結不存在</h1>
        <p className="text-sm text-on-surface-variant text-center max-w-sm">
          此對話分享連結已失效或已被移除。
        </p>
        <a
          href="/"
          className="mt-2 px-4 py-2 text-sm font-bold bg-primary text-on-primary rounded-lg hover:opacity-90 transition-opacity no-underline"
        >
          回到首頁
        </a>
      </div>
    );
  }

  const { conversation, messages, sharedBy } = data;
  const skill = conversation.skill_id ? SKILL_META[conversation.skill_id] : null;

  return (
    <div className="min-h-screen bg-surface-container-lowest">
      {/* Header */}
      <header className="sticky top-0 z-10 bg-surface/80 backdrop-blur-xl border-b border-outline-variant/10">
        <div className="max-w-4xl mx-auto px-4 md:px-8 py-3 md:py-4 flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-primary-container border border-primary/20 flex items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-primary text-sm" style={{ fontVariationSettings: "'FILL' 1" }}>smart_toy</span>
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-sm md:text-base font-bold text-on-surface truncate">{conversation.title}</h1>
            <div className="flex items-center gap-2 text-xs text-on-surface-variant">
              <span>{sharedBy}</span>
              <span className="opacity-30">|</span>
              <span>{new Date(conversation.created_at).toLocaleString('zh-TW', { year: 'numeric', month: 'short', day: 'numeric' })}</span>
              {skill && (
                <>
                  <span className="opacity-30">|</span>
                  <span className="font-bold tracking-wider uppercase" style={{ color: skill.color }}>{skill.label}</span>
                </>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1.5 px-2.5 py-1 bg-tertiary/10 text-tertiary rounded-full text-xs font-bold shrink-0">
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>visibility</span>
            唯讀分享
          </div>
        </div>
      </header>

      {/* Messages */}
      <main className="max-w-4xl mx-auto px-4 md:px-8 py-6 md:py-10 space-y-4 md:space-y-8">
        {messages.map(msg => {
          const sources = msg.role === 'assistant' ? extractSources(msg.content) : [];
          return (
            <div key={msg.id} className={msg.role === 'user' ? 'flex flex-col items-end' : 'flex gap-2 md:gap-4'}>
              {msg.role === 'assistant' && (
                <div className="w-7 h-7 md:w-9 md:h-9 shrink-0 bg-primary-container border border-primary/20 flex items-center justify-center rounded-lg">
                  <span className="material-symbols-outlined text-primary text-xs md:text-sm" style={{ fontVariationSettings: "'FILL' 1" }}>smart_toy</span>
                </div>
              )}
              <div className={
                msg.role === 'user'
                  ? 'max-w-[85%] md:max-w-[70%]'
                  : 'max-w-[90%] md:max-w-[85%] min-w-0'
              }>
                {msg.role === 'user' ? (
                  <div className="bg-surface-container px-3.5 py-3 md:px-5 md:py-4 rounded-xl rounded-tr-sm text-on-surface shadow-lg">
                    <p className="text-sm leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                  </div>
                ) : (
                  <div className="bg-surface-container-low px-3.5 py-3 md:px-5 md:py-4 rounded-xl rounded-tl-sm border border-outline-variant/10 overflow-hidden">
                    <div className="chat-markdown text-sm leading-relaxed text-on-surface-variant">
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{msg.content}</ReactMarkdown>
                    </div>
                    {sources.length > 0 && (
                      <details className="mt-2 md:mt-3 border-t border-outline-variant/10 pt-2">
                        <summary className="text-xs md:text-sm text-primary cursor-pointer font-bold uppercase tracking-wider">
                          來源 ({sources.length})
                        </summary>
                        <div className="flex flex-col gap-1.5 mt-2">
                          {sources.map((src, i) => (
                            <a key={i} href={src.url} target="_blank" rel="noopener noreferrer"
                              className="flex items-center gap-2 px-2 md:px-3 py-1.5 md:py-2 bg-surface-container rounded text-xs md:text-sm active:bg-surface-container-high md:hover:bg-surface-container-high transition-colors no-underline">
                              <span className="material-symbols-outlined text-primary text-xs md:text-sm">link</span>
                              <span className="text-on-surface truncate flex-1">{src.title}</span>
                              <span className="text-outline text-xs md:text-sm shrink-0 hidden md:inline">{new URL(src.url).hostname}</span>
                            </a>
                          ))}
                        </div>
                      </details>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {/* End of conversation indicator */}
        <div className="flex items-center gap-3 pt-6">
          <div className="flex-1 h-px bg-outline-variant/20" />
          <span className="text-xs text-on-surface-variant/40 font-bold uppercase tracking-widest">End of conversation</span>
          <div className="flex-1 h-px bg-outline-variant/20" />
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-outline-variant/10 py-4 md:py-6">
        <div className="max-w-4xl mx-auto px-4 md:px-8 flex items-center justify-between">
          <span className="text-xs text-on-surface-variant/40">Powered by AI Agents Office</span>
          <a
            href="/"
            className="text-xs text-primary font-bold no-underline hover:underline"
          >
            Try it yourself →
          </a>
        </div>
      </footer>
    </div>
  );
}
