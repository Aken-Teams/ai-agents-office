'use client';

import { useState, useEffect, useCallback } from 'react';
import type { DocumentBlock } from '../hooks/useDocumentBlocks';

interface BlockEditPanelProps {
  block: DocumentBlock;
  docType: string;
  onSave: (blockId: string, data: Record<string, unknown>) => void;
  onClose: () => void;
  onRegenerate: (blockId: string) => void;
  saving: boolean;
  t: (key: any, params?: Record<string, string | number>) => string;
}

/** Render an editable field based on value type */
function EditableField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: unknown;
  onChange: (newValue: unknown) => void;
}) {
  // String
  if (typeof value === 'string') {
    const isLong = value.length > 80;
    return (
      <div className="space-y-1">
        <label className="text-[11px] font-medium text-on-surface-variant uppercase tracking-wider">{label}</label>
        {isLong ? (
          <textarea
            value={value}
            onChange={e => onChange(e.target.value)}
            rows={3}
            className="w-full bg-surface-container-highest border border-outline-variant/20 rounded-lg py-2 px-3 text-sm text-on-surface outline-none focus:ring-1 focus:ring-primary/40 resize-y"
          />
        ) : (
          <input
            type="text"
            value={value}
            onChange={e => onChange(e.target.value)}
            className="w-full bg-surface-container-highest border border-outline-variant/20 rounded-lg py-2 px-3 text-sm text-on-surface outline-none focus:ring-1 focus:ring-primary/40"
          />
        )}
      </div>
    );
  }

  // Number
  if (typeof value === 'number') {
    return (
      <div className="space-y-1">
        <label className="text-[11px] font-medium text-on-surface-variant uppercase tracking-wider">{label}</label>
        <input
          type="number"
          value={value}
          onChange={e => onChange(Number(e.target.value))}
          className="w-full bg-surface-container-highest border border-outline-variant/20 rounded-lg py-2 px-3 text-sm text-on-surface outline-none focus:ring-1 focus:ring-primary/40"
        />
      </div>
    );
  }

  // Boolean
  if (typeof value === 'boolean') {
    return (
      <div className="flex items-center gap-2">
        <label className="text-[11px] font-medium text-on-surface-variant uppercase tracking-wider flex-1">{label}</label>
        <button
          onClick={() => onChange(!value)}
          className={`w-10 h-5 rounded-full transition-colors cursor-pointer ${value ? 'bg-primary' : 'bg-outline-variant/30'}`}
        >
          <div className={`w-4 h-4 rounded-full bg-white shadow transition-transform ${value ? 'translate-x-5' : 'translate-x-0.5'}`} />
        </button>
      </div>
    );
  }

  // Array of strings (bullets/points)
  if (Array.isArray(value) && value.every(v => typeof v === 'string')) {
    return (
      <div className="space-y-1">
        <label className="text-[11px] font-medium text-on-surface-variant uppercase tracking-wider">{label}</label>
        <div className="space-y-1">
          {(value as string[]).map((item, i) => (
            <div key={i} className="flex items-center gap-1">
              <span className="text-[10px] text-outline w-4 text-right shrink-0">{i + 1}</span>
              <input
                type="text"
                value={item}
                onChange={e => {
                  const newArr = [...value as string[]];
                  newArr[i] = e.target.value;
                  onChange(newArr);
                }}
                className="flex-1 bg-surface-container-highest border border-outline-variant/20 rounded py-1.5 px-2.5 text-sm text-on-surface outline-none focus:ring-1 focus:ring-primary/40"
              />
              <button
                onClick={() => {
                  const newArr = (value as string[]).filter((_, j) => j !== i);
                  onChange(newArr);
                }}
                className="p-0.5 rounded hover:bg-error/10 cursor-pointer"
              >
                <span className="material-symbols-outlined text-error/50 text-sm">close</span>
              </button>
            </div>
          ))}
          <button
            onClick={() => onChange([...(value as string[]), ''])}
            className="flex items-center gap-1 text-xs text-primary hover:text-primary-hover cursor-pointer py-1"
          >
            <span className="material-symbols-outlined text-sm">add</span>
            Add item
          </button>
        </div>
      </div>
    );
  }

  // Array of objects (stats/items)
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object') {
    return (
      <div className="space-y-1.5">
        <label className="text-[11px] font-medium text-on-surface-variant uppercase tracking-wider">{label}</label>
        {(value as Record<string, unknown>[]).map((item, i) => (
          <div key={i} className="bg-surface-container/50 rounded-lg p-2.5 space-y-1.5 border border-outline-variant/5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-outline">#{i + 1}</span>
              <button
                onClick={() => {
                  const newArr = (value as Record<string, unknown>[]).filter((_, j) => j !== i);
                  onChange(newArr);
                }}
                className="p-0.5 rounded hover:bg-error/10 cursor-pointer"
              >
                <span className="material-symbols-outlined text-error/50 text-[13px]">delete</span>
              </button>
            </div>
            {Object.entries(item).filter(([k]) => k !== 'type').map(([key, val]) => (
              <EditableField
                key={key}
                label={key}
                value={val}
                onChange={newVal => {
                  const newArr = [...(value as Record<string, unknown>[])];
                  newArr[i] = { ...newArr[i], [key]: newVal };
                  onChange(newArr);
                }}
              />
            ))}
          </div>
        ))}
      </div>
    );
  }

  // Fallback: show as JSON
  return (
    <div className="space-y-1">
      <label className="text-[11px] font-medium text-on-surface-variant uppercase tracking-wider">{label}</label>
      <textarea
        value={JSON.stringify(value, null, 2)}
        onChange={e => {
          try { onChange(JSON.parse(e.target.value)); } catch {}
        }}
        rows={4}
        className="w-full bg-surface-container-highest border border-outline-variant/20 rounded-lg py-2 px-3 text-xs text-on-surface font-mono outline-none focus:ring-1 focus:ring-primary/40 resize-y"
      />
    </div>
  );
}

