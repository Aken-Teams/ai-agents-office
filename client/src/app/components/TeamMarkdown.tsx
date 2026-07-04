'use client';

/**
 * Shared markdown renderer for team collaboration views (run page + public
 * share page). Styled to match the app, and renders chart code fences via the
 * same components the chat page uses.
 */

import dynamic from 'next/dynamic';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkCjkFriendly from 'remark-cjk-friendly';
import remarkFlexibleMarkers from 'remark-flexible-markers';

const ChatChart = dynamic(() => import('./charts/ChatChart'), { ssr: false });
const ChatEChart = dynamic(() => import('./charts/ChatEChart'), { ssr: false });
const ChatMermaid = dynamic(() => import('./charts/ChatMermaid'), { ssr: false });
const ChatMindmap = dynamic(() => import('./charts/ChatMindmap'), { ssr: false });
const ChatMap = dynamic(() => import('./charts/ChatMap'), { ssr: false });

const components: Record<string, any> = {
  h1: ({ children }: any) => <h1 className="text-[15px] font-bold text-on-surface mt-3 mb-1.5 first:mt-0">{children}</h1>,
  h2: ({ children }: any) => <h2 className="text-sm font-bold text-on-surface mt-3 mb-1.5 first:mt-0">{children}</h2>,
  h3: ({ children }: any) => <h3 className="text-sm font-semibold text-on-surface mt-2 mb-1 first:mt-0">{children}</h3>,
  p:  ({ children }: any) => <p className="mb-2 last:mb-0 leading-relaxed">{children}</p>,
  ul: ({ children }: any) => <ul className="list-disc pl-5 mb-2 space-y-1">{children}</ul>,
  ol: ({ children }: any) => <ol className="list-decimal pl-5 mb-2 space-y-1">{children}</ol>,
  li: ({ children }: any) => <li className="leading-relaxed">{children}</li>,
  strong: ({ children }: any) => <strong className="font-bold text-on-surface">{children}</strong>,
  em: ({ children }: any) => <em className="italic">{children}</em>,
  mark: ({ children }: any) => <mark className="bg-amber-300/40 text-on-surface rounded px-1 font-medium [box-decoration-break:clone] [-webkit-box-decoration-break:clone]">{children}</mark>,
  hr: () => <hr className="my-3 border-outline-variant/15" />,
  blockquote: ({ children }: any) => <blockquote className="border-l-2 border-primary/30 pl-3 my-2 text-on-surface-variant">{children}</blockquote>,
  a: ({ children, href }: any) => <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{children}</a>,
  pre: ({ children }: any) => <>{children}</>,
  code: ({ className, children }: any) => {
    const text = String(children).replace(/\n$/, '');
    if (className === 'language-chart') return <ChatChart rawJson={text} />;
    if (className === 'language-echart') return <ChatEChart rawJson={text} />;
    if (className === 'language-mermaid') return <ChatMermaid code={text} />;
    if (className === 'language-mindmap') return <ChatMindmap code={text} />;
    if (className === 'language-map') return <ChatMap rawJson={text} />;
    return <code className="px-1 py-0.5 rounded bg-surface-container-high text-[0.9em] font-mono break-words">{children}</code>;
  },
  // On narrow screens w-full crams every column; a min-width keeps columns
  // readable and lets the wrapper scroll horizontally instead (touch-friendly).
  table: ({ children }: any) => <div className="overflow-x-auto my-2 rounded-lg border border-outline-variant/20 [-webkit-overflow-scrolling:touch]"><table className="w-full min-w-[30rem] text-xs border-collapse">{children}</table></div>,
  thead: ({ children }: any) => <thead className="bg-surface-container-high">{children}</thead>,
  th: ({ children }: any) => <th className="text-left px-2 py-1.5 font-semibold text-on-surface border-b border-outline-variant/20 whitespace-nowrap">{children}</th>,
  td: ({ children }: any) => <td className="px-2 py-1.5 align-top border-b border-outline-variant/10">{children}</td>,
};

export default function TeamMarkdown({ children }: { children: string }) {
  return (
    <div className="break-words [overflow-wrap:anywhere]">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkCjkFriendly, remarkFlexibleMarkers]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
