'use client';

import { useState, useRef, useEffect } from 'react';
import type { DocumentBlock } from '../../editor/hooks/useDocumentBlocks';
import { formatCellRef, formatRange, type CellRef, type CellRange } from './SheetTableView';

interface SheetElementPanelProps {
  block: DocumentBlock;
  sheetIndex: number;
  selectedCell: CellRef | null;
  selectedRange: CellRange | null;
  onSaveField: (blockId: string, key: string, value: unknown) => void;
  onAiEdit: (blockId: string, context: string) => void;
  t: (key: any) => string;
}

/** Popover for editing sheet title */
function TitlePopover({
  value,
  onSave,
  onClose,
}: {
  value: string;
  onSave: (v: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  return (
    <div ref={popoverRef} className="absolute bottom-full left-0 right-0 mb-1 mx-2 bg-surface rounded-xl shadow-2xl border border-outline-variant/15 overflow-hidden z-30 p-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="material-symbols-outlined text-primary text-sm">title</span>
        <span className="text-xs font-medium text-on-surface flex-1">工作表名稱</span>
        <button onClick={onClose} className="p-0.5 rounded hover:bg-surface-container cursor-pointer">
          <span className="material-symbols-outlined text-sm text-on-surface-variant">close</span>
        </button>
      </div>
      <div className="flex gap-2">
        <input
          ref={ref}
          type="text"
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { onSave(text.trim()); onClose(); } }}
          className="flex-1 bg-surface-container-highest border border-outline-variant/20 rounded-lg px-3 py-2 text-sm text-on-surface outline-none focus:ring-1 focus:ring-primary/40"
        />
        <button
          onClick={() => { onSave(text.trim()); onClose(); }}
          className="px-3 py-1.5 text-xs bg-primary text-on-primary rounded-lg font-medium cursor-pointer hover:bg-primary-hover"
        >
          儲存
        </button>
      </div>
    </div>
  );
}

