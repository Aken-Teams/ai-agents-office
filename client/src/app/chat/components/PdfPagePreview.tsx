'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import SlideShapeOverlay, { type ShapeRect } from './SlideShapeOverlay';

interface PdfPagePreviewProps {
  pdfUrl: string;
  /** 0-based page index to display */
  pageIndex: number;
  /** Total page count callback */
  onPageCount?: (count: number) => void;
  /** Shape overlays for the current slide */
  shapes?: ShapeRect[];
  /** Currently selected shape id */
  selectedShapeId?: string | null;
  /** Called when a shape is hovered */
  onShapeHover?: (id: string | null) => void;
  /** Called when a shape is clicked */
  onShapeSelect?: (shape: ShapeRect) => void;
}

/**
 * Renders a single PDF page at high resolution using pdf.js.
 * Supports shape overlay for interactive element selection.
 */
export default function PdfPagePreview({
  pdfUrl,
  pageIndex,
  onPageCount,
  shapes,
  selectedShapeId,
  onShapeHover,
  onShapeSelect,
}: PdfPagePreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const slideWrapRef = useRef<HTMLDivElement>(null);
  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [rendering, setRendering] = useState(false);
  const [pageCount, setPageCount] = useState(0);
  const loadedUrlRef = useRef<string | null>(null);
  const renderTaskRef = useRef<any>(null);

  // Load PDF document
  const loadPdf = useCallback(async () => {
    if (!pdfUrl || loadedUrlRef.current === pdfUrl) return;
    loadedUrlRef.current = pdfUrl;

    // Destroy previous document to free memory
    if (pdfDoc) {
      try { pdfDoc.destroy(); } catch {}
      setPdfDoc(null);
    }

    try {
      const pdfjsLib = await import('pdfjs-dist');
      pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
      const pdf = await (pdfjsLib.getDocument as any)({ url: pdfUrl }).promise;
      // Only set if this is still the current URL (might have changed during async load)
      if (loadedUrlRef.current === pdfUrl) {
        setPdfDoc(pdf);
        setPageCount(pdf.numPages);
        onPageCount?.(pdf.numPages);
      } else {
        pdf.destroy();
      }
    } catch (err) {
      console.warn('[PdfPagePreview] Failed to load PDF:', err);
    }
  }, [pdfUrl, onPageCount]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { loadPdf(); }, [loadPdf]);

  // Render specific page
  useEffect(() => {
    if (!pdfDoc || !canvasRef.current || !containerRef.current) return;
    const pageNum = Math.min(Math.max(pageIndex + 1, 1), pdfDoc.numPages);

    let cancelled = false;

    const renderPage = async () => {
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

        const unscaledVp = page.getViewport({ scale: 1 });
        const containerWidth = container.clientWidth - 48;
        const containerHeight = container.clientHeight - 48;

        const scaleByWidth = containerWidth / unscaledVp.width;
        const scaleByHeight = containerHeight / unscaledVp.height;
        const scale = Math.min(scaleByWidth, scaleByHeight, 3);

        const dpr = window.devicePixelRatio || 1;
        const viewport = page.getViewport({ scale: scale * dpr });

        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.width = `${viewport.width / dpr}px`;
        canvas.style.height = `${viewport.height / dpr}px`;

        // Also size the overlay wrapper to match the canvas
        if (slideWrapRef.current) {
          slideWrapRef.current.style.width = `${viewport.width / dpr}px`;
          slideWrapRef.current.style.height = `${viewport.height / dpr}px`;
        }

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
        setPdfDoc((prev: any) => prev);
      }, 200);
    };
    window.addEventListener('resize', handleResize);
    return () => { window.removeEventListener('resize', handleResize); clearTimeout(timeout); };
  }, [pdfDoc]);

  const hasShapes = shapes && shapes.length > 0;

  return (
    <div ref={containerRef} className="flex-1 flex items-center justify-center bg-neutral-800 overflow-auto p-6 relative">
      {rendering && (
        <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
          <span className="material-symbols-outlined animate-spin text-white/40 text-3xl">progress_activity</span>
        </div>
      )}

      {/* Slide wrapper — positions canvas + shape overlay together */}
      <div ref={slideWrapRef} className="relative shadow-2xl rounded-sm">
        <canvas
          ref={canvasRef}
          className="block"
          style={{ width: '100%', height: '100%' }}
        />

        {/* Shape overlay — only when shapes are available */}
        {hasShapes && onShapeSelect && (
          <SlideShapeOverlay
            shapes={shapes}
            selectedId={selectedShapeId ?? null}
            onHover={onShapeHover ?? (() => {})}
            onSelect={onShapeSelect}
          />
        )}
      </div>

      {/* Page indicator */}
      {pageCount > 0 && (
        <div className="absolute bottom-3 right-3 px-2.5 py-1 bg-black/60 text-white/80 text-xs rounded-full backdrop-blur-sm">
          {pageIndex + 1} / {pageCount}
        </div>
      )}
    </div>
  );
}
