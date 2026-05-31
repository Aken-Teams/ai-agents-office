'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

interface PdfPagePreviewProps {
  pdfUrl: string;
  /** 0-based page index to display */
  pageIndex: number;
  /** Total page count callback */
  onPageCount?: (count: number) => void;
}

/**
 * Renders a single PDF page at high resolution using pdf.js.
 * Replaces the browser's built-in PDF viewer for a cleaner look.
 */
export default function PdfPagePreview({ pdfUrl, pageIndex, onPageCount }: PdfPagePreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [rendering, setRendering] = useState(false);
  const [pageCount, setPageCount] = useState(0);
  const loadedUrlRef = useRef<string | null>(null);
  const renderTaskRef = useRef<any>(null);

  // Load PDF document
  const loadPdf = useCallback(async () => {
    if (!pdfUrl || loadedUrlRef.current === pdfUrl) return;
    loadedUrlRef.current = pdfUrl;

    try {
      const pdfjsLib = await import('pdfjs-dist');
      pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
      const pdf = await (pdfjsLib.getDocument as any)({ url: pdfUrl }).promise;
      setPdfDoc(pdf);
      setPageCount(pdf.numPages);
      onPageCount?.(pdf.numPages);
    } catch (err) {
      console.warn('[PdfPagePreview] Failed to load PDF:', err);
    }
  }, [pdfUrl, onPageCount]);

  useEffect(() => { loadPdf(); }, [loadPdf]);

  // Render specific page
  useEffect(() => {
    if (!pdfDoc || !canvasRef.current || !containerRef.current) return;
    const pageNum = Math.min(Math.max(pageIndex + 1, 1), pdfDoc.numPages);

    let cancelled = false;

    const renderPage = async () => {
      // Cancel any in-progress render
      if (renderTaskRef.current) {
        try { renderTaskRef.current.cancel(); } catch {}
        renderTaskRef.current = null;
      }

      setRendering(true);
      try {
        const page = await pdfDoc.getPage(pageNum);
        if (cancelled) return;

        const container = containerRef.current!;
        const canvas = canvasRef.current!;

        // Calculate scale to fit container width while maintaining aspect ratio
        const unscaledVp = page.getViewport({ scale: 1 });
        const containerWidth = container.clientWidth - 48; // padding
        const containerHeight = container.clientHeight - 48;

        const scaleByWidth = containerWidth / unscaledVp.width;
        const scaleByHeight = containerHeight / unscaledVp.height;
        const scale = Math.min(scaleByWidth, scaleByHeight, 3); // cap at 3x

        // Use device pixel ratio for sharp rendering
        const dpr = window.devicePixelRatio || 1;
        const viewport = page.getViewport({ scale: scale * dpr });

        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.width = `${viewport.width / dpr}px`;
        canvas.style.height = `${viewport.height / dpr}px`;

        const ctx = canvas.getContext('2d')!;
        const task = (page as any).render({ canvasContext: ctx, viewport });
        renderTaskRef.current = task;
        await task.promise;
        renderTaskRef.current = null;
        page.cleanup();
      } catch (err: any) {
        if (err?.name !== 'RenderingCancelledException') {
          console.warn('[PdfPagePreview] Render error:', err);
        }
      } finally {
        if (!cancelled) setRendering(false);
      }
    };

    renderPage();
    return () => { cancelled = true; };
  }, [pdfDoc, pageIndex]);

  // Re-render on window resize
  useEffect(() => {
    if (!pdfDoc) return;
    let timeout: ReturnType<typeof setTimeout>;
    const handleResize = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        // Force re-render by toggling a dummy state
        setPdfDoc((prev: any) => prev); // trigger useEffect
      }, 200);
    };
    window.addEventListener('resize', handleResize);
    return () => { window.removeEventListener('resize', handleResize); clearTimeout(timeout); };
  }, [pdfDoc]);

  return (
    <div ref={containerRef} className="flex-1 flex items-center justify-center bg-neutral-800 overflow-auto p-6 relative">
      {rendering && (
        <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
          <span className="material-symbols-outlined animate-spin text-white/40 text-3xl">progress_activity</span>
        </div>
      )}
      <canvas
        ref={canvasRef}
        className="shadow-2xl rounded-sm"
        style={{ maxWidth: '100%', maxHeight: '100%' }}
      />
      {/* Page indicator */}
      {pageCount > 0 && (
        <div className="absolute bottom-3 right-3 px-2.5 py-1 bg-black/60 text-white/80 text-xs rounded-full backdrop-blur-sm">
          {pageIndex + 1} / {pageCount}
        </div>
      )}
    </div>
  );
}
