'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslation } from '../../../i18n/index';
import { getThemeVars } from './chartTheme';

interface ChatMindmapProps {
  code: string;
}

// Collapse nodes deeper than maxLevel so the mindmap starts compact
function foldTree(node: any, depth: number, maxExpandLevel: number) {
  if (depth >= maxExpandLevel && node.children?.length) {
    node.payload = { ...node.payload, fold: 1 };
  }
  node.children?.forEach((child: any) => foldTree(child, depth + 1, maxExpandLevel));
}

// Recursively unfold all nodes
function unfoldAll(node: any) {
  if (node.payload?.fold) {
    node.payload = { ...node.payload, fold: 0 };
  }
  node.children?.forEach((child: any) => unfoldAll(child));
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

        // Start collapsed, let user expand manually
        foldTree(root, 0, 1);

        // Clear previous content
        svgRef.current.innerHTML = '';
        const isDark = document.documentElement.classList.contains('dark');

        const mm = Markmap.create(svgRef.current, {
          autoFit: false,
          duration: 300,
          color: (node: any) => {
            const colors = isDark
              ? ['#80cbc4', '#ce93d8', '#90caf9', '#ffcc80', '#ef9a9a', '#a5d6a7', '#fff59d']
              : ['#00897b', '#8e24aa', '#1e88e5', '#f57c00', '#e53935', '#43a047', '#f9a825'];
            return colors[(node.state?.depth ?? 0) % colors.length];
          },
        }, root);
        // Fit once for initial view, then let user pan/zoom freely
        mm.fit();
        // Override click: toggle node then pan to show expanded children
        mm.handleClick = async (e: MouseEvent, d: any) => {
          const wasFolded = d.payload?.fold;
          const recursive = (navigator.platform.startsWith('Mac') ? e.metaKey : e.ctrlKey) && mm.options.toggleRecursively;
          await mm.toggleNode(d, recursive);
          if (wasFolded && d.children?.length) {
            // Expanding: shift node to left side so children are visible on right
            const vw = mm.svg.node().getBoundingClientRect().width;
            const ratio = vw < 768 ? 0.85 : 0.5;
            await mm.centerNode(d, { right: vw * ratio });
          } else {
            await mm.centerNode(d);
          }
        };

        mmRef.current = mm;
        if (!cancelled) setReady(true);
      } catch (e) {
        console.error('Mindmap render error:', e);
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
      async function rerender() {
        try {
          const { Transformer } = await import('markmap-lib');
          const { Markmap } = await import('markmap-view');
          if (!svgRef.current) return;

          const transformer = new Transformer();
          const { root } = transformer.transform(code.trim());
          foldTree(root, 0, 1);
          svgRef.current.innerHTML = '';
          const isDark = document.documentElement.classList.contains('dark');

          const mm = Markmap.create(svgRef.current, {
            autoFit: false,
            duration: 300,
            color: (node: any) => {
              const colors = isDark
                ? ['#80cbc4', '#ce93d8', '#90caf9', '#ffcc80', '#ef9a9a', '#a5d6a7', '#fff59d']
                : ['#00897b', '#8e24aa', '#1e88e5', '#f57c00', '#e53935', '#43a047', '#f9a825'];
              return colors[(node.state?.depth ?? 0) % colors.length];
            },
          }, root);
          mm.fit();
          mm.handleClick = async (e: MouseEvent, d: any) => {
            const wasFolded = d.payload?.fold;
            const recursive = (navigator.platform.startsWith('Mac') ? e.metaKey : e.ctrlKey) && mm.options.toggleRecursively;
            await mm.toggleNode(d, recursive);
            if (wasFolded && d.children?.length) {
              const vw = mm.svg.node().getBoundingClientRect().width;
              const ratio = vw < 768 ? 0.85 : 0.5;
              await mm.centerNode(d, { right: vw * ratio });
            } else {
              await mm.centerNode(d);
            }
          };
          mmRef.current = mm;
          setReady(true);
        } catch { /* ignore theme re-render errors */ }
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
        foldTree(root, 0, 1); // Start collapsed, let user expand manually
        fullscreenSvgRef.current.innerHTML = '';
        const isDark = document.documentElement.classList.contains('dark');

        const mm = Markmap.create(fullscreenSvgRef.current, {
          autoFit: false,
          duration: 300,
          color: (node: any) => {
            const colors = isDark
              ? ['#80cbc4', '#ce93d8', '#90caf9', '#ffcc80', '#ef9a9a', '#a5d6a7', '#fff59d']
              : ['#00897b', '#8e24aa', '#1e88e5', '#f57c00', '#e53935', '#43a047', '#f9a825'];
            return colors[(node.state?.depth ?? 0) % colors.length];
          },
        }, root);
        mm.fit();
        mm.handleClick = async (e: MouseEvent, d: any) => {
          const wasFolded = d.payload?.fold;
          const recursive = (navigator.platform.startsWith('Mac') ? e.metaKey : e.ctrlKey) && mm.options.toggleRecursively;
          await mm.toggleNode(d, recursive);
          if (wasFolded && d.children?.length) {
            const vw = mm.svg.node().getBoundingClientRect().width;
            const ratio = vw < 768 ? 0.85 : 0.5;
            await mm.centerNode(d, { right: vw * ratio });
          } else {
            await mm.centerNode(d);
          }
        };
        fullscreenMmRef.current = mm;
      } catch { /* ignore */ }
    }
    // Small delay to ensure DOM is ready
    const timer = setTimeout(renderFullscreen, 50);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [fullscreen, code]);

  const handleExpandAll = useCallback(async (mm: any) => {
    if (!mm?.state?.data) return;
    unfoldAll(mm.state.data);
    await mm.renderData();
    await mm.fit();
  }, []);

  const handleCollapseAll = useCallback(async (mm: any) => {
    if (!mm?.state?.data) return;
    foldTree(mm.state.data, 0, 1);
    await mm.renderData();
    await mm.fit();
  }, []);

  const handleDownloadHtml = useCallback(() => {
    const escaped = code.replace(/<\//g, '<\\/').replace(/`/g, '\\`');
    const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Mindmap</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100vh;font-family:system-ui,sans-serif}
svg.markmap{width:100%;height:calc(100vh - 44px);display:block}
.toolbar{display:flex;align-items:center;gap:8px;padding:6px 12px;background:#f5f5f5;border-bottom:1px solid #ddd}
.toolbar button{padding:4px 12px;font-size:13px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer}
.toolbar button:hover{background:#e8e8e8}
@media(prefers-color-scheme:dark){
  body{background:#1a1a1a}
  .toolbar{background:#2a2a2a;border-color:#444}
  .toolbar button{background:#333;color:#eee;border-color:#555}
  .toolbar button:hover{background:#444}
}
</style>
</head><body>
<div class="toolbar">
  <button onclick="expandAll()">&#x25BC; Expand All</button>
  <button onclick="collapseAll()">&#x25B6; Collapse All</button>
</div>
<svg class="markmap"></svg>
<script src="https://cdn.jsdelivr.net/npm/d3@7"><\/script>
<script src="https://cdn.jsdelivr.net/npm/markmap-lib"><\/script>
<script src="https://cdn.jsdelivr.net/npm/markmap-view"><\/script>
<script>
var md = \`${escaped}\`;
var {Transformer} = markmap;
// markmap-view exports under window.markmap as well
var MarkmapView = markmap.Markmap || window.markmap.Markmap;
var transformer = new Transformer();
var {root} = transformer.transform(md.trim());

function foldTree(node, depth, max) {
  if (depth >= max && node.children && node.children.length) {
    node.payload = Object.assign({}, node.payload, {fold: 1});
  }
  if (node.children) node.children.forEach(function(c) { foldTree(c, depth+1, max); });
}
function unfoldAllTree(node) {
  if (node.payload && node.payload.fold) {
    node.payload = Object.assign({}, node.payload, {fold: 0});
  }
  if (node.children) node.children.forEach(unfoldAllTree);
}

foldTree(root, 0, 1);

var svgEl = document.querySelector('svg.markmap');
var mm = MarkmapView.create(svgEl, {autoFit: false, duration: 300}, root);
mm.fit();

mm.handleClick = function(e, d) {
  var wasFolded = d.payload && d.payload.fold;
  var recursive = (navigator.platform.startsWith('Mac') ? e.metaKey : e.ctrlKey) && mm.options.toggleRecursively;
  mm.toggleNode(d, recursive).then(function() {
    if (wasFolded && d.children && d.children.length) {
      var vw = mm.svg.node().getBoundingClientRect().width;
      var ratio = vw < 768 ? 0.85 : 0.5;
      mm.centerNode(d, {right: vw * ratio});
    } else {
      mm.centerNode(d);
    }
  });
};

function expandAll() {
  unfoldAllTree(mm.state.data);
  mm.renderData().then(function() { mm.fit(); });
}
function collapseAll() {
  foldTree(mm.state.data, 0, 1);
  mm.renderData().then(function() { mm.fit(); });
}
<\/script>
</body></html>`;
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'mindmap.html';
    a.click();
    URL.revokeObjectURL(url);
  }, [code]);

  const handleDownloadPng = useCallback(() => {
    if (!svgRef.current) return;
    const svg = svgRef.current;
    // Read the viewBox that markmap already computed (avoids getBBox SVGLength errors)
    const vb = svg.getAttribute('viewBox')?.split(/[\s,]+/).map(Number);
    let vx: number, vy: number, w: number, h: number;
    if (vb && vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
      vx = vb[0]; vy = vb[1]; w = Math.ceil(vb[2]); h = Math.ceil(vb[3]);
    } else {
      vx = 0; vy = 0;
      w = svg.clientWidth || 800;
      h = svg.clientHeight || 600;
    }
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('viewBox', `${vx} ${vy} ${w} ${h}`);
    clone.setAttribute('width', String(w));
    clone.setAttribute('height', String(h));
    const svgData = new XMLSerializer().serializeToString(clone);
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
          {/* SVG is ALWAYS in the DOM so markmap can render into it */}
          <svg ref={svgRef} className="chat-mindmap-svg" />
          {/* Loading overlay shown until markmap finishes */}
          {!ready && (
            <div className="absolute inset-0 flex items-center justify-center bg-[var(--chart-bg,transparent)]">
              <span className="text-sm opacity-50 animate-pulse">{t('chart.status.renderingDiagram' as any)}</span>
            </div>
          )}
        </div>
        <div className="chat-mindmap-hint">
          <span className="material-symbols-outlined" style={{ fontSize: 13 }}>touch_app</span>
          <span>{t('chart.hint.mindmap' as any)}</span>
        </div>
        {/* Toolbar */}
        <div className="flex items-center flex-wrap gap-1 px-2 md:px-3 py-1.5 border-t border-[var(--chart-border)]">
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
          <span className="w-px h-4 bg-[var(--chart-border)] mx-0.5" />
          <button onClick={() => handleExpandAll(mmRef.current)} className="chat-chart-toggle flex items-center gap-1" title={t('chart.action.expandAll' as any)}>
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>unfold_more</span>
            <span>{t('chart.action.expandAll' as any)}</span>
          </button>
          <button onClick={() => handleCollapseAll(mmRef.current)} className="chat-chart-toggle flex items-center gap-1" title={t('chart.action.collapseAll' as any)}>
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>unfold_less</span>
            <span>{t('chart.action.collapseAll' as any)}</span>
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
            className="bg-surface rounded-xl shadow-2xl w-[95vw] md:w-[90vw] h-[90vh] md:h-[85vh] overflow-hidden p-3 md:p-4 relative flex flex-col"
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
            <div className="flex items-center flex-wrap gap-2 pt-3 border-t border-outline-variant/20">
              <div className="chat-mindmap-hint flex-1 min-w-0">
                <span className="material-symbols-outlined" style={{ fontSize: 13 }}>touch_app</span>
                <span className="truncate">{t('chart.hint.mindmap' as any)}</span>
              </div>
              <div className="flex items-center flex-wrap gap-2">
                <button onClick={() => handleExpandAll(fullscreenMmRef.current)} className="px-3 py-1.5 text-xs font-bold bg-primary/10 text-primary rounded-lg hover:bg-primary/20 transition-colors cursor-pointer flex items-center gap-1">
                  <span className="material-symbols-outlined" style={{ fontSize: 14 }}>unfold_more</span> <span className="hidden md:inline">{t('chart.action.expandAll' as any)}</span><span className="md:hidden">{t('chart.action.expandAll' as any)}</span>
                </button>
                <button onClick={() => handleCollapseAll(fullscreenMmRef.current)} className="px-3 py-1.5 text-xs font-bold bg-primary/10 text-primary rounded-lg hover:bg-primary/20 transition-colors cursor-pointer flex items-center gap-1">
                  <span className="material-symbols-outlined" style={{ fontSize: 14 }}>unfold_less</span> <span className="hidden md:inline">{t('chart.action.collapseAll' as any)}</span><span className="md:hidden">{t('chart.action.collapseAll' as any)}</span>
                </button>
                <span className="w-px h-4 bg-outline-variant/30" />
                <button onClick={handleDownloadHtml} className="px-3 py-1.5 text-xs font-bold bg-primary/10 text-primary rounded-lg hover:bg-primary/20 transition-colors cursor-pointer flex items-center gap-1">
                  <span className="material-symbols-outlined" style={{ fontSize: 14 }}>code</span> <span className="hidden md:inline">{t('chart.action.downloadHtml' as any)}</span><span className="md:hidden">HTML</span>
                </button>
                <button onClick={handleDownloadPng} className="px-3 py-1.5 text-xs font-bold bg-primary/10 text-primary rounded-lg hover:bg-primary/20 transition-colors cursor-pointer flex items-center gap-1">
                  <span className="material-symbols-outlined" style={{ fontSize: 14 }}>image</span> <span className="hidden md:inline">{t('chart.action.downloadPng' as any)}</span><span className="md:hidden">PNG</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
