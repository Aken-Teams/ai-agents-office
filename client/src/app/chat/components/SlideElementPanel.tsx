'use client';

import { useState, useRef, useEffect } from 'react';
import type { DocumentBlock } from '../../editor/hooks/useDocumentBlocks';

interface SlideElementPanelProps {
  block: DocumentBlock;
  slideIndex: number;
  selectedElement: string | null;
  onSelectElement: (key: string | null) => void;
  onSaveField: (blockId: string, key: string, value: unknown) => void;
  onAiEdit: (blockId: string, elementContext: string) => void;
  t: (key: any) => string;
}

interface FieldEntry {
  key: string;
  label: string;
  icon: string;
  type: 'text' | 'multiline' | 'list' | 'items';
  value: unknown;
}

function extractFields(data: Record<string, unknown>): FieldEntry[] {
  const fields: FieldEntry[] = [];
  if (data.title != null) fields.push({ key: 'title', label: '標題', icon: 'title', type: 'text', value: data.title });
  if (data.subtitle != null) fields.push({ key: 'subtitle', label: '副標題', icon: 'subtitles', type: 'text', value: data.subtitle });
  if (data.description != null) fields.push({ key: 'description', label: '描述', icon: 'description', type: 'multiline', value: data.description });
  if (data.content != null) fields.push({ key: 'content', label: '內容', icon: 'article', type: 'multiline', value: data.content });
  const bullets = (data.bullets as any[]) || (data.points as any[]);
  if (bullets?.length) fields.push({ key: data.bullets ? 'bullets' : 'points', label: '要點', icon: 'format_list_bulleted', type: 'list', value: bullets });
  const items = (data.items as any[]) || (data.stats as any[]) || (data.kpis as any[]);
  if (items?.length) fields.push({ key: data.items ? 'items' : data.stats ? 'stats' : 'kpis', label: '數據', icon: 'grid_view', type: 'items', value: items });
  if (data.quote != null) fields.push({ key: 'quote', label: '引言', icon: 'format_quote', type: 'multiline', value: data.quote });
  if (data.attribution != null) fields.push({ key: 'attribution', label: '來源', icon: 'person', type: 'text', value: data.attribution });
  return fields;
}

/** Popover editor that floats above the toolbar */
function FieldPopover({
  field,
  blockId,
  slideIndex,
  onSave,
  onAiEdit,
  onClose,
}: {
  field: FieldEntry;
  blockId: string;
  slideIndex: number;
  onSave: (key: string, value: unknown) => void;
  onAiEdit: (context: string) => void;
  onClose: () => void;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  return (
    <div
      ref={popoverRef}
      className="absolute bottom-full left-0 right-0 mb-1 mx-2 bg-surface rounded-xl shadow-2xl border border-outline-variant/15 overflow-hidden z-30 max-h-[50vh] overflow-y-auto"
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-outline-variant/10 bg-surface-container/30">
        <span className="material-symbols-outlined text-primary text-sm">{field.icon}</span>
        <span className="text-xs font-medium text-on-surface flex-1">{field.label}</span>
        <button
          onClick={() => onAiEdit(`[第${slideIndex + 1}頁 · ${field.label}]`)}
          className="flex items-center gap-1 px-2 py-0.5 text-[11px] text-primary bg-primary/8 rounded-full hover:bg-primary/15 cursor-pointer"
        >
          <span className="material-symbols-outlined text-xs">auto_fix_high</span>
          AI 修改
        </button>
        <button onClick={onClose} className="p-0.5 rounded hover:bg-surface-container cursor-pointer">
          <span className="material-symbols-outlined text-sm text-on-surface-variant">close</span>
        </button>
      </div>

      {/* Content editor */}
      <div className="p-3">
        {(field.type === 'text' || field.type === 'multiline') && (
          <TextFieldEditor
            value={String(field.value)}
            multiline={field.type === 'multiline'}
            onSave={(val) => { onSave(field.key, val); onClose(); }}
          />
        )}
        {field.type === 'list' && (
          <ListFieldEditor
            items={field.value as any[]}
            onSave={(val) => { onSave(field.key, val); onClose(); }}
          />
        )}
        {field.type === 'items' && (
          <ItemsFieldEditor items={field.value as any[]} />
        )}
      </div>
    </div>
  );
}

function TextFieldEditor({ value, multiline, onSave }: { value: string; multiline?: boolean; onSave: (v: string) => void }) {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLTextAreaElement | HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);

  const cls = "w-full bg-surface-container-highest border border-outline-variant/20 rounded-lg px-3 py-2 text-sm text-on-surface outline-none focus:ring-1 focus:ring-primary/40";

  return (
    <div className="space-y-2">
      {multiline ? (
        <textarea ref={ref as any} value={text} onChange={e => setText(e.target.value)} rows={3} className={`${cls} resize-none`}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSave(text.trim()); } }} />
      ) : (
        <input ref={ref as any} type="text" value={text} onChange={e => setText(e.target.value)} className={cls}
          onKeyDown={e => { if (e.key === 'Enter') onSave(text.trim()); }} />
      )}
      <div className="flex justify-end">
        <button onClick={() => onSave(text.trim())}
          className="px-3 py-1.5 text-xs bg-primary text-on-primary rounded-lg font-medium cursor-pointer hover:bg-primary-hover">
          儲存
        </button>
      </div>
    </div>
  );
}