/** Priority order for known fields — show these first */
const FIELD_PRIORITY = ['title', 'subtitle', 'heading', 'content', 'text', 'body', 'bullets', 'points', 'items', 'stats'];

export default function BlockEditPanel({ block, docType, onSave, onClose, onRegenerate, saving, t }: BlockEditPanelProps) {
  const [editData, setEditData] = useState<Record<string, unknown>>({});
  const [dirty, setDirty] = useState(false);

  // Reset when block changes
  useEffect(() => {
    setEditData({ ...block.data });
    setDirty(false);
  }, [block.id, block.data]);

  const handleFieldChange = useCallback((key: string, value: unknown) => {
    setEditData(prev => ({ ...prev, [key]: value }));
    setDirty(true);
  }, []);

  const handleSave = useCallback(() => {
    onSave(block.id, editData);
    setDirty(false);
  }, [block.id, editData, onSave]);

  // Sort fields: priority fields first, then alphabetical
  const fields = Object.entries(editData).sort(([a], [b]) => {
    const ai = FIELD_PRIORITY.indexOf(a);
    const bi = FIELD_PRIORITY.indexOf(b);
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    return a.localeCompare(b);
  });

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-outline-variant/10 shrink-0">
        <span className="material-symbols-outlined text-primary text-lg">edit</span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-on-surface truncate">
            {t('editor.editPanel.title')}
          </div>
          <div className="text-[10px] text-on-surface-variant uppercase tracking-wider">
            {block.type.replace(/_/g, ' ')} · #{block.order + 1}
          </div>
        </div>
        <button onClick={onClose} className="p-1 rounded hover:bg-surface-container transition-colors cursor-pointer">
          <span className="material-symbols-outlined text-on-surface-variant text-lg">close</span>
        </button>
      </div>

      {/* Fields */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {fields.map(([key, value]) => (
          <EditableField
            key={key}
            label={key}
            value={value}
            onChange={newVal => handleFieldChange(key, newVal)}
          />
        ))}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 px-4 py-3 border-t border-outline-variant/10 shrink-0">
        <button
          onClick={() => onRegenerate(block.id)}
          className="flex items-center gap-1.5 px-3 py-2 bg-surface-container-highest border border-outline-variant/10 rounded-lg text-xs font-medium text-on-surface hover:bg-surface-variant transition-colors cursor-pointer"
        >
          <span className="material-symbols-outlined text-sm text-primary">auto_fix_high</span>
          {t('editor.regenerate.submit')}
        </button>
        <div className="flex-1" />
        <button
          onClick={handleSave}
          disabled={!dirty || saving}
          className="flex items-center gap-1.5 px-4 py-2 bg-primary text-on-primary rounded-lg text-xs font-bold hover:bg-primary-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        >
          {saving && <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>}
          {t('common.save')}
        </button>
      </div>
    </div>
  );
}
