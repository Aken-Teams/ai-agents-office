'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { DocumentBlock, BlockRecord } from '../../editor/hooks/useDocumentBlocks';
import type { DocLayoutType } from '../hooks/useDocumentMode';
import dynamic from 'next/dynamic';
import SlideBlockPreview from '../../editor/renderers/SlideBlockPreview';
import DocBlockPreview from '../../editor/renderers/DocBlockPreview';
import DocNarrator from './DocNarrator';
import SheetBlockPreview from '../../editor/renderers/SheetBlockPreview';
import SlideElementPanel from './SlideElementPanel';
import DocElementPanel from './DocElementPanel';
import SheetTableView, { type CellRef, type CellRange } from './SheetTableView';
import SheetElementPanel from './SheetElementPanel';
import type { ShapeRect } from './SlideShapeOverlay';

const PdfSlideThumbs = dynamic(() => import('./PdfSlideThumbs'), { ssr: false });
const PdfPagePreview = dynamic(() => import('./PdfPagePreview'), { ssr: false });

const SSE_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

interface AgentActivity {
  tool: string;
  id?: string;
  status?: string;
  input?: string;
}

interface DocumentCanvasProps {
  layoutType: DocLayoutType;
  fileId: string | null;
  blocks: DocumentBlock[];
  record: BlockRecord | null;
  selectedBlockId: string | null;
  onSelectBlock: (id: string | null) => void;
  onClose: () => void;
  onRebuild: (instruction?: string) => void;
  onRegenerate: (blockId: string, elementContext?: string) => void;
  /** Update a single block field (for inline editing) */
  onUpdateBlock?: (blockId: string, key: string, value: unknown) => void;
  onDownload: () => void;
  streaming: boolean;
  rebuilding: boolean;
  /** Instruction text shown while AI regeneration is in progress */
  regenInstruction?: string;
  /** Current phase of regeneration: 'ai_thinking' | 'rebuilding' | '' */
  regenPhase?: string;
  token: string | null;
  /** Live agent activity during generation */
  agentActivity?: AgentActivity[];
  /** Callback when a sub-element (chart, field, etc.) is selected in the panel */
  onElementSelect?: (elementKey: string | null) => void;
  /** Callback when slide shapes are available for the current page */
  onShapesAvailable?: (shapes: Array<{ name: string; type: string }>) => void;
  /** Mobile: switch to chat view */
  onMobileSwitchToChat?: () => void;
  /** Image region-edit produced a new version — points the viewer at it */
  onFileReplaced?: (newFileId: string) => void;
  /** Brushed region changed — auto-attaches it to the left chat (null = cleared) */
  onRegionChange?: (maskDataUrl: string | null) => void;
  t: (key: any, params?: Record<string, string | number>) => string;
}

/** Find the best matching PDF page for a block, avoiding TOC false matches */
/** Normalize text for matching: drop whitespace AND punctuation so full-width vs
 *  half-width brackets/colons, spacing, and numbering differences don't break the
 *  match between the block heading and the rendered preview text. */
