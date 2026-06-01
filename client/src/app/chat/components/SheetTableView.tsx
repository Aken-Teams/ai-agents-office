'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import type { DocumentBlock } from '../../editor/hooks/useDocumentBlocks';

export type CellRef = { row: number; col: number };
export type CellRange = { startRow: number; startCol: number; endRow: number; endCol: number };

/** Convert column index to Excel-style letter (0→A, 1→B, ..., 25→Z, 26→AA) */
export function colToLetter(col: number): string {
  let s = '';
  let c = col;
  while (c >= 0) {
    s = String.fromCharCode((c % 26) + 65) + s;
    c = Math.floor(c / 26) - 1;
  }
  return s;
}

/** Format a cell reference like "A1" or a range like "A1:C5" */
export function formatCellRef(cell: CellRef): string {
  return `${colToLetter(cell.col)}${cell.row + 1}`;
}
export function formatRange(range: CellRange): string {
  return `${colToLetter(range.startCol)}${range.startRow + 1}:${colToLetter(range.endCol)}${range.endRow + 1}`;
}

interface SheetTableViewProps {
  block: DocumentBlock;
  sheetIndex: number;
  selectedCell: CellRef | null;
  selectedRange: CellRange | null;
  onSelectCell: (cell: CellRef | null) => void;
  onSelectRange: (range: CellRange | null) => void;
  onCellEdit: (row: number, col: number, value: string | number) => void;
  readOnly?: boolean;
}

