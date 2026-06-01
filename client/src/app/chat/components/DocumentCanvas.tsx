'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { DocumentBlock, BlockRecord } from '../../editor/hooks/useDocumentBlocks';
import type { DocLayoutType } from '../hooks/useDocumentMode';
import dynamic from 'next/dynamic';
import SlideBlockPreview from '../../editor/renderers/SlideBlockPreview';
import DocBlockPreview from '../../editor/renderers/DocBlockPreview';
import SheetBlockPreview from '../../editor/renderers/SheetBlockPreview';
import SlideElementPanel from './SlideElementPanel';
import DocElementPanel from './DocElementPanel';
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
  /** Callback when a sub-element (chart, field, etc.) is selected in the panel */
  onElementSelect?: (elementKey: string | null) => void;
  /** Callback when slide shapes are available for the current page */
  onShapesAvailable?: (shapes: Array<{ name: string; type: string }>) => void;
  t: (key: any, params?: Record<string, string | number>) => string;
}

/**
 * DOCX style presets — mirrors server/src/generators/generate-docx.ts
 * so the interactive preview matches the actual DOCX output.
 */
interface DocStylePreset {
  font: string;
  titleColor: string;
  headingColor: string;
  bodyColor: string;
  accentColor: string;
  titleAlign: 'center' | 'left';
  accentBorder: boolean;
  lineHeight: string;   // CSS line-height
}

const DOC_STYLES: Record<string, DocStylePreset> = {
  formal: {
    font: '"Times New Roman", Times, serif',
    titleColor: '#000000', headingColor: '#1B3A5C', bodyColor: '#333333', accentColor: '#1B3A5C',
    titleAlign: 'center', accentBorder: false, lineHeight: '1.8',
  },
  modern: {
    font: 'Calibri, "Segoe UI", sans-serif',
    titleColor: '#2D2D2D', headingColor: '#2B6CB0', bodyColor: '#444444', accentColor: '#2B6CB0',
    titleAlign: 'left', accentBorder: true, lineHeight: '1.5',
  },
  academic: {
    font: '"Times New Roman", Times, serif',
    titleColor: '#000000', headingColor: '#000000', bodyColor: '#000000', accentColor: '#333333',
    titleAlign: 'center', accentBorder: false, lineHeight: '2.0',
  },
  compact: {
    font: 'Arial, Helvetica, sans-serif',
    titleColor: '#1A1A1A', headingColor: '#333333', bodyColor: '#444444', accentColor: '#666666',
    titleAlign: 'left', accentBorder: false, lineHeight: '1.3',
  },
};

const DEFAULT_DOC_STYLE = DOC_STYLES['modern'];

