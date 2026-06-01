'use client';

import { useState, useRef, useEffect } from 'react';
import type { DocumentBlock } from '../../editor/hooks/useDocumentBlocks';

interface DocElementPanelProps {
  block: DocumentBlock;
  sectionIndex: number;
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
  type: 'text' | 'multiline' | 'list' | 'readonly';
  value: unknown;
}

function extractFields(data: Record<string, unknown>): FieldEntry[] {
  const fields: FieldEntry[] = [];

  // Heading / title
  if (data.heading != null) fields.push({ key: 'heading', label: '標題', icon: 'title', type: 'text', value: data.heading });
  else if (data.title != null) fields.push({ key: 'title', label: '標題', icon: 'title', type: 'text', value: data.title });

  // Subtitle
  if (data.subtitle != null) fields.push({ key: 'subtitle', label: '副標題', icon: 'subtitles', type: 'text', value: data.subtitle });

  // Content / body / text
  if (data.content != null) fields.push({ key: 'content', label: '內容', icon: 'article', type: 'multiline', value: data.content });
  else if (data.text != null) fields.push({ key: 'text', label: '內容', icon: 'article', type: 'multiline', value: data.text });
  else if (data.body != null) fields.push({ key: 'body', label: '內容', icon: 'article', type: 'multiline', value: data.body });

  // Paragraphs (string array)
  if (Array.isArray(data.paragraphs) && data.paragraphs.length > 0) {
    fields.push({ key: 'paragraphs', label: `段落 (${data.paragraphs.length})`, icon: 'format_align_left', type: 'list', value: data.paragraphs });
  }

  // Bullets / items / points
  const bullets = (data.bullets as any[]) || (data.items as any[]) || (data.points as any[]);
  if (bullets?.length) {
    const key = data.bullets ? 'bullets' : data.items ? 'items' : 'points';
    fields.push({ key, label: `要點 (${bullets.length})`, icon: 'format_list_bulleted', type: 'list', value: bullets });
  }

  // Description
  if (data.description != null) fields.push({ key: 'description', label: '描述', icon: 'description', type: 'multiline', value: data.description });

  // Subsections (readonly)
  if (Array.isArray(data.subsections) && data.subsections.length > 0) {
    fields.push({ key: 'subsections', label: `子段落 (${data.subsections.length})`, icon: 'segment', type: 'readonly', value: data.subsections });
  }

  // Table (readonly)
  if (Array.isArray(data.rows) && data.rows.length > 0) {
    fields.push({ key: 'rows', label: `表格 (${data.rows.length}行)`, icon: 'table_chart', type: 'readonly', value: data.rows });
  }

  return fields;
}

/** Readonly element summary */
function ReadonlySummary({ field }: { field: FieldEntry }) {
  const val = field.value;
  if (field.key === 'subsections' && Array.isArray(val)) {
    return (
      <div className="space-y-1">
        {val.slice(0, 4).map((s: any, i: number) => (
          <div key={i} className="flex items-center gap-2 px-2 py-1 bg-surface-container/40 rounded text-xs">
            <span className="text-primary font-medium shrink-0">{i + 1}.</span>
            <span className="truncate">{s.title || s.heading || ''}</span>
          </div>
        ))}
        {val.length > 4 && <span className="text-[10px] text-on-surface-variant/40">+{val.length - 4} 個子段落</span>}
      </div>
    );
  }
  if (field.key === 'rows' && Array.isArray(val)) {
    return (
      <div className="text-xs text-on-surface-variant">
        {val.length} 行 {Array.isArray(val[0]) ? `× ${val[0].length} 欄` : ''}
      </div>
    );
  }
  return <div className="text-xs text-on-surface-variant">{JSON.stringify(val).substring(0, 100)}</div>;
}

/** Popover editor floating above the toolbar */
function FieldPopover({
  field,
  blockId,
  sectionIndex,
  onSave,
  onAiEdit,
  onClose,
}: {
  field: FieldEntry;
  blockId: string;
  sectionIndex: number;
  onSave: (key: string, value: unknown) => void;
  onAiEdit: (context: string) => void;
  onClose: () => void;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);

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
          onClick={() => onAiEdit(`[第${sectionIndex + 1}段 · ${field.label}]`)}
          className="flex items-center gap-1 px-2 py-0.5 text-[11px] text-primary bg-primary/8 rounded-full hover:bg-primary/15 cursor-pointer"
        >
          <span className="material-symbols-outlined text-xs">auto_fix_high</span>
          AI 修改
        </button>
        <button onClick={onClose} className="p-0.5 rounded hover:bg-surface-container cursor-pointer">
          <span className="material-symbols-outlined text-sm text-on-surface-variant">close</span>
        </button>
      </div>

      {/* Content */}
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
        {field.type === 'readonly' && (
          <div className="space-y-2">
            <ReadonlySummary field={field} />
            <p className="text-[10px] text-on-surface-variant/50 text-center">此元素請使用上方「AI 修改」</p>
          </div>
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
        <textarea ref={ref as any} value={text} onChange={e => setText(e.target.value)} rows={4} className={`${cls} resize-none`}
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

/**
 * Compact bottom toolbar showing DOCX section element chips.
 * Click a chip to open a popover editor above.
 */
export default function DocElementPanel({
  block, sectionIndex, selectedElement, onSelectElement, onSaveField, onAiEdit, t,
}: DocElementPanelProps) {
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
          sectionIndex={sectionIndex}
          onSave={(key, value) => onSaveField(block.id, key, value)}
          onAiEdit={(ctx) => { onAiEdit(block.id, ctx); setOpenField(null); }}
          onClose={() => setOpenField(null)}
        />
      )}

      {/* Toolbar — single compact row */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 overflow-x-auto scrollbar-thin">
        <span className="text-[10px] text-on-surface-variant/50 shrink-0">第{sectionIndex + 1}段</span>
        <div className="w-px h-4 bg-outline-variant/15 shrink-0" />
        {fields.map((field) => {
          const isReadonly = field.type === 'readonly';
          return (
            <button
              key={field.key}
              onClick={() => {
                setOpenField(openField === field.key ? null : field.key);
                onSelectElement(field.key);
              }}
              className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] whitespace-nowrap transition-all cursor-pointer shrink-0 ${
                openField === field.key
                  ? 'bg-primary text-on-primary shadow-sm'
                  : selectedElement === field.key
                    ? 'bg-primary/10 text-primary border border-primary/20'
                    : 'text-on-surface-variant hover:bg-surface-container-highest/60'
              }`}
            >
              <span className={`material-symbols-outlined text-xs ${openField === field.key ? '' : isReadonly ? 'text-warning/70' : 'text-primary/60'}`}>
                {field.icon}
              </span>
              {field.label}
            </button>
          );
        })}
        <div className="flex-1" />
        <button
          onClick={() => onAiEdit(block.id, `[第${sectionIndex + 1}段]`)}
          className="flex items-center gap-1 px-2 py-1 text-[11px] text-primary hover:bg-primary/8 rounded-md cursor-pointer shrink-0"
        >
          <span className="material-symbols-outlined text-xs">auto_fix_high</span>
          AI
        </button>
      </div>
    </div>
  );
}
