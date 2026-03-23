'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslation } from '../../../i18n/index';
import { getThemeVars } from './chartTheme';

interface ChatMindmapProps {
  code: string;
}

export default function ChatMindmap({ code }: ChatMindmapProps) {
  const { t } = useTranslation();
  const svgRef = useRef<SVGSVGElement>(null);
  const mmRef = useRef<any>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const fullscreenSvgRef = useRef<SVGSVGElement>(null);
  const fullscreenMmRef = useRef<any>(null);

  // Parse and render markmap
  useEffect(() => {
    let cancelled = false;
    async function render() {
      try {
        const { Transformer } = await import('markmap-lib');
        const { Markmap } = await import('markmap-view');
        if (cancelled || !svgRef.current) return;

        const transformer = new Transformer();
        const { root } = transformer.transform(code.trim());

        // Clear previous content
        svgRef.current.innerHTML = '';
        const isDark = document.documentElement.classList.contains('dark');

        const mm = Markmap.create(svgRef.current, {
          autoFit: true,
          duration: 300,
          color: (node: any) => {
            const colors = isDark
              ? ['#80cbc4', '#ce93d8', '#90caf9', '#ffcc80', '#ef9a9a', '#a5d6a7', '#fff59d']
              : ['#00897b', '#8e24aa', '#1e88e5', '#f57c00', '#e53935', '#43a047', '#f9a825'];
            return colors[(node.state?.depth ?? 0) % colors.length];
          },
        }, root);

        mmRef.current = mm;
        if (!cancelled) setReady(true);
      } catch (e) {
        if (!cancelled) setError((e as Error).message || 'Mindmap render error');
      }
    }
    render();
    return () => { cancelled = true; };
  }, [code]);

  // Re-render on theme change
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setReady(false);
      setError(null);
      // Re-trigger render by resetting state
      async function rerender() {
        try {
          const { Transformer } = await import('markmap-lib');
          const { Markmap } = await import('markmap-view');
          if (!svgRef.current) return;

          const transformer = new Transformer();
          const { root } = transformer.transform(code.trim());
          svgRef.current.innerHTML = '';
          const isDark = document.documentElement.classList.contains('dark');

          const mm = Markmap.create(svgRef.current, {
            autoFit: true,
            duration: 300,
            color: (node: any) => {
              const colors = isDark
                ? ['#80cbc4', '#ce93d8', '#90caf9', '#ffcc80', '#ef9a9a', '#a5d6a7', '#fff59d']
                : ['#00897b', '#8e24aa', '#1e88e5', '#f57c00', '#e53935', '#43a047', '#f9a825'];
              return colors[(node.state?.depth ?? 0) % colors.length];
            },
          }, root);
          mmRef.current = mm;
          setReady(true);
        } catch { /* ignore */ }
      }
      rerender();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, [code]);

  // Fullscreen markmap
  useEffect(() => {
    if (!fullscreen) {
      if (fullscreenMmRef.current) {
        fullscreenMmRef.current = null;
      }
      return;
    }
    let cancelled = false;
    async function renderFullscreen() {
      try {
        const { Transformer } = await import('markmap-lib');
        const { Markmap } = await import('markmap-view');
        if (cancelled || !fullscreenSvgRef.current) return;

        const transformer = new Transformer();
        const { root } = transformer.transform(code.trim());
        fullscreenSvgRef.current.innerHTML = '';
        const isDark = document.documentElement.classList.contains('dark');

        const mm = Markmap.create(fullscreenSvgRef.current, {
          autoFit: true,
          duration: 300,
          color: (node: any) => {
            const colors = isDark
              ? ['#80cbc4', '#ce93d8', '#90caf9', '#ffcc80', '#ef9a9a', '#a5d6a7', '#fff59d']
              : ['#00897b', '#8e24aa', '#1e88e5', '#f57c00', '#e53935', '#43a047', '#f9a825'];
            return colors[(node.state?.depth ?? 0) % colors.length];
          },
        }, root);
        fullscreenMmRef.current = mm;
      } catch { /* ignore */ }
    }
    // Small delay to ensure DOM is ready
    const timer = setTimeout(renderFullscreen, 50);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [fullscreen, code]);

  const handleDownloadSvg = useCallback(() => {
    if (!svgRef.current) return;
    const svgData = new XMLSerializer().serializeToString(svgRef.current);
    const blob = new Blob([svgData], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'mindmap.svg';
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const handleDownloadPng = useCallback(() => {
    if (!svgRef.current) return;
    const svgData = new XMLSerializer().serializeToString(svgRef.current);
    const w = svgRef.current.clientWidth || 800;
    const h = svgRef.current.clientHeight || 600;
    const canvas = document.createElement('canvas');
    const scale = 2;
    canvas.width = w * scale;
    canvas.height = h * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(scale, scale);
    const img = new Image();
    const dataUrl = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svgData)))}`;
    img.onload = () => {
      ctx.fillStyle = getThemeVars().bg;
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      const a = document.createElement('a');
      a.href = canvas.toDataURL('image/png');
      a.download = 'mindmap.png';
      a.click();
    };
    img.src = dataUrl;
  }, []);

  // Loading state
  if (!ready && !error) {
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
        <div className="chat-mindmap-body">
          <svg ref={svgRef} className="chat-mindmap-svg" />
        </div>
        <div className="chat-mindmap-hint">
          <span className="material-symbols-outlined" style={{ fontSize: 13 }}>touch_app</span>
          <span>{t('chart.hint.mindmap' as any)}</span>
        </div>
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
          <button onClick={handleDownloadSvg} className="chat-chart-toggle flex items-center gap-1" title={t('chart.action.downloadSvg' as any)}>
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>download</span>
            <span>{t('chart.action.downloadSvg' as any)}</span>
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
            className="bg-surface rounded-xl shadow-2xl w-[90vw] h-[85vh] overflow-hidden p-4 relative flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <button
              onClick={() => setFullscreen(false)}
              className="absolute top-3 right-3 z-10 w-8 h-8 flex items-center justify-center rounded-lg bg-surface-container-high hover:bg-surface-container-highest text-on-surface-variant cursor-pointer transition-colors"
            >
              <span className="material-symbols-outlined text-sm">close</span>
            </button>
            <div className="flex-1 min-h-0">
              <svg ref={fullscreenSvgRef} className="w-full h-full" />
            </div>
            <div className="flex items-center gap-2 pt-3 border-t border-outline-variant/20">
              <div className="chat-mindmap-hint flex-1">
                <span className="material-symbols-outlined" style={{ fontSize: 13 }}>touch_app</span>
                <span>{t('chart.hint.mindmap' as any)}</span>
              </div>
              <button onClick={handleDownloadSvg} className="px-3 py-1.5 text-xs font-bold bg-primary/10 text-primary rounded-lg hover:bg-primary/20 transition-colors cursor-pointer flex items-center gap-1">
                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>download</span> {t('chart.action.downloadSvg' as any)}
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