export default function SheetTableView({
  block, sheetIndex, selectedCell, selectedRange, onSelectCell, onSelectRange, onCellEdit, readOnly,
}: SheetTableViewProps) {
  const headers = (block.data.headers as string[]) || (block.data.columns as string[]) || [];
  const rows = (block.data.rows as any[][]) || (block.data.data as any[][]) || [];

  const [editingCell, setEditingCell] = useState<CellRef | null>(null);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const dragStartRef = useRef<CellRef | null>(null);

  // Focus input when editing
  useEffect(() => {
    if (editingCell && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingCell]);

  const handleCellClick = useCallback((row: number, col: number, e: React.MouseEvent) => {
    // Shift+click for range selection
    if (e.shiftKey && selectedCell) {
      onSelectRange({
        startRow: Math.min(selectedCell.row, row),
        startCol: Math.min(selectedCell.col, col),
        endRow: Math.max(selectedCell.row, row),
        endCol: Math.max(selectedCell.col, col),
      });
      return;
    }
    onSelectCell({ row, col });
    onSelectRange(null);
  }, [selectedCell, onSelectCell, onSelectRange]);

  const handleCellDoubleClick = useCallback((row: number, col: number) => {
    if (readOnly) return;
    const value = rows[row]?.[col];
    setEditValue(value != null ? String(value) : '');
    setEditingCell({ row, col });
  }, [rows, readOnly]);

  const commitEdit = useCallback(() => {
    if (!editingCell) return;
    const parsed = editValue.trim();
    // Auto-detect number
    const num = Number(parsed);
    const finalValue = parsed !== '' && !isNaN(num) ? num : parsed;
    onCellEdit(editingCell.row, editingCell.col, finalValue);
    setEditingCell(null);
  }, [editingCell, editValue, onCellEdit]);

  const cancelEdit = useCallback(() => {
    setEditingCell(null);
  }, []);

  const handleEditKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitEdit();
    } else if (e.key === 'Escape') {
      cancelEdit();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      commitEdit();
      // Move to next cell
      if (editingCell) {
        const nextCol = editingCell.col + 1;
        if (nextCol < headers.length) {
          onSelectCell({ row: editingCell.row, col: nextCol });
          handleCellDoubleClick(editingCell.row, nextCol);
        }
      }
    }
  }, [commitEdit, cancelEdit, editingCell, headers.length, onSelectCell, handleCellDoubleClick]);

  // Mouse drag for range selection
  const handleMouseDown = useCallback((row: number, col: number, e: React.MouseEvent) => {
    if (e.button !== 0) return;
    dragStartRef.current = { row, col };
  }, []);

  const handleMouseEnter = useCallback((row: number, col: number) => {
    if (!dragStartRef.current) return;
    const start = dragStartRef.current;
    if (start.row !== row || start.col !== col) {
      onSelectRange({
        startRow: Math.min(start.row, row),
        startCol: Math.min(start.col, col),
        endRow: Math.max(start.row, row),
        endCol: Math.max(start.col, col),
      });
    }
  }, [onSelectRange]);

  useEffect(() => {
    const handleMouseUp = () => { dragStartRef.current = null; };
    window.addEventListener('mouseup', handleMouseUp);
    return () => window.removeEventListener('mouseup', handleMouseUp);
  }, []);

  const isInRange = (row: number, col: number): boolean => {
    if (!selectedRange) return false;
    return row >= selectedRange.startRow && row <= selectedRange.endRow &&
      col >= selectedRange.startCol && col <= selectedRange.endCol;
  };

  const isSelected = (row: number, col: number): boolean => {
    return selectedCell?.row === row && selectedCell?.col === col;
  };

  const isNumeric = (val: unknown): boolean => {
    if (val == null || val === '') return false;
    return typeof val === 'number' || (typeof val === 'string' && !isNaN(Number(val)) && val.trim() !== '');
  };

  const colCount = headers.length || (rows[0]?.length ?? 0);

  return (
    <div className="flex-1 overflow-auto bg-white select-none" style={{ userSelect: 'none' }}>
      <table className="border-collapse text-xs min-w-full" style={{ tableLayout: 'auto' }}>
        <thead className="sticky top-0 z-10">
          <tr>
            {/* Row number header */}
            <th className="bg-[#f0f0f0] border border-[#d4d4d4] text-[10px] text-gray-500 font-normal w-10 min-w-[40px] text-center py-1 sticky left-0 z-20" />
            {Array.from({ length: colCount }, (_, ci) => (
              <th
                key={ci}
                className="bg-[#f0f0f0] border border-[#d4d4d4] text-[10px] text-gray-600 font-medium text-center py-1 px-2 min-w-[80px] max-w-[200px]"
              >
                <div className="flex flex-col items-center">
                  <span className="text-[9px] text-gray-400 leading-none">{colToLetter(ci)}</span>
                  {headers[ci] && (
                    <span className="truncate w-full text-[11px] font-semibold text-gray-700 mt-0.5">{headers[ci]}</span>
                  )}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri}>
              {/* Row number */}
              <td className="bg-[#f0f0f0] border border-[#d4d4d4] text-[10px] text-gray-500 text-center py-0.5 font-normal sticky left-0 z-[5]">
                {ri + 1}
              </td>
              {Array.from({ length: colCount }, (_, ci) => {
                const cellArr = Array.isArray(row) ? row : Object.values(row);
                const val = cellArr[ci];
                const editing = editingCell?.row === ri && editingCell?.col === ci;
                const sel = isSelected(ri, ci);
                const inRange = isInRange(ri, ci);

                return (
                  <td
                    key={ci}
                    className={`border border-[#e0e0e0] py-0.5 px-1.5 relative cursor-cell transition-colors ${
                      editing ? 'p-0' :
                      sel ? 'bg-blue-50 outline outline-2 outline-blue-500 outline-offset-[-2px] z-[2]' :
                      inRange ? 'bg-blue-50/60' :
                      'hover:bg-gray-50'
                    } ${isNumeric(val) ? 'text-right' : 'text-left'}`}
                    onClick={(e) => { if (!editing) handleCellClick(ri, ci, e); }}
                    onDoubleClick={() => handleCellDoubleClick(ri, ci)}
                    onMouseDown={(e) => handleMouseDown(ri, ci, e)}
                    onMouseEnter={() => handleMouseEnter(ri, ci)}
                  >
                    {editing ? (
                      <input
                        ref={inputRef}
                        type="text"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onKeyDown={handleEditKeyDown}
                        onBlur={commitEdit}
                        className="w-full h-full px-1.5 py-0.5 text-xs outline-none border-2 border-blue-500 bg-white"
                        style={{ minWidth: '60px' }}
                      />
                    ) : (
                      <span className="block truncate max-w-[200px]">
                        {val != null ? String(val) : ''}
                      </span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
          {/* Empty row hint */}
          {rows.length === 0 && (
            <tr>
              <td colSpan={colCount + 1} className="text-center py-8 text-gray-400 text-xs">
                (empty sheet)
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
