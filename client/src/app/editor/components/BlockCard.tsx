'use client';

import { forwardRef } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { DocumentBlock } from '../hooks/useDocumentBlocks';
import SlideBlockPreview from '../renderers/SlideBlockPreview';
import DocBlockPreview from '../renderers/DocBlockPreview';
import SheetBlockPreview from '../renderers/SheetBlockPreview';

interface BlockCardProps {
  block: DocumentBlock;
  docType: string;
  index: number;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onRegenerate: () => void;
}

function BlockPreview({ block, docType }: { block: DocumentBlock; docType: string }) {
  if (['pptx', 'slides'].includes(docType)) {
    return <SlideBlockPreview data={block.data} type={block.type} />;
  }
  if (['docx', 'pdf'].includes(docType)) {
    return <DocBlockPreview data={block.data} type={block.type} />;
  }
  if (docType === 'xlsx') {
    return <SheetBlockPreview data={block.data} type={block.type} />;
  }
  // Fallback: generic
  return <DocBlockPreview data={block.data} type={block.type} />;
}

/** Block type label icons */
function blockTypeIcon(type: string): string {
  const map: Record<string, string> = {
    title: 'title', title_slide: 'title', title_page: 'title', cover: 'title',
    content: 'article', text: 'article', paragraph: 'article', body: 'article',
    bullets: 'format_list_bulleted', list: 'format_list_bulleted',
    stats: 'analytics', kpi: 'analytics', metrics: 'analytics',
    chart: 'bar_chart', graph: 'bar_chart', visualization: 'bar_chart',
    image: 'image', photo: 'image', media: 'image',
    table: 'table_chart', comparison: 'table_chart', sheet: 'table_chart',
    timeline: 'timeline', roadmap: 'timeline', process: 'timeline',
    section: 'segment', heading: 'segment', header: 'segment',
    toc: 'toc', table_of_contents: 'toc',
  };
  return map[type] || 'widgets';
}

export default function BlockCard({ block, docType, index, selected, onSelect, onDelete, onRegenerate }: BlockCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: block.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group relative rounded-xl border transition-all duration-200 ${
        isDragging
          ? 'opacity-50 shadow-2xl z-50 border-primary/40'
          : selected
            ? 'border-primary shadow-lg ring-1 ring-primary/20'
            : 'border-outline-variant/10 hover:border-outline-variant/30 hover:shadow-md'
      } bg-surface-container-low`}
    >
      {/* Top bar: drag handle + type label + actions */}
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-outline-variant/5">
        {/* Drag handle */}
        <button
          {...attributes}
          {...listeners}
          className="cursor-grab active:cursor-grabbing p-0.5 rounded hover:bg-surface-container transition-colors touch-none"
          tabIndex={-1}
        >
          <span className="material-symbols-outlined text-on-surface-variant/50 text-base">drag_indicator</span>
        </button>

        {/* Block type label */}
        <div className="flex items-center gap-1 flex-1 min-w-0" onClick={onSelect} role="button" tabIndex={0}>
          <span className="material-symbols-outlined text-sm text-on-surface-variant/70">{blockTypeIcon(block.type)}</span>
          <span className="text-[11px] font-medium text-on-surface-variant/70 uppercase tracking-wider truncate">
            {block.type.replace(/_/g, ' ')}
          </span>
          <span className="text-[10px] text-outline ml-auto shrink-0">#{index + 1}</span>
        </div>

        {/* Action buttons — visible on hover or selected */}
        <div className={`flex items-center gap-0.5 ${selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} transition-opacity`}>
          <button
            onClick={onRegenerate}
            className="p-1 rounded hover:bg-primary/10 transition-colors cursor-pointer"
            title="AI Regenerate"
          >
            <span className="material-symbols-outlined text-sm text-primary">auto_fix_high</span>
          </button>
          <button
            onClick={onDelete}
            className="p-1 rounded hover:bg-error/10 transition-colors cursor-pointer"
            title="Delete"
          >
            <span className="material-symbols-outlined text-sm text-error/70">delete</span>
          </button>
        </div>
      </div>

      {/* Preview area — clickable to select */}
      <div onClick={onSelect} className="cursor-pointer p-2">
        {block.status === 'regenerating' ? (
          <div className="flex items-center justify-center py-6 gap-2">
            <span className="material-symbols-outlined animate-spin text-primary text-xl">progress_activity</span>
            <span className="text-xs text-on-surface-variant">AI regenerating...</span>
          </div>
        ) : (
          <BlockPreview block={block} docType={docType} />
        )}
      </div>
    </div>
  );
}
