'use client';

import type { DocumentBlock } from '../../editor/hooks/useDocumentBlocks';

interface SlideElement {
  key: string;
  label: string;
  icon: string;
  preview: string;
}

interface SlideElementPanelProps {
  block: DocumentBlock;
  slideIndex: number;
  selectedElement: string | null;
  onSelectElement: (key: string | null) => void;
  t: (key: any) => string;
}

/** Extract meaningful sub-elements from a slide block's data */
function extractElements(data: Record<string, unknown>): SlideElement[] {
  const elements: SlideElement[] = [];

  if (data.title) {
    elements.push({ key: 'title', label: '標題', icon: 'title', preview: String(data.title).slice(0, 40) });
  }
  if (data.subtitle) {
    elements.push({ key: 'subtitle', label: '副標題', icon: 'subtitles', preview: String(data.subtitle).slice(0, 40) });
  }
  if (data.description) {
    elements.push({ key: 'description', label: '描述', icon: 'description', preview: String(data.description).slice(0, 40) });
  }
  if (data.content) {
    elements.push({ key: 'content', label: '內容', icon: 'article', preview: String(data.content).slice(0, 40) });
  }

  const bullets = (data.bullets as any[]) || (data.points as any[]);
  if (bullets?.length) {
    elements.push({ key: 'bullets', label: '要點', icon: 'format_list_bulleted', preview: `${bullets.length} 項` });
  }

  const items = (data.items as any[]) || (data.stats as any[]) || (data.kpis as any[]);
  if (items?.length) {
    elements.push({ key: 'items', label: '數據項', icon: 'grid_view', preview: `${items.length} 項` });
  }

  if (data.chart) {
    const chartType = (data.chart as any)?.type || 'chart';
    elements.push({ key: 'chart', label: '圖表', icon: 'bar_chart', preview: chartType });
  }

  const headers = (data.headers as any[]) || (data.columns as any[]);
  const rows = (data.rows as any[]);
  if (headers?.length || rows?.length) {
    elements.push({ key: 'table', label: '表格', icon: 'table_chart', preview: `${headers?.length || 0} 欄 × ${rows?.length || 0} 列` });
  }

  if (data.quote) {
    elements.push({ key: 'quote', label: '引言', icon: 'format_quote', preview: String(data.quote).slice(0, 40) });
  }

  const steps = (data.steps as any[]);
  if (steps?.length) {
    elements.push({ key: 'steps', label: '流程', icon: 'route', preview: `${steps.length} 步驟` });
  }

  const highlights = (data.highlights as any[]);
  if (highlights?.length) {
    elements.push({ key: 'highlights', label: '重點', icon: 'star', preview: `${highlights.length} 項` });
  }

  return elements;
}

/**
 * Bottom panel showing clickable sub-elements of the selected slide.
 * Clicking an element sets it as the edit target for AI modification.
 */
export default function SlideElementPanel({ block, slideIndex, selectedElement, onSelectElement, t }: SlideElementPanelProps) {
  const elements = extractElements(block.data);

  if (elements.length === 0) return null;

  return (
    <div className="border-t border-outline-variant/10 bg-surface-container/30 shrink-0">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 pt-2 pb-1">
        <span className="material-symbols-outlined text-primary text-sm">layers</span>
        <span className="text-[11px] font-medium text-on-surface-variant">
          第 {slideIndex + 1} 頁元素
        </span>
        {selectedElement && (
          <button
            onClick={() => onSelectElement(null)}
            className="ml-auto text-[10px] text-primary hover:underline cursor-pointer"
          >
            取消選取
          </button>
        )}
      </div>

      {/* Element chips — horizontal scrollable */}
      <div className="flex gap-1.5 px-4 pb-2 overflow-x-auto scrollbar-thin">
        {elements.map((el) => (
          <button
            key={el.key}
            onClick={() => onSelectElement(selectedElement === el.key ? null : el.key)}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs whitespace-nowrap transition-all cursor-pointer shrink-0 ${
              selectedElement === el.key
                ? 'bg-primary text-on-primary shadow-sm'
                : 'bg-surface-container-highest/60 text-on-surface-variant hover:bg-surface-container-highest'
            }`}
          >
            <span className={`material-symbols-outlined text-sm ${selectedElement === el.key ? '' : 'text-primary/70'}`}>
              {el.icon}
            </span>
            <span className="font-medium">{el.label}</span>
            <span className={`text-[10px] ${selectedElement === el.key ? 'text-on-primary/70' : 'text-on-surface-variant/50'}`}>
              {el.preview}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