function ListFieldEditor({ items, onSave }: { items: any[]; onSave: (v: string[]) => void }) {
  const [list, setList] = useState<string[]>(items.map(b => (typeof b === 'string' ? b : b.text || JSON.stringify(b))));

  const update = (i: number, val: string) => { const n = [...list]; n[i] = val; setList(n); };
  const remove = (i: number) => setList(list.filter((_, idx) => idx !== i));
  const add = () => setList([...list, '']);

  return (
    <div className="space-y-1.5">
      {list.map((item, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <span className="text-[10px] text-on-surface-variant/40 w-4 text-right shrink-0">{i + 1}.</span>
          <input type="text" value={item} onChange={e => update(i, e.target.value)}
            className="flex-1 bg-surface-container-highest border border-outline-variant/20 rounded px-2 py-1.5 text-xs text-on-surface outline-none focus:border-primary/40"
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          />
          <button onClick={() => remove(i)} className="p-0.5 rounded hover:bg-error/10 cursor-pointer">
            <span className="material-symbols-outlined text-xs text-on-surface-variant/30 hover:text-error">close</span>
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2 pt-1">
        <button onClick={add} className="flex items-center gap-0.5 px-2 py-1 text-[11px] text-primary hover:bg-primary/5 rounded cursor-pointer">
          <span className="material-symbols-outlined text-xs">add</span>新增
        </button>
        <div className="flex-1" />
        <button onClick={() => onSave(list.filter(s => s.trim()))}
          className="px-3 py-1.5 text-xs bg-primary text-on-primary rounded-lg font-medium cursor-pointer hover:bg-primary-hover">
          儲存
        </button>
      </div>
    </div>
  );
}

function ItemsFieldEditor({ items }: { items: any[] }) {
  return (
    <div className="space-y-1 text-xs text-on-surface-variant">
      {items.map((item, i) => (
        <div key={i} className="flex items-center gap-2 px-2 py-1 bg-surface-container/40 rounded">
          <span className="text-primary font-medium">{item.value || item.number || '—'}</span>
          <span>{item.label || item.title || ''}</span>
        </div>
      ))}
      <div className="text-[10px] text-on-surface-variant/40 pt-1">數據項目請使用 AI 修改</div>
    </div>
  );
}

/**
 * Compact bottom toolbar showing slide element chips.
 * Click a chip to open a popover editor above.
 */
export default function SlideElementPanel({
  block, slideIndex, selectedElement, onSelectElement, onSaveField, onAiEdit, t,
}: SlideElementPanelProps) {
  const [openField, setOpenField] = useState<string | null>(null);
  const fields = extractFields(block.data);

  if (fields.length === 0) return null;

  const activeField = fields.find(f => f.key === openField);

  return (
    <div className="relative border-t border-outline-variant/10 bg-surface-container/30 shrink-0">
      {/* Popover — floats above the toolbar */}
      {activeField && (
        <FieldPopover
          field={activeField}
          blockId={block.id}
          slideIndex={slideIndex}
          onSave={(key, value) => onSaveField(block.id, key, value)}
          onAiEdit={(ctx) => { onAiEdit(block.id, ctx); setOpenField(null); }}
          onClose={() => setOpenField(null)}
        />
      )}

      {/* Toolbar — single compact row */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 overflow-x-auto scrollbar-thin">
        <span className="text-[10px] text-on-surface-variant/50 shrink-0">第{slideIndex + 1}頁</span>
        <div className="w-px h-4 bg-outline-variant/15 shrink-0" />
        {fields.map((field) => (
          <button
            key={field.key}
            onClick={() => setOpenField(openField === field.key ? null : field.key)}
            className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] whitespace-nowrap transition-all cursor-pointer shrink-0 ${
              openField === field.key
                ? 'bg-primary text-on-primary shadow-sm'
                : selectedElement === field.key
                  ? 'bg-primary/10 text-primary border border-primary/20'
                  : 'text-on-surface-variant hover:bg-surface-container-highest/60'
            }`}
          >
            <span className={`material-symbols-outlined text-xs ${openField === field.key ? '' : 'text-primary/60'}`}>
              {field.icon}
            </span>
            {field.label}
          </button>
        ))}
        <div className="flex-1" />
        <button
          onClick={() => onAiEdit(block.id, `[第${slideIndex + 1}頁]`)}
          className="flex items-center gap-1 px-2 py-1 text-[11px] text-primary hover:bg-primary/8 rounded-md cursor-pointer shrink-0"
        >
          <span className="material-symbols-outlined text-xs">auto_fix_high</span>
          AI
        </button>
      </div>
    </div>
  );
}
