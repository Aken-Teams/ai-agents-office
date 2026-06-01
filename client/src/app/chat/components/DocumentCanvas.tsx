'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { DocumentBlock, BlockRecord } from '../../editor/hooks/useDocumentBlocks';
import type { DocLayoutType } from '../hooks/useDocumentMode';
import dynamic from 'next/dynamic';
import SlideBlockPreview from '../../editor/renderers/SlideBlockPreview';
import DocBlockPreview from '../../editor/renderers/DocBlockPreview';
import SheetBlockPreview from '../../editor/renderers/SheetBlockPreview';
import SlideElementPanel from './SlideElementPanel';
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
  onRebuild: () => void;
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
  t: (key: any, params?: Record<string, string | number>) => string;
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
  const previewKeyRef = useRef(0);
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
      const res = await fetch(`${SSE_BASE}/api/files/${fileId}/preview?t=${Date.now()}`, {
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

  // Load preview when fileId is available
  useEffect(() => {
    if (fileId) {
      loadPreview();
    }
  }, [fileId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Refresh preview after rebuild or regeneration completes
  const prevRebuilding = useRef(false);
  const prevRegenInstruction = useRef('');
  useEffect(() => {
    // Trigger on transition from rebuilding→done or regen→done
    if (prevRebuilding.current && !rebuilding && fileId) {
      loadPreview();
    }
    if (prevRegenInstruction.current && !regenInstruction && fileId) {
      loadPreview();
    }
    prevRebuilding.current = rebuilding;
    prevRegenInstruction.current = regenInstruction || '';
  }, [rebuilding, regenInstruction]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup blob on unmount
  useEffect(() => {
    return () => { if (previewBlobUrl) URL.revokeObjectURL(previewBlobUrl); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch PPTX shape data for overlay
  useEffect(() => {
    if (!token || !fileId || layoutType !== 'slides') return;
    (async () => {
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
    })();
  }, [token, fileId, layoutType]);

  // Reset shape selection when switching slides
  useEffect(() => {
    setSelectedShapeId(null);
    setSelectedElement(null);
    setHoveredShapeName(null);
  }, [selectedPageIndex]);

  // Sync selectedBlockId → page index
  useEffect(() => {
    if (selectedBlockId && blocks.length > 0) {
      const idx = blocks.findIndex(b => b.id === selectedBlockId);
      if (idx >= 0) setSelectedPageIndex(idx);
    }
  }, [selectedBlockId, blocks]);

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
  if (layoutType === 'slides') {
    return (
      <div className="flex-1 flex flex-col min-w-0 bg-surface">
        {/* Toolbar */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-outline-variant/10 bg-surface-container/30 shrink-0">
          <div className="flex-1 min-w-0">
            {title && <div className="text-sm font-semibold text-on-surface truncate">{title}</div>}
            <div className="text-[10px] text-on-surface-variant uppercase tracking-wider">
              {docType || 'slides'} · {totalPages || blocks.length} {t('editor.blocks')}
            </div>
          </div>
          <button
            onClick={onRebuild}
            disabled={rebuilding || blocks.length === 0}
            className="flex items-center gap-1 px-2.5 py-1.5 bg-primary text-on-primary rounded-lg text-xs font-bold hover:bg-primary-hover transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
          >
            {rebuilding ? (
              <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
            ) : (
              <span className="material-symbols-outlined text-sm">build</span>
            )}
            {t('chat.docMode.rebuild')}
          </button>
          <button
            onClick={onDownload}
            className="p-1.5 rounded-lg hover:bg-surface-container transition-colors cursor-pointer"
            title={t('chat.docMode.download')}
          >
            <span className="material-symbols-outlined text-on-surface-variant text-lg">download</span>
          </button>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-surface-container transition-colors cursor-pointer"
          >
            <span className="material-symbols-outlined text-on-surface-variant text-lg">close</span>
          </button>
        </div>

        {/* Main content area */}
        <div className="flex-1 flex min-h-0">
          {/* Thumbnail strip (left) — real PDF page thumbnails */}
          <div className="w-36 lg:w-44 border-r border-outline-variant/10 overflow-y-auto p-2 shrink-0 bg-surface-container/20">
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
            {previewBlobUrl && (
              <PdfSlideThumbs
                pdfUrl={previewBlobUrl}
                slideCount={blocks.length || undefined}
                selectedIndex={selectedPageIndex}
                onSelect={(index) => {
                  setSelectedPageIndex(index);
                  // Also select corresponding block if available
                  if (blocks[index]) {
                    onSelectBlock(blocks[index].id);
                  }
                }}
              />
            )}
          </div>

          {/* Main preview (right) — rendered PDF page via pdf.js */}
          <div className="flex-1 flex flex-col min-w-0 relative">
            {/* AI regeneration in-progress banner */}
            {regenInstruction && (
              <div className="flex items-center gap-2.5 px-4 py-2.5 bg-primary/8 border-b border-primary/15 shrink-0 z-10">
                <span className="material-symbols-outlined text-primary text-base animate-spin">progress_activity</span>
                <div className="flex-1 min-w-0">
                  <span className="text-xs font-medium text-primary">
                    {regenPhase === 'patching' ? '套用變更中...' : regenPhase === 'rebuilding' ? '重建文件中...' : 'AI 修改中...'}
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
                  setSelectedShapeId(prev => prev === shape.id ? null : shape.id);
                  // Also select the corresponding block
                  if (blocks[selectedPageIndex]) {
                    onSelectBlock(blocks[selectedPageIndex].id);
                  }
                }}
              />
            ) : previewBlobUrl ? (
              <iframe
                key={previewKeyRef.current}
                src={previewBlobUrl}
                className="flex-1 w-full border-0 bg-white"
                title="Document Preview"
                sandbox="allow-scripts allow-same-origin"
                tabIndex={-1}
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
                      <div className="w-full max-w-xs space-y-1">
                        {agentActivity.slice(-4).map((act, i) => (
                          <div key={act.id || i} className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-container/80 text-[11px]">
                            <span className={`material-symbols-outlined text-xs ${act.status === 'completed' ? 'text-primary' : 'text-on-surface-variant/50 animate-pulse'}`}>
                              {act.status === 'completed' ? 'check_circle' : 'pending'}
                            </span>
                            <span className="text-on-surface-variant/70 truncate">{act.tool}</span>
                          </div>
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

            {/* Selected shape/element info bar */}
            {(selectedBlockId || selectedShapeId) && (
              <div className="flex items-center gap-2 px-4 py-2 border-t border-outline-variant/10 bg-surface-container/30 shrink-0">
                <span className="material-symbols-outlined text-primary text-sm">edit_note</span>
                <span className="text-xs text-on-surface-variant flex-1">
                  {selectedShapeId ? (
                    <>
                      第 {selectedPageIndex + 1} 頁 ·{' '}
                      {slideShapes[selectedPageIndex]?.find(s => s.id === selectedShapeId)?.text?.slice(0, 40) ||
                       slideShapes[selectedPageIndex]?.find(s => s.id === selectedShapeId)?.name || '元素'}
                    </>
                  ) : selectedBlockId ? (
                    <>#{(blocks.findIndex(b => b.id === selectedBlockId) + 1)} — {blocks.find(b => b.id === selectedBlockId)?.type.replace(/_/g, ' ')}</>
                  ) : null}
                </span>
                <button
                  onClick={() => { onSelectBlock(null); setSelectedShapeId(null); }}
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
      </div>
    );
  }

  // Doc / Sheet / Webapp layout: vertical block list with optional preview
  return (
    <div className="flex-1 flex flex-col min-w-0 bg-surface">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-outline-variant/10 bg-surface-container/30 shrink-0">
        <div className="flex-1 min-w-0">
          {title && <div className="text-sm font-semibold text-on-surface truncate">{title}</div>}
          <div className="text-[10px] text-on-surface-variant uppercase tracking-wider">
            {docType || layoutType} · {blocks.length} {t('editor.blocks')}
          </div>
        </div>
        <button
          onClick={onRebuild}
          disabled={rebuilding || blocks.length === 0}
          className="flex items-center gap-1 px-2.5 py-1.5 bg-primary text-on-primary rounded-lg text-xs font-bold hover:bg-primary-hover transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
        >
          {rebuilding ? (
            <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
          ) : (
            <span className="material-symbols-outlined text-sm">build</span>
          )}
          {t('chat.docMode.rebuild')}
        </button>
        <button
          onClick={onDownload}
          className="p-1.5 rounded-lg hover:bg-surface-container transition-colors cursor-pointer"
          title={t('chat.docMode.download')}
        >
          <span className="material-symbols-outlined text-on-surface-variant text-lg">download</span>
        </button>
        <button
          onClick={onClose}
          className="p-1.5 rounded-lg hover:bg-surface-container transition-colors cursor-pointer"
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
              {regenPhase === 'patching' ? '套用變更中...' : regenPhase === 'rebuilding' ? '重建文件中...' : 'AI 修改中...'}
            </span>
            <p className="text-[11px] text-on-surface-variant truncate mt-0.5">{regenInstruction}</p>
          </div>
        </div>
      )}

      {/* Main content area */}
      <div className="flex-1 flex min-h-0">
        {/* Section list (left) — only when blocks exist */}
        {blocks.length > 0 && (
          <div className="w-48 lg:w-56 border-r border-outline-variant/10 overflow-y-auto p-1.5 space-y-0.5 shrink-0 bg-surface-container/20">
            {blocks.map((block, index) => (
              <button
                key={block.id}
                onClick={() => onSelectBlock(selectedBlockId === block.id ? null : block.id)}
                className={`w-full text-left transition-all duration-200 cursor-pointer rounded-lg px-2 py-1.5 ${
                  index < visibleCount ? 'opacity-100' : 'opacity-0'
                } ${
                  selectedBlockId === block.id
                    ? 'bg-primary/10 text-primary'
                    : 'hover:bg-surface-container/60 text-on-surface-variant'
                }`}
              >
                <div className="flex items-start gap-1.5">
                  <span className="text-[9px] font-bold bg-surface-container-highest rounded px-1 py-px shrink-0 mt-0.5">
                    {index + 1}
                  </span>
                  <span className="text-[11px] line-clamp-2 leading-tight">
                    {(block.data.title as string) || block.type.replace(/_/g, ' ')}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Main preview (right) */}
        <div className="flex-1 flex flex-col min-w-0">
          {previewLoading ? (
            <div className="flex-1 flex items-center justify-center">
              <span className="material-symbols-outlined animate-spin text-primary text-3xl">progress_activity</span>
            </div>
          ) : previewBlobUrl ? (
            previewType === 'pdf' ? (
              <embed
                key={previewKeyRef.current}
                src={previewBlobUrl}
                type="application/pdf"
                className="flex-1 w-full border-0 bg-white"
                title="Document Preview"
              />
            ) : (
              <iframe
                key={previewKeyRef.current}
                src={previewBlobUrl}
                className="flex-1 w-full border-0 bg-white"
                title="Document Preview"
                sandbox="allow-scripts allow-same-origin"
                tabIndex={-1}
              />
            )
          ) : streaming ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-3">
              <span className="material-symbols-outlined text-4xl text-primary animate-spin">progress_activity</span>
              <span className="text-sm text-on-surface-variant">{t('chat.docMode.generating')}</span>
              {agentActivity && agentActivity.length > 0 && (
                <div className="mt-2 w-full max-w-xs space-y-1.5">
                  {agentActivity.slice(-5).map((act, i) => (
                    <div key={act.id || i} className="flex items-center gap-2 px-2.5 py-1.5 rounded bg-surface-container/50 text-[11px]">
                      <span className={`material-symbols-outlined text-xs ${act.status === 'completed' ? 'text-primary' : 'text-on-surface-variant/60 animate-pulse'}`}>
                        {act.status === 'completed' ? 'check_circle' : 'pending'}
                      </span>
                      <span className="text-on-surface-variant truncate">{act.tool}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-on-surface-variant/30">
              <span className="material-symbols-outlined text-5xl">description</span>
            </div>
          )}

          {/* Selected block action bar */}
          {selectedBlockId && blocks.length > 0 && (
            <div className="flex items-center gap-2 px-4 py-2 border-t border-outline-variant/10 bg-surface-container/30 shrink-0">
              <span className="material-symbols-outlined text-primary text-sm">edit_note</span>
              <span className="text-xs text-on-surface-variant flex-1 truncate">
                #{(blocks.findIndex(b => b.id === selectedBlockId) + 1)} — {blocks.find(b => b.id === selectedBlockId)?.type.replace(/_/g, ' ')}
              </span>
              <button
                onClick={() => onSelectBlock(null)}
                className="p-1 rounded hover:bg-surface-container transition-colors cursor-pointer"
              >
                <span className="material-symbols-outlined text-on-surface-variant text-sm">close</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
