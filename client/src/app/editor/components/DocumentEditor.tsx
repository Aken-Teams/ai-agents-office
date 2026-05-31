'use client';

import { useState, useCallback } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
  arrayMove,
} from '@dnd-kit/sortable';
import type { DocumentBlock, BlockRecord } from '../hooks/useDocumentBlocks';
import BlockCard from './BlockCard';

interface DocumentEditorProps {
  record: BlockRecord | null;
  blocks: DocumentBlock[];
  loading: boolean;
  error: string | null;
  selectedBlockId: string | null;
  onSelectBlock: (blockId: string | null) => void;
  onReorder: (blocks: DocumentBlock[]) => void;
  onDeleteBlock: (blockId: string) => void;
  onRegenerateBlock: (blockId: string) => void;
  onRebuild: () => void;
  onAddBlock?: () => void;
  rebuilding: boolean;
  t: (key: any, params?: Record<string, string | number>) => string;
}

export default function DocumentEditor({
  record,
  blocks,
  loading,
  error,
  selectedBlockId,
  onSelectBlock,
  onReorder,
  onDeleteBlock,
  onRegenerateBlock,
  onRebuild,
  onAddBlock,
  rebuilding,
  t,
}: DocumentEditorProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = blocks.findIndex(b => b.id === active.id);
    const newIndex = blocks.findIndex(b => b.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;

    const reordered = arrayMove(blocks, oldIndex, newIndex).map((b, i) => ({ ...b, order: i }));
    onReorder(reordered);
  }, [blocks, onReorder]);

  const docType = record?.docType || '';
  const meta = record?.meta || {};
  const title = (meta.title as string) || (meta.name as string) || '';

  const docTypeLabel: Record<string, string> = {
    pptx: 'PowerPoint', docx: 'Word', xlsx: 'Excel', pdf: 'PDF', slides: 'Slides', webapp: 'Web App',
  };

  // Empty state
  if (!loading && !record) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center">
        <span className="material-symbols-outlined text-5xl text-on-surface-variant/20">draft</span>
        <p className="text-sm text-on-surface-variant/50">{t('editor.noBlocks')}</p>
        <p className="text-xs text-outline">{t('editor.noBlocksHint')}</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-outline-variant/10 bg-surface-container/30 shrink-0">
        <div className="flex-1 min-w-0">
          {title && <div className="text-sm font-semibold text-on-surface truncate">{title}</div>}
          <div className="flex items-center gap-2 text-xs text-on-surface-variant">
            {docType && (
              <span className="px-1.5 py-0.5 bg-primary/10 text-primary rounded text-[10px] font-medium uppercase">
                {docTypeLabel[docType] || docType}
              </span>
            )}
            <span>{blocks.length} {t('editor.blocks')}</span>
            {record && <span>v{record.version}</span>}
          </div>
        </div>

        <button
          onClick={onRebuild}
          disabled={rebuilding || blocks.length === 0}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-on-primary rounded-lg text-xs font-bold hover:bg-primary-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        >
          {rebuilding ? (
            <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
          ) : (
            <span className="material-symbols-outlined text-sm">build</span>
          )}
          {t('editor.rebuild')}
        </button>
      </div>

      {/* Error banner */}
      {error && (
        <div className="mx-4 mt-2 px-3 py-2 bg-error/10 border border-error/20 rounded-lg text-xs text-error">
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex-1 flex items-center justify-center">
          <span className="material-symbols-outlined animate-spin text-primary text-3xl">progress_activity</span>
        </div>
      )}

      {/* Block list */}
      {!loading && blocks.length > 0 && (
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={blocks.map(b => b.id)} strategy={verticalListSortingStrategy}>
              {blocks.map((block, index) => (
                <BlockCard
                  key={block.id}
                  block={block}
                  docType={docType}
                  index={index}
                  selected={selectedBlockId === block.id}
                  onSelect={() => onSelectBlock(selectedBlockId === block.id ? null : block.id)}
                  onDelete={() => onDeleteBlock(block.id)}
                  onRegenerate={() => onRegenerateBlock(block.id)}
                />
              ))}
            </SortableContext>
          </DndContext>

          {/* Add block button */}
          {onAddBlock && (
            <button
              onClick={onAddBlock}
              className="w-full flex items-center justify-center gap-2 py-3 border-2 border-dashed border-outline-variant/20 hover:border-primary/30 rounded-xl text-sm text-on-surface-variant hover:text-primary transition-all cursor-pointer"
            >
              <span className="material-symbols-outlined text-lg">add</span>
              {t('editor.addBlock.button')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