/** Render a table from headers + rows */
function DocTable({ headers, rows, s }: { headers?: string[]; rows: any[][]; s: DocStylePreset }) {
  return (
    <div className="mt-2 mb-2 overflow-x-auto">
      <table className="w-full text-[12px] border-collapse" style={{ fontFamily: s.font, color: s.bodyColor }}>
        {headers && headers.length > 0 && (
          <thead>
            <tr>
              {headers.map((h, i) => (
                <th key={i} className="text-left px-2.5 py-1.5 font-semibold" style={{
                  backgroundColor: s.accentColor, color: '#FFFFFF',
                  borderBottom: '1px solid #ddd',
                }}>{h}</th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} style={{ backgroundColor: ri % 2 === 0 ? '#FFFFFF' : '#F8F9FA' }}>
              {(Array.isArray(row) ? row : Object.values(row)).map((cell, ci) => (
                <td key={ci} className="px-2.5 py-1.5" style={{ borderBottom: '1px solid #E5E7EB' }}>
                  {typeof cell === 'string' ? cell : JSON.stringify(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Render callout/note/tip boxes */
function DocCallout({ text, label, type }: { text: string; label?: string; type?: string }) {
  const colors: Record<string, { bg: string; border: string; icon: string }> = {
    note: { bg: '#FFF9E6', border: '#F0C000', icon: 'lightbulb' },
    tip: { bg: '#E8F5E9', border: '#4CAF50', icon: 'tips_and_updates' },
    warning: { bg: '#FFF3E0', border: '#FF9800', icon: 'warning' },
    info: { bg: '#E3F2FD', border: '#2196F3', icon: 'info' },
    guide: { bg: '#FFF9E6', border: '#F0C000', icon: 'lightbulb' },
  };
  const c = colors[type || 'note'] || colors.note;
  return (
    <div className="mt-2 mb-2 rounded px-3 py-2 text-[12px]" style={{
      backgroundColor: c.bg, borderLeft: `3px solid ${c.border}`,
    }}>
      {label && (
        <div className="flex items-center gap-1 font-semibold text-[11px] mb-1" style={{ color: c.border }}>
          <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>{c.icon}</span>
          {label}
        </div>
      )}
      <div style={{ color: '#555' }}>{text}</div>
    </div>
  );
}

/** Render key-value metadata pairs as a compact table */
function DocMetaTable({ entries, s }: { entries: Record<string, string> | Array<{ key: string; value: string }>; s: DocStylePreset }) {
  const pairs = Array.isArray(entries)
    ? entries
    : Object.entries(entries).map(([key, value]) => ({ key, value: String(value) }));
  if (pairs.length === 0) return null;
  return (
    <div className="mt-2 mb-2">
      <table className="text-[12px] border-collapse" style={{ fontFamily: s.font }}>
        <tbody>
          {pairs.map((p, i) => (
            <tr key={i}>
              <td className="px-2.5 py-1 font-semibold whitespace-nowrap" style={{
                color: s.headingColor, backgroundColor: '#F0F4F8', borderBottom: '1px solid #E5E7EB',
              }}>{p.key}</td>
              <td className="px-2.5 py-1" style={{
                color: s.bodyColor, borderBottom: '1px solid #E5E7EB', minWidth: '180px',
              }}>{p.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Render a DOCX block matching the actual DOCX generator output */
function DocBlockRenderer({ block, docStyle }: { block: DocumentBlock; docStyle: string }) {
  const s = DOC_STYLES[docStyle] || DEFAULT_DOC_STYLE;
  const data = block.data;
  const heading = (data.heading as string) || (data.title as string) || '';
  const content = (data.content as string) || (data.text as string) || (data.body as string) || '';
  const paragraphs = (data.paragraphs as string[]) || [];
  const bullets = (data.bullets as string[]) || (data.items as string[]) || (data.points as string[]) || [];
  const subsections = (data.subsections as any[]) || [];
  const headers = (data.headers as string[]) || [];
  const rows = (data.rows as any[][]) || [];
  const level = (data.level as number) || 1;
  const type = block.type;

  const bodyStyle: React.CSSProperties = { fontFamily: s.font, color: s.bodyColor, lineHeight: s.lineHeight };

  // Cover / title page — may include metadata table
  if (type === 'cover' || type === 'title' || type === 'title_page') {
    const meta = (data.metadata as any) || (data.meta as any);
    return (
      <div className="py-8" style={{ textAlign: s.titleAlign }}>
        {heading && (
          <div className="text-2xl font-bold" style={{ fontFamily: s.font, color: s.titleColor }}>
            {heading}
          </div>
        )}
        {(data.subtitle as string) && (
          <div className="text-base mt-3" style={{ fontFamily: s.font, color: s.bodyColor }}>
            {data.subtitle as string}
          </div>
        )}
        {(data.author as string) && (
          <div className="text-sm mt-2" style={{ fontFamily: s.font, color: s.bodyColor, opacity: 0.7 }}>
            {data.author as string}
          </div>
        )}
        {meta && typeof meta === 'object' && <DocMetaTable entries={meta} s={s} />}
        {rows.length > 0 && <DocTable headers={headers} rows={rows} s={s} />}
      </div>
    );
  }

  // Section heading styles based on level
  const headingEl = heading ? (() => {
    const base: React.CSSProperties = { fontFamily: s.font, color: s.headingColor, fontWeight: 700 };
    if (level === 1) {
      return (
        <div
          className="mb-2"
          style={{
            ...base,
            fontSize: '16px',
            ...(s.accentBorder ? {
              borderLeft: `3px solid ${s.accentColor}`,
              backgroundColor: '#F0F4F8',
              padding: '6px 10px',
              borderRadius: '2px',
            } : {}),
            marginTop: '16px',
          }}
        >
          {heading}
        </div>
      );
    }
    if (level === 2) {
      return (
        <div className="mb-1.5" style={{ ...base, fontSize: '14px', marginTop: '12px' }}>
          {heading}
        </div>
      );
    }
    return (
      <div className="mb-1" style={{ ...base, fontSize: '13px', marginTop: '8px' }}>
        {heading}
      </div>
    );
  })() : null;

  // Detect callout/note/tip fields
  const callout = (data.callout as string) || (data.note as string) || (data.tip as string) || (data.guide as string) || '';
  const calloutLabel = data.callout ? '備註' : data.note ? '注意' : data.tip ? '提示' : data.guide ? '撰寫指引' : '';
  const calloutType = data.callout ? 'note' : data.note ? 'info' : data.tip ? 'tip' : data.guide ? 'guide' : 'note';

  return (
    <div>
      {headingEl}
      {content && (
        <p className="mb-2 text-[13px]" style={bodyStyle}>{content}</p>
      )}
      {paragraphs.length > 0 && (
        <div className="space-y-2">
          {paragraphs.map((p, i) => (
            <p key={i} className="text-[13px]" style={bodyStyle}>{p}</p>
          ))}
        </div>
      )}
      {bullets.length > 0 && (
        <ul className="mt-1 space-y-0.5 list-disc" style={{ ...bodyStyle, paddingLeft: '24px' }}>
          {bullets.map((b, i) => (
            <li key={i} className="text-[13px]">{typeof b === 'string' ? b : (b as any).text || JSON.stringify(b)}</li>
          ))}
        </ul>
      )}
      {/* Tables */}
      {rows.length > 0 && <DocTable headers={headers} rows={rows} s={s} />}
      {/* Callout / note / tip */}
      {callout && <DocCallout text={callout} label={calloutLabel} type={calloutType} />}
      {/* Subsections — recursively render children */}
      {subsections.length > 0 && (
        <div className="mt-2 space-y-2">
          {subsections.map((sub, i) => (
            <div key={i} className="pl-3" style={{ borderLeft: `2px solid ${s.accentColor}20` }}>
              <div className="text-[13px] font-semibold" style={{ fontFamily: s.font, color: s.headingColor }}>
                {sub.title || sub.heading || `Section ${i + 1}`}
              </div>
              {sub.content && <p className="text-[13px] mt-0.5" style={bodyStyle}>{sub.content}</p>}
              {sub.paragraphs?.length > 0 && sub.paragraphs.map((p: string, j: number) => (
                <p key={j} className="text-[13px] mt-1" style={bodyStyle}>{p}</p>
              ))}
              {sub.bullets?.length > 0 && (
                <ul className="mt-0.5 space-y-0.5 list-disc" style={{ ...bodyStyle, paddingLeft: '20px' }}>
                  {sub.bullets.map((b: string, j: number) => (
                    <li key={j} className="text-[13px]">{b}</li>
                  ))}
                </ul>
              )}
              {sub.rows?.length > 0 && <DocTable headers={sub.headers} rows={sub.rows} s={s} />}
              {(sub.callout || sub.note || sub.guide) && (
                <DocCallout
                  text={sub.callout || sub.note || sub.guide}
                  label={sub.callout ? '備註' : sub.note ? '注意' : '撰寫指引'}
                  type={sub.callout ? 'note' : sub.note ? 'info' : 'guide'}
                />
              )}
            </div>
          ))}
        </div>
      )}
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
            AI 將根據目前的區塊資料重新設計並產生簡報，品質與左側對話相同。此過程約需 1-3 分鐘。
          </p>
        </div>
        <div className="flex gap-2 px-6 pb-6 pt-2">
          <button
            onClick={() => setShowRebuildConfirm(false)}
            className="flex-1 px-4 py-2.5 rounded-lg text-sm font-medium text-on-surface-variant bg-surface-container-high hover:bg-surface-container-highest transition-colors cursor-pointer"
          >
            取消
          </button>
          <button
            onClick={() => { setShowRebuildConfirm(false); onRebuild(); }}
            className="flex-1 px-4 py-2.5 rounded-lg text-sm font-medium text-on-primary bg-primary hover:bg-primary-hover transition-colors cursor-pointer"
          >
            確定重建
          </button>
        </div>
      </div>
    </div>
  );

  if (layoutType === 'slides') {
    return (
      <><div className="flex-1 flex flex-col min-w-0 bg-surface">
        {/* Toolbar */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-outline-variant/10 bg-surface-container/30 shrink-0">
          <div className="flex-1 min-w-0">
            {title && <div className="text-sm font-semibold text-on-surface truncate">{title}</div>}
            <div className="text-[10px] text-on-surface-variant uppercase tracking-wider">
              {docType || 'slides'} · {totalPages || blocks.length} {t('editor.blocks')}
            </div>
          </div>
          <button
            onClick={() => setShowRebuildConfirm(true)}
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

            {/* Selected shape/element info bar */}
            {(selectedBlockId || selectedShapeId) && (
              <div className="flex items-center gap-2 px-4 py-2 border-t border-outline-variant/10 bg-surface-container/30 shrink-0">
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

  // Doc / Sheet / Webapp layout: vertical block list with optional preview
  return (
    <>
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
          onClick={() => setShowRebuildConfirm(true)}
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
              {regenPhase === 'patching' ? '套用變更中...' : regenPhase === 'rebuilding' ? 'AI 重新設計中...' : 'AI 修改中...'}
            </span>
            <p className="text-[11px] text-on-surface-variant truncate mt-0.5">{regenInstruction}</p>
          </div>
        </div>
      )}

      {/* Main content area */}
      <div className="flex-1 flex min-h-0">
        {/* Section list (left) — only when blocks exist */}
        {blocks.length > 0 && (
          <div className="w-52 lg:w-60 border-r border-outline-variant/10 overflow-y-auto p-1.5 space-y-px shrink-0 bg-surface-container/20">
            {blocks.map((block, index) => {
              const level = (block.data.level as number) || 1;
              const isMainSection = level === 1 || block.type === 'cover' || block.type === 'title_page' || block.type === 'toc';
              const indent = isMainSection ? 0 : level >= 3 ? 2 : 1;
              const label = (block.data.heading as string) || (block.data.title as string) || block.type.replace(/_/g, ' ');
              const icon = block.type === 'cover' || block.type === 'title_page' ? 'menu_book'
                : block.type === 'toc' || block.type === 'table_of_contents' ? 'toc'
                : block.type === 'list' || block.type === 'bullets' ? 'format_list_bulleted'
                : isMainSection ? 'segment' : '';
              return (
                <button
                  key={block.id}
                  onClick={() => onSelectBlock(selectedBlockId === block.id ? null : block.id)}
                  className={`w-full text-left transition-all duration-200 cursor-pointer rounded-lg py-1.5 ${
                    index < visibleCount ? 'opacity-100' : 'opacity-0'
                  } ${
                    selectedBlockId === block.id
                      ? 'bg-primary/10 text-primary'
                      : 'hover:bg-surface-container/60 text-on-surface-variant'
                  }`}
                  style={{ paddingLeft: `${8 + indent * 12}px`, paddingRight: '8px' }}
                >
                  <div className="flex items-center gap-1.5">
                    {icon ? (
                      <span className={`material-symbols-outlined shrink-0 ${selectedBlockId === block.id ? 'text-primary' : 'text-on-surface-variant/40'}`} style={{ fontSize: '14px' }}>{icon}</span>
                    ) : (
                      <span className="text-[9px] font-bold bg-surface-container-highest rounded px-1 py-px shrink-0">
                        {index + 1}
                      </span>
                    )}
                    <span className={`line-clamp-1 leading-tight ${isMainSection ? 'text-[12px] font-semibold' : 'text-[11px]'}`}>
                      {label}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {/* Main content — interactive document view */}
        <div className="flex-1 flex flex-col min-w-0">
          {blocks.length > 0 ? (
            <div className="flex-1 overflow-y-auto" style={{ backgroundColor: '#E8E8E8' }}>
              {/* Paper-like container */}
              <div className="max-w-[740px] mx-auto my-6 bg-white shadow-md rounded-sm" style={{ minHeight: 'calc(100% - 48px)' }}>
                <div className="px-12 py-10 md:px-16">
                  {/* Blocks as clickable sections */}
                  {blocks.map((block, index) => {
                    const isSelected = selectedBlockId === block.id;
                    const isRegenerating = block.status === 'regenerating';
                    return (
                      <div
                        key={block.id}
                        onClick={() => onSelectBlock(isSelected ? null : block.id)}
                        className={`relative group cursor-pointer rounded transition-all duration-150 px-3 py-1 -mx-3 ${
                          index < visibleCount ? 'opacity-100' : 'opacity-0'
                        } ${
                          isSelected
                            ? 'ring-1 ring-primary/30 bg-primary/3'
                            : 'hover:bg-black/[0.02]'
                        } ${isRegenerating ? 'animate-pulse' : ''}`}
                      >
                        {/* Selection indicator */}
                        {isSelected && (
                          <div className="absolute left-0 top-1 bottom-1 w-[3px] bg-primary rounded-full" />
                        )}

                        <DocBlockRenderer block={block} docStyle={String(meta.style || 'modern')} />

                        {/* Hover hint */}
                        {!isSelected && (
                          <div className="absolute right-1 top-1 opacity-0 group-hover:opacity-60 transition-opacity">
                            <span className="material-symbols-outlined text-gray-400" style={{ fontSize: '14px' }}>edit_note</span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
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
