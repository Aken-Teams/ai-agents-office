'use client';

import { useState } from 'react';

export interface ShapeRect {
  id: string;
  name: string;
  type: 'text' | 'picture' | 'chart' | 'table' | 'group' | 'shape';
  /** All percentages (0–100) relative to slide dimensions */
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
}

interface SlideShapeOverlayProps {
  shapes: ShapeRect[];
  selectedId: string | null;
  onHover: (id: string | null) => void;
  onSelect: (shape: ShapeRect) => void;
}

const TYPE_ICON: Record<string, string> = {
  text: 'text_fields',
  picture: 'image',
  chart: 'bar_chart',
  table: 'table_chart',
  group: 'group_work',
  shape: 'category',
};

/**
 * Transparent overlay that sits on top of the rendered PDF slide canvas.
 * Shows hover highlights on PPTX shapes and allows clicking to select them.
 */
export default function SlideShapeOverlay({ shapes, selectedId, onHover, onSelect }: SlideShapeOverlayProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  return (
    <div className="absolute inset-0 pointer-events-none">
      {shapes.map((shape, i) => {
        const isHovered = hoveredId === shape.id;
        const isSelected = selectedId === shape.id;

        return (
          <div
            key={`${shape.id}-${i}`}
            className="absolute pointer-events-auto cursor-pointer transition-all duration-150"
            style={{
              left: `${shape.x}%`,
              top: `${shape.y}%`,
              width: `${shape.width}%`,
              height: `${shape.height}%`,
            }}
            onMouseEnter={() => { setHoveredId(shape.id); onHover(shape.id); }}
            onMouseLeave={() => { setHoveredId(null); onHover(null); }}
            onClick={(e) => { e.stopPropagation(); onSelect(shape); }}
          >
            {/* Hover/select border overlay */}
            <div
              className={`absolute inset-0 rounded-sm transition-all duration-150 ${
                isSelected
                  ? 'border-2 border-primary bg-primary/10 shadow-lg shadow-primary/20'
                  : isHovered
                    ? 'border-2 border-primary/60 bg-primary/5'
                    : 'border border-transparent'
              }`}
            />

            {/* Shape label tooltip — shows on hover */}
            {(isHovered || isSelected) && (
              <div className="absolute -top-6 left-0 z-20 flex items-center gap-1 px-1.5 py-0.5 bg-inverse-surface text-inverse-on-surface text-[10px] rounded whitespace-nowrap shadow-lg">
                <span className="material-symbols-outlined text-[11px]">
                  {TYPE_ICON[shape.type] || 'category'}
                </span>
                <span>{shape.text?.slice(0, 30) || shape.name || shape.type}</span>
              </div>
            )}

            {/* Selection indicator dot */}
            {isSelected && (
              <div className="absolute -top-1 -right-1 w-3 h-3 bg-primary rounded-full border-2 border-white shadow-sm z-10" />
            )}
          </div>
        );
      })}
    </div>
  );
}
