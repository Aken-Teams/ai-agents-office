'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { DocumentBlock, BlockRecord } from '../../editor/hooks/useDocumentBlocks';
import type { DocLayoutType } from '../hooks/useDocumentMode';
import SlideBlockPreview from '../../editor/renderers/SlideBlockPreview';
import DocBlockPreview from '../../editor/renderers/DocBlockPreview';
import SheetBlockPreview from '../../editor/renderers/SheetBlockPreview';

const SSE_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

interface DocumentCanvasProps {
  layoutType: DocLayoutType;
  fileId: string | null;
  blocks: DocumentBlock[];
  record: BlockRecord | null;
  selectedBlockId: string | null;
  onSelectBlock: (id: string | null) => void;
  onClose: () => void;
  onRebuild: () => void;
  onRegenerate: (blockId: string) => void;
  onDownload: () => void;
  streaming: boolean;
  rebuilding: boolean;
  token: string | null;
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
  onDownload,
  streaming,
  rebuilding,
  token,
  t,
}: DocumentCanvasProps) {
  const [previewBlobUrl, setPreviewBlobUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewKeyRef = useRef(0);
  const visibleCount = useStaggerReveal(blocks.length);

  const docType = record?.docType || '';
  const meta = record?.meta || {};
  const title = (meta.title as string) || (meta.name as string) || '';

  // Load live preview for HTML/PDF files
  const loadPreview = useCallback(async () => {
    if (!token || !fileId) return;
    setPreviewLoading(true);
    try {
      const res = await fetch(`${SSE_BASE}/api/files/${fileId}/download`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('preview failed');
      const blob = await res.blob();
      const ct = res.headers.get('Content-Type') || '';
      const type = ct.includes('pdf') ? 'application/pdf' : ct.includes('html') ? 'text/html' : ct;
      if (previewBlobUrl) URL.revokeObjectURL(previewBlobUrl);
      setPreviewBlobUrl(URL.createObjectURL(new Blob([blob], { type })));
    } catch {
      setPreviewBlobUrl(null);
    } finally {
      setPreviewLoading(false);
    }
  }, [token, fileId, previewBlobUrl]);

  // Load preview when fileId changes or blocks arrive
  useEffect(() => {
    if (fileId && blocks.length > 0 && (layoutType === 'slides' || layoutType === 'webapp')) {
      loadPreview();
    }
  }, [fileId, blocks.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Refresh preview after rebuild
  useEffect(() => {
    if (!rebuilding && fileId && previewBlobUrl) {
      previewKeyRef.current++;
      loadPreview();
    }
  }, [rebuilding]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup blob on unmount
  useEffect(() => {
    return () => { if (previewBlobUrl) URL.revokeObjectURL(previewBlobUrl); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const renderBlockPreview = (block: DocumentBlock) => {
    if (layoutType === 'slides') {
      return <SlideBlockPreview data={block.data} type={block.type} />;
    }
    if (layoutType === 'sheet') {
      return <SheetBlockPreview data={block.data} type={block.type} />;
    }
    return <DocBlockPreview data={block.data} type={block.type} />;
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
              {docType || 'slides'} · {blocks.length} {t('editor.blocks')}
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
          {/* Thumbnail strip (left) */}
          <div className="w-32 lg:w-40 border-r border-outline-variant/10 overflow-y-auto p-2 space-y-2 shrink-0 bg-surface-container/20">
            {streaming && blocks.length === 0 && (
              <div className="space-y-2">
                {[1, 2, 3].map(i => (
                  <div key={i} className="aspect-[16/9] rounded-lg bg-surface-container animate-pulse" />
                ))}
              </div>
            )}
            {blocks.map((block, index) => (
              <button
                key={block.id}
                onClick={() => onSelectBlock(selectedBlockId === block.id ? null : block.id)}
                className={`w-full text-left transition-all duration-300 cursor-pointer rounded-lg overflow-hidden border-2 ${
                  index < visibleCount ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-3'
                } ${
                  selectedBlockId === block.id
                    ? 'border-primary shadow-md'
                    : 'border-transparent hover:border-outline-variant/30'
                }`}
              >
                <div className="relative">
                  <div className="scale-[0.85] origin-top-left w-[118%]">
                    {renderBlockPreview(block)}
                  </div>
                  <div className="absolute top-1 left-1 px-1.5 py-0.5 bg-black/60 text-white text-[9px] font-bold rounded">
                    {index + 1}
                  </div>
                </div>
              </button>
            ))}
          </div>

          {/* Main preview (right) */}
          <div className="flex-1 flex flex-col min-w-0">
            {previewLoading ? (
              <div className="flex-1 flex items-center justify-center">
                <span className="material-symbols-outlined animate-spin text-primary text-3xl">progress_activity</span>
              </div>
            ) : previewBlobUrl ? (
              <iframe
                key={previewKeyRef.current}
                src={previewBlobUrl}
                className="flex-1 w-full border-0 bg-white"
                title="Document Preview"
                sandbox="allow-scripts allow-same-origin"
                tabIndex={-1}
              />
            ) : selectedBlockId ? (
              <div className="flex-1 flex items-center justify-center p-6">
                <div className="w-full max-w-lg">
                  {renderBlockPreview(blocks.find(b => b.id === selectedBlockId)!)}
                </div>
              </div>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-on-surface-variant/30 gap-2">
                <span className="material-symbols-outlined text-5xl">slideshow</span>
                <span className="text-sm">{streaming ? t('chat.docMode.generating') : ''}</span>
              </div>
            )}

            {/* Selected block action bar */}
            {selectedBlockId && (
              <div className="flex items-center gap-2 px-4 py-2 border-t border-outline-variant/10 bg-surface-container/30 shrink-0">
                <span className="material-symbols-outlined text-primary text-sm">edit_note</span>
                <span className="text-xs text-on-surface-variant flex-1">
                  #{(blocks.findIndex(b => b.id === selectedBlockId) + 1)} — {blocks.find(b => b.id === selectedBlockId)?.type.replace(/_/g, ' ')}
                </span>
                <button
                  onClick={() => onRegenerate(selectedBlockId)}
                  className="flex items-center gap-1 px-2.5 py-1 bg-surface-container-highest border border-outline-variant/10 rounded-lg text-xs text-on-surface hover:bg-surface-variant transition-colors cursor-pointer"
                >
                  <span className="material-symbols-outlined text-primary text-sm">auto_fix_high</span>
                  AI
                </button>
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

      {/* Block list */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {streaming && blocks.length === 0 && (
          <div className="space-y-3">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="h-16 rounded-lg bg-surface-container animate-pulse" />
            ))}
            <div className="text-center text-xs text-on-surface-variant/50 py-2">
              {t('chat.docMode.generating')}
            </div>
          </div>
        )}

        {blocks.map((block, index) => (
          <button
            key={block.id}
            onClick={() => onSelectBlock(selectedBlockId === block.id ? null : block.id)}
            className={`w-full text-left transition-all duration-300 cursor-pointer rounded-xl overflow-hidden border-2 ${
              index < visibleCount ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-3'
            } ${
              selectedBlockId === block.id
                ? 'border-primary shadow-md ring-2 ring-primary/20'
                : 'border-transparent hover:border-outline-variant/20'
            }`}
          >
            {renderBlockPreview(block)}
          </button>
        ))}

        {/* Selected block action bar */}
        {selectedBlockId && blocks.length > 0 && (
          <div className="sticky bottom-0 flex items-center gap-2 px-4 py-2.5 bg-surface/90 backdrop-blur-sm border border-outline-variant/10 rounded-xl shadow-lg">
            <span className="material-symbols-outlined text-primary text-sm">edit_note</span>
            <span className="text-xs text-on-surface-variant flex-1 truncate">
              #{(blocks.findIndex(b => b.id === selectedBlockId) + 1)} — {blocks.find(b => b.id === selectedBlockId)?.type.replace(/_/g, ' ')}
            </span>
            <button
              onClick={() => onRegenerate(selectedBlockId)}
              className="flex items-center gap-1 px-2.5 py-1 bg-primary/10 border border-primary/20 rounded-lg text-xs text-primary font-medium hover:bg-primary/20 transition-colors cursor-pointer"
            >
              <span className="material-symbols-outlined text-sm">auto_fix_high</span>
              AI
            </button>
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
  );
}
