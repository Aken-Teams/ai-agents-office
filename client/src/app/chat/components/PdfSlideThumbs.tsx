'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

interface PdfSlideThumbsProps {
  pdfUrl: string;
  /** Number of blocks (slides). If provided, limits to this many pages. */
  slideCount?: number;
  selectedIndex: number | null;
  onSelect: (index: number) => void;
}

/**
 * Renders per-page thumbnails from a PDF blob URL using pdf.js.
 * Each page is rendered to a small canvas with 16:9-ish aspect ratio.
 */
export default function PdfSlideThumbs({ pdfUrl, slideCount, selectedIndex, onSelect }: PdfSlideThumbsProps) {
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const loadedUrlRef = useRef<string | null>(null);

  const renderThumbs = useCallback(async () => {
    if (!pdfUrl || loadedUrlRef.current === pdfUrl) return;
    loadedUrlRef.current = pdfUrl;
    setLoading(true);

    try {
      const pdfjsLib = await import('pdfjs-dist');
      // Point to worker in public folder (avoids webpack bundling issues)
      pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

      const pdf = await (pdfjsLib.getDocument as any)({ url: pdfUrl }).promise;
      const pageCount = slideCount ? Math.min(pdf.numPages, slideCount) : pdf.numPages;
      const rendered: string[] = [];

      for (let i = 1; i <= pageCount; i++) {
        const page = await pdf.getPage(i);
        const vp = page.getViewport({ scale: 0.3 }); // small thumbnail
        const canvas = document.createElement('canvas');
        canvas.width = vp.width;
        canvas.height = vp.height;
        const ctx = canvas.getContext('2d')!;
        await (page as any).render({ canvasContext: ctx, viewport: vp }).promise;
        rendered.push(canvas.toDataURL('image/png', 0.7));
        page.cleanup();
      }

      setThumbs(rendered);
    } catch (err) {
      console.warn('[PdfSlideThumbs] Failed to render:', err);
      setThumbs([]);
    } finally {
      setLoading(false);
    }
  }, [pdfUrl, slideCount]);

  useEffect(() => {
    renderThumbs();
  }, [renderThumbs]);

  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: slideCount || 4 }).map((_, i) => (
          <div key={i} className="aspect-[16/9] rounded-lg bg-surface-container border border-outline-variant/10 overflow-hidden relative">
            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-primary/5 to-transparent animate-shimmer" />
          </div>
        ))}
      </div>
    );
  }

  if (thumbs.length === 0) return null;

  return (
    <div className="space-y-2">
      {thumbs.map((src, i) => (
        <button
          key={i}
          onClick={() => onSelect(i)}
          className={`w-full cursor-pointer rounded-lg overflow-hidden border-2 transition-all shadow-sm ${
            selectedIndex === i
              ? 'border-primary shadow-md ring-1 ring-primary/20 scale-[1.02]'
              : 'border-outline-variant/20 hover:border-outline-variant/50 hover:shadow-md'
          }`}
        >
          <div className="relative">
            <img
              src={src}
              alt={`Slide ${i + 1}`}
              className="w-full block"
              draggable={false}
            />
            <div className="absolute top-1 left-1 px-1.5 py-0.5 bg-black/60 text-white text-[9px] font-semibold rounded-md backdrop-blur-sm">
              {i + 1}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}
