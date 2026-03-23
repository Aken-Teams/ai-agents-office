'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

interface ChatMermaidProps {
  code: string;
}

export default function ChatMermaid({ code }: ChatMermaidProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function render() {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: document.documentElement.classList.contains('dark') ? 'dark' : 'default',
          fontFamily: 'Inter, system-ui, sans-serif',
          flowchart: { useMaxWidth: true, htmlLabels: true, curve: 'basis' },
          gantt: { useMaxWidth: true },
          sequence: { useMaxWidth: true },
          er: { useMaxWidth: true },
          mindmap: { useMaxWidth: true },
        });
        const id = `mermaid-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const { svg: rendered } = await mermaid.render(id, code.trim());
        if (!cancelled) setSvg(rendered);
      } catch (e) {
        if (!cancelled) setError((e as Error).message || 'Mermaid render error');
      }
    }
    render();
    return () => { cancelled = true; };
  }, [code]);

  // Re-render on theme change
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setSvg('');
      setError(null);
      async function rerender() {
        try {
          const mermaid = (await import('mermaid')).default;
          mermaid.initialize({
            startOnLoad: false,
            theme: document.documentElement.classList.contains('dark') ? 'dark' : 'default',
            fontFamily: 'Inter, system-ui, sans-serif',
          });
          const id = `mermaid-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          const { svg: rendered } = await mermaid.render(id, code.trim());
          setSvg(rendered);
        } catch { /* ignore */ }
      }
      rerender();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, [code]);

  const handleDownload = useCallback(() => {
    if (!svg) return;
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'diagram.svg';
    a.click();
    URL.revokeObjectURL(url);
  }, [svg]);

  const handleDownloadPng = useCallback(() => {
    if (!svg) return;
    const svgEl = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
    const w = parseInt(svgEl.getAttribute('width') || '800');
    const h = parseInt(svgEl.getAttribute('height') || '600');
    const canvas = document.createElement('canvas');
    const scale = 2;
    canvas.width = w * scale;
    canvas.height = h * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(scale, scale);
    const img = new Image();
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      const pngUrl = canvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = pngUrl;
      a.download = 'diagram.png';
      a.click();
    };
    img.src = url;
  }, [svg]);

  // Streaming: incomplete mermaid code
  if (!svg && !error) {
    return (
      <div className="chat-chart-container">
        <div className="chat-chart-body flex items-center justify-center" style={{ minHeight: 120 }}>
          <span className="text-sm opacity-50 animate-pulse">Rendering diagram...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="chat-chart-fallback">
        <div className="chat-chart-fallback-header">
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>warning</span>
          <span>Diagram error: {error}</span>
        </div>
        <pre><code>{code}</code></pre>
      </div>
    );
  }

  return (
    <>
      <div className="chat-chart-container group">
        <div
          ref={containerRef}
          className="chat-chart-body overflow-x-auto"
          dangerouslySetInnerHTML={{ __html: svg }}
          style={{ minHeight: 80 }}
        />
        {/* Toolbar */}
        <div className="flex items-center gap-1 px-3 py-1.5 border-t border-[var(--chart-border)]">
          <button
            onClick={() => setFullscreen(true)}
            className="chat-chart-toggle flex items-center gap-1"
            title="Fullscreen"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>fullscreen</span>
            <span>Expand</span>
          </button>
          <button onClick={handleDownload} className="chat-chart-toggle flex items-center gap-1" title="Download SVG">
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>download</span>
            <span>SVG</span>
          </button>
          <button onClick={handleDownloadPng} className="chat-chart-toggle flex items-center gap-1" title="Download PNG">
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>image</span>
            <span>PNG</span>
          </button>
        </div>
      </div>

      {/* Fullscreen modal */}
      {fullscreen && (
        <div
          className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm flex items-center justify-center"
          onClick={() => setFullscreen(false)}
        >
          <div
            className="bg-surface rounded-xl shadow-2xl max-w-[90vw] max-h-[90vh] overflow-auto p-8 relative"
            onClick={e => e.stopPropagation()}
          >
            <button
              onClick={() => setFullscreen(false)}
              className="absolute top-3 right-3 w-8 h-8 flex items-center justify-center rounded-lg bg-surface-container-high hover:bg-surface-container-highest text-on-surface-variant cursor-pointer transition-colors"
            >
              <span className="material-symbols-outlined text-sm">close</span>
            </button>
            <div dangerouslySetInnerHTML={{ __html: svg }} />
            <div className="flex items-center gap-2 mt-4 pt-3 border-t border-outline-variant/20">
              <button onClick={handleDownload} className="px-3 py-1.5 text-xs font-bold bg-primary/10 text-primary rounded-lg hover:bg-primary/20 transition-colors cursor-pointer flex items-center gap-1">
                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>download</span> SVG
              </button>
              <button onClick={handleDownloadPng} className="px-3 py-1.5 text-xs font-bold bg-primary/10 text-primary rounded-lg hover:bg-primary/20 transition-colors cursor-pointer flex items-center gap-1">
                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>image</span> PNG
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
