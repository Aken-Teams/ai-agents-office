'use client';

/**
 * Self-contained PDF viewer for the KM 助手 — renders pages with pdf.js and paints
 * YELLOW highlight boxes over every occurrence of the search term (aligned to the
 * canvas via the page viewport transform, so no fragile text-layer overlay). Has
 * zoom, prev/next match, and jumps to an initial page. Falls back to a plain
 * <iframe> if pdf.js can't initialise (e.g. worker issue), so the user never gets a
 * blank screen.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';

// Bundled worker (webpack/turbopack emit it as an asset from this URL).
try {
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
} catch { /* set at render if needed */ }

interface Box { left: number; top: number; width: number; height: number }

export default function KmPdfViewer({ url, search, initialPage }: { url: string; search?: string; initialPage?: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1.3);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [matchCount, setMatchCount] = useState(0);
  const matchElsRef = useRef<HTMLElement[]>([]);
  const matchIdxRef = useRef(0);
  const pdfRef = useRef<any>(null);
  const renderTokenRef = useRef(0);

  const renderAll = useCallback(async (pdf: any, sc: number) => {
    const container = containerRef.current;
    if (!container) return;
    const token = ++renderTokenRef.current;
    container.innerHTML = '';
    matchElsRef.current = [];
    const q = (search || '').trim().toLowerCase();
    let matches = 0;

    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      if (token !== renderTokenRef.current) return; // superseded (zoom/close)
      const viewport = page.getViewport({ scale: sc });
      const pageDiv = document.createElement('div');
      pageDiv.style.cssText = `position:relative;margin:0 auto 12px;width:${viewport.width}px;height:${viewport.height}px;box-shadow:0 1px 6px rgba(0,0,0,.3);background:#fff`;
      pageDiv.dataset.page = String(n);
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width; canvas.height = viewport.height;
      canvas.style.cssText = 'display:block;width:100%;height:100%';
      pageDiv.appendChild(canvas);
      container.appendChild(pageDiv);
      const ctx = canvas.getContext('2d');
      if (ctx) await page.render({ canvasContext: ctx, viewport }).promise;
      if (token !== renderTokenRef.current) return;

      if (q) {
        const tc = await page.getTextContent();
        for (const item of tc.items as any[]) {
          if (!item.str || !item.str.toLowerCase().includes(q)) continue;
          const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
          const fontH = Math.hypot(tx[2], tx[3]) || 10;
          const box: Box = { left: tx[4], top: tx[5] - fontH, width: (item.width || 0) * sc, height: fontH * 1.25 };
          const hl = document.createElement('div');
          hl.style.cssText = `position:absolute;left:${box.left}px;top:${box.top}px;width:${Math.max(box.width, 6)}px;height:${box.height}px;background:rgba(250,204,21,.45);border-radius:2px;pointer-events:none;mix-blend-mode:multiply`;
          pageDiv.appendChild(hl);
          matchElsRef.current.push(hl);
          matches++;
        }
      }
    }
    if (token !== renderTokenRef.current) return;
    setMatchCount(matches);
    setLoading(false);
    // Jump to the requested page, or the first match.
    requestAnimationFrame(() => {
      if (initialPage) {
        const el = container.querySelector(`[data-page="${initialPage}"]`) as HTMLElement | null;
        el?.scrollIntoView({ block: 'start' });
      } else if (matchElsRef.current[0]) {
        matchElsRef.current[0].scrollIntoView({ block: 'center' });
      }
    });
  }, [search, initialPage]);

  // Load the document once.
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setFailed(false);
    (async () => {
      try {
        const pdf = await pdfjsLib.getDocument({ url }).promise;
        if (cancelled) return;
        pdfRef.current = pdf;
        await renderAll(pdf, scale);
      } catch (e) {
        console.warn('[KmPdfViewer] pdf.js failed, falling back to iframe:', e);
        if (!cancelled) setFailed(true);
      }
    })();
    return () => { cancelled = true; renderTokenRef.current++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  // Re-render on zoom.
  useEffect(() => {
    if (pdfRef.current && !failed) renderAll(pdfRef.current, scale);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale]);

  const gotoMatch = (dir: 1 | -1) => {
    const els = matchElsRef.current;
    if (!els.length) return;
    matchIdxRef.current = (matchIdxRef.current + dir + els.length) % els.length;
    els.forEach(el => { el.style.outline = ''; });
    const el = els[matchIdxRef.current];
    el.style.outline = '2px solid rgba(234,88,12,.9)';
    el.scrollIntoView({ block: 'center' });
  };

  if (failed) {
    return <iframe src={`${url}#navpanes=0&view=FitH${initialPage ? `&page=${initialPage}` : ''}${search ? `&search=${encodeURIComponent(search)}` : ''}`} title="pdf" className="w-full h-full border-0 bg-white" />;
  }

  return (
    <div className="relative w-full h-full bg-neutral-800">
      {/* Toolbar */}
      <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1 bg-surface-container-high/95 rounded-full shadow-lg px-2 py-1">
        <button onClick={() => setScale(s => Math.max(0.6, +(s - 0.2).toFixed(2)))} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-surface-container text-on-surface-variant"><span className="material-symbols-outlined text-lg">zoom_out</span></button>
        <span className="text-xs text-on-surface-variant w-10 text-center">{Math.round(scale * 100)}%</span>
        <button onClick={() => setScale(s => Math.min(3, +(s + 0.2).toFixed(2)))} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-surface-container text-on-surface-variant"><span className="material-symbols-outlined text-lg">zoom_in</span></button>
        {search && (
          <>
            <span className="w-px h-5 bg-outline-variant/30 mx-1" />
            <span className="text-xs text-on-surface-variant px-1 whitespace-nowrap">「{search}」{matchCount}</span>
            <button onClick={() => gotoMatch(-1)} disabled={!matchCount} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-surface-container text-on-surface-variant disabled:opacity-40"><span className="material-symbols-outlined text-lg">keyboard_arrow_up</span></button>
            <button onClick={() => gotoMatch(1)} disabled={!matchCount} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-surface-container text-on-surface-variant disabled:opacity-40"><span className="material-symbols-outlined text-lg">keyboard_arrow_down</span></button>
          </>
        )}
      </div>
      {loading && <div className="absolute inset-0 flex items-center justify-center text-white/80 text-sm gap-2 z-0"><span className="material-symbols-outlined animate-spin">progress_activity</span>載入 PDF 中…</div>}
      <div ref={containerRef} className="absolute inset-0 overflow-auto py-4 px-2" />
    </div>
  );
}
