'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslation } from '../../../i18n/index';
import { getThemeVars } from './chartTheme';

interface ChatMermaidProps {
  code: string;
}

export default function ChatMermaid({ code }: ChatMermaidProps) {
  const { t } = useTranslation();
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

  const handleDownloadHtml = useCallback(() => {
    const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Diagram</title>
<style>body{display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;padding:40px;font-family:Inter,system-ui,sans-serif;background:#f8f9fa}.mermaid{max-width:95vw}</style>
</head><body>
<pre class="mermaid">
${code.replace(/</g, '&lt;').replace(/>/g, '&gt;')}
</pre>
<script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"><\/script>
<script>mermaid.initialize({startOnLoad:true,theme:'default',fontFamily:'Inter,system-ui,sans-serif'});<\/script>
</body></html>`;
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'diagram.html';
    a.click();
    URL.revokeObjectURL(url);
  }, [code]);

  const handleDownloadPng = useCallback(() => {
    if (!svg) return;
    // Read dimensions from the actual DOM SVG element (not parsed string)
    const domSvg = containerRef.current?.querySelector('svg');
    const parsedSvg = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
    // Prefer viewBox dimensions > DOM rendered size > attribute values > fallback
    const vb = parsedSvg.getAttribute('viewBox')?.split(/[\s,]+/).map(Number);
    const vbW = vb && vb.length === 4 ? vb[2] : 0;
    const vbH = vb && vb.length === 4 ? vb[3] : 0;
    const domW = domSvg?.clientWidth || 0;
    const domH = domSvg?.clientHeight || 0;
    const attrW = parseInt(parsedSvg.getAttribute('width') || '0');
    const attrH = parseInt(parsedSvg.getAttribute('height') || '0');
    const w = Math.max(vbW, domW, attrW, 800);
    const h = Math.max(vbH, domH, attrH, 400);

    // Clone SVG and set proper width/height for export
    const cloned = parsedSvg.cloneNode(true) as Element;
    cloned.setAttribute('width', String(w));
    cloned.setAttribute('height', String(h));
    if (!cloned.getAttribute('viewBox') && vbW > 0) {
      cloned.setAttribute('viewBox', `0 0 ${vbW} ${vbH}`);
    }
    const svgStr = new XMLSerializer().serializeToString(cloned);

    const canvas = document.createElement('canvas');
    const scale = 2;
    canvas.width = w * scale;
    canvas.height = h * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(scale, scale);
    const img = new Image();
    const svgData = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svgStr)))}`;
    img.onload = () => {
      ctx.fillStyle = getThemeVars().bg;
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      const pngUrl = canvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = pngUrl;
      a.download = 'diagram.png';
      a.click();
    };
    img.src = svgData;
  }, [svg]);

  // Streaming: incomplete mermaid code
  if (!svg && !error) {
    return (
      <div className="chat-chart-container">
        <div className="chat-chart-body flex items-center justify-center" style={{ minHeight: 120 }}>
          <span className="text-sm opacity-50 animate-pulse">{t('chart.status.renderingDiagram' as any)}</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="chat-chart-fallback">
        <div className="chat-chart-fallback-header">
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>warning</span>
          <span>{t('chart.error.diagram' as any)}: {error}</span>
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
          className="chat-mermaid-body overflow-x-auto"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
        {/* Toolbar */}
        <div className="flex items-center gap-1 px-3 py-1.5 border-t border-[var(--chart-border)]">
          <button
            onClick={() => setFullscreen(true)}
            className="chat-chart-toggle flex items-center gap-1"
            title={t('chart.action.expand' as any)}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>fullscreen</span>
            <span>{t('chart.action.expand' as any)}</span>
          </button>
          <button onClick={handleDownloadHtml} className="chat-chart-toggle flex items-center gap-1" title={t('chart.action.downloadHtml' as any)}>
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>code</span>
            <span>{t('chart.action.downloadHtml' as any)}</span>
          </button>
          <button onClick={handleDownloadPng} className="chat-chart-toggle flex items-center gap-1" title={t('chart.action.downloadPng' as any)}>
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>image</span>
            <span>{t('chart.action.downloadPng' as any)}</span>
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
            <div
              className="chat-mermaid-fullscreen"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
            <div className="flex items-center gap-2 mt-4 pt-3 border-t border-outline-variant/20">
              <button onClick={handleDownloadHtml} className="px-3 py-1.5 text-xs font-bold bg-primary/10 text-primary rounded-lg hover:bg-primary/20 transition-colors cursor-pointer flex items-center gap-1">
                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>code</span> {t('chart.action.downloadHtml' as any)}
              </button>
              <button onClick={handleDownloadPng} className="px-3 py-1.5 text-xs font-bold bg-primary/10 text-primary rounded-lg hover:bg-primary/20 transition-colors cursor-pointer flex items-center gap-1">
                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>image</span> {t('chart.action.downloadPng' as any)}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