/** Popover for editing headers list */
function HeadersPopover({
  headers,
  onSave,
  onClose,
}: {
  headers: string[];
  onSave: (v: string[]) => void;
  onClose: () => void;
}) {
  const [list, setList] = useState([...headers]);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const update = (i: number, val: string) => { const n = [...list]; n[i] = val; setList(n); };
  const remove = (i: number) => setList(list.filter((_, idx) => idx !== i));
  const add = () => setList([...list, '']);

  return (
    <div ref={popoverRef} className="absolute bottom-full left-0 right-0 mb-1 mx-2 bg-surface rounded-xl shadow-2xl border border-outline-variant/15 overflow-hidden z-30 max-h-[50vh] overflow-y-auto">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-outline-variant/10 bg-surface-container/30">
        <span className="material-symbols-outlined text-primary text-sm">view_column</span>
        <span className="text-xs font-medium text-on-surface flex-1">欄位名稱</span>
        <button onClick={onClose} className="p-0.5 rounded hover:bg-surface-container cursor-pointer">
          <span className="material-symbols-outlined text-sm text-on-surface-variant">close</span>
        </button>
      </div>
      <div className="p-3 space-y-1.5">
        {list.map((h, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <span className="text-[10px] text-on-surface-variant/40 w-5 text-right shrink-0">{String.fromCharCode(65 + i)}</span>
            <input
              type="text"
              value={h}
              onChange={e => update(i, e.target.value)}
              className="flex-1 bg-surface-container-highest border border-outline-variant/20 rounded px-2 py-1.5 text-xs text-on-surface outline-none focus:border-primary/40"
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
          <button
            onClick={() => { onSave(list.filter(s => s.trim())); onClose(); }}
            className="px-3 py-1.5 text-xs bg-primary text-on-primary rounded-lg font-medium cursor-pointer hover:bg-primary-hover"
          >
            儲存
          </button>
        </div>
      </div>
    </div>
  );
}

export default function SheetElementPanel({
  block, sheetIndex, selectedCell, selectedRange, onSaveField, onAiEdit, t,
}: SheetElementPanelProps) {
  const [openPopover, setOpenPopover] = useState<'title' | 'headers' | null>(null);

  const sheetName = (block.data.name as string) || (block.data.title as string) || (block.data.sheetName as string) || `Sheet ${sheetIndex + 1}`;
  const headers = (block.data.headers as string[]) || (block.data.columns as string[]) || [];
  const rows = (block.data.rows as any[][]) || (block.data.data as any[][]) || [];

  // Build AI context with cell reference
  const buildAiContext = (): string => {
    let ctx = `[工作表: ${sheetName}]`;
    if (selectedRange) {
      ctx += ` [選取: ${formatRange(selectedRange)}]`;
    } else if (selectedCell) {
      ctx += ` [選取: ${formatCellRef(selectedCell)}]`;
    }
    return ctx;
  };

  // Cell reference display
  const cellRefDisplay = selectedRange
    ? formatRange(selectedRange)
    : selectedCell
      ? formatCellRef(selectedCell)
      : null;

  return (
    <div className="relative border-t border-outline-variant/10 bg-surface-container/30 shrink-0">
      {/* Popovers */}
      {openPopover === 'title' && (
        <TitlePopover
          value={sheetName}
          onSave={(v) => {
            const key = block.data.name != null ? 'name' : block.data.sheetName != null ? 'sheetName' : 'name';
            onSaveField(block.id, key, v);
          }}
          onClose={() => setOpenPopover(null)}
        />
      )}
      {openPopover === 'headers' && (
        <HeadersPopover
          headers={headers}
          onSave={(v) => {
            const key = block.data.headers != null ? 'headers' : 'columns';
            onSaveField(block.id, key, v);
          }}
          onClose={() => setOpenPopover(null)}
        />
      )}

      {/* Toolbar */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 overflow-x-auto scrollbar-thin">
        {/* Sheet name badge */}
        <span className="text-[10px] text-on-surface-variant/50 shrink-0 flex items-center gap-1">
          <span className="material-symbols-outlined" style={{ fontSize: '12px' }}>table_chart</span>
          {sheetName}
        </span>

        <div className="w-px h-4 bg-outline-variant/15 shrink-0" />

        {/* Cell reference indicator */}
        {cellRefDisplay && (
          <>
            <span className="text-[11px] font-mono text-primary font-semibold px-1.5 py-0.5 bg-primary/8 rounded shrink-0">
              {cellRefDisplay}
            </span>
            <div className="w-px h-4 bg-outline-variant/15 shrink-0" />
          </>
        )}

        {/* Title chip */}
        <button
          onClick={() => setOpenPopover(openPopover === 'title' ? null : 'title')}
          className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] whitespace-nowrap transition-all cursor-pointer shrink-0 ${
            openPopover === 'title'
              ? 'bg-primary text-on-primary shadow-sm'
              : 'text-on-surface-variant hover:bg-surface-container-highest/60'
          }`}
        >
          <span className={`material-symbols-outlined text-xs ${openPopover === 'title' ? '' : 'text-primary/60'}`}>title</span>
          標題
        </button>

        {/* Headers chip */}
        <button
          onClick={() => setOpenPopover(openPopover === 'headers' ? null : 'headers')}
          className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] whitespace-nowrap transition-all cursor-pointer shrink-0 ${
            openPopover === 'headers'
              ? 'bg-primary text-on-primary shadow-sm'
              : 'text-on-surface-variant hover:bg-surface-container-highest/60'
          }`}
        >
          <span className={`material-symbols-outlined text-xs ${openPopover === 'headers' ? '' : 'text-primary/60'}`}>view_column</span>
          欄位 ({headers.length})
        </button>

        {/* Rows count (readonly) */}
        <span className="flex items-center gap-1 px-2 py-1 text-[11px] text-on-surface-variant/50 shrink-0">
          <span className="material-symbols-outlined text-xs text-on-surface-variant/40">storage</span>
          {rows.length} 行
        </span>

        <div className="flex-1" />

        {/* AI edit button */}
        <button
          onClick={() => onAiEdit(block.id, buildAiContext())}
          className="flex items-center gap-1 px-2 py-1 text-[11px] text-primary hover:bg-primary/8 rounded-md cursor-pointer shrink-0"
        >
          <span className="material-symbols-outlined text-xs">auto_fix_high</span>
          AI
        </button>
      </div>
    </div>
  );
}