function normMatch(s: string): string {
  return (s || '').toLowerCase()
    .replace(/[\s　]+/g, '')
    .replace(/[（）()【】［］\[\]「」『』《》〈〉{}:：，,。.、；;·・•\-—–_~～!！?？'"'""`]/g, '');
}

/** Progressively looser variants of a heading to match against the preview.
 *  The block label often has extra parts the rendered heading line lacks
 *  (e.g. block "1.2 目標用戶（Persona）" vs PDF heading "1.2 目標用戶"). */
function headingCandidates(heading: string): string[] {
  const out: string[] = [];
  const push = (s: string) => { const v = s.trim(); if (v && !out.includes(v) && normMatch(v).length >= 2) out.push(v); };
  push(heading);
  const noTrailParen = heading.replace(/[（(][^（）()]*[）)]\s*$/, '');   // drop trailing "（…）"
  push(noTrailParen);
  push(heading.replace(/^[\d.\s、]+/, ''));                              // drop leading number
  push(noTrailParen.replace(/^[\d.\s、]+/, ''));                          // drop both
  return out;
}

function findBestPage(heading: string, content: string, blockIndex: number, totalBlocks: number, pageTexts: string[]): number {
  const normPages = pageTexts.map(normMatch);
  const pagesContaining = (needle: string): number[] => {
    const n = normMatch(needle);
    if (n.length < 2) return [];
    return normPages.map((t, pi) => t.includes(n) ? pi : -1).filter(pi => pi >= 0);
  };
  if (heading) {
    // Try progressively looser heading variants until one matches a page.
    let matches: number[] = [];
    for (const cand of headingCandidates(heading)) {
      matches = pagesContaining(cand);
      if (matches.length) break;
    }
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      // Multiple matches (e.g. heading appears in TOC + actual section) — pick closest to proportional estimate
      const est = blockIndex * pageTexts.length / totalBlocks;
      return matches.reduce((best, p) => Math.abs(p - est) < Math.abs(best - est) ? p : best);
    }
  }
  if (content) {
    const snippet = normMatch(content.slice(0, 40));
    if (snippet.length >= 6) {
      const idx = normPages.findIndex(t => t.includes(snippet));
      if (idx >= 0) return idx;
    }
  }
  return Math.min(Math.floor(blockIndex * pageTexts.length / totalBlocks), pageTexts.length - 1);
}

/** Find text position on a page — returns topFrac (0-1, 0=top) or null */
function findTextOnPage(items: Array<{ str: string; topFrac: number }>, search: string, afterFrac = 0): number | null {
  const norm = normMatch(search);
  if (!norm || norm.length < 2) return null;
  // Direct item match
  for (const item of items) {
    if (item.topFrac < afterFrac) continue;
    if (normMatch(item.str).includes(norm)) return item.topFrac;
  }
  // Running concatenation match (for text split across items)
  let running = '';
  for (const item of items) {
    running += item.str;
    if (item.topFrac < afterFrac) continue;
    if (normMatch(running).includes(norm)) return item.topFrac;
  }
  return null;
}

/** Locate a heading on a page, trying progressively looser variants. */
function findHeadingFrac(items: Array<{ str: string; topFrac: number }>, heading: string, afterFrac = 0): number | null {
  for (const cand of headingCandidates(heading)) {
    const f = findTextOnPage(items, cand, afterFrac);
    if (f != null) return f;
  }
  return null;
}

/** Extract search texts for a specific element field within a block */
function getElementSearchTexts(data: Record<string, unknown>, key: string): { start: string; end: string } | null {
  switch (key) {
    case 'heading': case 'title': case 'subtitle':
      return data[key] ? { start: String(data[key]).slice(0, 30), end: String(data[key]).slice(0, 30) } : null;
    case 'content': case 'text': case 'body': case 'description': {
      const t = String(data[key] || '');
      return t ? { start: t.slice(0, 30), end: t.slice(-30) } : null;
    }
    case 'rows': {
      const rows = data.rows as any[];
      if (!rows?.length) return null;
      const first = rows[0];
      const last = rows[rows.length - 1];
      const fCell = String(Array.isArray(first) ? first[0] : Object.values(first)[0] || '');
      const lCell = String(Array.isArray(last) ? last[last.length - 1] || last[0] : Object.values(last).pop() || '');
      return { start: fCell.slice(0, 20), end: lCell.slice(0, 20) };
    }
    case 'bullets': case 'items': case 'points': {
      const arr = (data[key] as any[]) || [];
      if (!arr.length) return null;
      const f = typeof arr[0] === 'string' ? arr[0] : (arr[0] as any).text || '';
      const l = typeof arr[arr.length - 1] === 'string' ? arr[arr.length - 1] : (arr[arr.length - 1] as any).text || '';
      return { start: String(f).slice(0, 25), end: String(l).slice(0, 25) };
    }
    case 'paragraphs': {
      const ps = (data.paragraphs as string[]) || [];
      if (!ps.length) return null;
      return { start: ps[0].slice(0, 30), end: ps[ps.length - 1].slice(0, 30) };
    }
    default: return null;
  }
}

/**
 * Renders ALL pages of a PDF vertically in a scrollable view,
 * each page looking like a paper sheet with shadow — matching actual DOCX output.
 * Supports section highlight overlay via text position matching.
 */
function DocPdfPages({ pdfUrl, previewKey, onPageCount, onPageTexts, highlightInfo, singlePageIndex }: {
  pdfUrl: string; previewKey: number;
  onPageCount?: (count: number) => void;
  onPageTexts?: (texts: string[]) => void;
  highlightInfo?: {
    pageIndex: number; heading: string; nextHeading?: string;
    elementSearch?: { start: string; end: string };
  } | null;
  /** When set, render ONLY this page (used by the broadcast view to show just
   *  the narrated paragraph's page, with its section highlighted). */
  singlePageIndex?: number;
}) {
  const [pageImages, setPageImages] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  // Store text items with vertical positions for highlight computation
  const pageItemsRef = useRef<Array<Array<{ str: string; topFrac: number }>>>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setPageImages([]);
    pageItemsRef.current = [];

    (async () => {
      try {
        const pdfjsLib = await import('pdfjs-dist');
        pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
        const pdf = await (pdfjsLib.getDocument as any)({ url: pdfUrl }).promise;
        const images: string[] = [];
        const texts: string[] = [];
        const allItems: Array<Array<{ str: string; topFrac: number }>> = [];

        for (let i = 1; i <= pdf.numPages; i++) {
          if (cancelled) break;
          const page = await pdf.getPage(i);
          const viewport = page.getViewport({ scale: 2 });
          const canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          const ctx = canvas.getContext('2d')!;
          await page.render({ canvasContext: ctx, viewport }).promise;
          images.push(canvas.toDataURL('image/png', 0.92));

          // Extract text with vertical positions for highlight + page matching
          const tc = await page.getTextContent();
          const pageH = viewport.height / 2; // unscaled page height
          texts.push(tc.items.map((item: any) => item.str).join(''));
          allItems.push(tc.items.map((item: any) => ({
            str: item.str as string,
            topFrac: Math.max(0, Math.min(1, 1 - ((item.transform?.[5] ?? 0) + (item.height ?? 0)) / pageH)),
          })));
          page.cleanup();
        }

        if (!cancelled) {
          setPageImages(images);
          setLoading(false);
          pageItemsRef.current = allItems;
          onPageCount?.(images.length);
          onPageTexts?.(texts);
        }
        pdf.destroy();
      } catch {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [pdfUrl, previewKey]);

  // Compute highlight overlay position (section-level or element-level)
  const highlight = (() => {
    if (!highlightInfo || !pageItemsRef.current[highlightInfo.pageIndex]) return null;
    const { pageIndex, heading, nextHeading, elementSearch } = highlightInfo;
    const items = pageItemsRef.current[pageIndex];

    // Element-level highlight: find start/end of a specific field (table, bullets, etc.)
    if (elementSearch) {
      const startFrac = findTextOnPage(items, elementSearch.start);
      if (startFrac == null) return null;
      const topPct = Math.max(0, startFrac * 100 - 0.5);
      // Find end text after the start position
      const endFrac = elementSearch.end !== elementSearch.start
        ? findTextOnPage(items, elementSearch.end, startFrac + 0.01)
        : null;
      const bottomPct = endFrac != null
        ? Math.min(100, endFrac * 100 + 2.5)
        : Math.min(100, topPct + 15); // fallback: ~15% of page
      return { pageIdx: pageIndex, topPct, bottomPct };
    }

    // Section-level highlight: from heading to next heading
    const topFrac = findHeadingFrac(items, heading);
    if (topFrac == null) return null;
    const topPct = Math.max(0, topFrac * 100 - 0.5);
    let bottomPct = 100;
    if (nextHeading) {
      const nextFrac = findHeadingFrac(items, nextHeading, topFrac + 0.01);
      if (nextFrac != null && nextFrac * 100 > topPct + 3) {
        bottomPct = nextFrac * 100 - 0.5;
      }
    }
    return { pageIdx: pageIndex, topPct, bottomPct };
  })();

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <span className="material-symbols-outlined animate-spin text-primary text-3xl">progress_activity</span>
      </div>
    );
  }

  const shownIndices = singlePageIndex != null
    ? (pageImages[singlePageIndex] != null ? [singlePageIndex] : [])
    : pageImages.map((_, i) => i);

  return (
    <div className="py-4 px-4 space-y-4">
      {shownIndices.map((i) => (
        // Skip the scroll-anchor id in single-page mode so it doesn't collide
        // with the main (hidden) preview's identical page ids.
        <div key={i} {...(singlePageIndex == null ? { id: `doc-pdf-page-${i}` } : {})} className="mx-auto bg-white shadow-md relative overflow-hidden" style={{ maxWidth: '740px' }}>
          <img src={pageImages[i]} alt={`Page ${i + 1}`} className="w-full h-auto block" />
          {highlight && highlight.pageIdx === i && (
            <div
              className="absolute left-0 right-0 pointer-events-none border-l-[3px] border-amber-300/50"
              style={{
                top: `${highlight.topPct}%`,
                height: `${highlight.bottomPct - highlight.topPct}%`,
                backgroundColor: 'rgba(251, 191, 36, 0.06)',
              }}
            />
          )}
        </div>
      ))}
    </div>
  );
}

/** Stagger reveal animation hook */
function useStaggerReveal(totalCount: number, interval = 120) {
  const [visibleCount, setVisibleCount] = useState(0);
  const prevCountRef = useRef(0);

  useEffect(() => {
    if (totalCount === 0) { setVisibleCount(0); prevCountRef.current = 0; return; }
    // If blocks were already shown, don't re-animate
    if (totalCount <= prevCountRef.current) { setVisibleCount(totalCount); return; }
    // Start from where we left off
    let count = prevCountRef.current;
    const timer = setInterval(() => {
      count++;
      setVisibleCount(count);
      if (count >= totalCount) {
        clearInterval(timer);
        prevCountRef.current = totalCount;
      }
    }, interval);
    return () => clearInterval(timer);
  }, [totalCount, interval]);

  return visibleCount;
}

export default function DocumentCanvas({
  layoutType,
  fileId,
  blocks,
  record,
  selectedBlockId,
  onSelectBlock,
  onClose,
  onRebuild,
  onRegenerate,
  onUpdateBlock,
  onDownload,
  streaming,
  rebuilding,
  regenInstruction,
  regenPhase,
  token,
  t,
  agentActivity,
  onElementSelect,
  onShapesAvailable,
  onMobileSwitchToChat,
  onFileReplaced,
  onRegionChange,
}: DocumentCanvasProps) {
  const [previewBlobUrl, setPreviewBlobUrl] = useState<string | null>(null);
  const [previewType, setPreviewType] = useState<'html' | 'pdf' | 'other'>('html');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [selectedPageIndex, setSelectedPageIndex] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [slideShapes, setSlideShapes] = useState<Record<number, ShapeRect[]>>({});
  const [selectedShapeId, setSelectedShapeId] = useState<string | null>(null);
  const [selectedElement, setSelectedElement] = useState<string | null>(null);
  const [hoveredShapeName, setHoveredShapeName] = useState<string | null>(null);
  const [showRebuildConfirm, setShowRebuildConfirm] = useState(false);
  const [rebuildStyle, setRebuildStyle] = useState('');
  const [docPageCount, setDocPageCount] = useState(0);
  const [docPageTexts, setDocPageTexts] = useState<string[]>([]);
  const [selectedCell, setSelectedCell] = useState<CellRef | null>(null);
  const [selectedRange, setSelectedRange] = useState<CellRange | null>(null);
  // Image region-edit (brush) state
  const [imgEditMode, setImgEditMode] = useState(false);
  const [imgBrushSize, setImgBrushSize] = useState(11);
  const [imgBrushColor, setImgBrushColor] = useState('rgba(255,45,45,0.5)');
  const [imgInstruction, setImgInstruction] = useState('');
  const [imgEditing, setImgEditing] = useState(false);
  const [imgHasStrokes, setImgHasStrokes] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const drawCanvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);
  const previewKeyRef = useRef(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const visibleCount = useStaggerReveal(blocks.length);

  const docType = record?.docType || '';
  const meta = record?.meta || {};
  const title = (meta.title as string) || (meta.name as string) || '';

  // Load live preview (uses /preview endpoint which handles Office conversion)
  const loadPreview = useCallback(async () => {
    if (!token || !fileId) return;
    setPreviewLoading(true);
    try {
      // Add cache-buster to prevent browser/HTTP caching of stale preview
      const res = await fetch(`${SSE_BASE}/api/files/${fileId}/preview?editing=1&t=${Date.now()}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      });
      if (!res.ok) throw new Error('preview failed');
      const blob = await res.blob();
      const ct = res.headers.get('Content-Type') || '';
      const isPdf = ct.includes('pdf');
      const isHtml = ct.includes('html');
      const type = isPdf ? 'application/pdf' : isHtml ? 'text/html' : ct;
      setPreviewType(isPdf ? 'pdf' : isHtml ? 'html' : 'other');
      if (previewBlobUrl) URL.revokeObjectURL(previewBlobUrl);
      const newUrl = URL.createObjectURL(new Blob([blob], { type }));
      setPreviewBlobUrl(newUrl);
      previewKeyRef.current++;
    } catch {
      setPreviewBlobUrl(null);
    } finally {
      setPreviewLoading(false);
    }
  }, [token, fileId, previewBlobUrl]);

  // ── Image region-edit (brush) ──────────────────────────────────────────
  // Size the draw canvas to exactly overlay the displayed image.
  const syncCanvasSize = useCallback(() => {
    const img = imgRef.current, cv = drawCanvasRef.current;
    if (!img || !cv) return;
    if (cv.width !== img.clientWidth || cv.height !== img.clientHeight) {
      cv.width = img.clientWidth;
      cv.height = img.clientHeight;
    }
  }, []);

  const drawAt = useCallback((e: React.PointerEvent<HTMLCanvasElement>, start: boolean) => {
    const cv = drawCanvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const rect = cv.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (cv.width / rect.width);
    const y = (e.clientY - rect.top) * (cv.height / rect.height);
    ctx.strokeStyle = imgBrushColor;
    ctx.fillStyle = imgBrushColor;
    ctx.lineWidth = imgBrushSize;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (start) {
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.arc(x, y, imgBrushSize / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
      ctx.stroke();
    }
    if (!imgHasStrokes) setImgHasStrokes(true);
  }, [imgBrushSize, imgBrushColor, imgHasStrokes]);

  const clearStrokes = useCallback(() => {
    const cv = drawCanvasRef.current;
    if (cv) cv.getContext('2d')?.clearRect(0, 0, cv.width, cv.height);
    setImgHasStrokes(false);
    onRegionChange?.(null);
  }, [onRegionChange]);

  // Push the current brush mask to the left chat so it auto-attaches (no button).
  const emitRegion = useCallback(() => {
    if (drawCanvasRef.current) onRegionChange?.(drawCanvasRef.current.toDataURL('image/png'));
  }, [onRegionChange]);

  const exitImgEdit = useCallback(() => {
    setImgEditMode(false);
    setImgInstruction('');
    clearStrokes();
  }, [clearStrokes]);

  const applyRegionEdit = useCallback(async () => {
    if (!token || !fileId || !drawCanvasRef.current || !imgInstruction.trim() || !imgHasStrokes) return;
    setImgEditing(true);
    try {
      const mask = drawCanvasRef.current.toDataURL('image/png');
      const res = await fetch(`${SSE_BASE}/api/files/${fileId}/region-edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ mask, instruction: imgInstruction.trim() }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || '局部編輯失敗');
      }
      const data = await res.json();
      exitImgEdit();
      if (data.file?.id && onFileReplaced) onFileReplaced(data.file.id);
      else loadPreview();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setImgEditing(false);
    }
  }, [token, fileId, imgInstruction, imgHasStrokes, exitImgEdit, onFileReplaced, loadPreview]);

  // Load preview when fileId is available; reset state for new file
  useEffect(() => {
    if (fileId) {
      loadPreview();
      exitImgEdit();
      setSelectedPageIndex(0);
      setSelectedShapeId(null);
      setSelectedElement(null);
      setHoveredShapeName(null);
    }
  }, [fileId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Refresh preview after rebuild or regeneration completes
  const prevRebuilding = useRef(false);
  const prevRegenInstruction = useRef('');
  useEffect(() => {
    // On transition rebuild→done or regen→done: refresh the preview AND re-fetch
    // shapes, then drop the stale element selection (its old position no longer
    // matches the re-laid-out slide, which is what made the highlight "jump").
    const justFinished =
      (prevRebuilding.current && !rebuilding) || (prevRegenInstruction.current && !regenInstruction);
    if (justFinished && fileId) {
      loadPreview();
      loadShapes();
      setSelectedShapeId(null);
      setSelectedElement(null);
      setHoveredShapeName(null);
      onElementSelect?.(null);
    }
    prevRebuilding.current = rebuilding;
    prevRegenInstruction.current = regenInstruction || '';
  }, [rebuilding, regenInstruction]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup blob on unmount
  useEffect(() => {
    return () => { if (previewBlobUrl) URL.revokeObjectURL(previewBlobUrl); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch PPTX shape rects for the selection overlay. Re-run after any edit so
  // the overlay matches the NEW layout instead of stale (pre-edit) coordinates.
  const loadShapes = useCallback(async () => {
    if (!token || !fileId || layoutType !== 'slides') return;
    try {
      const res = await fetch(`${SSE_BASE}/api/files/${fileId}/shapes`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const data = await res.json();
      const map: Record<number, ShapeRect[]> = {};
      for (const slide of data.slides || []) {
        map[slide.slideIndex] = slide.shapes;
      }
      setSlideShapes(map);
    } catch {
      // Shapes are optional — silently fail
    }
  }, [token, fileId, layoutType]);

  const hasBlocks = blocks.length > 0;
  useEffect(() => {
    if (!token || !fileId || layoutType !== 'slides' || !hasBlocks) return;
    setSlideShapes({}); // reset when switching files
    loadShapes();
  }, [token, fileId, layoutType, hasBlocks, loadShapes]);

  // Reset shape selection when switching slides
  useEffect(() => {
    setSelectedShapeId(null);
    setSelectedElement(null);
    setHoveredShapeName(null);
    onElementSelect?.(null);
  }, [selectedPageIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  // Notify parent of available shapes for current slide (for AI context)
  useEffect(() => {
    const shapes = slideShapes[selectedPageIndex] || [];
    onShapesAvailable?.(shapes.map(s => ({ name: s.name, type: s.type })));
  }, [selectedPageIndex, slideShapes]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync selectedBlockId → page index
  useEffect(() => {
    if (selectedBlockId && blocks.length > 0) {
      const idx = blocks.findIndex(b => b.id === selectedBlockId);
      if (idx >= 0) setSelectedPageIndex(idx);
    }
  }, [selectedBlockId, blocks]);

  // Auto-scroll PDF + compute highlight when a doc block/element is selected
  const [docHighlight, setDocHighlight] = useState<{
    pageIndex: number; heading: string; nextHeading?: string;
    elementSearch?: { start: string; end: string };
  } | null>(null);
  const prevScrollBlockRef = useRef<string | null>(null);

  useEffect(() => {
    if (layoutType === 'slides' || !selectedBlockId || docPageTexts.length === 0 || blocks.length === 0) {
      if (!selectedBlockId) setDocHighlight(null);
      return;
    }
    const idx = blocks.findIndex(b => b.id === selectedBlockId);
    const block = blocks[idx];
    if (!block) { setDocHighlight(null); return; }

    const heading = (block.data.heading as string) || (block.data.title as string) || '';
    const content = (block.data.content as string) || (block.data.text as string) || '';
    const targetPage = findBestPage(heading, content, idx, blocks.length, docPageTexts);

    const nextBlock = blocks[idx + 1];
    const nextHeading = nextBlock ? ((nextBlock.data.heading as string) || (nextBlock.data.title as string) || '') : '';

    // Element-level search when a specific chip is selected
    const elementSearch = selectedElement ? getElementSearchTexts(block.data, selectedElement) ?? undefined : undefined;

    setDocHighlight(heading || elementSearch ? { pageIndex: targetPage, heading, nextHeading, elementSearch } : null);

    // Only scroll when block selection changes (not element chip changes)
    if (selectedBlockId !== prevScrollBlockRef.current) {
      prevScrollBlockRef.current = selectedBlockId;
      const timer = setTimeout(() => {
        document.getElementById(`doc-pdf-page-${targetPage}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [selectedBlockId, selectedElement, docPageTexts, blocks, layoutType]);

  // Listen for slide change messages from HTML iframe (sync thumbnail selection)
  useEffect(() => {
    if (layoutType !== 'slides' || previewType === 'pdf') return;
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'slideChanged' && typeof e.data.index === 'number') {
        const idx = e.data.index;
        setSelectedPageIndex(idx);
        if (blocks[idx]) onSelectBlock(blocks[idx].id);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [layoutType, previewType, blocks, onSelectBlock]);

  // Keyboard navigation for slides
  useEffect(() => {
    if (layoutType !== 'slides') return;
    const maxPage = totalPages > 0 ? totalPages : blocks.length;
    if (maxPage === 0) return;

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedPageIndex(prev => {
          const next = Math.max(0, prev - 1);
          if (blocks[next]) onSelectBlock(blocks[next].id);
          return next;
        });
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedPageIndex(prev => {
          const next = Math.min(maxPage - 1, prev + 1);
          if (blocks[next]) onSelectBlock(blocks[next].id);
          return next;
        });
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [layoutType, totalPages, blocks, onSelectBlock]);

  const renderBlockPreview = (block: DocumentBlock) => {
    if (layoutType === 'slides') {
      return <SlideBlockPreview data={block.data} type={block.type} />;
    }
    if (layoutType === 'sheet') {
      return <SheetBlockPreview data={block.data} type={block.type} />;
    }
    return <DocBlockPreview data={block.data} type={block.type} />;
  };

  /** Mini slide thumbnail — looks like a real slide (dark bg, 16:9, centered text) */
  const renderSlideThumbnail = (block: DocumentBlock) => {
    const t = (block.data.title as string) || '';
    const bullets = (block.data.bullets as string[]) || [];
    const isTitle = block.type === 'title' || block.type === 'title_slide';
    return (
      <div className="aspect-[16/9] bg-[#1B2A4A] rounded flex flex-col justify-center px-2 py-1.5 overflow-hidden">
        <div className={`font-bold text-white truncate ${isTitle ? 'text-[10px] text-center' : 'text-[8px]'}`}>
          {t}
        </div>
        {!isTitle && bullets.length > 0 && (
          <div className="mt-0.5 space-y-px">
            {bullets.slice(0, 3).map((b, i) => (
              <div key={i} className="text-[6px] text-gray-300 truncate flex items-start gap-0.5">
                <span className="text-[5px] mt-[2px] shrink-0">•</span>
                <span>{typeof b === 'string' ? b : ''}</span>
              </div>
            ))}
            {bullets.length > 3 && (
              <div className="text-[5px] text-gray-500">+{bullets.length - 3}</div>
            )}
          </div>
        )}
      </div>
    );
  };

  // Slides layout: thumbnail strip + main preview
  // Rebuild confirmation modal (shared by both layouts)
  const rebuildModal = showRebuildConfirm && (
    <div className="fixed inset-0 z-[110] flex items-center justify-center" onClick={() => setShowRebuildConfirm(false)}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div className="relative bg-surface-container rounded-xl shadow-2xl border border-outline-variant/10 w-full max-w-sm mx-4 overflow-hidden animate-in" onClick={e => e.stopPropagation()}>
        <div className="flex flex-col items-center pt-6 pb-3 px-6">
          <div className="w-12 h-12 rounded-full bg-tertiary/10 flex items-center justify-center mb-3">
            <span className="material-symbols-outlined text-tertiary text-2xl">build</span>
          </div>
          <h3 className="font-bold text-base text-on-surface mb-1.5">重新產生文件</h3>
          <p className="text-sm text-on-surface-variant text-center leading-relaxed">
            {docType === 'pptx'
              ? 'AI 會保留所有內容，重新設計並產生整份簡報（全頁風格一致）。此過程約需 1-3 分鐘。'
              : '會保留所有內容，以原本的格式重新產生整份文件（修正排版／同步最新編輯）。通常數秒內完成。'}
          </p>
        </div>
        {docType === 'pptx' && (
          <div className="px-6 pb-1">
            <label className="block text-xs font-medium text-on-surface-variant mb-1.5">想順便換風格？（選填）</label>
            <input
              type="text"
              value={rebuildStyle}
              onChange={e => setRebuildStyle(e.target.value)}
              placeholder="例如：改成深色科技風 / 粉色簡約風"
              className="w-full bg-surface-container-high border border-outline-variant/20 rounded-lg px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:border-primary"
            />
          </div>
        )}
        {docType === 'docx' && (
          <div className="px-6 pb-1">
            <label className="block text-sm font-medium text-on-surface-variant mb-2">想換個風格（含表格配色）？（選填）</label>
            <div className="flex flex-wrap gap-2">
              {[
                { key: 'modern', label: '現代簡約（藍）' },
                { key: 'formal', label: '專業端莊（深藍）' },
                { key: 'academic', label: '學術（黑白）' },
                { key: 'compact', label: '精簡（灰）' },
              ].map(c => (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => setRebuildStyle(prev => prev === c.key ? '' : c.key)}
                  className={`px-3.5 py-2 rounded-full text-sm border transition-colors cursor-pointer ${rebuildStyle === c.key ? 'border-primary bg-primary/10 text-primary font-medium' : 'border-outline-variant/30 text-on-surface-variant hover:border-primary/40'}`}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {docType === 'slides' && (
          <div className="px-6 pb-1">
            <label className="block text-sm font-medium text-on-surface-variant mb-2">想換個佈景主題？（選填）</label>
            <div className="flex flex-wrap gap-2">
              {[
                { key: 'editorial', label: '編輯風（奶油＋磚紅）' },
                { key: 'minimal', label: '極簡（白）' },
                { key: 'dark', label: '深色科技' },
                { key: 'gradient', label: '漸層（紫藍）' },
                { key: 'neon', label: '霓虹' },
                { key: 'corporate', label: '企業藍' },
                { key: 'creative', label: '創意粉' },
                { key: 'elegant', label: '優雅棕' },
                { key: 'tech', label: '技術黑' },
              ].map(c => (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => setRebuildStyle(prev => prev === c.key ? '' : c.key)}
                  className={`px-3.5 py-2 rounded-full text-sm border transition-colors cursor-pointer ${rebuildStyle === c.key ? 'border-primary bg-primary/10 text-primary font-medium' : 'border-outline-variant/30 text-on-surface-variant hover:border-primary/40'}`}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="flex gap-2 px-6 pb-6 pt-3">
          <button
            onClick={() => setShowRebuildConfirm(false)}
            className="flex-1 px-4 py-2.5 rounded-lg text-sm font-medium text-on-surface-variant bg-surface-container-high hover:bg-surface-container-highest transition-colors cursor-pointer"
          >
            取消
          </button>
          <button
            onClick={() => { setShowRebuildConfirm(false); onRebuild(rebuildStyle.trim() || undefined); setRebuildStyle(''); }}
            className="flex-1 px-4 py-2.5 rounded-lg text-sm font-medium text-on-primary bg-primary hover:bg-primary-hover transition-colors cursor-pointer"
          >
            {rebuildStyle.trim() ? '重建並換風格' : '確定重建'}
          </button>
        </div>
      </div>
    </div>
  );

  if (layoutType === 'image') {
    return (
      <div className="flex-1 flex flex-col min-w-0 bg-surface">
        {/* Toolbar */}
        <div className="flex items-center gap-1.5 sm:gap-2 px-2 sm:px-4 py-2 border-b border-outline-variant/10 bg-surface-container/30 shrink-0">
          <div className="flex-1 min-w-0">
            {title && <div className="text-xs sm:text-sm font-semibold text-on-surface truncate">{title}</div>}
            <div className="text-[10px] text-on-surface-variant uppercase tracking-wider">{docType || 'image'}</div>
          </div>
          {previewBlobUrl && !imgEditMode && (
            <button onClick={() => setImgEditMode(true)} className="flex items-center gap-1 px-2 sm:px-2.5 py-1.5 bg-primary text-on-primary rounded-lg text-xs font-bold hover:bg-primary-hover transition-colors cursor-pointer" title="圈選局部修改">
              <span className="material-symbols-outlined text-sm">brush</span>
              <span className="hidden sm:inline">局部編輯</span>
            </button>
          )}
          {onMobileSwitchToChat && (
            <button onClick={onMobileSwitchToChat} className="sm:hidden p-1 rounded hover:bg-surface-container transition-colors cursor-pointer shrink-0" title="切換至對話">
              <span className="material-symbols-outlined text-on-surface-variant text-sm">chat</span>
            </button>
          )}
          <button onClick={onDownload} className="p-1.5 rounded-lg hover:bg-surface-container transition-colors cursor-pointer" title={t('chat.docMode.download')}>
            <span className="material-symbols-outlined text-on-surface-variant text-sm">download</span>
          </button>
          <button onClick={onClose} className="hidden sm:block p-1.5 rounded-lg hover:bg-surface-container transition-colors cursor-pointer">
            <span className="material-symbols-outlined text-on-surface-variant text-lg">close</span>
          </button>
        </div>

        {/* Brush controls bar (edit mode) */}
        {imgEditMode && (
          <div className="flex items-center gap-2.5 sm:gap-3 px-2.5 sm:px-4 py-2 border-b border-outline-variant/10 bg-primary/5 shrink-0">
            <span className="text-xs text-on-surface-variant inline-flex items-center gap-1 shrink-0">
              <span className="material-symbols-outlined text-[16px] text-primary">brush</span>
              <span className="hidden sm:inline">塗抹要修改的區域</span>
            </span>
            <input type="range" min={4} max={32} value={imgBrushSize} onChange={e => setImgBrushSize(Number(e.target.value))} className="w-16 sm:w-24 accent-primary shrink-0" title="筆刷粗細" />
            <div className="inline-flex items-center gap-2 shrink-0">
              {[
                { dot: '#ff2d2d', stroke: 'rgba(255,45,45,0.5)' },
                { dot: '#2979ff', stroke: 'rgba(41,121,255,0.5)' },
                { dot: '#00b84d', stroke: 'rgba(0,184,77,0.5)' },
              ].map(c => (
                <button
                  key={c.dot}
                  onClick={() => setImgBrushColor(c.stroke)}
                  className={`w-6 h-6 sm:w-5 sm:h-5 rounded-full transition-transform ${imgBrushColor === c.stroke ? 'ring-2 ring-offset-1 ring-on-surface scale-110' : 'active:scale-110'}`}
                  style={{ background: c.dot }}
                  title="筆刷顏色"
                />
              ))}
            </div>
            <button onClick={clearStrokes} disabled={!imgHasStrokes} title="清除" className="text-xs text-on-surface-variant hover:text-on-surface disabled:opacity-40 inline-flex items-center gap-1 shrink-0">
              <span className="material-symbols-outlined text-[17px] sm:text-[15px]">ink_eraser</span><span className="hidden sm:inline">清除</span>
            </button>
            <button onClick={exitImgEdit} className="ml-auto text-xs text-on-surface-variant hover:text-on-surface shrink-0">取消</button>
          </div>
        )}
        {imgEditMode && imgHasStrokes && (
          <div className="px-2.5 sm:px-4 py-1.5 text-[11px] text-on-surface-variant bg-primary/[0.03] shrink-0 flex items-start gap-1 leading-relaxed">
            <span className="material-symbols-outlined text-[14px] text-primary shrink-0">forum</span>
            <span>已圈選 —— 下方輸入指令直接改，或回<span className="text-primary font-medium">聊天</span>問問題／討論</span>
          </div>
        )}

        {/* Image body — top-aligned so tall infographics aren't clipped at the top */}
        <div className="flex-1 overflow-auto px-3 sm:px-6 pt-5 sm:pt-8 pb-5 sm:pb-8 flex items-start justify-center bg-surface-container-low">
          {previewBlobUrl ? (
            <div className="relative inline-block">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img ref={imgRef} src={previewBlobUrl} alt={title || 'infographic'} onLoad={syncCanvasSize} className="max-w-full h-auto rounded-lg shadow-md block select-none" draggable={false} />
              {imgEditMode && (
                <canvas
                  ref={drawCanvasRef}
                  className="absolute inset-0 w-full h-full rounded-lg cursor-crosshair touch-none"
                  style={{ background: 'transparent' }}
                  onPointerDown={e => { (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId); drawingRef.current = true; syncCanvasSize(); drawAt(e, true); }}
                  onPointerMove={e => { if (drawingRef.current) drawAt(e, false); }}
                  onPointerUp={() => { drawingRef.current = false; emitRegion(); }}
                  onPointerLeave={() => { if (drawingRef.current) { drawingRef.current = false; emitRegion(); } }}
                />
              )}
              {imgEditing && (
                <div className="absolute inset-0 rounded-lg bg-black/40 flex flex-col items-center justify-center gap-2 text-white">
                  <span className="material-symbols-outlined animate-spin">progress_activity</span>
                  <span className="text-xs">AI 修改中…</span>
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 text-on-surface-variant">
              <span className="material-symbols-outlined animate-spin">progress_activity</span>
              <span className="text-xs">{previewLoading ? '載入圖片中…' : '圖片生成中…'}</span>
            </div>
          )}
        </div>

        {/* Instruction input (edit mode) */}
        {imgEditMode && (
          <div className="flex items-center gap-2 px-2 sm:px-4 py-2.5 border-t border-outline-variant/10 bg-surface-container/30 shrink-0">
            <input
              value={imgInstruction}
              onChange={e => setImgInstruction(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && imgHasStrokes && imgInstruction.trim() && !imgEditing) applyRegionEdit(); }}
              placeholder={imgHasStrokes ? '這個區域要改成什麼？（例：把杯子改成玻璃杯）' : '先在圖上塗抹要修改的區域…'}
              disabled={imgEditing}
              className="flex-1 bg-surface-container-high border-none rounded-lg px-3 py-2 text-sm text-on-surface placeholder:text-outline focus:ring-1 focus:ring-primary/40 outline-none"
            />
            <button
              onClick={applyRegionEdit}
              disabled={imgEditing || !imgHasStrokes || !imgInstruction.trim()}
              className="px-3 py-2 bg-primary text-on-primary rounded-lg text-sm font-bold hover:bg-primary-hover transition-colors disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed shrink-0"
            >
              套用
            </button>
          </div>
        )}
      </div>
    );
  }

  if (layoutType === 'slides') {
    return (
      <><div className="flex-1 flex flex-col min-w-0 bg-surface">
        {/* Toolbar */}
        <div className="flex items-center gap-1.5 sm:gap-2 px-2 sm:px-4 py-2 border-b border-outline-variant/10 bg-surface-container/30 shrink-0">
          <div className="flex-1 min-w-0">
            {title && <div className="text-xs sm:text-sm font-semibold text-on-surface truncate">{title}</div>}
            <div className="text-[10px] text-on-surface-variant uppercase tracking-wider">
              {docType || 'slides'} · {totalPages || blocks.length} {t('editor.blocks')}
            </div>
          </div>
          <DocNarrator fileId={fileId} fileType={docType} blocks={blocks} onSelectBlock={onSelectBlock} token={token} renderPreview={() => {
            // Real page preview, same components the canvas uses, navigated to the
            // current selection (selectedPageIndex is driven by onSelectBlock).
            if (previewBlobUrl && previewType === 'pdf') {
              // pptx: 1 slide = 1 page → simple single-page render.
              // (cast: this closure is shared by the slides & doc toolbars, whose
              //  layoutType narrows differently)
              if ((layoutType as string) === 'slides') {
                return <PdfPagePreview pdfUrl={previewBlobUrl} pageIndex={selectedPageIndex} onPageCount={() => { /* noop */ }} />;
              }
              // docx/pdf: show the narrated paragraph's page, with that section
              // highlighted in light yellow (follows docHighlight as it advances).
              return (
                <div className="flex-1 overflow-auto">
                  <DocPdfPages
                    pdfUrl={previewBlobUrl}
                    previewKey={previewKeyRef.current}
                    onPageCount={setDocPageCount}
                    onPageTexts={setDocPageTexts}
                    highlightInfo={docHighlight}
                    singlePageIndex={docHighlight?.pageIndex ?? selectedPageIndex}
                  />
                </div>
              );
            }
            if (previewBlobUrl) {
              return <iframe src={previewBlobUrl} className="flex-1 w-full border-0 bg-white" title="broadcast-preview" sandbox="allow-scripts allow-same-origin" />;
            }
            return blocks[selectedPageIndex] ? (
              <div className="flex-1 overflow-auto p-6 flex items-center justify-center">{renderBlockPreview(blocks[selectedPageIndex])}</div>
            ) : null;
          }} />
          <button
            onClick={() => setShowRebuildConfirm(true)}
            disabled={rebuilding || blocks.length === 0}
            className="flex items-center gap-1 px-2 sm:px-2.5 py-1.5 bg-primary text-on-primary rounded-lg text-xs font-bold hover:bg-primary-hover transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
          >
            {rebuilding ? (
              <span className="material-symbols-outlined text-sm animate-spin">progress_activity</span>
            ) : (
              <span className="material-symbols-outlined text-sm">build</span>
            )}
            <span className="hidden sm:inline">{t('chat.docMode.rebuild')}</span>
          </button>
          {onMobileSwitchToChat && (
            <button
              onClick={onMobileSwitchToChat}
              className="sm:hidden p-1 rounded hover:bg-surface-container transition-colors cursor-pointer shrink-0"
              title="切換至對話"
            >
              <span className="material-symbols-outlined text-on-surface-variant text-sm">chat</span>
            </button>
          )}
          <button
            onClick={onDownload}
            className="p-1.5 rounded-lg hover:bg-surface-container transition-colors cursor-pointer"
            title={t('chat.docMode.download')}
          >
            <span className="material-symbols-outlined text-on-surface-variant text-sm">download</span>
          </button>
          <button
            onClick={onClose}
            className="hidden sm:block p-1.5 rounded-lg hover:bg-surface-container transition-colors cursor-pointer"
          >
            <span className="material-symbols-outlined text-on-surface-variant text-lg">close</span>
          </button>
        </div>

        {/* Mobile horizontal thumbnail strip */}
        {blocks.length > 0 && (
          <div className="sm:hidden flex items-center gap-1.5 px-2 py-1.5 border-b border-outline-variant/10 bg-surface-container/20 overflow-x-auto shrink-0 scrollbar-thin">
            {blocks.map((block, index) => (
              <button
                key={block.id}
                onClick={() => {
                  setSelectedPageIndex(index);
                  onSelectBlock(block.id);
                  try {
                    const win = iframeRef.current?.contentWindow;
                    if (win) {
                      win.postMessage({ type: 'goToSlide', index }, '*');
                      const el = win.document?.querySelector?.('#slide-' + index);
                      if (el) el.scrollIntoView({ behavior: 'smooth' });
                    }
                  } catch { /* ignored */ }
                }}
                className={`shrink-0 rounded border-2 transition-all cursor-pointer overflow-hidden ${
                  selectedPageIndex === index
                    ? 'border-primary shadow-sm'
                    : 'border-transparent opacity-60'
                }`}
                style={{ width: '64px' }}
              >
                <div className="aspect-[16/9] bg-[#1B2A4A] rounded-sm flex flex-col justify-center px-1 py-0.5 overflow-hidden">
                  <div className={`font-bold text-white truncate ${
                    block.type === 'title' || block.type === 'title_slide' ? 'text-[5px] text-center' : 'text-[4px]'
                  }`}>
                    {(block.data.title as string) || ''}
                  </div>
                </div>
                <div className={`text-[8px] text-center ${
                  selectedPageIndex === index ? 'text-primary font-semibold' : 'text-on-surface-variant/50'
                }`}>
                  {index + 1}
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Main content area */}
        <div className="flex-1 flex min-h-0">
          {/* Thumbnail strip (left) — desktop only, hide when no blocks (interactive web) */}
          {(blocks.length > 0 || previewType === 'pdf' || (streaming && !previewBlobUrl)) && (
          <div className="hidden sm:block w-36 lg:w-44 border-r border-outline-variant/10 overflow-y-auto p-2 shrink-0 bg-surface-container/20">
            {streaming && !previewBlobUrl && (
              <div className="space-y-2">
                {[1, 2, 3, 4].map(i => (
                  <div key={i} className="aspect-[16/9] rounded-lg bg-surface-container border border-outline-variant/10 overflow-hidden relative">
                    <div className="absolute inset-0 bg-gradient-to-r from-transparent via-primary/5 to-transparent animate-shimmer" />
                    <div className="p-2 space-y-1.5">
                      <div className="h-2 w-3/5 rounded bg-on-surface/6" />
                      <div className="h-1.5 w-4/5 rounded bg-on-surface/4" />
                      <div className="h-1.5 w-2/3 rounded bg-on-surface/4" />
                    </div>
                  </div>
                ))}
              </div>
            )}
            {previewBlobUrl && previewType === 'pdf' && (
              <PdfSlideThumbs
                pdfUrl={previewBlobUrl}
                slideCount={blocks.length || undefined}
                selectedIndex={selectedPageIndex}
                onSelect={(index) => {
                  setSelectedPageIndex(index);
                  if (blocks[index]) {
                    onSelectBlock(blocks[index].id);
                  }
                }}
              />
            )}
            {previewType !== 'pdf' && blocks.length > 0 && (
              <div className="space-y-1.5">
                {blocks.map((block, index) => (
                  <button
                    key={block.id}
                    onClick={() => {
                      setSelectedPageIndex(index);
                      onSelectBlock(block.id);
                      // Navigate main iframe to this slide
                      try {
                        const win = iframeRef.current?.contentWindow;
                        if (win) {
                          win.postMessage({ type: 'goToSlide', index }, '*');
                          const el = win.document?.querySelector?.('#slide-' + index);
                          if (el) el.scrollIntoView({ behavior: 'smooth' });
                        }
                      } catch { /* cross-origin — ignored */ }
                    }}
                    className={`w-full rounded-lg border-2 transition-all cursor-pointer overflow-hidden ${
                      selectedPageIndex === index
                        ? 'border-primary shadow-md ring-1 ring-primary/30'
                        : 'border-transparent hover:border-outline-variant/30'
                    }`}
                  >
                    {previewBlobUrl ? (
                      <div className="relative w-full overflow-hidden bg-[#1B2A4A]" style={{ aspectRatio: '16/9' }}>
                        <iframe
                          src={`${previewBlobUrl}#slide-${index}`}
                          className="absolute top-0 left-0 border-0 origin-top-left"
                          style={{
                            width: '1000%',
                            height: '1000%',
                            transform: 'scale(0.1)',
                            pointerEvents: 'none',
                          }}
                          tabIndex={-1}
                          sandbox="allow-scripts allow-same-origin"
                          loading="lazy"
                        />
                      </div>
                    ) : (
                      renderSlideThumbnail(block)
                    )}
                    <div className={`text-[9px] py-0.5 text-center ${
                      selectedPageIndex === index ? 'text-primary font-semibold' : 'text-on-surface-variant/50'
                    }`}>
                      {index + 1}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
          )}

          {/* Main preview — PDF page viewer (PPTX) or full-width iframe (HTML slides) */}
          <div className="flex-1 flex flex-col min-w-0 relative">
            {/* AI regeneration in-progress banner */}
            {regenInstruction && (
              <div className="flex items-center gap-2.5 px-4 py-2.5 bg-primary/8 border-b border-primary/15 shrink-0 z-10">
                <span className="material-symbols-outlined text-primary text-base animate-spin">progress_activity</span>
                <div className="flex-1 min-w-0">
                  <span className="text-xs font-medium text-primary">
                    {regenPhase === 'patching' ? '套用變更中...' : regenPhase === 'rebuilding' ? 'AI 重新設計中...' : 'AI 修改中...'}
                  </span>
                  <p className="text-[11px] text-on-surface-variant truncate mt-0.5">{regenInstruction}</p>
                </div>
              </div>
            )}
            {previewLoading ? (
              <div className="flex-1 flex items-center justify-center bg-surface-container/50">
                <span className="material-symbols-outlined animate-spin text-primary/60 text-3xl">progress_activity</span>
              </div>
            ) : previewBlobUrl && previewType === 'pdf' ? (
              <PdfPagePreview
                key={previewKeyRef.current}
                pdfUrl={previewBlobUrl}
                pageIndex={selectedPageIndex}
                onPageCount={(count) => setTotalPages(count)}
                shapes={slideShapes[selectedPageIndex]}
                selectedShapeId={selectedShapeId}
                onShapeHover={(id) => {
                  const shape = slideShapes[selectedPageIndex]?.find(s => s.id === id);
                  setHoveredShapeName(shape?.text?.slice(0, 30) || shape?.name || null);
                }}
                onShapeSelect={(shape) => {
                  const isDeselect = selectedShapeId === shape.id;
                  setSelectedShapeId(isDeselect ? null : shape.id);
                  // Also select the corresponding block
                  if (blocks[selectedPageIndex]) {
                    onSelectBlock(blocks[selectedPageIndex].id);
                  }
                  // Propagate shape name as element context for AI instructions
                  const shapeName = isDeselect ? null : (shape.name || shape.text?.slice(0, 40) || null);
                  setSelectedElement(isDeselect ? null : shapeName);
                  onElementSelect?.(isDeselect ? null : shapeName);
                }}
              />
            ) : previewBlobUrl ? (
              <iframe
                ref={iframeRef}
                key={previewKeyRef.current}
                src={previewBlobUrl}
                className="flex-1 w-full border-0 bg-white"
                title="Document Preview"
                sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups"
                tabIndex={0}
              />
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center gap-4 bg-surface-container/30">
                {streaming ? (
                  <>
                    {/* Animated slide skeleton */}
                    <div className="w-[70%] max-w-md aspect-[16/9] rounded-xl bg-surface-container border border-outline-variant/10 shadow-sm overflow-hidden relative">
                      <div className="absolute inset-0 bg-gradient-to-r from-transparent via-primary/5 to-transparent animate-shimmer" />
                      <div className="p-6 space-y-3">
                        <div className="h-5 w-3/5 rounded bg-on-surface/8 animate-pulse" />
                        <div className="h-3 w-4/5 rounded bg-on-surface/5 animate-pulse delay-75" />
                        <div className="h-3 w-2/3 rounded bg-on-surface/5 animate-pulse delay-150" />
                      </div>
                    </div>
                    <div className="flex items-center gap-2 text-on-surface-variant/60">
                      <span className="material-symbols-outlined text-lg animate-spin text-primary/70">progress_activity</span>
                      <span className="text-xs font-medium">{t('chat.docMode.generating')}</span>
                    </div>
                    {agentActivity && agentActivity.length > 0 && (
                      <div className="flex items-center gap-1.5 flex-wrap justify-center max-w-sm">
                        {agentActivity.slice(-6).map((act, i) => (
                          <span key={act.id || i} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] ${
                            act.status === 'completed'
                              ? 'bg-primary/10 text-primary/60'
                              : 'bg-surface-container text-on-surface-variant/70'
                          }`}>
                            <span className={`material-symbols-outlined ${act.status !== 'completed' ? 'animate-pulse' : ''}`} style={{ fontSize: '10px' }}>
                              {act.status === 'completed' ? 'check' : 'pending'}
                            </span>
                            <span className="truncate max-w-[80px]">{(act.tool || '').split(':').pop()}</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="flex flex-col items-center gap-2 text-on-surface-variant/30">
                    <span className="material-symbols-outlined text-5xl">slideshow</span>
                    <span className="text-xs">Preview</span>
                  </div>
                )}
              </div>
            )}

            {/* Hovered shape name tooltip */}
            {hoveredShapeName && !selectedShapeId && (
              <div className="absolute bottom-14 left-1/2 -translate-x-1/2 px-3 py-1.5 bg-inverse-surface text-inverse-on-surface text-xs rounded-full shadow-lg pointer-events-none z-20 whitespace-nowrap">
                {hoveredShapeName}
              </div>
            )}

            {/* Selected shape/element info bar (only when blocks exist — not for HTML slides) */}
            {blocks.length > 0 && (selectedBlockId || selectedShapeId) && (
              <div className="flex items-center gap-2 px-2 sm:px-4 py-1.5 sm:py-2 border-t border-outline-variant/10 bg-surface-container/30 shrink-0">
                <span className="material-symbols-outlined text-primary text-sm">edit_note</span>
                <span className="text-xs text-on-surface-variant flex-1 min-w-0">
                  {selectedShapeId ? (
                    <>
                      第 {selectedPageIndex + 1} 頁 ·{' '}
                      <span className="text-primary font-medium">
                        {slideShapes[selectedPageIndex]?.find(s => s.id === selectedShapeId)?.text?.slice(0, 40) ||
                         slideShapes[selectedPageIndex]?.find(s => s.id === selectedShapeId)?.name || '元素'}
                      </span>
                      <span className="text-on-surface-variant/50 ml-2">← 在左側輸入修改需求</span>
                    </>
                  ) : selectedBlockId ? (
                    <>#{(blocks.findIndex(b => b.id === selectedBlockId) + 1)} — {blocks.find(b => b.id === selectedBlockId)?.type.replace(/_/g, ' ')}</>
                  ) : null}
                </span>
                <button
                  onClick={() => {
                    onSelectBlock(null);
                    setSelectedShapeId(null);
                    setSelectedElement(null);
                    onElementSelect?.(null);
                  }}
                  className="p-1 rounded hover:bg-surface-container transition-colors cursor-pointer"
                >
                  <span className="material-symbols-outlined text-on-surface-variant text-sm">close</span>
                </button>
              </div>
            )}

            {/* Slide element panel — editable fields for current slide */}
            {blocks[selectedPageIndex] && (
              <SlideElementPanel
                block={blocks[selectedPageIndex]}
                slideIndex={selectedPageIndex}
                selectedElement={selectedElement}
                onSelectElement={(key) => {
                  setSelectedElement(key);
                  onElementSelect?.(key);
                  if (blocks[selectedPageIndex]) {
                    onSelectBlock(blocks[selectedPageIndex].id);
                  }
                }}
                onSaveField={(blockId, key, value) => {
                  onUpdateBlock?.(blockId, key, value);
                }}
                onAiEdit={(blockId, context) => {
                  onRegenerate(blockId, context);
                }}
                t={t}
              />
            )}
          </div>
        </div>
      </div>{rebuildModal}</>
    );
  }

  // Sheet layout: tab bar + interactive table + element panel
  if (layoutType === 'sheet') {
    const selectedSheetBlock = blocks.find(b => b.id === selectedBlockId) || blocks[0];
    const selectedSheetIndex = selectedSheetBlock ? blocks.findIndex(b => b.id === selectedSheetBlock.id) : 0;

    const handleCellEdit = (row: number, col: number, value: string | number) => {
      if (!selectedSheetBlock) return;
      const rows = [...((selectedSheetBlock.data.rows as any[][]) || [])];
      if (!rows[row]) return;
      const newRow = [...rows[row]];
      newRow[col] = value;
      rows[row] = newRow;
      onUpdateBlock?.(selectedSheetBlock.id, 'rows', rows);
    };

    return (
      <><div className="flex-1 flex flex-col min-w-0 bg-surface">
        {/* Toolbar */}
        <div className="flex items-center gap-1.5 sm:gap-2 px-2 sm:px-4 py-2 border-b border-outline-variant/10 bg-surface-container/30 shrink-0">
          <div className="flex-1 min-w-0">
            {title && <div className="text-xs sm:text-sm font-semibold text-on-surface truncate">{title}</div>}
            <div className="text-[10px] text-on-surface-variant uppercase tracking-wider">
              {docType || 'xlsx'} · {blocks.length} {blocks.length === 1 ? 'sheet' : 'sheets'}
            </div>
          </div>
          <button
            onClick={() => setShowRebuildConfirm(true)}
            disabled={rebuilding || blocks.length === 0}
            className="flex items-center gap-1 px-2 sm:px-2.5 py-1.5 bg-primary text-on-primary rounded-lg text-xs font-bold hover:bg-primary-hover transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
          >
            {rebuilding ? (
              <span className="material-symbols-outlined text-sm animate-spin">progress_activity</span>
            ) : (
              <span className="material-symbols-outlined text-sm">build</span>
            )}
            <span className="hidden sm:inline">{t('chat.docMode.rebuild')}</span>
          </button>
          {onMobileSwitchToChat && (
            <button
              onClick={onMobileSwitchToChat}
              className="sm:hidden p-1 rounded hover:bg-surface-container transition-colors cursor-pointer shrink-0"
              title="切換至對話"
            >
              <span className="material-symbols-outlined text-on-surface-variant text-sm">chat</span>
            </button>
          )}
          <button
            onClick={onDownload}
            className="p-1.5 rounded-lg hover:bg-surface-container transition-colors cursor-pointer"
            title={t('chat.docMode.download')}
          >
            <span className="material-symbols-outlined text-on-surface-variant text-sm">download</span>
          </button>
          <button
            onClick={onClose}
            className="hidden sm:block p-1.5 rounded-lg hover:bg-surface-container transition-colors cursor-pointer"
          >
            <span className="material-symbols-outlined text-on-surface-variant text-lg">close</span>
          </button>
        </div>

        {/* AI regeneration banner */}
        {regenInstruction && (
          <div className="flex items-center gap-2.5 px-4 py-2.5 bg-primary/8 border-b border-primary/15 shrink-0">
            <span className="material-symbols-outlined text-primary text-base animate-spin">progress_activity</span>
            <div className="flex-1 min-w-0">
              <span className="text-xs font-medium text-primary">
                {regenPhase === 'rebuilding' ? 'AI 重新產生中...' : 'AI 修改中...'}
              </span>
              <p className="text-[11px] text-on-surface-variant truncate mt-0.5">{regenInstruction}</p>
            </div>
          </div>
        )}

        {/* Sheet tabs */}
        {blocks.length > 1 && (
          <div className="flex items-center border-b border-outline-variant/10 bg-surface-container/20 px-2 overflow-x-auto shrink-0">
            {blocks.map((block, i) => {
              const name = (block.data.name as string) || (block.data.title as string) || (block.data.sheetName as string) || `Sheet ${i + 1}`;
              const active = selectedSheetBlock?.id === block.id;
              return (
                <button
                  key={block.id}
                  onClick={() => {
                    onSelectBlock(block.id);
                    setSelectedCell(null);
                    setSelectedRange(null);
                  }}
                  className={`px-3 py-1.5 text-xs whitespace-nowrap border-b-2 transition-colors cursor-pointer ${
                    active
                      ? 'border-primary text-primary font-semibold bg-surface'
                      : 'border-transparent text-on-surface-variant hover:text-on-surface hover:bg-surface-container-highest/40'
                  }`}
                >
                  {name}
                </button>
              );
            })}
          </div>
        )}

        {/* Main table area */}
        {selectedSheetBlock ? (
          <SheetTableView
            block={selectedSheetBlock}
            sheetIndex={selectedSheetIndex}
            selectedCell={selectedCell}
            selectedRange={selectedRange}
            onSelectCell={setSelectedCell}
            onSelectRange={setSelectedRange}
            onCellEdit={handleCellEdit}
          />
        ) : streaming ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3">
            <span className="material-symbols-outlined text-4xl text-primary animate-spin">progress_activity</span>
            <span className="text-sm text-on-surface-variant">{t('chat.docMode.generating')}</span>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-on-surface-variant/30">
            <span className="material-symbols-outlined text-5xl">table_chart</span>
          </div>
        )}

        {/* Bottom panel */}
        {selectedSheetBlock && (
          <SheetElementPanel
            block={selectedSheetBlock}
            sheetIndex={selectedSheetIndex}
            selectedCell={selectedCell}
            selectedRange={selectedRange}
            onSaveField={(blockId, key, value) => onUpdateBlock?.(blockId, key, value)}
            onAiEdit={(blockId, ctx) => onRegenerate(blockId, ctx)}
            t={t}
          />
        )}
      </div>{rebuildModal}</>
    );
  }

  // Doc layout: vertical block list with optional preview
  return (
    <>
    <div className="flex-1 flex flex-col min-w-0 bg-surface">
      {/* Toolbar */}
      <div className="flex items-center gap-1.5 sm:gap-2 px-2 sm:px-4 py-2 border-b border-outline-variant/10 bg-surface-container/30 shrink-0">
        <div className="flex-1 min-w-0">
          {title && <div className="text-xs sm:text-sm font-semibold text-on-surface truncate">{title}</div>}
          <div className="text-[10px] text-on-surface-variant uppercase tracking-wider">
            {docType || layoutType} · {blocks.length} {t('editor.blocks')}
          </div>
        </div>
        <DocNarrator fileId={fileId} fileType={docType} blocks={blocks} onSelectBlock={onSelectBlock} token={token} renderPreview={() => {
            // Real page preview, same components the canvas uses, navigated to the
            // current selection (selectedPageIndex is driven by onSelectBlock).
            if (previewBlobUrl && previewType === 'pdf') {
              // pptx: 1 slide = 1 page → simple single-page render.
              // (cast: this closure is shared by the slides & doc toolbars, whose
              //  layoutType narrows differently)
              if ((layoutType as string) === 'slides') {
                return <PdfPagePreview pdfUrl={previewBlobUrl} pageIndex={selectedPageIndex} onPageCount={() => { /* noop */ }} />;
              }
              // docx/pdf: show the narrated paragraph's page, with that section
              // highlighted in light yellow (follows docHighlight as it advances).
              return (
                <div className="flex-1 overflow-auto">
                  <DocPdfPages
                    pdfUrl={previewBlobUrl}
                    previewKey={previewKeyRef.current}
                    onPageCount={setDocPageCount}
                    onPageTexts={setDocPageTexts}
                    highlightInfo={docHighlight}
                    singlePageIndex={docHighlight?.pageIndex ?? selectedPageIndex}
                  />
                </div>
              );
            }
            if (previewBlobUrl) {
              return <iframe src={previewBlobUrl} className="flex-1 w-full border-0 bg-white" title="broadcast-preview" sandbox="allow-scripts allow-same-origin" />;
            }
            return blocks[selectedPageIndex] ? (
              <div className="flex-1 overflow-auto p-6 flex items-center justify-center">{renderBlockPreview(blocks[selectedPageIndex])}</div>
            ) : null;
          }} />
        <button
          onClick={() => setShowRebuildConfirm(true)}
          disabled={rebuilding || blocks.length === 0}
          className="flex items-center gap-1 px-2 sm:px-2.5 py-1.5 bg-primary text-on-primary rounded-lg text-xs font-bold hover:bg-primary-hover transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
        >
          {rebuilding ? (
            <span className="material-symbols-outlined text-sm animate-spin">progress_activity</span>
          ) : (
            <span className="material-symbols-outlined text-sm">build</span>
          )}
          <span className="hidden sm:inline">{t('chat.docMode.rebuild')}</span>
        </button>
        {onMobileSwitchToChat && (
          <button
            onClick={onMobileSwitchToChat}
            className="sm:hidden p-1 rounded hover:bg-surface-container transition-colors cursor-pointer shrink-0"
            title="切換至對話"
          >
            <span className="material-symbols-outlined text-on-surface-variant text-sm">chat</span>
          </button>
        )}
        <button
          onClick={onDownload}
          className="p-1.5 rounded-lg hover:bg-surface-container transition-colors cursor-pointer"
          title={t('chat.docMode.download')}
        >
          <span className="material-symbols-outlined text-on-surface-variant text-sm">download</span>
        </button>
        <button
          onClick={onClose}
          className="hidden sm:block p-1.5 rounded-lg hover:bg-surface-container transition-colors cursor-pointer"
        >
          <span className="material-symbols-outlined text-on-surface-variant text-lg">close</span>
        </button>
      </div>

      {/* AI regeneration in-progress banner */}
      {regenInstruction && (
        <div className="flex items-center gap-2.5 px-4 py-2.5 bg-primary/8 border-b border-primary/15 shrink-0">
          <span className="material-symbols-outlined text-primary text-base animate-spin">progress_activity</span>
          <div className="flex-1 min-w-0">
            <span className="text-xs font-medium text-primary">
              {regenPhase === 'patching' ? '套用變更中...' : regenPhase === 'rebuilding' ? 'AI 重新設計中...' : 'AI 修改中...'}
            </span>
            <p className="text-[11px] text-on-surface-variant truncate mt-0.5">{regenInstruction}</p>
          </div>
        </div>
      )}

      {/* Mobile horizontal section strip */}
      {blocks.length > 0 && (
        <div className="sm:hidden flex items-center gap-1 px-2 py-1.5 border-b border-outline-variant/10 bg-surface-container/20 overflow-x-auto shrink-0 scrollbar-thin">
          {blocks.map((block, index) => {
            const label = (block.data.heading as string) || (block.data.title as string) || block.type.replace(/_/g, ' ');
            const selected = selectedBlockId === block.id;
            return (
              <button
                key={block.id}
                onClick={() => onSelectBlock(selected ? null : block.id)}
                className={`shrink-0 px-2 py-1 rounded-md text-[10px] whitespace-nowrap transition-colors cursor-pointer ${
                  selected
                    ? 'bg-primary/10 text-primary font-semibold border border-primary/20'
                    : 'text-on-surface-variant/70 hover:bg-surface-container-highest/50'
                }`}
              >
                {label.length > 12 ? label.slice(0, 12) + '…' : label}
              </button>
            );
          })}
        </div>
      )}

      {/* Main content area */}
      <div className="flex-1 flex min-h-0">
        {/* Section list (left) — desktop only */}
        {blocks.length > 0 && (
          <div className="hidden sm:block w-56 lg:w-64 border-r border-outline-variant/10 overflow-y-auto py-1 shrink-0 bg-surface-container/20">
            {blocks.map((block, index) => {
              const level = (block.data.level as number) || 1;
              const blockType = block.type;
              const isSpecial = blockType === 'cover' || blockType === 'title_page' || blockType === 'toc' || blockType === 'table_of_contents';
              const isMainSection = level === 1 || isSpecial;
              const label = (block.data.heading as string) || (block.data.title as string) || blockType.replace(/_/g, ' ');
              const selected = selectedBlockId === block.id;

              // Content badges — show what's inside each block
              const bullets = (block.data.bullets as string[]) || (block.data.items as string[]) || (block.data.points as string[]) || [];
              const paragraphs = (block.data.paragraphs as string[]) || [];
              const subsections = (block.data.subsections as any[]) || [];
              const rows = (block.data.rows as any[]) || [];
              const snippet = (block.data.content as string) || (block.data.text as string) || (block.data.body as string) || '';
              const badges: string[] = [];
              if (paragraphs.length > 0) badges.push(`${paragraphs.length}段`);
              if (bullets.length > 0) badges.push(`${bullets.length}點`);
              if (subsections.length > 0) badges.push(`${subsections.length}子節`);
              if (rows.length > 0) badges.push(`${rows.length}行`);

              // Icons
              const icon = blockType === 'cover' || blockType === 'title_page' ? 'menu_book'
                : blockType === 'toc' || blockType === 'table_of_contents' ? 'toc'
                : blockType === 'list' || blockType === 'bullets' ? 'format_list_bulleted'
                : blockType === 'table' ? 'table_chart'
                : isMainSection ? 'segment' : '';

              // Separator before main sections (except first)
              const showSep = index > 0 && isMainSection;

              // Tree connector: ├ for middle children, └ for last child before next main
              const nextBlock = blocks[index + 1];
              const nextIsMain = !nextBlock || ((nextBlock.data.level as number) || 1) === 1 ||
                ['cover', 'title_page', 'toc', 'table_of_contents'].includes(nextBlock.type);

              return (
                <div key={block.id}>
                  {showSep && <div className="h-px mx-3 my-1 bg-outline-variant/10" />}
                  <div className={isMainSection ? 'px-1' : 'pl-5 pr-1'}>
                    <button
                      onClick={() => onSelectBlock(selected ? null : block.id)}
                      className={`w-full text-left rounded-md transition-colors duration-150 cursor-pointer pr-2 ${
                        index < visibleCount ? 'opacity-100' : 'opacity-0'
                      } ${
                        selected
                          ? 'bg-primary/10 text-primary'
                          : 'hover:bg-surface-container-highest/50 text-on-surface-variant'
                      } ${isMainSection ? 'py-1.5 pl-2.5' : 'py-1 pl-1.5'}`}
                    >
                      <div className="flex items-start gap-1.5">
                        {isMainSection ? (
                          icon ? <span className={`material-symbols-outlined shrink-0 mt-px ${selected ? 'text-primary' : 'text-on-surface-variant/40'}`} style={{ fontSize: '15px' }}>{icon}</span> : null
                        ) : (
                          <span className={`text-[11px] shrink-0 leading-none mt-1 ${selected ? 'text-primary/40' : 'text-on-surface-variant/20'}`}>
                            {nextIsMain ? '\u2514' : '\u251C'}
                          </span>
                        )}
                        <div className="flex-1 min-w-0">
                          <span className={`line-clamp-1 leading-tight block ${
                            isMainSection ? 'text-xs font-semibold' : 'text-[11px]'
                          } ${!isMainSection && !selected ? 'text-on-surface-variant/70' : ''}`}>
                            {label}
                          </span>
                          {/* Content badges */}
                          {badges.length > 0 && (
                            <div className="flex items-center gap-1 mt-0.5">
                              {badges.map((b, bi) => (
                                <span key={bi} className={`text-[9px] px-1 py-px rounded ${selected ? 'bg-primary/10 text-primary/60' : 'bg-surface-container-highest/60 text-on-surface-variant/40'}`}>{b}</span>
                              ))}
                            </div>
                          )}
                          {/* Content snippet for main sections */}
                          {isMainSection && snippet && (
                            <span className={`text-[10px] line-clamp-1 block mt-0.5 ${selected ? 'text-primary/50' : 'text-on-surface-variant/40'}`}>
                              {snippet.slice(0, 60)}
                            </span>
                          )}
                        </div>
                      </div>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Main content — PDF page-by-page view (matches actual DOCX output) */}
        <div className="flex-1 flex flex-col min-w-0 relative">
          {/* Selected section floating indicator */}
          {selectedBlockId && previewBlobUrl && !regenInstruction && (() => {
            const blk = blocks.find(b => b.id === selectedBlockId);
            if (!blk) return null;
            const idx = blocks.findIndex(b => b.id === selectedBlockId);
            const sLabel = (blk.data.heading as string) || (blk.data.title as string) || blk.type.replace(/_/g, ' ');
            return (
              <div className="absolute top-2 left-0 right-0 z-10 flex justify-center pointer-events-none">
                <div className="flex items-center gap-1.5 px-3 py-1.5 bg-inverse-surface/80 text-inverse-on-surface rounded-full text-[11px] shadow-lg backdrop-blur-sm pointer-events-auto">
                  <span className="material-symbols-outlined" style={{ fontSize: '13px' }}>edit_note</span>
                  <span>第{idx + 1}段 · {sLabel}</span>
                  <button
                    onClick={() => { onSelectBlock(null); setSelectedElement(null); onElementSelect?.(null); }}
                    className="ml-0.5 p-0.5 rounded-full hover:bg-white/20 cursor-pointer"
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: '12px' }}>close</span>
                  </button>
                </div>
              </div>
            );
          })()}
          {previewBlobUrl ? (
            <div className="flex-1 overflow-y-auto" style={{ backgroundColor: '#E8E8E8' }}>
              <DocPdfPages
                pdfUrl={previewBlobUrl}
                previewKey={previewKeyRef.current}
                onPageCount={setDocPageCount}
                onPageTexts={setDocPageTexts}
                highlightInfo={docHighlight}
              />
            </div>
          ) : streaming ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-3">
              <span className="material-symbols-outlined text-4xl text-primary animate-spin">progress_activity</span>
              <span className="text-sm text-on-surface-variant">{t('chat.docMode.generating')}</span>
              {agentActivity && agentActivity.length > 0 && (
                <div className="mt-2 flex items-center gap-1.5 flex-wrap justify-center max-w-sm">
                  {agentActivity.slice(-6).map((act, i) => (
                    <span key={act.id || i} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] ${
                      act.status === 'completed'
                        ? 'bg-primary/10 text-primary/60'
                        : 'bg-surface-container text-on-surface-variant/70'
                    }`}>
                      <span className={`material-symbols-outlined ${act.status !== 'completed' ? 'animate-pulse' : ''}`} style={{ fontSize: '10px' }}>
                        {act.status === 'completed' ? 'check' : 'pending'}
                      </span>
                      <span className="truncate max-w-[80px]">{(act.tool || '').split(':').pop()}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          ) : previewLoading ? (
            <div className="flex-1 flex items-center justify-center">
              <span className="material-symbols-outlined animate-spin text-primary text-3xl">progress_activity</span>
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-on-surface-variant/30">
              <span className="material-symbols-outlined text-5xl">description</span>
            </div>
          )}

          {/* Selected block element panel */}
          {selectedBlockId && blocks.length > 0 && (() => {
            const block = blocks.find(b => b.id === selectedBlockId);
            if (!block) return null;
            const sectionIndex = blocks.findIndex(b => b.id === selectedBlockId);
            return (
              <DocElementPanel
                block={block}
                sectionIndex={sectionIndex}
                selectedElement={selectedElement}
                onSelectElement={(key) => {
                  setSelectedElement(key);
                  onElementSelect?.(key);
                }}
                onSaveField={(blockId, key, value) => onUpdateBlock?.(blockId, key, value)}
                onAiEdit={(blockId, ctx) => onRegenerate(blockId, ctx)}
                t={t}
              />
            );
          })()}
        </div>
      </div>
    </div>
    {rebuildModal}
    </>
  );
}
